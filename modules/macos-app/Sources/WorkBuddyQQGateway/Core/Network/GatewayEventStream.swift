import Foundation

public enum GatewayConnectionStatus: Equatable, Sendable {
    case connecting
    case connected
    case reconnecting(String)
    case offline(String)

    public var label: String {
        switch self {
        case .connecting: return "连接中"
        case .connected: return "实时已连接"
        case .reconnecting: return "重连中"
        case .offline: return "Hub 离线"
        }
    }
}

public enum GatewayStreamPayload: Sendable {
    case snapshot(GatewayState)
    case targetUpdate(
        targets: [String: ConversationTarget],
        activeTargets: [String]?,
        activeGroups: [String]?
    )
    case event(GatewayEventItem?, GatewayState)
    case stateRefresh(String, GatewayState)
}

private struct StreamFrameEnvelope: Decodable {
    var type: String
    var state: GatewayState?
    var targets: [String: ConversationTarget]?
    var activeTargets: [String]?
    var activeGroups: [String]?
    var event: GatewayEventItem?
}

public actor GatewayEventStream {
    private var task: Task<Void, Never>?
    private let session: URLSession

    public init() {
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 60
        config.timeoutIntervalForResource = .infinity
        self.session = URLSession(configuration: config)
    }

    public func stop() {
        task?.cancel()
        task = nil
    }

    public func start(
        baseURL: URL,
        token: String,
        onStatus: @escaping @Sendable (GatewayConnectionStatus) -> Void,
        onPayload: @escaping @Sendable (GatewayStreamPayload) -> Void
    ) {
        stop()
        task = Task { [session] in
            var backoffSeconds: Double = 1.0
            while !Task.isCancelled {
                onStatus(.connecting)
                let streamURL = baseURL.appendingPathComponent("api/qq/stream")
                var request = URLRequest(url: streamURL)
                request.httpMethod = "GET"
                request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
                let trimmed = token.trimmingCharacters(in: .whitespacesAndNewlines)
                if !trimmed.isEmpty {
                    request.setValue("Bearer \(trimmed)", forHTTPHeaderField: "Authorization")
                }

                do {
                    let (bytes, response) = try await session.bytes(for: request)
                    guard let http = response as? HTTPURLResponse else {
                        throw GatewayAPIError.transport("无效的 SSE 响应")
                    }
                    guard (200..<300).contains(http.statusCode) else {
                        throw GatewayAPIError.httpStatus(http.statusCode, "SSE 鉴权或连接失败")
                    }

                    var receivedState = false
                    for try await line in bytes.lines {
                        if Task.isCancelled { break }
                        // The Hub writes each JSON envelope on a single data line.
                        // Foundation's lines sequence skips empty SSE separators.
                        guard let payload = Self.payload(fromDataLine: line) else { continue }
                        if !receivedState {
                            receivedState = true
                            onStatus(.connected)
                            backoffSeconds = 1.0
                        }
                        onPayload(payload)
                    }
                    if !Task.isCancelled {
                        onStatus(.reconnecting("SSE 连接中断"))
                    }
                } catch is CancellationError {
                    break
                } catch {
                    if Task.isCancelled { break }
                    let message = error.localizedDescription
                    if message.contains("HTTP 401") {
                        onStatus(.offline("鉴权令牌无效或未配置"))
                    } else {
                        onStatus(.reconnecting(message))
                    }
                }

                if Task.isCancelled { break }
                let delay = UInt64(backoffSeconds * 1_000_000_000)
                try? await Task.sleep(nanoseconds: delay)
                backoffSeconds = min(10.0, backoffSeconds * 1.5)
            }
        }
    }

    static func payload(fromDataLine line: String) -> GatewayStreamPayload? {
        guard line.hasPrefix("data:"),
              let data = line.dropFirst(5).data(using: .utf8),
              let envelope = try? JSONDecoder().decode(StreamFrameEnvelope.self, from: data) else {
            return nil
        }
        switch envelope.type {
        case "snapshot":
            if let state = envelope.state {
                return .snapshot(state)
            }
        case "target-update":
            if let targets = envelope.targets {
                return .targetUpdate(
                    targets: targets,
                    activeTargets: envelope.activeTargets,
                    activeGroups: envelope.activeGroups
                )
            }
        case "event":
            if let state = envelope.state {
                return .event(envelope.event, state)
            }
        default:
            if let state = envelope.state {
                return .stateRefresh(envelope.type, state)
            }
        }
        return nil
    }
}
