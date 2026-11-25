import Foundation

public struct HARawAttributes: Decodable, Sendable {
    public var friendlyName: String?

    enum CodingKeys: String, CodingKey {
        case friendlyName = "friendly_name"
    }

    public init(friendlyName: String? = nil) {
        self.friendlyName = friendlyName
    }
}

public struct HARawState: Decodable, Sendable {
    public var entityId: String
    public var state: String
    public var attributes: HARawAttributes?

    enum CodingKeys: String, CodingKey {
        case entityId = "entity_id"
        case state
        case attributes
    }

    public init(entityId: String, state: String, attributes: HARawAttributes? = nil) {
        self.entityId = entityId
        self.state = state
        self.attributes = attributes
    }
}

public struct HAEntityItem: Identifiable, Hashable, Sendable {
    public var entityId: String
    public var friendlyName: String
    public var state: String
    public var domain: String

    public var id: String { entityId }

    public init(entityId: String, friendlyName: String, state: String, domain: String) {
        self.entityId = entityId
        self.friendlyName = friendlyName
        self.state = state
        self.domain = domain
    }
}

public struct HAEntityCatalog: Equatable, Sendable {
    public var speakers: [HAEntityItem]
    public var buttons: [HAEntityItem]
    public var otherDeviceCount: Int
    public var totalStatesCount: Int

    public init(speakers: [HAEntityItem], buttons: [HAEntityItem], otherDeviceCount: Int, totalStatesCount: Int) {
        self.speakers = speakers
        self.buttons = buttons
        self.otherDeviceCount = otherDeviceCount
        self.totalStatesCount = totalStatesCount
    }
}

public enum HALoginOutcome: Equatable, Sendable {
    case authenticated(longLivedToken: String)
    case mfaRequired(flowId: String, message: String)
}

public enum HomeAssistantServiceError: LocalizedError, Sendable {
    case invalidURL(String)
    case missingCredentials(String)
    case authenticationFailed(String)
    case networkFailure(String)
    case invalidResponse(String)

    public var errorDescription: String? {
        switch self {
        case .invalidURL(let msg),
             .missingCredentials(let msg),
             .authenticationFailed(let msg),
             .networkFailure(let msg),
             .invalidResponse(let msg):
            return msg
        }
    }
}

public final class HomeAssistantService: Sendable {
    private static let otherReadableDomains: Set<String> = [
        "light", "switch", "cover", "climate", "fan",
        "media_player", "number", "select", "sensor", "binary_sensor"
    ]

    private let session: URLSession

    public init(session: URLSession? = nil) {
        if let session {
            self.session = session
        } else {
            let config = URLSessionConfiguration.ephemeral
            config.timeoutIntervalForRequest = 10
            config.timeoutIntervalForResource = 25
            config.httpCookieStorage = nil
            config.urlCredentialStorage = nil
            config.requestCachePolicy = .reloadIgnoringLocalCacheData
            self.session = URLSession(configuration: config)
        }
    }

    public static func normalizeBaseURL(_ raw: String) throws -> URL {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            throw HomeAssistantServiceError.invalidURL("请输入 Home Assistant 地址或 IP（例如 192.168.1.10:8123）。")
        }
        let lower = trimmed.lowercased()
        let hasAnyScheme = trimmed.contains("://")
        let candidate = hasAnyScheme ? trimmed : "http://\(trimmed)"

        guard var components = URLComponents(string: candidate),
              let scheme = components.scheme?.lowercased(),
              scheme == "http" || scheme == "https",
              let host = components.host, !host.isEmpty else {
            throw HomeAssistantServiceError.invalidURL("Home Assistant 地址格式无效（仅支持 http:// 或 https:// 根地址）。")
        }
        if lower.hasPrefix("https://") == false && hasAnyScheme && scheme != "http" {
            throw HomeAssistantServiceError.invalidURL("仅支持 HTTP 或 HTTPS 协议。")
        }
        guard components.user == nil && components.password == nil else {
            throw HomeAssistantServiceError.invalidURL("地址中请勿内嵌用户名或密码。")
        }
        guard components.query == nil && components.fragment == nil else {
            throw HomeAssistantServiceError.invalidURL("Home Assistant 地址不能包含查询参数或锚点。")
        }
        guard components.path.isEmpty || components.path == "/" else {
            throw HomeAssistantServiceError.invalidURL("请填写 Home Assistant 根地址，不要包含子路径（\(components.path)）。")
        }
        if scheme == "http" && components.port == nil {
            components.port = 8123
        }
        components.path = ""
        guard let url = components.url else {
            throw HomeAssistantServiceError.invalidURL("无法解析 Home Assistant 地址。")
        }
        return url
    }

    public static func isValidXiaoAiSpeakerEntityId(_ entityId: String) -> Bool {
        entityId.range(
            of: #"^notify\.xiaomi_[a-z0-9_]+_play_text_a_[0-9]+_[0-9]+$"#,
            options: .regularExpression
        ) != nil
    }

    public static func categorizeStates(_ rawStates: [HARawState]) -> HAEntityCatalog {
        var speakers: [HAEntityItem] = []
        var buttons: [HAEntityItem] = []
        var otherCount = 0

        for raw in rawStates {
            let entityId = raw.entityId.trimmingCharacters(in: .whitespacesAndNewlines)
            guard let dot = entityId.firstIndex(of: ".") else { continue }
            let domain = String(entityId[..<dot])
            let friendly = raw.attributes?.friendlyName?.trimmingCharacters(in: .whitespacesAndNewlines)
            let displayName = (friendly?.isEmpty == false) ? friendly! : entityId
            let item = HAEntityItem(
                entityId: entityId,
                friendlyName: displayName,
                state: raw.state,
                domain: domain
            )

            if isValidXiaoAiSpeakerEntityId(entityId) {
                speakers.append(item)
            } else if domain == "button" {
                buttons.append(item)
            } else if otherReadableDomains.contains(domain) {
                otherCount += 1
            }
        }

        speakers.sort { ($0.friendlyName, $0.entityId) < ($1.friendlyName, $1.entityId) }
        buttons.sort { ($0.friendlyName, $0.entityId) < ($1.friendlyName, $1.entityId) }

        return HAEntityCatalog(
            speakers: speakers,
            buttons: buttons,
            otherDeviceCount: otherCount,
            totalStatesCount: rawStates.count
        )
    }

    public func login(baseURL: URL, username: String, password: String) async throws -> HALoginOutcome {
        let cleanUser = username.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !cleanUser.isEmpty, !password.isEmpty else {
            throw HomeAssistantServiceError.missingCredentials("请输入 Home Assistant 账号和密码。")
        }

        let clientId = Self.oauthClientId(for: baseURL)
        let redirectUri = "\(clientId)?auth_callback=1"

        // 1. Initiate Home Assistant login flow
        let startURL = baseURL.appendingPathComponent("auth/login_flow")
        let startBody: [String: Any] = [
            "client_id": clientId,
            "handler": ["homeassistant", NSNull()],
            "redirect_uri": redirectUri
        ]
        let startJSON = try await postJSON(url: startURL, body: startBody)
        guard let flowId = startJSON["flow_id"] as? String, !flowId.isEmpty else {
            throw HomeAssistantServiceError.invalidResponse("Home Assistant 登录流程未返回 flow_id，请确认服务版本正常。")
        }

        // 2. Submit username & password
        let stepURL = baseURL.appendingPathComponent("auth/login_flow/\(flowId)")
        let stepBody: [String: Any] = [
            "client_id": clientId,
            "username": cleanUser,
            "password": password
        ]
        let stepJSON = try await postJSON(url: stepURL, body: stepBody)
        return try await handleFlowStepResponse(stepJSON, baseURL: baseURL, defaultFlowId: flowId)
    }

    public func submitMFA(baseURL: URL, flowId: String, code: String) async throws -> HALoginOutcome {
        let cleanCode = code.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !cleanCode.isEmpty else {
            throw HomeAssistantServiceError.missingCredentials("请输入二步验证码。")
        }
        let clientId = Self.oauthClientId(for: baseURL)
        let stepURL = baseURL.appendingPathComponent("auth/login_flow/\(flowId)")
        let stepJSON = try await postJSON(url: stepURL, body: [
            "client_id": clientId,
            "code": cleanCode
        ])
        return try await handleFlowStepResponse(stepJSON, baseURL: baseURL, defaultFlowId: flowId)
    }

    public func fetchEntities(baseURL: URL, token: String) async throws -> HAEntityCatalog {
        let cleanToken = token.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !cleanToken.isEmpty else {
            throw HomeAssistantServiceError.missingCredentials("缺少 Home Assistant 访问令牌。")
        }

        var request = URLRequest(url: baseURL.appendingPathComponent("api/states"))
        request.httpMethod = "GET"
        request.setValue("Bearer \(cleanToken)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Accept")

        let (data, http) = try await performRequest(request)
        if http.statusCode == 401 || http.statusCode == 403 {
            throw HomeAssistantServiceError.authenticationFailed("Home Assistant 令牌无效或已过期（HTTP \(http.statusCode)），请使用账号密码重新登录。")
        }
        guard (200..<300).contains(http.statusCode) else {
            throw HomeAssistantServiceError.invalidResponse("拉取设备列表失败：HTTP \(http.statusCode)。")
        }

        do {
            let states = try JSONDecoder().decode([HARawState].self, from: data)
            return Self.categorizeStates(states)
        } catch {
            throw HomeAssistantServiceError.invalidResponse("Home Assistant 设备状态响应解析失败：\(error.localizedDescription)")
        }
    }

    public func testSpeak(baseURL: URL, token: String, entityId: String, text: String) async throws {
        guard Self.isValidXiaoAiSpeakerEntityId(entityId) else {
            throw HomeAssistantServiceError.invalidResponse("该实体不是标准小米播放文本实体（notify.xiaomi_*_play_text_a_*_*）。")
        }
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, trimmed.count <= 500 else {
            throw HomeAssistantServiceError.invalidResponse("试播文本长度须在 1–500 字符之间。")
        }
        let cleanToken = token.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !cleanToken.isEmpty else {
            throw HomeAssistantServiceError.missingCredentials("缺少 Home Assistant 访问令牌。")
        }

        var request = URLRequest(url: baseURL.appendingPathComponent("api/services/notify/send_message"))
        request.httpMethod = "POST"
        request.setValue("Bearer \(cleanToken)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: [
            "entity_id": entityId,
            "message": trimmed
        ])

        let (_, http) = try await performRequest(request)
        if http.statusCode == 401 || http.statusCode == 403 {
            throw HomeAssistantServiceError.authenticationFailed("Home Assistant 令牌已失效（HTTP \(http.statusCode)）。")
        }
        guard (200..<300).contains(http.statusCode) else {
            throw HomeAssistantServiceError.invalidResponse("试播请求失败：HTTP \(http.statusCode)，请检查音箱实体是否在线。")
        }
    }

    // MARK: - Private Login / WebSocket Token Helpers

    private static func oauthClientId(for baseURL: URL) -> String {
        let s = baseURL.absoluteString
        return s.hasSuffix("/") ? s : "\(s)/"
    }

    private func handleFlowStepResponse(
        _ json: [String: Any],
        baseURL: URL,
        defaultFlowId: String
    ) async throws -> HALoginOutcome {
        let type = (json["type"] as? String) ?? ""
        switch type {
        case "create_entry":
            guard let authCode = json["result"] as? String, !authCode.isEmpty else {
                throw HomeAssistantServiceError.invalidResponse("登录成功但未收到授权码。")
            }
            let longLived = try await exchangeAndMintLongLivedToken(baseURL: baseURL, authCode: authCode)
            return .authenticated(longLivedToken: longLived)

        case "form":
            let stepId = (json["step_id"] as? String) ?? ""
            let nextFlowId = (json["flow_id"] as? String) ?? defaultFlowId
            let errors = json["errors"] as? [String: Any]
            if stepId == "mfa" && (errors == nil || errors?.isEmpty == true) {
                return .mfaRequired(flowId: nextFlowId, message: "该 Home Assistant 账号开启了二步验证，请输入动态验证码。")
            }
            if stepId == "mfa", let errors, !errors.isEmpty {
                throw HomeAssistantServiceError.authenticationFailed("二步验证码错误或已过期。")
            }
            let errDetail = Self.describeFlowErrors(errors)
            throw HomeAssistantServiceError.authenticationFailed(errDetail)

        case "abort":
            let reason = (json["reason"] as? String) ?? "unknown"
            throw HomeAssistantServiceError.authenticationFailed("Home Assistant 拒绝了登录请求（\(reason)）。")

        default:
            throw HomeAssistantServiceError.invalidResponse("未预期的登录状态响应：\(type)")
        }
    }

    private static func describeFlowErrors(_ errors: [String: Any]?) -> String {
        guard let errors, !errors.isEmpty else {
            return "Home Assistant 登录未完成，请检查账号和密码。"
        }
        let values = errors.values.compactMap { $0 as? String }.joined(separator: ", ")
        if values.contains("invalid_auth") {
            return "Home Assistant 账号或密码错误。"
        }
        if values.contains("invalid_code") {
            return "二步验证码错误。"
        }
        return "Home Assistant 登录校验失败（\(values.isEmpty ? "请检查凭据" : values)）。"
    }

    private func exchangeAndMintLongLivedToken(baseURL: URL, authCode: String) async throws -> String {
        let clientId = Self.oauthClientId(for: baseURL)
        var tokenRequest = URLRequest(url: baseURL.appendingPathComponent("auth/token"))
        tokenRequest.httpMethod = "POST"
        tokenRequest.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        let formBody = [
            "grant_type=" + Self.formURLEncode("authorization_code"),
            "code=" + Self.formURLEncode(authCode),
            "client_id=" + Self.formURLEncode(clientId)
        ].joined(separator: "&")
        tokenRequest.httpBody = Data(formBody.utf8)

        let (data, http) = try await performRequest(tokenRequest)
        guard (200..<300).contains(http.statusCode) else {
            throw HomeAssistantServiceError.authenticationFailed("换取短期访问令牌失败：HTTP \(http.statusCode)。")
        }
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let shortAccessToken = json["access_token"] as? String,
              !shortAccessToken.isEmpty else {
            throw HomeAssistantServiceError.invalidResponse("Home Assistant 未返回短期 access_token。")
        }

        return try await mintLongLivedTokenViaWebSocket(baseURL: baseURL, shortAccessToken: shortAccessToken)
    }

    private func mintLongLivedTokenViaWebSocket(baseURL: URL, shortAccessToken: String) async throws -> String {
        guard var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false) else {
            throw HomeAssistantServiceError.invalidURL("无法构造 WebSocket 地址。")
        }
        components.scheme = (baseURL.scheme?.lowercased() == "https") ? "wss" : "ws"
        components.path = "/api/websocket"
        guard let wsURL = components.url else {
            throw HomeAssistantServiceError.invalidURL("无法构造 WebSocket 地址。")
        }

        let task = session.webSocketTask(with: wsURL)
        task.maximumMessageSize = 16 * 1024 * 1024
        task.resume()
        defer { task.cancel(with: .goingAway, reason: nil) }

        // Frame 1: auth_required (or auth_ok)
        let hello = try await receiveJSONFrame(from: task)
        let helloType = (hello["type"] as? String) ?? ""
        if helloType != "auth_ok" {
            let authPayload = try Self.encodeJSONString([
                "type": "auth",
                "access_token": shortAccessToken
            ])
            try await task.send(.string(authPayload))

            let authResult = try await receiveJSONFrame(from: task)
            let authType = (authResult["type"] as? String) ?? ""
            guard authType == "auth_ok" else {
                let msg = (authResult["message"] as? String) ?? "WebSocket 认证失败"
                throw HomeAssistantServiceError.authenticationFailed("签发长效令牌时认证失败：\(msg)")
            }
        }

        let formatter = DateFormatter()
        formatter.dateFormat = "yyyyMMdd-HHmmss"
        let clientName = "WorkBuddy QQ Gateway \(formatter.string(from: Date()))"

        let createPayload = try Self.encodeJSONString([
            "id": 1,
            "type": "auth/long_lived_access_token",
            "client_name": clientName,
            "lifespan": 3650
        ])
        try await task.send(.string(createPayload))

        for _ in 0..<8 {
            let frame = try await receiveJSONFrame(from: task)
            guard (frame["id"] as? Int) == 1 else { continue }
            if (frame["success"] as? Bool) == true,
               let jwt = frame["result"] as? String,
               !jwt.isEmpty {
                return jwt
            }
            let errObj = frame["error"] as? [String: Any]
            let errMsg = (errObj?["message"] as? String) ?? "无法生成长效令牌"
            throw HomeAssistantServiceError.authenticationFailed("签发 HA 长效令牌失败：\(errMsg)")
        }
        throw HomeAssistantServiceError.invalidResponse("等待 Home Assistant 长效令牌响应超时。")
    }

    private func receiveJSONFrame(from task: URLSessionWebSocketTask) async throws -> [String: Any] {
        let message = try await task.receive()
        let data: Data
        switch message {
        case .string(let text):
            data = Data(text.utf8)
        case .data(let raw):
            data = raw
        @unknown default:
            throw HomeAssistantServiceError.invalidResponse("收到未知类型的 WebSocket 帧。")
        }
        guard let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw HomeAssistantServiceError.invalidResponse("WebSocket 返回了无效 JSON。")
        }
        return obj
    }

    private func postJSON(url: URL, body: [String: Any]) async throws -> [String: Any] {
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.httpBody = try JSONSerialization.data(withJSONObject: body)

        let (data, http) = try await performRequest(request)
        guard let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw HomeAssistantServiceError.invalidResponse("Home Assistant 返回了非 JSON 响应（HTTP \(http.statusCode)）。")
        }
        if http.statusCode >= 400 {
            let errDetail = (obj["message"] as? String) ?? "HTTP \(http.statusCode)"
            throw HomeAssistantServiceError.authenticationFailed("Home Assistant 登录接口报错：\(errDetail)")
        }
        return obj
    }

    private func performRequest(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch {
            throw HomeAssistantServiceError.networkFailure("无法连接 Home Assistant（\(error.localizedDescription)）。请确认局域网地址、端口号和电脑网络正常。")
        }
        guard let http = response as? HTTPURLResponse else {
            throw HomeAssistantServiceError.invalidResponse("Home Assistant 未返回 HTTP 响应。")
        }
        return (data, http)
    }

    private static func encodeJSONString(_ obj: [String: Any]) throws -> String {
        let data = try JSONSerialization.data(withJSONObject: obj)
        guard let str = String(data: data, encoding: .utf8) else {
            throw HomeAssistantServiceError.invalidResponse("JSON 编码失败。")
        }
        return str
    }

    private static func formURLEncode(_ value: String) -> String {
        var allowed = CharacterSet.alphanumerics
        allowed.insert(charactersIn: "-._~")
        return value.addingPercentEncoding(withAllowedCharacters: allowed) ?? value
    }
}
