import Foundation

/// Supports both `"auto"` and integer context limits (`100000`, `200000`, etc.).
public enum ContextTokenLimit: Codable, Hashable, Sendable {
    case auto
    case tokens(Int)

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if let stringValue = try? container.decode(String.self) {
            if stringValue.lowercased() == "auto" {
                self = .auto
                return
            }
            if let intVal = Int(stringValue) {
                self = .tokens(intVal)
                return
            }
        }
        if let intValue = try? container.decode(Int.self) {
            self = .tokens(intValue)
            return
        }
        if let doubleValue = try? container.decode(Double.self) {
            self = .tokens(Int(doubleValue))
            return
        }
        self = .auto
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .auto:
            try container.encode("auto")
        case .tokens(let count):
            try container.encode(count)
        }
    }

    public var keyString: String {
        switch self {
        case .auto: return "auto"
        case .tokens(let count): return String(count)
        }
    }
}

public struct SpeakerGreetingPlan: Codable, Hashable, Sendable, Identifiable {
    public var id: String
    public var time: String
    public var days: [Int]
    public var enabled: Bool
    public var weather: Bool

    public init(id: String, time: String, days: [Int], enabled: Bool, weather: Bool) {
        self.id = id
        self.time = time
        self.days = days
        self.enabled = enabled
        self.weather = weather
    }

    static let timeZone = TimeZone(identifier: "Asia/Shanghai") ?? TimeZone(secondsFromGMT: 8 * 3600)!

    private static var scheduleCalendar: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        return calendar
    }

    var timeSelection: Date {
        get {
            let fields = time.split(separator: ":").compactMap { Int($0) }
            let hour = fields.count == 2 && (0..<24).contains(fields[0]) ? fields[0] : 8
            let minute = fields.count == 2 && (0..<60).contains(fields[1]) ? fields[1] : 0
            return Self.scheduleCalendar.date(from: DateComponents(year: 2001, month: 1, day: 1, hour: hour, minute: minute))!
        }
        set {
            let fields = Self.scheduleCalendar.dateComponents([.hour, .minute], from: newValue)
            time = String(format: "%02d:%02d", fields.hour ?? 0, fields.minute ?? 0)
        }
    }

    mutating func setWeekday(_ day: Int, selected: Bool) {
        var selection = Set(days)
        if selected { selection.insert(day) }
        else { selection.remove(day) }
        days = selection.sorted()
    }
}

public struct AgentConfig: Codable, Equatable, Sendable {
    public var model: String?
    public var reasoningEffort: String?
    public var contextTokenLimit: ContextTokenLimit?
    public var workingMode: String?
    public var permissionMode: String?
    public var calendarRemindersEnabled: Bool?
    public var homeAssistantPermission: String?
    public var groupEssenceEnabled: Bool?
    public var groupMuteEnabled: Bool?
    public var speakerGreetings: [SpeakerGreetingPlan]?

    public init(
        model: String? = nil,
        reasoningEffort: String? = nil,
        contextTokenLimit: ContextTokenLimit? = .auto,
        workingMode: String? = "agent",
        permissionMode: String? = "workspaceWrite",
        calendarRemindersEnabled: Bool? = false,
        homeAssistantPermission: String? = "owner",
        groupEssenceEnabled: Bool? = false,
        groupMuteEnabled: Bool? = false,
        speakerGreetings: [SpeakerGreetingPlan]? = []
    ) {
        self.model = model
        self.reasoningEffort = reasoningEffort
        self.contextTokenLimit = contextTokenLimit
        self.workingMode = workingMode
        self.permissionMode = permissionMode
        self.calendarRemindersEnabled = calendarRemindersEnabled
        self.homeAssistantPermission = homeAssistantPermission
        self.groupEssenceEnabled = groupEssenceEnabled
        self.groupMuteEnabled = groupMuteEnabled
        self.speakerGreetings = speakerGreetings
    }
}

public struct MessageAttachment: Codable, Equatable, Sendable {
    public var name: String?
    public var fileName: String?
    public var size: Int?
    public var kind: String?
    public var mimeType: String?
}

public struct MessageImageRef: Codable, Equatable, Sendable {
    public var localPath: String?
    public var url: String?
    public var context: String?
}

public struct QuotedMessageSummary: Codable, Equatable, Sendable {
    public var messageId: String?
    public var senderId: String?
    public var senderName: String?
    public var senderRole: String?
    public var timestamp: String?
    public var displayTime: String?
    public var text: String?
    public var trust: String?
}

public struct ConversationMessage: Codable, Equatable, Sendable, Identifiable {
    public var id: String { messageId ?? "\(sequence ?? 0)::\(timestamp ?? "")::\(senderId ?? "")" }
    public var messageId: String?
    public var sequence: Int?
    public var groupId: String?
    public var senderId: String?
    public var senderName: String?
    public var senderRole: String?
    public var timestamp: String?
    public var displayTime: String?
    public var readAt: String?
    public var text: String?
    public var links: [String]?
    public var images: [MessageImageRef]?
    public var attachments: [MessageAttachment]?
    public var mentionedBot: Bool?
    public var replyToMessageId: String?
    public var quotedMessage: QuotedMessageSummary?
    public var quoteError: String?
    public var trust: String?
    public var source: String?
    public var rawType: String?
    public var eventType: String?
    public var direction: String?
    public var recalled: Bool?
}

public struct CompletedReplySummary: Codable, Equatable, Sendable {
    public var text: String?
    public var sentAt: String?
    public var displayTime: String?
    public var messageId: String?
    public var recalled: Bool?
}

public struct ActiveReplyState: Codable, Equatable, Sendable {
    public var running: Bool?
    public var waiting: Bool?
    public var waitUntil: String?
    public var uploading: Bool?
    public var status: String?
    public var text: String?
    public var startedAt: String?
    public var updatedAt: String?
    public var turnId: String?
    public var error: String?
}

public struct TriggerInfo: Codable, Equatable, Sendable {
    public var reason: String?
    public var requestedAt: String?
}

public struct ProcessingInfo: Codable, Equatable, Sendable {
    public var processingUntilMessageId: String?
    public var trigger: TriggerInfo?
}

public struct FailedDeliveryInfo: Codable, Equatable, Sendable {
    public var failedAt: String?
    public var processingUntilMessageId: String?
    public var trigger: TriggerInfo?
    public var subscriptionIds: [String]?
}

public struct ContextLinkInfo: Codable, Equatable, Sendable {
    public var groupId: String?
    public var groupName: String?
    public var threadId: String?
    public var parkedThreadId: String?
}

public struct ContextQueueTask: Codable, Equatable, Sendable {
    public var targetType: String?
    public var targetId: String?
    public var kind: String?
}

public struct ContextQueueInfo: Codable, Equatable, Sendable {
    public var groupId: String?
    public var linkedPrivateIds: [String]?
    public var active: ContextQueueTask?
    public var queued: [ContextQueueTask]?
}

public struct ThreadLockInfo: Codable, Equatable, Sendable {
    public var status: String?
    public var threadId: String?
    public var error: String?
}

public struct ActivitySummary: Codable, Equatable, Sendable {
    public var stage: String?
    public var message: String?
    public var at: String?
}

public struct TurnUsage: Codable, Equatable, Sendable {
    public var inputTokens: Int?
    public var cachedTokens: Int?
    public var cacheCreationTokens: Int?
    public var outputTokens: Int?
    public var modelCalls: Int?
}

public struct TurnDiagnosticsSnapshot: Codable, Equatable, Sendable {
    public var groupId: String?
    public var model: String?
    public var requests: Int?
    public var startedAtMs: Double?
    public var finishedAtMs: Double?
    public var stage: String?
    public var firstTextMs: Double?
    public var lastProgressAtMs: Double?
    public var toolCalls: Int?
    public var toolName: String?
    public var imageCount: Int?
    public var inputChars: Int?
    public var inputPreview: String?
    public var inputTruncated: Bool?
    public var usage: TurnUsage?
    public var error: String?
}

public struct SubscriptionStateDetail: Codable, Equatable, Sendable {
    public var pendingMessages: [ConversationMessage]?
    public var pendingCount: Int?
    public var collectionStartedAt: String?
    public var collectionDeadline: String?
    public var processingUntilMessageId: String?
    public var lastConsumedMessageId: String?
    public var lastCompletedAt: String?
    public var lastError: String?
}

public struct SubscriptionItem: Codable, Equatable, Sendable, Identifiable {
    public var id: String
    public var targetType: String
    public var targetId: String
    public var sourceGroupId: String
    public var sourceGroupName: String?
    public var mode: String?
    public var intakeMode: String
    public var collectionDelayMinutes: Double
    public var enabled: Bool
    public var createdAt: String?
    public var updatedAt: String?
    public var state: SubscriptionStateDetail?
}

public struct ConversationTarget: Codable, Equatable, Sendable, Identifiable {
    public var id: String { "\(targetType)::\(targetId)" }
    public var groupId: String
    public var replyEnabled: Bool
    public var groupName: String?
    public var botRole: String?
    public var isBotGroupAdmin: Bool?
    public var displayName: String?
    public var userId: String?
    public var targetType: String
    public var targetId: String
    public var conversationType: String?
    public var threadId: String?
    public var agentConfig: AgentConfig?
    public var effectiveAgentConfig: AgentConfig?
    public var contextLink: ContextLinkInfo?
    public var contextQueue: ContextQueueInfo?
    public var threadCreatedAt: String?
    public var lastActivityAt: String?
    public var lastCompletedReply: CompletedReplySummary?
    public var pendingMessages: [ConversationMessage]?
    public var messageTimeline: [ConversationMessage]?
    public var pendingCount: Int?
    public var unreadCount: Int?
    public var busy: Bool?
    public var pendingTrigger: TriggerInfo?
    public var processingUntilMessageId: String?
    public var processing: ProcessingInfo?
    public var failedDelivery: FailedDeliveryInfo?
    public var lastError: String?
    public var resumeError: String?
    public var activeReply: ActiveReplyState?
    public var diagnostics: TurnDiagnosticsSnapshot?
    public var qzoneActivity: ActivitySummary?
    public var speakerGreetingActivity: ActivitySummary?
    public var threadLock: ThreadLockInfo?
    public var subscriptions: [SubscriptionItem]?

    public var resolvedTitle: String {
        if targetType == "private" {
            if let displayName, !displayName.isEmpty { return displayName }
            if let groupName, !groupName.isEmpty { return groupName }
            return "QQ \(targetId)"
        }
        if let groupName, !groupName.isEmpty { return groupName }
        return "群 \(targetId)"
    }

    public var effectiveConfig: AgentConfig {
        effectiveAgentConfig ?? agentConfig ?? AgentConfig()
    }

    public var botIsGroupAdmin: Bool {
        isBotGroupAdmin == true || botRole == "admin" || botRole == "owner"
    }

    public var botRoleLabel: String {
        switch botRole {
        case "owner": return "群主"
        case "admin": return "管理员"
        case "member": return "普通成员"
        default: return "未检测"
        }
    }
}

public struct SubscriberProgress: Codable, Equatable, Sendable, Identifiable {
    public var id: String { subscriptionId }
    public var subscriptionId: String
    public var targetType: String
    public var targetId: String
    public var targetName: String?
    public var mode: String?
    public var status: String
    public var pendingCount: Int?
    public var collectionDeadline: String?
    public var lastCompletedAt: String?
    public var lastError: String?
}

public struct SourceGroupMessage: Codable, Equatable, Sendable, Identifiable {
    public var id: String { messageId ?? "\(sequence ?? 0)::\(timestamp ?? "")" }
    public var messageId: String?
    public var sequence: Int?
    public var groupId: String?
    public var senderId: String?
    public var senderName: String?
    public var senderRole: String?
    public var timestamp: String?
    public var displayTime: String?
    public var text: String?
    public var retainedBySubscription: Bool?
    public var pendingSubscriberCount: Int?
}

public struct SourceGroupState: Codable, Equatable, Sendable, Identifiable {
    public var id: String { groupId }
    public var groupId: String
    public var groupName: String?
    public var lastActivityAt: String?
    public var retainedCount: Int?
    public var recentCount: Int?
    public var visibleMessages: [SourceGroupMessage]?
    public var retainedMessages: [SourceGroupMessage]?
    public var visibleCount: Int?
    public var subscriptionCount: Int?
    public var subscriberProgress: [SubscriberProgress]?
    public var pendingSubscriberCount: Int?
    public var failedSubscriberCount: Int?
    public var neverReplies: Bool?
}

public struct AvailableGroupCandidate: Codable, Equatable, Sendable, Identifiable {
    public var id: String { groupId }
    public var groupId: String
    public var groupName: String?
}

public struct AvailableFriendCandidate: Codable, Equatable, Sendable, Identifiable {
    public var id: String { userId }
    public var userId: String
    public var nickname: String?
    public var remark: String?
    public var displayName: String?

    public init(userId: String, nickname: String? = nil, remark: String? = nil, displayName: String? = nil) {
        self.userId = userId
        self.nickname = nickname
        self.remark = remark
        self.displayName = displayName
    }

    public var resolvedLabel: String {
        let remarkText = remark?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let nickText = nickname?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if !remarkText.isEmpty && !nickText.isEmpty && remarkText != nickText {
            return "\(remarkText)（\(nickText)）"
        }
        if !remarkText.isEmpty { return remarkText }
        if !nickText.isEmpty { return nickText }
        if let displayName, !displayName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return displayName.trimmingCharacters(in: .whitespacesAndNewlines)
        }
        return "QQ \(userId)"
    }
}
