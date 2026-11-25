import Foundation

public enum GatewayAPIError: LocalizedError, Sendable {
    case invalidURL(String)
    case httpStatus(Int, String)
    case decodingFailed(String)
    case transport(String)

    public var statusCode: Int? {
        if case .httpStatus(let code, _) = self { return code }
        return nil
    }

    public var errorDescription: String? {
        switch self {
        case .invalidURL(let url):
            return "无效的服务端地址：\(url)"
        case .httpStatus(let code, let message):
            if message.isEmpty { return "网关请求失败（HTTP \(code)）" }
            return "\(message)（HTTP \(code)）"
        case .decodingFailed(let detail):
            return "响应数据解析失败：\(detail)"
        case .transport(let detail):
            return "无法连接到网关：\(detail)"
        }
    }
}

private struct ServerErrorEnvelope: Decodable {
    var error: String?
}

public actor GatewayAPIClient {
    private var baseURL: URL
    private var token: String
    private let session: URLSession
    private var imageCache: [String: Data] = [:]

    public init(
        baseURL: URL = URL(string: "http://127.0.0.1:3789")!,
        token: String = "",
        session: URLSession? = nil
    ) {
        self.baseURL = baseURL
        self.token = token.trimmingCharacters(in: .whitespacesAndNewlines)
        if let session {
            self.session = session
        } else {
            let config = URLSessionConfiguration.default
            config.timeoutIntervalForRequest = 20
            config.timeoutIntervalForResource = 60
            self.session = URLSession(configuration: config)
        }
    }

    public func configure(baseURL: URL, token: String) {
        self.baseURL = baseURL
        self.token = token.trimmingCharacters(in: .whitespacesAndNewlines)
        self.imageCache.removeAll()
    }

    public func currentConfiguration() -> (baseURL: URL, hasToken: Bool) {
        (baseURL, !token.isEmpty)
    }

    // MARK: - Core Status

    public func health() async throws -> HealthResponse {
        try await get("/api/health", authorized: false)
    }

    public func fetchState(refreshMetadata: Bool = false) async throws -> GatewayState {
        try await get(refreshMetadata ? "/api/state?refresh=1" : "/api/state")
    }

    public func fetchMaintenance() async throws -> MaintenanceState {
        try await get("/api/maintenance")
    }

    public func fetchQQLoginStatus() async throws -> OneBotMaintenanceInfo? {
        var request = makeRequest(path: "/api/qq/login-status", method: "GET", authorized: true)
        request.cachePolicy = .reloadIgnoringLocalCacheData
        request.timeoutInterval = 5
        let (data, response) = try await performData(request)
        if response.statusCode == 404 {
            return try await fetchMaintenance().oneBot
        }
        return try decodeResponse(data: data, response: response)
    }

    // MARK: - LAN Control Panel

    public func fetchLanPanelStatus() async throws -> LanPanelStatus {
        try await get("/api/lan-panel/status")
    }

    public func updateLanPanelConfig(
        enabled: Bool,
        port: Int,
        password: String? = nil,
        bonjourEnabled: Bool = true,
        revokeSessions: Bool = false
    ) async throws -> LanPanelStatus {
        struct Body: Encodable {
            let enabled: Bool
            let port: Int
            let password: String?
            let bonjourEnabled: Bool
            let revokeSessions: Bool
        }
        return try await post(
            "/api/lan-panel/config",
            body: Body(
                enabled: enabled,
                port: port,
                password: (password?.isEmpty == false) ? password : nil,
                bonjourEnabled: bonjourEnabled,
                revokeSessions: revokeSessions
            )
        )
    }

    // MARK: - Dispatch & Messages

    public func setAgentDispatch(enabled: Bool) async throws -> AgentDispatchState {
        struct Body: Encodable { let enabled: Bool }
        return try await post("/api/qq/agent-dispatch", body: Body(enabled: enabled))
    }

    public func sendAgentMessage(targetType: String, targetId: String, text: String) async throws {
        struct Body: Encodable {
            let targetType: String
            let targetId: String
            let text: String
        }
        try await postVoid("/api/qq/agent-message", body: Body(targetType: targetType, targetId: targetId, text: text))
    }

    public func cancelAgent(targetType: String, targetId: String) async throws {
        struct Body: Encodable {
            let targetType: String
            let targetId: String
        }
        try await postVoid("/api/qq/agent/cancel", body: Body(targetType: targetType, targetId: targetId))
    }

    // MARK: - Conversations & Targets

    public func fetchAvailableGroups() async throws -> [AvailableGroupCandidate] {
        struct Envelope: Decodable { let groups: [AvailableGroupCandidate] }
        let res: Envelope = try await get("/api/qq/groups/available")
        return res.groups
    }

    public func fetchAvailableFriends() async throws -> [AvailableFriendCandidate] {
        struct Envelope: Decodable { let friends: [AvailableFriendCandidate] }
        let res: Envelope = try await get("/api/qq/friends/available")
        return res.friends
    }

    public func addGroup(groupId: String) async throws {
        struct Body: Encodable { let groupId: String }
        try await postVoid("/api/qq/groups", body: Body(groupId: groupId))
    }

    public func addPrivateChat(userId: String, displayName: String?) async throws {
        struct Body: Encodable {
            let userId: String
            let displayName: String
        }
        try await postVoid("/api/qq/private-chats", body: Body(userId: userId, displayName: displayName ?? ""))
    }

    public func setReplyEnabled(targetType: String, targetId: String, enabled: Bool) async throws {
        struct Body: Encodable { let enabled: Bool }
        try await postVoid("/api/qq/\(segment(for: targetType))/\(encoded(targetId))/reply-enabled", body: Body(enabled: enabled))
    }

    public func saveConfig(targetType: String, targetId: String, config: AgentConfig) async throws {
        try await postVoid("/api/qq/\(segment(for: targetType))/\(encoded(targetId))/config", body: config)
    }

    public func setContextLink(privateId: String, groupId: String?) async throws {
        struct Body: Encodable {
            let groupId: String?
            let acknowledgeSharedContext: Bool
            func encode(to encoder: Encoder) throws {
                var container = encoder.container(keyedBy: CodingKeys.self)
                if let groupId {
                    try container.encode(groupId, forKey: .groupId)
                } else {
                    try container.encodeNil(forKey: .groupId)
                }
                try container.encode(acknowledgeSharedContext, forKey: .acknowledgeSharedContext)
            }
            enum CodingKeys: String, CodingKey {
                case groupId
                case acknowledgeSharedContext
            }
        }
        try await postVoid("/api/qq/private/\(encoded(privateId))/context-link", body: Body(groupId: groupId, acknowledgeSharedContext: true))
    }

    public func performTargetAction(targetType: String, targetId: String, action: String) async throws {
        try await postEmpty("/api/qq/\(segment(for: targetType))/\(encoded(targetId))/\(encoded(action))")
    }

    public func deleteTarget(targetType: String, targetId: String, confirmTargetId: String) async throws {
        struct Body: Encodable { let confirmTargetId: String }
        try await postVoid("/api/qq/\(segment(for: targetType))/\(encoded(targetId))/delete", body: Body(confirmTargetId: confirmTargetId))
    }

    public func fetchDiagnostics(targetType: String, targetId: String) async throws -> TurnDiagnosticsSnapshot? {
        struct Envelope: Decodable { let diagnostics: TurnDiagnosticsSnapshot? }
        let res: Envelope = try await get("/api/qq/\(segment(for: targetType))/\(encoded(targetId))/diagnostics")
        return res.diagnostics
    }

    // MARK: - Subscriptions

    public func upsertSubscription(
        id: String?,
        targetType: String,
        targetId: String,
        sourceGroupId: String,
        intakeMode: String,
        collectionDelayMinutes: Double,
        enabled: Bool
    ) async throws -> SubscriptionItem {
        struct Body: Encodable {
            let id: String?
            let targetType: String
            let targetId: String
            let sourceGroupId: String
            let mode: String
            let intakeMode: String
            let collectionDelayMinutes: Double
            let enabled: Bool
        }
        return try await post(
            "/api/qq/subscriptions",
            body: Body(
                id: id,
                targetType: targetType,
                targetId: targetId,
                sourceGroupId: sourceGroupId,
                mode: "AUTO",
                intakeMode: intakeMode,
                collectionDelayMinutes: collectionDelayMinutes,
                enabled: enabled
            )
        )
    }

    public func deleteSubscription(id: String) async throws {
        try await postEmpty("/api/qq/subscriptions/\(encoded(id))/delete")
    }

    // MARK: - Persona & Portability

    public func updatePersonaName(_ name: String) async throws -> PersonaNameUpdateResponse {
        struct Body: Encodable { let name: String }
        return try await post("/api/qq/persona/name", body: Body(name: name))
    }

    public func updatePersonaCatchphrases(_ entries: [PersonaCatchphrase]) async throws -> PersonaCatchphrasesUpdateResponse {
        struct Body: Encodable { let catchphrases: [PersonaCatchphrase] }
        return try await post("/api/qq/persona/catchphrases", body: Body(catchphrases: entries))
    }

    public func exportPersona() async throws -> PersonaBundle {
        try await get("/api/qq/persona/export")
    }

    public func importPersona(_ bundle: PersonaBundle) async throws -> PersonaImportResult {
        try await post("/api/qq/persona/import", body: bundle)
    }

    public func resetImportedPersona() async throws -> PersonaImportResult {
        struct Empty: Encodable {}
        return try await post("/api/qq/persona/reset-imported", body: Empty())
    }

    // MARK: - Stickers

    public func fetchStickers() async throws -> StickerCollectionState {
        try await get("/api/qq/stickers")
    }

    public func fetchStickerImage(id: String) async throws -> Data {
        if let cached = imageCache[id] { return cached }
        let request = makeRequest(path: "/api/qq/stickers/\(encoded(id))/image", method: "GET", authorized: true)
        let (data, response) = try await performData(request)
        guard (200..<300).contains(response.statusCode) else {
            throw GatewayAPIError.httpStatus(response.statusCode, "读取表情图片失败")
        }
        if imageCache.count > 240 {
            imageCache.removeAll()
        }
        imageCache[id] = data
        return data
    }

    public func updateStickerUsage(id: String, usage: String) async throws -> StickerCollectionState {
        struct Body: Encodable { let usage: String }
        struct Envelope: Decodable { let stickers: StickerCollectionState }
        let res: Envelope = try await post("/api/qq/stickers/\(encoded(id))/update", body: Body(usage: usage))
        return res.stickers
    }

    public func performStickerAction(id: String, action: String) async throws -> StickerCollectionState {
        struct Empty: Encodable {}
        struct Envelope: Decodable { let stickers: StickerCollectionState }
        let res: Envelope = try await post("/api/qq/stickers/\(encoded(id))/\(encoded(action))", body: Empty())
        return res.stickers
    }

    public func cleanStickerBlacklistFiles() async throws -> StickerCollectionState {
        struct Empty: Encodable {}
        struct Envelope: Decodable { let stickers: StickerCollectionState }
        let res: Envelope = try await post("/api/qq/stickers/blacklist/clean-files", body: Empty())
        return res.stickers
    }

    public func cleanStickerBlacklistFavorites() async throws -> StickerCollectionState {
        struct Empty: Encodable {}
        struct Envelope: Decodable { let stickers: StickerCollectionState }
        let res: Envelope = try await post("/api/qq/stickers/blacklist/clean-qq-favorites", body: Empty())
        return res.stickers
    }

    public func updateStickerLabelModel(_ model: String) async throws -> StickerLabelingState {
        struct Body: Encodable { let model: String }
        return try await post("/api/qq/stickers/label-settings", body: Body(model: model))
    }

    // MARK: - QZone

    public func saveQzoneSettings(
        targetType: String?,
        targetId: String?,
        autoPostEnabled: Bool,
        autoEngageEnabled: Bool
    ) async throws -> QzoneState {
        struct Body: Encodable {
            let targetType: String?
            let targetId: String?
            let autoPostEnabled: Bool
            let autoEngageEnabled: Bool
        }
        return try await post(
            "/api/qq/qzone/settings",
            body: Body(
                targetType: targetType,
                targetId: targetId,
                autoPostEnabled: autoPostEnabled,
                autoEngageEnabled: autoEngageEnabled
            )
        )
    }

    public func refreshQzoneTodayFeeds() async throws -> QzoneState {
        struct EmptyBody: Encodable {}
        return try await post("/api/qq/qzone/refresh-today", body: EmptyBody())
    }

    public func fetchStorageUsage() async throws -> StorageUsageReport {
        try await get("/api/maintenance/storage")
    }

    public func cleanupStorage() async throws -> StorageCleanupResult {
        struct EmptyBody: Encodable {}
        return try await post("/api/maintenance/storage/cleanup", body: EmptyBody())
    }

    // MARK: - Helpers

    private func segment(for targetType: String) -> String {
        targetType == "private" ? "private" : "groups"
    }

    private func encoded(_ value: String) -> String {
        value.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? value
    }

    private func makeRequest(path: String, method: String, authorized: Bool) -> URLRequest {
        let normalizedPath = path.hasPrefix("/") ? String(path.dropFirst()) : path
        let url = baseURL.appendingPathComponent(normalizedPath)
        var request = URLRequest(url: url)
        request.httpMethod = method
        if authorized && !token.isEmpty {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        if method == "POST" {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        return request
    }

    private func get<T: Decodable>(_ path: String, authorized: Bool = true) async throws -> T {
        let request = makeRequest(path: path, method: "GET", authorized: authorized)
        let (data, response) = try await performData(request)
        return try decodeResponse(data: data, response: response)
    }

    private func post<Body: Encodable, T: Decodable>(_ path: String, body: Body) async throws -> T {
        var request = makeRequest(path: path, method: "POST", authorized: true)
        request.httpBody = try JSONEncoder().encode(body)
        let (data, response) = try await performData(request)
        return try decodeResponse(data: data, response: response)
    }

    private func postVoid<Body: Encodable>(_ path: String, body: Body) async throws {
        var request = makeRequest(path: path, method: "POST", authorized: true)
        request.httpBody = try JSONEncoder().encode(body)
        let (data, response) = try await performData(request)
        try ensureSuccess(data: data, response: response)
    }

    private func postEmpty(_ path: String) async throws {
        var request = makeRequest(path: path, method: "POST", authorized: true)
        request.httpBody = Data("{}".utf8)
        let (data, response) = try await performData(request)
        try ensureSuccess(data: data, response: response)
    }

    private func performData(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        do {
            let (data, response) = try await session.data(for: request)
            guard let http = response as? HTTPURLResponse else {
                throw GatewayAPIError.transport("无效的 HTTP 响应")
            }
            return (data, http)
        } catch let error as GatewayAPIError {
            throw error
        } catch {
            throw GatewayAPIError.transport(error.localizedDescription)
        }
    }

    private func ensureSuccess(data: Data, response: HTTPURLResponse) throws {
        guard (200..<300).contains(response.statusCode) else {
            let envelope = try? JSONDecoder().decode(ServerErrorEnvelope.self, from: data)
            throw GatewayAPIError.httpStatus(response.statusCode, envelope?.error ?? "")
        }
    }

    private func decodeResponse<T: Decodable>(data: Data, response: HTTPURLResponse) throws -> T {
        try ensureSuccess(data: data, response: response)
        do {
            return try JSONDecoder().decode(T.self, from: data)
        } catch {
            throw GatewayAPIError.decodingFailed(error.localizedDescription)
        }
    }
}
