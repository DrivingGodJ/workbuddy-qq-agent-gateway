import AppKit
import Foundation
import SwiftUI

public enum MainWorkspaceSection: String, CaseIterable, Identifiable, Sendable {
    case conversations = "会话"
    case qzone = "动态"
    case stickers = "表情包"

    public var id: String { rawValue }

    public var symbolName: String {
        switch self {
        case .conversations: return "bubble.left.and.bubble.right"
        case .qzone: return "sparkles.rectangle.stack"
        case .stickers: return "face.smiling"
        }
    }
}

public enum SelectedTargetKey: Hashable, Sendable {
    case group(String)
    case privateChat(String)
    case source(String)

    public var targetType: String {
        switch self {
        case .group: return "group"
        case .privateChat: return "private"
        case .source: return "source"
        }
    }

    public var targetId: String {
        switch self {
        case .group(let id), .privateChat(let id), .source(let id):
            return id
        }
    }

    public var storageKey: String {
        "\(targetType):\(targetId)"
    }
}

public enum EmbeddedWebSheetKind: Identifiable, Sendable {
    case noVNC
    case snowlumaWebUI

    public var id: String {
        switch self {
        case .noVNC: return "novnc"
        case .snowlumaWebUI: return "snowluma-webui"
        }
    }

    public var title: String {
        switch self {
        case .noVNC: return "QQ 小号扫码桌面（noVNC 6081）"
        case .snowlumaWebUI: return "SnowLuma 高级管理（5099）"
        }
    }

    public var url: URL {
        switch self {
        case .noVNC: return URL(string: "http://127.0.0.1:6081/")!
        case .snowlumaWebUI: return URL(string: "http://127.0.0.1:5099/")!
        }
    }
}

public enum QQLoginPromptMode: Equatable, Sendable {
    case needsAutoLoginCheck
    case needsQRLogin
}

public enum OverallHealthLevel: Sendable {
    case allHealthy
    case degraded
    case offline

    public var color: Color {
        switch self {
        case .allHealthy: return .green
        case .degraded: return .orange
        case .offline: return .red
        }
    }

    public var symbolName: String {
        switch self {
        case .allHealthy: return "bubble.left.and.bubble.right.fill"
        case .degraded: return "exclamationmark.bubble.fill"
        case .offline: return "bolt.horizontal.circle.fill"
        }
    }

    public var summary: String {
        switch self {
        case .allHealthy: return "服务在线"
        case .degraded: return "部分组件恢复中"
        case .offline: return "网关离线"
        }
    }
}

@MainActor
@Observable
public final class AppState {
    // Public reactive state
    public var gatewayState: GatewayState?
    public var maintenance: MaintenanceState?
    public private(set) var qqLoginStatus: OneBotMaintenanceInfo?
    public var storageUsage: StorageUsageReport?
    public var connectionStatus: GatewayConnectionStatus = .connecting
    public var deploymentMode: DeploymentMode = .freshInstall
    public var runtimePaths: RuntimePaths
    public var capabilities: EnvironmentCapabilities?
    public var colimaSnapshot: ColimaDockerSnapshot?
    public var launchAgentStatus: LaunchAgentStatus?
    public var appLoginAgentInstalled: Bool = false
    public var permissionSummary = SystemPermissionSummary(calendar: .notDetermined, reminders: .notDetermined, notifications: .notDetermined)
    public var keepAwakeEnabled: Bool = false
    public let autoStartServicesOnLaunch: Bool = true
    public let stopAllServicesOnQuit: Bool = true
    public var isShuttingDown: Bool = false
    public var skipServiceShutdownOnNextQuit: Bool = false
    public var hasPerformedShutdown: Bool = false
    public var openMainWindowAction: (() -> Void)?

    // UI navigation state
    public var activeSection: MainWorkspaceSection = .conversations
    public var selectedTarget: SelectedTargetKey?
    public var inspectorPresented: Bool = true
    public var searchQuery: String = ""
    public var embeddedWebSheet: EmbeddedWebSheetKind?
    public var settingsRequestedTab: String?
    public var pendingDeleteTarget: ConversationTarget?
    public var pendingResetTarget: ConversationTarget?

    // Banners & notices
    public var statusBanner: String?
    public var errorBanner: String?
    public var shouldPromptOnboarding: Bool = false
    public var qqLoginPromptMode: QQLoginPromptMode?
    public var qqLoginPromptDismissed: Bool = false
    public var isWaitingForQQAutoLogin: Bool = false
    public private(set) var isCheckingForUpdates = false
    public private(set) var updateCheckMessage: String?

    // Core dependencies
    public let keychain = KeychainStore()
    public let apiClient = GatewayAPIClient()
    public let eventStream = GatewayEventStream()
    public let detector = DeploymentDetector()
    public let supervisor: RuntimeSupervisor
    public let launchAgents = LaunchAgentManager()
    public let permissions = PermissionManager()
    public let powerManager = PowerManager()
    public let logsManager = LogDiagnosticsManager()
    public let authHelper = CodeBuddyAuthHelper()
    public let personaPortability = PersonaPortabilityService()
    public let onboarding: OnboardingOrchestrator

    private var maintenanceTimerTask: Task<Void, Never>?
    private var qqStatusPollingTask: Task<Void, Never>?
    private var qqLoginMonitorTask: Task<Void, Never>?
    private var streamedStateRevision: UInt64 = 0
    private var started = false

    public init() {
        let supervisor = RuntimeSupervisor(
            detector: detector,
            launchAgents: launchAgents,
            keychain: keychain
        )
        self.supervisor = supervisor
        self.runtimePaths = RuntimeSupervisor.defaultStandalonePaths()
        self.onboarding = OnboardingOrchestrator(
            detector: detector,
            keychain: keychain,
            authHelper: authHelper,
            launchAgents: launchAgents,
            permissions: permissions,
            personaPortability: personaPortability
        )
    }

    public var agentName: String {
        gatewayState?.persona?.name ?? "小伴"
    }

    public var isQQOneBotOnline: Bool {
        qqLoginStatus?.isOnline == true
    }

    public var homeAssistantReadiness: HomeAssistantReadiness? {
        guard case .connected = connectionStatus else { return nil }
        return maintenance?.homeAssistant
    }

    public var overallHealth: OverallHealthLevel {
        guard case .connected = connectionStatus else {
            return .offline
        }
        let oneBotOK = isQQOneBotOnline
        let engineOK = (maintenance?.engine?.engineReady ?? true)
        if oneBotOK && engineOK {
            return .allHealthy
        }
        return .degraded
    }

    public var sortedGroups: [ConversationTarget] {
        let all = Array((gatewayState?.qq?.groups ?? [:]).values)
        return filterAndSort(all)
    }

    public var sortedPrivateChats: [ConversationTarget] {
        let all = Array((gatewayState?.qq?.privateChats ?? [:]).values)
        return filterAndSort(all)
    }

    public var sortedSourceGroups: [SourceGroupState] {
        let all = Array((gatewayState?.qq?.sourceGroups ?? [:]).values)
        let q = searchQuery.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return all.filter { source in
            if q.isEmpty { return true }
            return source.groupId.lowercased().contains(q)
                || (source.groupName?.lowercased().contains(q) ?? false)
        }.sorted {
            ($0.groupName ?? $0.groupId) < ($1.groupName ?? $1.groupId)
        }
    }

    public var currentConversation: ConversationTarget? {
        guard let selectedTarget else { return nil }
        switch selectedTarget {
        case .group(let id):
            return gatewayState?.qq?.groups?[id]
        case .privateChat(let id):
            return gatewayState?.qq?.privateChats?[id]
        case .source:
            return nil
        }
    }

    public var currentSourceGroup: SourceGroupState? {
        guard case .source(let id) = selectedTarget else { return nil }
        return gatewayState?.qq?.sourceGroups?[id]
    }

    public func bootstrapOnLaunch() async {
        guard !started else { return }
        started = true
        Task { [weak self] in await self?.checkForAppUpdates() }

        deploymentMode = await detector.detect(probeContainers: true)
        runtimePaths = await supervisor.configure(from: deploymentMode)
        capabilities = await detector.probeCapabilities()
        launchAgentStatus = await launchAgents.status()
        appLoginAgentInstalled = launchAgents.isAppLoginAgentInstalled()
        permissionSummary = await permissions.currentSummary()
        colimaSnapshot = await supervisor.inspectColimaAndDocker()

        let baseURL = URL(string: "http://127.0.0.1:\(runtimePaths.hubPort)")!
        let token = keychain.read(account: .hubApiToken) ?? ""
        await apiClient.configure(baseURL: baseURL, token: token)
        startQQStatusPolling()

        let health = await supervisor.checkHubHealth()
        if health?.ok == true {
            await connectStreamsAndRefresh()
            shouldPromptOnboarding = false
        } else if case .existingTakeover(let existing) = deploymentMode,
                  existing.envFileURL != nil || existing.hasHubLaunchAgent {
            shouldPromptOnboarding = false
            if autoStartServicesOnLaunch {
                statusBanner = "正在启动本地网关服务…"
                do {
                    try await supervisor.startHub()
                    statusBanner = nil
                } catch {
                    errorBanner = "自动启动 Hub 失败：\(error.localizedDescription)"
                }
            }
            await connectStreamsAndRefresh()
        } else {
            shouldPromptOnboarding = true
        }

        if autoStartServicesOnLaunch,
           case .existingTakeover(let existing) = deploymentMode,
           (existing.envFileURL != nil || existing.hasHubLaunchAgent),
           (existing.hasColimaSnowlumaProfile || existing.hasSnowlumaContainer),
           colimaSnapshot?.containerRunning != true {
            Task { [weak self] in
                guard let self else { return }
                self.statusBanner = "正在后台唤醒 Colima 虚拟机与 QQ 容器…"
                do {
                    _ = try await self.supervisor.ensureQQRuntimeRunning()
                    self.colimaSnapshot = await self.supervisor.inspectColimaAndDocker()
                    await self.refreshNow()
                    if self.colimaSnapshot?.containerRunning == true && !self.isQQOneBotOnline {
                        self.statusBanner = "QQ 容器已启动，正在检测 QQ 是否自动登录…"
                        self.scheduleQQLoginCheckAfterStartup(graceSeconds: 22, autoOpenNoVNC: true)
                    } else if self.statusBanner?.contains("Colima") == true {
                        self.statusBanner = nil
                    }
                } catch {
                    self.errorBanner = "自动启动 QQ 容器失败：\(error.localizedDescription)"
                }
            }
        } else if !shouldPromptOnboarding,
                  colimaSnapshot?.containerRunning == true,
                  !isQQOneBotOnline {
            statusBanner = "正在检测 QQ 自动登录状态…"
            scheduleQQLoginCheckAfterStartup(graceSeconds: 15, autoOpenNoVNC: true)
        }

        Task { [weak self] in
            await self?.refreshStorageUsage()
        }

        startMaintenancePolling()
    }

    public func checkForAppUpdates(manual: Bool = false) async {
        guard !isCheckingForUpdates else { return }
        isCheckingForUpdates = true
        if manual { updateCheckMessage = nil }
        defer { isCheckingForUpdates = false }

        do {
            let result = try await GitHubReleaseChecker.check()
            guard !Task.isCancelled, !isShuttingDown else { return }
            switch result {
            case .noRelease:
                if manual { updateCheckMessage = "GitHub 暂无正式发布版本。" }
            case .upToDate:
                if manual { updateCheckMessage = "当前已是最新版本。" }
            case .available(let release):
                let alert = NSAlert()
                alert.messageText = "发现新版本 \(release.version)"
                alert.informativeText = "当前版本为 \(GitHubReleaseChecker.installedVersion)。你可以前往 GitHub 查看发布说明并下载安装包。"
                alert.alertStyle = .informational
                alert.addButton(withTitle: "前往下载")
                alert.addButton(withTitle: "稍后")
                NSApp.activate(ignoringOtherApps: true)
                if alert.runModal() == .alertFirstButtonReturn {
                    NSWorkspace.shared.open(release.pageURL)
                }
            }
        } catch {
            if manual, !Task.isCancelled { updateCheckMessage = "暂时无法检查更新，请稍后再试。" }
        }
    }

    public func reconnectAfterOnboarding() async {
        deploymentMode = await detector.detect(probeContainers: true)
        runtimePaths = await supervisor.configure(from: deploymentMode)
        appLoginAgentInstalled = launchAgents.isAppLoginAgentInstalled()
        launchAgentStatus = await launchAgents.status()
        let baseURL = URL(string: "http://127.0.0.1:\(runtimePaths.hubPort)")!
        let token = keychain.read(account: .hubApiToken) ?? ""
        await apiClient.configure(baseURL: baseURL, token: token)
        await connectStreamsAndRefresh()
        await refreshStorageUsage()
    }

    public func connectStreamsAndRefresh() async {
        let baseURL = URL(string: "http://127.0.0.1:\(runtimePaths.hubPort)")!
        let token = keychain.read(account: .hubApiToken) ?? ""
        await apiClient.configure(baseURL: baseURL, token: token)

        await eventStream.start(
            baseURL: baseURL,
            token: token,
            onStatus: { [weak self] status in
                Task { @MainActor [weak self] in
                    self?.connectionStatus = status
                }
            },
            onPayload: { [weak self] payload in
                Task { @MainActor [weak self] in
                    self?.handleStreamPayload(payload)
                }
            }
        )
        await refreshNow()
    }

    public func refreshNow(forceMetadata: Bool = false) async {
        let revision = streamedStateRevision
        do {
            async let stateTask = apiClient.fetchState(refreshMetadata: forceMetadata)
            async let maintTask = apiClient.fetchMaintenance()
            let (newState, newMaint) = try await (stateTask, maintTask)
            if streamedStateRevision == revision {
                applyState(newState)
            }
            maintenance = newMaint
            errorBanner = nil
        } catch {
            maintenance?.homeAssistant = nil
            // Keep UI readable if Hub is offline; SSE status shows offline/reconnecting
            if case .offline = connectionStatus {
                errorBanner = error.localizedDescription
            }
        }
        launchAgentStatus = await launchAgents.status()
        colimaSnapshot = await supervisor.inspectColimaAndDocker()
        await refreshPermissions()
    }

    public func refreshPermissions() async {
        permissionSummary = await permissions.currentSummary()
    }

    public func scheduleQQLoginCheckAfterStartup(graceSeconds: Int = 22, autoOpenNoVNC: Bool = true) {
        qqLoginMonitorTask?.cancel()
        if isQQOneBotOnline {
            clearQQLoginPrompt()
            return
        }

        qqLoginMonitorTask = Task { [weak self] in
            guard let self else { return }
            self.isWaitingForQQAutoLogin = true
            do {
                try await Task.sleep(for: .seconds(graceSeconds))
            } catch {
                return
            }
            defer { self.isWaitingForQQAutoLogin = false }

            if Task.isCancelled || self.shouldPromptOnboarding || self.isQQOneBotOnline {
                return
            }

            let probe = await self.supervisor.inspectQQSavedLoginState()
            guard probe.containerRunning else {
                if self.statusBanner?.contains("自动登录") == true {
                    self.statusBanner = nil
                }
                return
            }

            guard !Task.isCancelled, !self.isQQOneBotOnline else { return }

            self.qqLoginPromptMode = probe.hasSavedLoginProfile ? .needsAutoLoginCheck : .needsQRLogin
            self.qqLoginPromptDismissed = false
            if self.statusBanner?.contains("自动登录") == true {
                self.statusBanner = nil
            }
            if autoOpenNoVNC && self.embeddedWebSheet == nil {
                self.embeddedWebSheet = .noVNC
            }
        }
    }

    public func checkQQLoginStateNow() async {
        await refreshQQLoginStatus()
        if isQQOneBotOnline {
            let nickname = qqLoginStatus?.login?.nickname ?? "在线"
            statusBanner = "QQ 小号已上线（\(nickname)）。"
            return
        }
        let probe = await supervisor.inspectQQSavedLoginState()
        guard probe.containerRunning, !isQQOneBotOnline else { return }
        qqLoginPromptMode = probe.hasSavedLoginProfile ? .needsAutoLoginCheck : .needsQRLogin
        qqLoginPromptDismissed = false
    }

    private func syncQQLoginPrompt() {
        if isQQOneBotOnline {
            clearQQLoginPrompt()
            if statusBanner?.contains("自动登录") == true || statusBanner?.contains("正在后台唤醒 Colima") == true {
                statusBanner = nil
            }
        }
    }

    private func clearQQLoginPrompt() {
        qqLoginPromptMode = nil
        qqLoginPromptDismissed = false
        isWaitingForQQAutoLogin = false
    }

    public func setAgentDispatch(_ enabled: Bool) async {
        do {
            let updated = try await apiClient.setAgentDispatch(enabled: enabled)
            gatewayState?.agentDispatch = updated
            await refreshNow()
        } catch {
            errorBanner = error.localizedDescription
        }
    }

    public func sendOwnerMessage(text: String) async {
        guard let target = currentConversation else { return }
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        do {
            try await apiClient.sendAgentMessage(targetType: target.targetType, targetId: target.targetId, text: trimmed)
            await refreshNow()
        } catch {
            errorBanner = error.localizedDescription
        }
    }

    public func cancelCurrentTurn() async {
        guard let target = currentConversation else { return }
        do {
            try await apiClient.cancelAgent(targetType: target.targetType, targetId: target.targetId)
            await refreshNow()
        } catch {
            errorBanner = error.localizedDescription
        }
    }

    public func isTargetBusy(_ target: ConversationTarget) -> Bool {
        target.busy == true
            || target.activeReply?.running == true
            || target.qzoneActivity != nil
            || target.contextQueue?.active != nil
            || !(target.contextQueue?.queued?.isEmpty ?? true)
    }

    public func toggleReplyEnabled(_ enabled: Bool, target explicitTarget: ConversationTarget? = nil) async {
        guard let target = explicitTarget ?? currentConversation else { return }
        do {
            try await apiClient.setReplyEnabled(targetType: target.targetType, targetId: target.targetId, enabled: enabled)
            await refreshNow()
        } catch {
            errorBanner = error.localizedDescription
        }
    }

    public func deleteConversation(_ target: ConversationTarget) async throws {
        try await apiClient.deleteTarget(
            targetType: target.targetType,
            targetId: target.targetId,
            confirmTargetId: target.targetId
        )
        if selectedTarget?.targetType == target.targetType && selectedTarget?.targetId == target.targetId {
            selectedTarget = nil
        }
        statusBanner = "已删除会话「\(target.resolvedTitle)」，并清理工作目录与聊天记录。"
        errorBanner = nil
        await refreshNow()
    }

    public func resetConversation(_ target: ConversationTarget) async throws {
        try await apiClient.performTargetAction(
            targetType: target.targetType,
            targetId: target.targetId,
            action: "reset"
        )
        statusBanner = "已提交新建会话指令，正在清理「\(target.resolvedTitle)」的旧工作目录与聊天记录…"
        errorBanner = nil
        await refreshNow()
    }

    // MARK: - Persona Portability (Export / Import / Reset)

    public func exportPersonaToPanel() async {
        let panel = NSSavePanel()
        panel.title = "导出人格配置文件"
        panel.message = "将完整人格（核心规则、情境示例、昵称与口头禅）保存为可跨版本导入的文件"
        let stamp = Self.dateStamp()
        let safeName = agentName.replacingOccurrences(of: "/", with: "_")
        panel.nameFieldStringValue = "\(safeName)-persona-\(stamp).laodai-persona.json"
        panel.allowedContentTypes = [.json]

        guard panel.runModal() == .OK, let destination = panel.url else { return }

        do {
            let bundle: PersonaBundle
            do {
                bundle = try await apiClient.exportPersona()
            } catch let err as GatewayAPIError where err.statusCode == 404 || err.statusCode == nil {
                // Fallback for legacy production Hub that doesn't have /api/qq/persona/export yet
                bundle = try personaPortability.assembleReadOnlyBundle(
                    fromDirectory: runtimePaths.gatewayRoot,
                    dataDirectory: runtimePaths.dataDir
                )
            }
            try personaPortability.writeBundle(bundle, to: destination)
            statusBanner = "已导出人格「\(bundle.effectiveName)」（\(bundle.examples.examples.count) 条情境示例）到 \(destination.lastPathComponent)"
            errorBanner = nil
        } catch {
            errorBanner = "导出人格失败：\(error.localizedDescription)"
        }
    }

    public func pickPersonaBundleForImport() -> (url: URL, bundle: PersonaBundle)? {
        let panel = NSOpenPanel()
        panel.title = "选择要导入的人格文件或人格目录"
        panel.message = "支持人格备份文件（.json / .laodai-persona.json），或包含 core.json 与 examples.json 的目录"
        panel.canChooseFiles = true
        panel.canChooseDirectories = true
        panel.allowsMultipleSelection = false

        guard panel.runModal() == .OK, let url = panel.url else { return nil }
        do {
            let bundle = try personaPortability.loadBundle(from: url)
            return (url, bundle)
        } catch {
            errorBanner = error.localizedDescription
            return nil
        }
    }

    public func importPersonaBundle(_ bundle: PersonaBundle) async -> Bool {
        do {
            do {
                let res = try await apiClient.importPersona(bundle)
                gatewayState?.persona = res.persona
                statusBanner = "已导入人格「\(res.name ?? bundle.effectiveName)」（\(res.exampleCount ?? bundle.examples.examples.count) 条示例），下一轮回复生效。"
            } catch let err as GatewayAPIError where err.statusCode == nil {
                // Hub is offline; write directly to local data directory
                try personaPortability.writeBundleOffline(bundle, intoDataDirectory: runtimePaths.dataDir)
                statusBanner = "Hub 当前未运行，已将人格「\(bundle.effectiveName)」写入数据目录，下次启动生效。"
            }
            errorBanner = nil
            await refreshNow()
            return true
        } catch {
            errorBanner = "导入人格失败：\(error.localizedDescription)"
            return false
        }
    }

    public func resetImportedPersona() async {
        do {
            let res = try await apiClient.resetImportedPersona()
            gatewayState?.persona = res.persona
            statusBanner = "已移除自定义导入，恢复基础默认人格。"
            errorBanner = nil
            await refreshNow()
        } catch {
            errorBanner = "恢复默认人格失败：\(error.localizedDescription)"
        }
    }

    public func setKeepAwake(_ enabled: Bool) {
        powerManager.setKeepAwake(enabled)
        keepAwakeEnabled = powerManager.isKeepAwakeActive
    }

    public func refreshStorageUsage() async {
        if let report = try? await apiClient.fetchStorageUsage() {
            storageUsage = report
        }
    }

    public func runStorageCleanup() async throws -> StorageCleanupResult {
        let result = try await apiClient.cleanupStorage()
        if let updated = result.storage {
            storageUsage = updated
        } else {
            await refreshStorageUsage()
        }
        return result
    }

    public func performFullShutdown(stopQQRuntime: Bool) async {
        guard !hasPerformedShutdown else { return }
        hasPerformedShutdown = true
        isShuttingDown = true
        maintenanceTimerTask?.cancel()
        qqStatusPollingTask?.cancel()
        qqLoginMonitorTask?.cancel()
        powerManager.stopKeepAwake()
        await eventStream.stop()
        await supervisor.stopAllServices(stopQQRuntime: stopQQRuntime)
    }

    public func shutdownAllServicesAndQuit(stopQQRuntime: Bool = true) async {
        if stopQQRuntime {
            statusBanner = "正在停止网关、QQ 容器与 Colima 虚拟机…"
            await performFullShutdown(stopQQRuntime: true)
        } else {
            skipServiceShutdownOnNextQuit = true
            powerManager.stopKeepAwake()
            await eventStream.stop()
        }
        NSApp.terminate(nil)
    }

    private func startMaintenancePolling() {
        maintenanceTimerTask?.cancel()
        maintenanceTimerTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 15_000_000_000)
                if Task.isCancelled { break }
                guard let self else { break }
                if let maint = try? await self.apiClient.fetchMaintenance() {
                    self.maintenance = maint
                } else {
                    self.maintenance?.homeAssistant = nil
                }
                self.colimaSnapshot = await self.supervisor.inspectColimaAndDocker()
                self.launchAgentStatus = await self.launchAgents.status()
            }
        }
    }

    private func startQQStatusPolling() {
        qqStatusPollingTask?.cancel()
        qqStatusPollingTask = Task { [weak self] in
            while !Task.isCancelled, let self {
                await self.refreshQQLoginStatus()
                try? await Task.sleep(for: .seconds(self.isQQOneBotOnline ? 10 : 2))
            }
        }
    }

    private func refreshQQLoginStatus() async {
        var status = try? await apiClient.fetchQQLoginStatus()
        if status == nil, case .freshInstall = deploymentMode, onboarding.currentStep == .qqScanAndOneBot {
            status = await onboarding.probeLocalQQLogin()
        }
        guard !Task.isCancelled else { return }
        qqLoginStatus = status
        syncQQLoginPrompt()
    }

    private func handleStreamPayload(_ payload: GatewayStreamPayload) {
        switch payload {
        case .snapshot(let state):
            streamedStateRevision &+= 1
            applyState(state)
        case .targetUpdate(let targets, let activeTargets, let activeGroups):
            guard var current = gatewayState else { return }
            streamedStateRevision &+= 1
            var qq = current.qq ?? QQStatePayload()
            var groups = qq.groups ?? [:]
            var privates = qq.privateChats ?? [:]
            for (key, target) in targets {
                if key.hasPrefix("private:") {
                    privates[target.targetId] = target
                } else {
                    groups[target.targetId] = target
                }
            }
            qq.groups = groups
            qq.privateChats = privates
            if let activeTargets { qq.activeTargets = activeTargets }
            if let activeGroups { qq.activeGroups = activeGroups }
            current.qq = qq
            gatewayState = current
        case .event(_, let state), .stateRefresh(_, let state):
            streamedStateRevision &+= 1
            applyState(state)
        }
    }

    private func applyState(_ state: GatewayState) {
        gatewayState = state
        if selectedTarget == nil {
            if let firstGroup = sortedGroups.first {
                selectedTarget = .group(firstGroup.targetId)
            } else if let firstPrivate = sortedPrivateChats.first {
                selectedTarget = .privateChat(firstPrivate.targetId)
            } else if let firstSource = sortedSourceGroups.first {
                selectedTarget = .source(firstSource.groupId)
            }
        }
    }

    private func filterAndSort(_ items: [ConversationTarget]) -> [ConversationTarget] {
        let q = searchQuery.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let filtered = items.filter { item in
            if q.isEmpty { return true }
            return item.targetId.lowercased().contains(q)
                || item.resolvedTitle.lowercased().contains(q)
        }
        return filtered.sorted { lhs, rhs in
            let lTime = lhs.lastActivityAt ?? ""
            let rTime = rhs.lastActivityAt ?? ""
            if lTime != rTime { return lTime > rTime }
            return lhs.resolvedTitle < rhs.resolvedTitle
        }
    }

    private static func dateStamp() -> String {
        let fmt = DateFormatter()
        fmt.dateFormat = "yyyyMMdd"
        return fmt.string(from: Date())
    }
}
