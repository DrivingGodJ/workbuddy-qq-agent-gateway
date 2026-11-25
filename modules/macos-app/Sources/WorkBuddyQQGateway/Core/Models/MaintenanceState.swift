import Foundation

public struct HealthResponse: Codable, Sendable {
    public var ok: Bool
    public var pid: Int?
    public var version: String?
}

public struct HubMaintenanceInfo: Codable, Sendable {
    public var host: String?
    public var port: Int?
    public var authDisabled: Bool?
}

public struct OneBotLoginData: Codable, Sendable {
    public var user_id: Int64?
    public var nickname: String?

    public var userIdString: String? {
        user_id.map(String.init)
    }
}

public struct OneBotRuntimeStatus: Codable, Sendable {
    public var online: Bool?
    public var good: Bool?
}

public struct OneBotMaintenanceInfo: Codable, Sendable {
    public var ok: Bool
    public var login: OneBotLoginData?
    public var status: OneBotRuntimeStatus?
    public var error: String?

    public var isOnline: Bool {
        ok && (login?.user_id ?? 0) > 0 && status?.online != false
    }
}

public struct WorkBuddyAccountProbe: Codable, Sendable {
    public var probed: Bool?
    public var loggedIn: Bool?
    public var modelCount: Int?
    public var error: String?
}

public struct AgentMaintenanceInfo: Codable, Sendable {
    public var engine: String?
    public var engineReady: Bool?
    public var cliPath: String?
    public var sdkVersion: String?
    public var account: WorkBuddyAccountProbe?
    public var dispatchEnabled: Bool?
    public var model: String?
    public var reasoningEffort: String?
    public var activeTargets: [String]?
    public var reservationsOk: Bool?
    public var threadLocks: [String: ThreadLockInfo]?
}

public struct MaintenanceStoragePaths: Codable, Sendable {
    public var groupSessions: String?
    public var privateSessions: String?
    public var subscriptions: String?
    public var agentDispatch: String?
    public var stickers: String?
    public var personaOwnerStyle: String?
    public var personaDir: String?
    public var personaImported: Bool?
    public var mediaRoot: String?
    public var stickerLibrary: String?
}

public struct HomeAssistantReadiness: Codable, Sendable {
    public var ready: Bool
    public var speakerReady: Bool
    public var reason: String?
}

public struct MaintenanceState: Codable, Sendable {
    public var ok: Bool
    public var hub: HubMaintenanceInfo?
    public var lanPanel: LanPanelStatus?
    public var oneBot: OneBotMaintenanceInfo?
    public var engine: AgentMaintenanceInfo?
    public var storage: MaintenanceStoragePaths?
    public var homeAssistant: HomeAssistantReadiness?
}

public struct LanPanelUrlEntry: Codable, Hashable, Sendable, Identifiable {
    public var id: String { "\(interface)::\(address)" }
    public var interface: String
    public var address: String
    public var url: String
}

public struct LanPanelStatus: Codable, Equatable, Sendable {
    public var enabled: Bool
    public var running: Bool
    public var port: Int
    public var bonjourEnabled: Bool
    public var bonjourActive: Bool
    public var hasPassword: Bool
    public var activeSessions: Int
    public var urls: [LanPanelUrlEntry]
    public var bonjourHost: String?
    public var lastError: String?
}

public struct StorageCategoryUsage: Codable, Equatable, Sendable {
    public var label: String
    public var path: String?
    public var bytes: Int64
}

public struct StorageCategoriesMap: Codable, Equatable, Sendable {
    public var media: StorageCategoryUsage?
    public var stickers: StorageCategoryUsage?
    public var data: StorageCategoryUsage?
    public var logs: StorageCategoryUsage?
    public var tempJobs: StorageCategoryUsage?
    public var venv: StorageCategoryUsage?
}

public struct StorageHygienePolicy: Codable, Equatable, Sendable {
    public var mediaTtlHours: Int?
    public var mediaMaxMb: Int?
    public var chatQueueTtlHours: Int?
    public var chatQueueMaxPerTarget: Int?
    public var qzoneRetention: String?
    public var logMaxMb: Int?
}

public struct StorageUsageReport: Codable, Equatable, Sendable {
    public var updatedAt: String?
    public var lastCleanupAt: String?
    public var totalBytes: Int64
    public var ephemeralBytes: Int64
    public var categories: StorageCategoriesMap
    public var policy: StorageHygienePolicy?
}

public struct StorageCleanupResult: Codable, Equatable, Sendable {
    public var ok: Bool
    public var freedBytes: Int64
    public var removedItems: Int
    public var containerCleaned: Bool?
    public var storage: StorageUsageReport?
}
