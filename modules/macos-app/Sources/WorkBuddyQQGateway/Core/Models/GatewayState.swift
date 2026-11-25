import Foundation

public struct AgentDispatchState: Codable, Sendable, Equatable {
    public var enabled: Bool
    public var updatedAt: String?

    public init(enabled: Bool = true, updatedAt: String? = nil) {
        self.enabled = enabled
        self.updatedAt = updatedAt
    }
}

public struct TaskGateState: Codable, Sendable, Equatable {
    public var blocked: Bool?
    public var running: Bool?
    public var activeTasks: Int?
    public var queuedTasks: Int?
}

public struct ReasoningEffortOption: Codable, Hashable, Sendable {
    public var reasoningEffort: String
    public var description: String?
}

public struct AIModelDescriptor: Codable, Hashable, Sendable, Identifiable {
    public var id: String { model }
    public var model: String
    public var displayName: String?
    public var description: String?
    public var isDefault: Bool?
    public var defaultReasoningEffort: String?
    public var reasoningCapabilitySource: String?
    public var supportedReasoningEfforts: [ReasoningEffortOption]?
}

public struct ContextTokenOption: Codable, Hashable, Sendable, Identifiable {
    public var id: String { value.keyString }
    public var value: ContextTokenLimit
    public var label: String
    public var description: String?
}

public struct PermissionOption: Codable, Hashable, Sendable, Identifiable {
    public var id: String { value }
    public var value: String
    public var label: String
    public var description: String?
    public var targetTypes: [String]?
}

public struct AIStateConfig: Codable, Sendable, Equatable {
    public var provider: String?
    public var model: String?
    public var reasoningEffort: String?
    public var persistentThreads: Bool?
    public var autoCompactTokenScope: String?
    public var availableModels: [AIModelDescriptor]?
    public var contextTokenOptions: [ContextTokenOption]?
    public var permissionModeOptions: [PermissionOption]?
    public var homeAssistantPermissionOptions: [PermissionOption]?
    public var speakerGreetingsAvailable: Bool?
    public var speakerWeatherCity: String?
}

public struct GatewayEventItem: Codable, Sendable, Equatable, Identifiable {
    public var id: String { "\(at ?? "")::\(type)::\(groupId ?? userId ?? targetId ?? "")" }
    public var type: String
    public var groupId: String?
    public var userId: String?
    public var targetType: String?
    public var targetId: String?
    public var threadId: String?
    public var turnId: String?
    public var at: String?
    public var kind: String?
    public var reason: String?
    public var status: String?
    public var count: Int?
    public var model: String?
}

public struct QQStatePayload: Codable, Sendable, Equatable {
    public var ownerId: String?
    public var allowedGroups: [String]?
    public var groups: [String: ConversationTarget]?
    public var privateChats: [String: ConversationTarget]?
    public var sourceGroups: [String: SourceGroupState]?
    public var availableSourceGroups: [AvailableGroupCandidate]?
    public var stickers: StickerCollectionState?
    public var qzone: QzoneState?
    public var activeTargets: [String]?
    public var activeGroups: [String]?
    public var events: [GatewayEventItem]?
}

public struct GatewayState: Codable, Sendable, Equatable {
    public var version: Int?
    public var architecture: String?
    public var agentDispatch: AgentDispatchState?
    public var persona: PersonaPublicState?
    public var lanPanel: LanPanelStatus?
    public var taskGate: TaskGateState?
    public var ai: AIStateConfig?
    public var qq: QQStatePayload?

    public init(
        version: Int? = nil,
        architecture: String? = nil,
        agentDispatch: AgentDispatchState? = nil,
        persona: PersonaPublicState? = nil,
        taskGate: TaskGateState? = nil,
        ai: AIStateConfig? = nil,
        qq: QQStatePayload? = nil
    ) {
        self.version = version
        self.architecture = architecture
        self.agentDispatch = agentDispatch
        self.persona = persona
        self.taskGate = taskGate
        self.ai = ai
        self.qq = qq
    }
}
