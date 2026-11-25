import EventKit
import Foundation

// MARK: - Helpers

final class SendableBox<T>: @unchecked Sendable {
    var value: T
    init(_ value: T) { self.value = value }
}

struct ReminderSnapshot: Sendable {
    let identifier: String
    let title: String
    let listName: String
    let dueDate: Date?
    let completed: Bool
    let priority: Int
    let notes: String
}

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data((message + "\n").utf8))
    exit(1)
}

func readInputJSON() -> [String: Any] {
    let raw: String
    if CommandLine.arguments.count > 1, CommandLine.arguments[1] != "-" {
        raw = CommandLine.arguments[1]
    } else {
        let data = FileHandle.standardInput.readDataToEndOfFile()
        raw = String(data: data, encoding: .utf8) ?? "{}"
    }
    let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    if trimmed.isEmpty { return [:] }
    guard let data = trimmed.data(using: .utf8),
          let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
        fail("EventKit 输入参数不是合法的 JSON")
    }
    return obj
}

func writeJSON(_ obj: Any) {
    guard let data = try? JSONSerialization.data(withJSONObject: obj, options: []),
          let text = String(data: data, encoding: .utf8) else {
        fail("无法序列化 EventKit 输出 JSON")
    }
    print(text)
}

func formatISO(_ date: Date) -> String {
    let formatter = ISO8601DateFormatter()
    formatter.timeZone = TimeZone.current
    formatter.formatOptions = [.withInternetDateTime]
    return formatter.string(from: date)
}

func parseISO(_ raw: Any?) -> Date? {
    guard let text = (raw as? String)?.trimmingCharacters(in: .whitespacesAndNewlines),
          !text.isEmpty else {
        return nil
    }
    let frac = ISO8601DateFormatter()
    frac.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    if let d = frac.date(from: text) { return d }

    let basic = ISO8601DateFormatter()
    basic.formatOptions = [.withInternetDateTime]
    if let d = basic.date(from: text) { return d }

    for pattern in ["yyyy-MM-dd'T'HH:mm:ss", "yyyy-MM-dd HH:mm:ss", "yyyy-MM-dd'T'HH:mm", "yyyy-MM-dd HH:mm", "yyyy-MM-dd"] {
        let df = DateFormatter()
        df.locale = Locale(identifier: "en_US_POSIX")
        df.timeZone = TimeZone.current
        df.dateFormat = pattern
        if let d = df.date(from: text) { return d }
    }
    return nil
}

func parseDateBoundary(_ raw: Any?, isEnd: Bool = false) -> (date: Date, isDateOnly: Bool)? {
    guard let text = (raw as? String)?.trimmingCharacters(in: .whitespacesAndNewlines),
          !text.isEmpty else {
        return nil
    }
    if text.count == 10,
       text.range(of: #"^\d{4}-\d{2}-\d{2}$"#, options: .regularExpression) != nil,
       let dayStart = parseISO(text) {
        if isEnd {
            let endOfDay = Calendar.current.date(byAdding: DateComponents(day: 1, second: -1), to: dayStart) ?? dayStart.addingTimeInterval(86399)
            return (endOfDay, true)
        }
        return (dayStart, true)
    }
    if let parsed = parseISO(text) {
        return (parsed, false)
    }
    return nil
}

func authStatusLabel(_ status: EKAuthorizationStatus) -> String {
    switch status {
    case .fullAccess: return "fullAccess"
    case .writeOnly: return "writeOnly"
    case .denied: return "denied"
    case .restricted: return "restricted"
    case .notDetermined: return "notDetermined"
    @unknown default: return "unknown"
    }
}

func clamp(_ value: Int, min lo: Int, max hi: Int) -> Int {
    Swift.max(lo, Swift.min(hi, value))
}

func preferredSource(in store: EKEventStore, entityType: EKEntityType) -> EKSource? {
    let defaultSource = entityType == .event
        ? store.defaultCalendarForNewEvents?.source
        : store.defaultCalendarForNewReminders()?.source
    let writableSources = store.sources.filter { source in
        source.sourceType == .calDAV || source.sourceType == .local || source.sourceType == .exchange
    }
    if let icloud = writableSources.first(where: {
        $0.sourceType == .calDAV && $0.title.localizedCaseInsensitiveContains("icloud")
    }) {
        return icloud
    }
    if let caldav = writableSources.first(where: { $0.sourceType == .calDAV }) {
        return caldav
    }
    if let defaultSource { return defaultSource }
    if let local = writableSources.first(where: { $0.sourceType == .local }) {
        return local
    }
    return store.sources.first
}

func findOrCreateCalendar(in store: EKEventStore, title rawTitle: String, entityType: EKEntityType) throws -> EKCalendar {
    let targetTitle = rawTitle.trimmingCharacters(in: .whitespacesAndNewlines)
    let calendars = store.calendars(for: entityType).filter { $0.allowsContentModifications }
    if let existing = calendars.first(where: { $0.title.trimmingCharacters(in: .whitespacesAndNewlines) == targetTitle }) {
        return existing
    }
    if entityType == .reminder, targetTitle.isEmpty, let def = store.defaultCalendarForNewReminders(), def.allowsContentModifications {
        return def
    }
    let cal = EKCalendar(for: entityType, eventStore: store)
    cal.title = targetTitle.isEmpty ? (entityType == .event ? "活动" : "待办") : targetTitle
    guard let source = preferredSource(in: store, entityType: entityType) else {
        if entityType == .event, let def = store.defaultCalendarForNewEvents { return def }
        if entityType == .reminder, let def = store.defaultCalendarForNewReminders() { return def }
        fail("找不到可用的日历或待办账户来源")
    }
    cal.source = source
    try store.saveCalendar(cal, commit: true)
    return cal
}

func fetchRemindersSync(store: EKEventStore, calendars: [EKCalendar]?, includeCompleted: Bool = false, timeoutSeconds: TimeInterval = 8.0) -> (items: [ReminderSnapshot], timedOut: Bool) {
    let pred = includeCompleted
        ? store.predicateForReminders(in: calendars)
        : store.predicateForIncompleteReminders(withDueDateStarting: nil, ending: nil, calendars: calendars)
    let sem = DispatchSemaphore(value: 0)
    let box = SendableBox<[ReminderSnapshot]>([])
    store.fetchReminders(matching: pred) { rawList in
        let snapshots = (rawList ?? []).map { item in
            let dueDate = item.dueDateComponents.flatMap { Calendar.current.date(from: $0) }
            return ReminderSnapshot(
                identifier: item.calendarItemIdentifier,
                title: item.title ?? "",
                listName: item.calendar?.title ?? "",
                dueDate: dueDate,
                completed: item.isCompleted,
                priority: item.priority,
                notes: item.notes ?? ""
            )
        }
        box.value = snapshots
        sem.signal()
    }
    let waitResult = sem.wait(timeout: .now() + timeoutSeconds)
    if waitResult == .timedOut {
        return ([], true)
    }
    return (box.value, false)
}

func composeNotes(notes: String, provenance: String, marker: String) -> String {
    let trimmedNotes = notes.trimmingCharacters(in: .whitespacesAndNewlines)
    if trimmedNotes.isEmpty { return provenance }
    if !marker.isEmpty && trimmedNotes.contains(marker) { return trimmedNotes }
    return "\(trimmedNotes)\n\n\(provenance)"
}

// MARK: - Operations

func runPreflight(store: EKEventStore) {
    let calStatus = EKEventStore.authorizationStatus(for: .event)
    let remStatus = EKEventStore.authorizationStatus(for: .reminder)
    let calRead = calStatus == .fullAccess
    let calWrite = calStatus == .fullAccess || calStatus == .writeOnly
    let remRead = remStatus == .fullAccess
    let remWrite = remStatus == .fullAccess || remStatus == .writeOnly

    let calendars = calRead ? store.calendars(for: .event).filter { $0.allowsContentModifications }.map { $0.title } : []
    let reminderLists = remRead ? store.calendars(for: .reminder).filter { $0.allowsContentModifications }.map { $0.title } : []

    var warnings: [String] = []
    if !calRead {
        warnings.append("日历未获完全访问权限（status=\(authStatusLabel(calStatus))），请在 系统设置 → 隐私与安全性 → 日历 中允许 WorkBuddy QQ Gateway")
    }
    if !remRead {
        warnings.append("提醒事项未获完全访问权限（status=\(authStatusLabel(remStatus))），请在 系统设置 → 隐私与安全性 → 提醒事项 中允许 WorkBuddy QQ Gateway")
    }

    writeJSON([
        "ok": true,
        "ready": calWrite && remWrite,
        "calendarAuthorized": calRead,
        "remindersAuthorized": remRead,
        "calendarStatus": authStatusLabel(calStatus),
        "remindersStatus": authStatusLabel(remStatus),
        "calendars": calendars,
        "reminderLists": reminderLists,
        "warnings": warnings
    ])
}

func runContext(store: EKEventStore, input: [String: Any]) {
    let now = parseISO(input["now"]) ?? Date()
    let horizonDays = clamp((input["horizonDays"] as? Int) ?? 30, min: 1, max: 60)
    let limit = clamp((input["limit"] as? Int) ?? 20, min: 1, max: 80)
    let rawScope = ((input["scope"] as? String) ?? "both").trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    let scope = ["both", "calendar", "reminders"].contains(rawScope) ? rawScope : "both"
    let wantsCalendar = scope == "both" || scope == "calendar"
    let wantsReminders = scope == "both" || scope == "reminders"

    let explicitStart = parseDateBoundary(input["startDate"], isEnd: false)
    let explicitEnd = parseDateBoundary(input["endDate"], isEnd: true)
    let startBoundary = explicitStart?.date ?? now
    let endBoundary = explicitEnd?.date ?? startBoundary.addingTimeInterval(TimeInterval(horizonDays) * 86400)
    let rangeStart = min(startBoundary, endBoundary)
    let rangeEnd = max(startBoundary, endBoundary)

    let calendarNameFilter = ((input["calendarName"] as? String) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    let calendarNameLower = calendarNameFilter.lowercased()
    let queryFilter = ((input["query"] as? String) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    let queryLower = queryFilter.lowercased()
    let includeCompleted = (input["includeCompleted"] as? Bool) ?? false

    let calStatus = EKEventStore.authorizationStatus(for: .event)
    let remStatus = EKEventStore.authorizationStatus(for: .reminder)
    let calRead = calStatus == .fullAccess
    let remRead = remStatus == .fullAccess

    var warnings: [String] = []
    var calendarItems: [[String: Any]] = []
    var reminderItems: [[String: Any]] = []
    var calendarNames: [String] = []
    var reminderListNames: [String] = []

    if wantsCalendar {
        if calRead {
            let allEventCalendars = store.calendars(for: .event)
            calendarNames = allEventCalendars.filter { $0.allowsContentModifications }.map { $0.title }
            let filteredCals: [EKCalendar]? = calendarNameLower.isEmpty
                ? nil
                : allEventCalendars.filter { $0.title.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == calendarNameLower }
            if filteredCals == nil || !filteredCals!.isEmpty {
                let searchStart = rangeStart.addingTimeInterval(-12 * 3600)
                let pred = store.predicateForEvents(withStart: searchStart, end: rangeEnd, calendars: filteredCals)
                let matched = store.events(matching: pred)
                    .filter { ev in
                        guard (ev.endDate ?? ev.startDate) >= rangeStart && ev.startDate <= rangeEnd else { return false }
                        if queryLower.isEmpty { return true }
                        let hay = "\(ev.title ?? "")\n\(ev.location ?? "")\n\(ev.notes ?? "")".lowercased()
                        return hay.contains(queryLower)
                    }
                    .sorted { $0.startDate < $1.startDate }
                    .prefix(limit)
                for ev in matched {
                    calendarItems.append([
                        "title": ev.title ?? "",
                        "calendarName": ev.calendar?.title ?? "",
                        "start": formatISO(ev.startDate),
                        "end": ev.endDate != nil ? formatISO(ev.endDate) : NSNull(),
                        "allDay": ev.isAllDay,
                        "location": ev.location ?? ""
                    ])
                }
            }
        } else {
            warnings.append("日历未获完全访问权限（status=\(authStatusLabel(calStatus))），请在 系统设置 → 隐私与安全性 → 日历 中允许 WorkBuddy QQ Gateway")
        }
    }

    if wantsReminders {
        if remRead {
            let allRemLists = store.calendars(for: .reminder)
            reminderListNames = allRemLists.filter { $0.allowsContentModifications }.map { $0.title }
            let filteredLists: [EKCalendar]? = calendarNameLower.isEmpty
                ? nil
                : allRemLists.filter { $0.title.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == calendarNameLower }
            if filteredLists == nil || !filteredLists!.isEmpty {
                let (fetched, timedOut) = fetchRemindersSync(store: store, calendars: filteredLists, includeCompleted: includeCompleted, timeoutSeconds: 8.0)
                if timedOut {
                    warnings.append("提醒事项读取超时")
                } else {
                    let hasExplicitRange = explicitStart != nil || explicitEnd != nil
                    let filtered = fetched
                        .filter { item in
                            if !queryLower.isEmpty {
                                let hay = "\(item.title)\n\(item.notes)".lowercased()
                                if !hay.contains(queryLower) { return false }
                            }
                            if let due = item.dueDate {
                                if hasExplicitRange {
                                    return due >= rangeStart && due <= rangeEnd
                                }
                                return due <= rangeEnd
                            }
                            return !hasExplicitRange
                        }
                        .sorted { lhs, rhs in
                            switch (lhs.dueDate, rhs.dueDate) {
                            case let (l?, r?): return l != r ? l < r : lhs.title < rhs.title
                            case (_?, nil): return true
                            case (nil, _?): return false
                            case (nil, nil): return lhs.title < rhs.title
                            }
                        }
                        .prefix(limit)
                    for item in filtered {
                        reminderItems.append([
                            "title": item.title,
                            "listName": item.listName,
                            "due": item.dueDate != nil ? formatISO(item.dueDate!) : NSNull(),
                            "completed": item.completed,
                            "priority": item.priority,
                            "notes": String(item.notes.prefix(200))
                        ])
                    }
                }
            }
        } else {
            warnings.append("提醒事项未获完全访问权限（status=\(authStatusLabel(remStatus))），请在 系统设置 → 隐私与安全性 → 提醒事项 中允许 WorkBuddy QQ Gateway")
        }
    }

    writeJSON([
        "now": formatISO(now),
        "timezone": TimeZone.current.identifier,
        "scope": scope,
        "startDate": formatISO(rangeStart),
        "endDate": formatISO(rangeEnd),
        "calendarName": calendarNameFilter.isEmpty ? NSNull() : calendarNameFilter,
        "query": queryFilter.isEmpty ? NSNull() : queryFilter,
        "calendarAuthorized": calRead,
        "remindersAuthorized": remRead,
        "calendars": calendarNames,
        "reminderLists": reminderListNames,
        "warnings": warnings,
        "calendar": calendarItems,
        "reminders": reminderItems
    ])
}

func runUpsertCalendar(store: EKEventStore, input: [String: Any]) {
    let calStatus = EKEventStore.authorizationStatus(for: .event)
    guard calStatus == .fullAccess || calStatus == .writeOnly else {
        fail("没有日历写入权限（status=\(authStatusLabel(calStatus))），请在 系统设置 → 隐私与安全性 → 日历 中允许 WorkBuddy QQ Gateway")
    }
    guard let title = (input["title"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines),
          !title.isEmpty else {
        fail("日历事项缺少标题")
    }
    guard let start = parseISO(input["start"]) else {
        fail("日历事项缺少有效的开始时间")
    }
    let allDay = (input["allDay"] as? Bool) ?? false
    let parsedEnd = parseISO(input["end"])
    let end: Date
    if let parsedEnd, parsedEnd >= start {
        end = parsedEnd
    } else if allDay {
        let cal = Calendar.current
        let dayStart = cal.startOfDay(for: start)
        end = cal.date(byAdding: DateComponents(day: 1, second: -1), to: dayStart) ?? start.addingTimeInterval(86399)
    } else {
        end = start.addingTimeInterval(3600)
    }

    let calendarName = (input["calendarName"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
    let desiredCalName = (calendarName?.isEmpty == false) ? calendarName! : "活动"
    let targetCal: EKCalendar
    do {
        targetCal = try findOrCreateCalendar(in: store, title: desiredCalName, entityType: .event)
    } catch {
        fail("无法获取或创建日历“\(desiredCalName)”：\(error.localizedDescription)")
    }

    let marker = (input["marker"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    let sourceName = (input["sourceGroupName"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? "QQ 会话"
    let sourceId = (input["sourceGroupId"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    let provenance = marker.isEmpty
        ? "来源：\(sourceName)\(sourceId.isEmpty ? "" : " (\(sourceId))")"
        : "\(marker)\n来源群：\(sourceName)\(sourceId.isEmpty ? "" : " (\(sourceId))")"
    let notes = composeNotes(notes: (input["notes"] as? String) ?? "", provenance: provenance, marker: marker)
    let location = ((input["location"] as? String) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)

    var existingEvent: EKEvent?
    if calStatus == .fullAccess && !marker.isEmpty {
        let searchStart = start.addingTimeInterval(-30 * 86400)
        let searchEnd = end.addingTimeInterval(30 * 86400)
        let pred = store.predicateForEvents(withStart: searchStart, end: searchEnd, calendars: [targetCal])
        existingEvent = store.events(matching: pred).first(where: { ($0.notes ?? "").contains(marker) })
    }

    let existed = existingEvent != nil
    let event = existingEvent ?? EKEvent(eventStore: store)
    event.title = title
    event.calendar = targetCal
    event.isAllDay = allDay
    event.startDate = allDay ? Calendar.current.startOfDay(for: start) : start
    event.endDate = end
    event.location = location.isEmpty ? nil : location
    event.notes = notes
    if !existed && (event.alarms == nil || event.alarms!.isEmpty) && !allDay {
        event.addAlarm(EKAlarm(relativeOffset: -15 * 60))
    }

    do {
        try store.save(event, span: .thisEvent, commit: true)
    } catch {
        fail("写入日历“\(targetCal.title)”失败：\(error.localizedDescription)")
    }

    writeJSON([
        "externalItemId": event.eventIdentifier ?? "",
        "targetList": targetCal.title,
        "result": existed ? "已更新“\(targetCal.title)”日历" : "已写入“\(targetCal.title)”日历"
    ])
}

func runUpsertReminder(store: EKEventStore, input: [String: Any]) {
    let remStatus = EKEventStore.authorizationStatus(for: .reminder)
    guard remStatus == .fullAccess || remStatus == .writeOnly else {
        fail("没有提醒事项写入权限（status=\(authStatusLabel(remStatus))），请在 系统设置 → 隐私与安全性 → 提醒事项 中允许 WorkBuddy QQ Gateway")
    }
    guard let title = (input["title"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines),
          !title.isEmpty else {
        fail("待办事项缺少标题")
    }

    let listName = ((input["listName"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)).flatMap { $0.isEmpty ? nil : $0 } ?? "待办"
    let targetList: EKCalendar
    do {
        targetList = try findOrCreateCalendar(in: store, title: listName, entityType: .reminder)
    } catch {
        fail("无法获取或创建提醒事项列表“\(listName)”：\(error.localizedDescription)")
    }

    let marker = (input["marker"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    let sourceName = (input["sourceGroupName"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? "QQ 会话"
    let sourceId = (input["sourceGroupId"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    let provenance = marker.isEmpty
        ? "来源：\(sourceName)\(sourceId.isEmpty ? "" : " (\(sourceId))")"
        : "\(marker)\n来源群：\(sourceName)\(sourceId.isEmpty ? "" : " (\(sourceId))")"
    let notes = composeNotes(notes: (input["notes"] as? String) ?? "", provenance: provenance, marker: marker)

    var existingReminder: EKReminder?
    if remStatus == .fullAccess && !marker.isEmpty {
        let (items, _) = fetchRemindersSync(store: store, calendars: [targetList], timeoutSeconds: 8.0)
        if let matched = items.first(where: { $0.notes.contains(marker) }) {
            existingReminder = store.calendarItem(withIdentifier: matched.identifier) as? EKReminder
        }
    }

    let existed = existingReminder != nil
    let reminder = existingReminder ?? EKReminder(eventStore: store)
    reminder.title = title
    reminder.calendar = targetList
    reminder.notes = notes
    reminder.priority = 1

    if let dueDate = parseISO(input["due"]) {
        var components = Calendar.current.dateComponents([.year, .month, .day, .hour, .minute, .second, .timeZone], from: dueDate)
        components.timeZone = TimeZone.current
        reminder.dueDateComponents = components
        reminder.alarms = [EKAlarm(absoluteDate: dueDate)]
    }

    do {
        try store.save(reminder, commit: true)
    } catch {
        fail("写入待办“\(targetList.title)”失败：\(error.localizedDescription)")
    }

    writeJSON([
        "externalItemId": reminder.calendarItemIdentifier,
        "targetList": targetList.title,
        "result": existed ? "已更新“\(targetList.title)”待办列表" : "已写入“\(targetList.title)”待办列表"
    ])
}

// MARK: - Main

let input = readInputJSON()
let op = ((input["op"] as? String) ?? (input["type"] as? String) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
let store = EKEventStore()

switch op {
case "preflight":
    runPreflight(store: store)
case "context":
    runContext(store: store, input: input)
case "calendar":
    runUpsertCalendar(store: store, input: input)
case "reminder":
    runUpsertReminder(store: store, input: input)
default:
    fail("不支持的 EventKit 操作：\(op)")
}
