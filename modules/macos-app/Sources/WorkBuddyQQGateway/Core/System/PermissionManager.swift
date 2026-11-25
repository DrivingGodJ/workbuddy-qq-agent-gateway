import AppKit
import EventKit
import Foundation
import UserNotifications

public enum PermissionAuthorizationStatus: String, Sendable {
    case granted = "已授权"
    case denied = "已拒绝"
    case restricted = "受限制"
    case notDetermined = "未请求"
    case writeOnly = "仅写入"
    case unavailable = "不可用（需 .app 运行）"

    public var isGranted: Bool { self == .granted }
}

public struct SystemPermissionSummary: Equatable, Sendable {
    public var calendar: PermissionAuthorizationStatus
    public var reminders: PermissionAuthorizationStatus
    public var notifications: PermissionAuthorizationStatus

    public var calendarRemindersReady: Bool {
        calendar.isGranted && reminders.isGranted
    }
}

@MainActor
public final class PermissionManager {
    private let eventStore = EKEventStore()

    public init() {}

    public func currentSummary() async -> SystemPermissionSummary {
        let cal = Self.mapEventKit(EKEventStore.authorizationStatus(for: .event))
        let rem = Self.mapEventKit(EKEventStore.authorizationStatus(for: .reminder))
        let notif = await currentNotificationStatus()
        return SystemPermissionSummary(calendar: cal, reminders: rem, notifications: notif)
    }

    public func requestCalendarAccess() async -> PermissionAuthorizationStatus {
        do {
            let granted = try await eventStore.requestFullAccessToEvents()
            return granted ? .granted : Self.mapEventKit(EKEventStore.authorizationStatus(for: .event))
        } catch {
            return Self.mapEventKit(EKEventStore.authorizationStatus(for: .event))
        }
    }

    public func requestRemindersAccess() async -> PermissionAuthorizationStatus {
        do {
            let granted = try await eventStore.requestFullAccessToReminders()
            return granted ? .granted : Self.mapEventKit(EKEventStore.authorizationStatus(for: .reminder))
        } catch {
            return Self.mapEventKit(EKEventStore.authorizationStatus(for: .reminder))
        }
    }

    public func requestNotificationsAccess() async -> PermissionAuthorizationStatus {
        guard Bundle.main.bundleIdentifier != nil else {
            return .unavailable
        }
        let center = UNUserNotificationCenter.current()
        do {
            let granted = try await center.requestAuthorization(options: [.alert, .sound, .badge])
            return granted ? .granted : await currentNotificationStatus()
        } catch {
            return await currentNotificationStatus()
        }
    }

    public func openSystemSettingsPrivacy(_ pane: String) {
        let urlString: String
        switch pane {
        case "calendar":
            urlString = "x-apple.systempreferences:com.apple.preference.security?Privacy_Calendars"
        case "reminders":
            urlString = "x-apple.systempreferences:com.apple.preference.security?Privacy_Reminders"
        case "notifications":
            urlString = "x-apple.systempreferences:com.apple.preference.notifications"
        default:
            urlString = "x-apple.systempreferences:com.apple.preference.security"
        }
        if let url = URL(string: urlString) {
            NSWorkspace.shared.open(url)
        }
    }

    private func currentNotificationStatus() async -> PermissionAuthorizationStatus {
        guard Bundle.main.bundleIdentifier != nil else {
            return .unavailable
        }
        let settings = await UNUserNotificationCenter.current().notificationSettings()
        switch settings.authorizationStatus {
        case .authorized, .provisional, .ephemeral:
            return .granted
        case .denied:
            return .denied
        case .notDetermined:
            return .notDetermined
        @unknown default:
            return .notDetermined
        }
    }

    private static func mapEventKit(_ status: EKAuthorizationStatus) -> PermissionAuthorizationStatus {
        switch status {
        case .fullAccess:
            return .granted
        case .writeOnly:
            return .writeOnly
        case .denied:
            return .denied
        case .restricted:
            return .restricted
        case .notDetermined:
            return .notDetermined
        @unknown default:
            return .notDetermined
        }
    }
}
