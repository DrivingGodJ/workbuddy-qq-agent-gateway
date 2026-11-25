import Foundation

public struct StickerCollectionState: Codable, Sendable, Equatable {
    public var total: Int?
    public var collectionLimit: Int?
    public var collectionFull: Bool?
    public var ready: Int?
    public var awaitingAi: Int?
    public var awaitingCommit: Int?
    public var needsReview: Int?
    public var favoritePending: Int?
    public var cleanupPending: Int?
    public var excludedCount: Int?
    public var excludedItems: [ExcludedStickerItem]?
    public var items: [StickerItem]?
    public var candidates: [StickerCandidate]?
    public var labeling: StickerLabelingState?
    public var curation: StickerCurationState?

    public init(
        total: Int? = 0,
        collectionLimit: Int? = 110,
        collectionFull: Bool? = false,
        ready: Int? = 0,
        awaitingAi: Int? = 0,
        awaitingCommit: Int? = 0,
        needsReview: Int? = 0,
        favoritePending: Int? = 0,
        cleanupPending: Int? = 0,
        excludedCount: Int? = 0,
        excludedItems: [ExcludedStickerItem]? = [],
        items: [StickerItem]? = [],
        candidates: [StickerCandidate]? = [],
        labeling: StickerLabelingState? = nil,
        curation: StickerCurationState? = nil
    ) {
        self.total = total
        self.collectionLimit = collectionLimit
        self.collectionFull = collectionFull
        self.ready = ready
        self.awaitingAi = awaitingAi
        self.awaitingCommit = awaitingCommit
        self.needsReview = needsReview
        self.favoritePending = favoritePending
        self.cleanupPending = cleanupPending
        self.excludedCount = excludedCount
        self.excludedItems = excludedItems
        self.items = items
        self.candidates = candidates
        self.labeling = labeling
        self.curation = curation
    }
}

public struct StickerItem: Codable, Sendable, Equatable, Identifiable {
    public var id: String
    public var usage: String?
    public var labelStatus: String?
    public var labelSource: String?
    public var favoriteStatus: String?
    public var favoriteError: String?
    public var receiveCount: Int?
    public var sendCount: Int?
    public var createdAt: String?
    public var lastSeenAt: String?
    public var lastUsedAt: String?
}

public struct StickerCandidate: Codable, Sendable, Equatable, Identifiable {
    public var id: String
    public var status: String?
    public var usage: String?
    public var receiveCount: Int?
    public var createdAt: String?
    public var lastSeenAt: String?
    public var labelError: String?
}

public struct ExcludedStickerItem: Codable, Sendable, Equatable, Identifiable {
    public var id: String
    public var reason: String?
    public var excludedAt: String?
    public var lastSeenAt: String?
    public var receiveCount: Int?
    public var usage: String?
    public var filesCleanedAt: String?
    public var favoriteCleanupStatus: String?
    public var favoriteCleanupError: String?
    public var hasPreview: Bool?
    public var canRestore: Bool?
}

public struct StickerLabelingState: Codable, Sendable, Equatable {
    public var model: String?
    public var ephemeralSession: Bool?
    public var retainsContext: Bool?
    public var cleanupPolicy: String?
}

public struct StickerCurationProgress: Codable, Sendable, Equatable {
    public var reviewed: Int?
    public var phase: String?
}

public struct StickerCurationState: Codable, Sendable, Equatable {
    public var status: String?
    public var requestedAt: String?
    public var nextCheckAt: String?
    public var beforeCount: Int?
    public var retainedCount: Int?
    public var removedCount: Int?
    public var error: String?
    public var schedule: String?
    public var timezone: String?
    public var threshold: Int?
    public var keepCount: Int?
    public var progress: StickerCurationProgress?
}
