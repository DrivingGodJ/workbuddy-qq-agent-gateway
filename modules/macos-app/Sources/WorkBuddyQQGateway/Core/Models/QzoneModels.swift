import Foundation

public struct QzoneFeedComment: Codable, Sendable, Equatable, Identifiable {
    public var id: String
    public var uin: String
    public var nickname: String
    public var content: String
    public var timeText: String?
    public var isBot: Bool
    public var at: String?

    public init(
        id: String,
        uin: String,
        nickname: String,
        content: String,
        timeText: String? = nil,
        isBot: Bool = false,
        at: String? = nil
    ) {
        self.id = id
        self.uin = uin
        self.nickname = nickname
        self.content = content
        self.timeText = timeText
        self.isBot = isBot
        self.at = at
    }
}

public struct QzoneTodayFeed: Codable, Sendable, Equatable, Identifiable {
    public var id: String
    public var uin: String
    public var tid: String
    public var nickname: String
    public var timeMs: Double?
    public var text: String
    public var imageCount: Int?
    public var imageUrls: [String]?
    public var likeCount: Int?
    public var botLiked: Bool?
    public var isBotPost: Bool?
    public var scannedAt: String?
    public var comments: [QzoneFeedComment]?

    public init(
        id: String,
        uin: String,
        tid: String,
        nickname: String,
        timeMs: Double? = nil,
        text: String,
        imageCount: Int? = 0,
        imageUrls: [String]? = nil,
        likeCount: Int? = 0,
        botLiked: Bool? = false,
        isBotPost: Bool? = false,
        scannedAt: String? = nil,
        comments: [QzoneFeedComment]? = nil
    ) {
        self.id = id
        self.uin = uin
        self.tid = tid
        self.nickname = nickname
        self.timeMs = timeMs
        self.text = text
        self.imageCount = imageCount
        self.imageUrls = imageUrls
        self.likeCount = likeCount
        self.botLiked = botLiked
        self.isBotPost = isBotPost
        self.scannedAt = scannedAt
        self.comments = comments
    }
}

public struct QzoneEvent: Codable, Sendable, Equatable, Identifiable {
    public var id: String { "\(at ?? "")::\(kind ?? "")::\(message ?? "")" }
    public var kind: String?
    public var status: String?
    public var at: String?
    public var message: String?
}

public struct QzoneState: Codable, Sendable, Equatable {
    public var targetType: String?
    public var targetId: String?
    public var autoPostEnabled: Bool?
    public var autoEngageEnabled: Bool?
    public var lastPostAt: String?
    public var lastScanAt: String?
    public var lastSeenFeedId: String?
    public var lastSeenFeedTimeMs: Double?
    public var lastError: String?
    public var scheduleTimes: [String]?
    public var events: [QzoneEvent]?
    public var todayDate: String?
    public var todayFeeds: [QzoneTodayFeed]?

    public init(
        targetType: String? = nil,
        targetId: String? = nil,
        autoPostEnabled: Bool? = false,
        autoEngageEnabled: Bool? = false,
        lastPostAt: String? = nil,
        lastScanAt: String? = nil,
        lastSeenFeedId: String? = nil,
        lastSeenFeedTimeMs: Double? = nil,
        lastError: String? = nil,
        scheduleTimes: [String]? = nil,
        events: [QzoneEvent]? = nil,
        todayDate: String? = nil,
        todayFeeds: [QzoneTodayFeed]? = nil
    ) {
        self.targetType = targetType
        self.targetId = targetId
        self.autoPostEnabled = autoPostEnabled
        self.autoEngageEnabled = autoEngageEnabled
        self.lastPostAt = lastPostAt
        self.lastScanAt = lastScanAt
        self.lastSeenFeedId = lastSeenFeedId
        self.lastSeenFeedTimeMs = lastSeenFeedTimeMs
        self.lastError = lastError
        self.scheduleTimes = scheduleTimes
        self.events = events
        self.todayDate = todayDate
        self.todayFeeds = todayFeeds
    }
}
