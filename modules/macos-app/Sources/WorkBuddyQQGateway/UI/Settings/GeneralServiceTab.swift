import AppKit
import SwiftUI

struct GeneralServiceTab: View {
    @Bindable var appState: AppState
    @Environment(\.openWindow) private var openWindow
    @State private var isWorking = false
    @State private var showLegacyLaunchd = false
    @State private var message: String?
    @State private var errorMessage: String?

    var body: some View {
        Form {
            Section("启动与常驻") {
                Toggle("开机登录自动打开 WorkBuddy QQ Gateway", isOn: Binding(
                    get: { appState.appLoginAgentInstalled },
                    set: { enabled in
                        Task { await toggleAppLoginLaunch(enabled) }
                    }
                ))
                .disabled(isWorking)

                Toggle("防休眠保持运行（caffeinate）", isOn: Binding(
                    get: { appState.keepAwakeEnabled },
                    set: { appState.setKeepAwake($0) }
                ))

                Text("打开应用时会自动拉起全部服务；关闭主窗口后程序常驻右上角菜单栏，点击程序坞或菜单栏图标可随时重新打开；完全退出应用（⌘Q）时自动停止全部后台服务。")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            Section("软件更新") {
                LabeledContent("当前版本") {
                    HStack(spacing: 10) {
                        Text(GitHubReleaseChecker.installedVersion)
                            .monospacedDigit()
                        Button(appState.isCheckingForUpdates ? "正在检查…" : "检查更新") {
                            Task { await appState.checkForAppUpdates(manual: true) }
                        }
                        .disabled(appState.isCheckingForUpdates)
                    }
                }
                if let message = appState.updateCheckMessage {
                    Text(message).font(.caption).foregroundStyle(.secondary)
                }
            }

            Section("运行状态与一键控制") {
                LabeledContent("Hub 网关 (:\(String(appState.runtimePaths.hubPort)))") {
                    HStack(spacing: 8) {
                        StatusPill(
                            text: appState.connectionStatus.label,
                            color: appState.connectionStatus == .connected ? .green : .orange
                        )
                        Button("启动") {
                            Task { await runServiceAction { try await appState.supervisor.startHub(); await appState.connectStreamsAndRefresh() } }
                        }
                        .controlSize(.small)
                        Button("重启") {
                            Task { await runServiceAction { try await appState.supervisor.restartHub(); await appState.connectStreamsAndRefresh() } }
                        }
                        .controlSize(.small)
                        Button("停止", role: .destructive) {
                            Task { await runServiceAction { try await appState.supervisor.stopHub(); await appState.refreshNow() } }
                        }
                        .controlSize(.small)
                    }
                    .disabled(isWorking)
                }

                LabeledContent("Colima 虚拟机 & SnowLuma") {
                    VStack(alignment: .trailing, spacing: 6) {
                        HStack(spacing: 8) {
                            let snap = appState.colimaSnapshot
                            StatusPill(
                                text: snap?.statusMessage ?? "未检测",
                                color: snap?.containerRunning == true ? .green : (snap?.colimaRunning == true ? .orange : .secondary)
                            )
                            Button("启动/恢复") {
                                Task {
                                    await runServiceAction {
                                        let msg = try await appState.supervisor.ensureQQRuntimeRunning()
                                        appState.colimaSnapshot = await appState.supervisor.inspectColimaAndDocker()
                                        await appState.refreshNow()
                                        if appState.colimaSnapshot?.containerRunning == true {
                                            appState.scheduleQQLoginCheckAfterStartup(graceSeconds: 22, autoOpenNoVNC: false)
                                        }
                                        message = msg
                                    }
                                }
                            }
                            .controlSize(.small)
                            Button("重启容器") {
                                Task {
                                    await runServiceAction {
                                        try await appState.supervisor.restartQQRuntime()
                                        appState.colimaSnapshot = await appState.supervisor.inspectColimaAndDocker()
                                        await appState.refreshNow()
                                        if appState.colimaSnapshot?.containerRunning == true {
                                            appState.scheduleQQLoginCheckAfterStartup(graceSeconds: 22, autoOpenNoVNC: false)
                                        }
                                    }
                                }
                            }
                            .controlSize(.small)
                            Button("停止容器与虚拟机", role: .destructive) {
                                Task {
                                    await runServiceAction {
                                        await appState.supervisor.stopQQRuntime()
                                        appState.colimaSnapshot = await appState.supervisor.inspectColimaAndDocker()
                                        await appState.refreshNow()
                                    }
                                }
                            }
                            .controlSize(.small)
                        }
                        .disabled(isWorking)

                        HStack {
                            Text("Profile: \(appState.runtimePaths.colimaProfile) · Container: \(appState.runtimePaths.snowlumaContainer)")
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                            Button("修复 Colima 残留锁") {
                                Task { await repairColima() }
                            }
                            .controlSize(.mini)
                            .disabled(isWorking)
                        }
                    }
                }
            }

            Section("运行模式与路径") {
                LabeledContent("运行模式") {
                    StatusPill(
                        text: appState.runtimePaths.modeLabel,
                        color: appState.runtimePaths.isTakeover ? .green : .blue
                    )
                }
                LabeledContent("网关代码目录") {
                    HStack {
                        Text(appState.runtimePaths.gatewayRoot.path)
                            .font(.caption.monospaced())
                            .lineLimit(1)
                            .truncationMode(.middle)
                        Button("在 Finder 中打开") {
                            NSWorkspace.shared.activateFileViewerSelecting([appState.runtimePaths.gatewayRoot])
                        }
                        .controlSize(.small)
                    }
                }
                LabeledContent("数据目录") {
                    HStack {
                        Text(appState.runtimePaths.dataDir.path)
                            .font(.caption.monospaced())
                            .lineLimit(1)
                            .truncationMode(.middle)
                        Button("打开") {
                            NSWorkspace.shared.activateFileViewerSelecting([appState.runtimePaths.dataDir])
                        }
                        .controlSize(.small)
                    }
                }
                LabeledContent("Hub 监听地址") {
                    Text("http://127.0.0.1:\(String(appState.runtimePaths.hubPort))")
                        .font(.caption.monospaced())
                }
            }

            Section("安装与引导") {
                HStack {
                    Text("如需重新体检环境、调整账号或初始化新机器配置，可随时打开安装向导。")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                    Spacer()
                    Button("重新打开安装向导") {
                        openWindow(id: "onboarding")
                    }
                }

                DisclosureGroup("高级：传统 launchd 无界面常驻服务", isExpanded: $showLegacyLaunchd) {
                    VStack(alignment: .leading, spacing: 8) {
                        Toggle("保留独立后台 LaunchAgents（退出 App 后仍在后台保活）", isOn: Binding(
                            get: { appState.launchAgentStatus?.hubPlistExists == true },
                            set: { enabled in
                                Task { await toggleLaunchAgents(enabled) }
                            }
                        ))
                        .disabled(isWorking)
                        Text("仅用于兼容旧版无界面常驻模式；默认请保持关闭。")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    .padding(.top, 4)
                }
            }

            if let message {
                InfoBannerView(message: message)
            }
            if let errorMessage {
                ErrorBannerView(message: errorMessage)
            }
        }
        .formStyle(.grouped)
    }

    private func runServiceAction(_ operation: @escaping () async throws -> Void) async {
        isWorking = true
        message = nil
        errorMessage = nil
        defer { isWorking = false }
        do {
            try await operation()
            if message == nil {
                message = "操作已完成。"
            }
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func repairColima() async {
        isWorking = true
        message = nil
        errorMessage = nil
        defer { isWorking = false }
        do {
            message = try await appState.supervisor.repairColimaStaleState()
            appState.colimaSnapshot = await appState.supervisor.inspectColimaAndDocker()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func toggleAppLoginLaunch(_ enable: Bool) async {
        isWorking = true
        message = nil
        errorMessage = nil
        defer { isWorking = false }
        do {
            if enable {
                try await appState.launchAgents.installAppLoginAgent()
                if !appState.runtimePaths.isTakeover {
                    await appState.launchAgents.removePlist(
                        label: DeploymentDetector.hubPlistLabel,
                        plistURL: appState.launchAgents.hubPlistURL
                    )
                    await appState.launchAgents.removePlist(
                        label: DeploymentDetector.qqRuntimePlistLabel,
                        plistURL: appState.launchAgents.qqRuntimePlistURL
                    )
                }
                message = "已开启登录 macOS 后自动打开本应用。"
            } else {
                await appState.launchAgents.removeAppLoginAgent()
                message = "已关闭开机自动打开本应用。"
            }
            appState.appLoginAgentInstalled = appState.launchAgents.isAppLoginAgentInstalled()
            appState.launchAgentStatus = await appState.launchAgents.status()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func toggleLaunchAgents(_ enable: Bool) async {
        isWorking = true
        message = nil
        errorMessage = nil
        defer { isWorking = false }
        do {
            if enable {
                let paths = appState.runtimePaths
                if paths.isTakeover {
                    try await appState.launchAgents.installFromProject(projectDirectory: paths.gatewayRoot)
                    try await appState.launchAgents.bootstrap(label: DeploymentDetector.hubPlistLabel, plistURL: appState.launchAgents.hubPlistURL)
                    try await appState.launchAgents.bootstrap(label: DeploymentDetector.qqRuntimePlistLabel, plistURL: appState.launchAgents.qqRuntimePlistURL)
                } else if let node = appState.capabilities?.nodePath {
                    let caps = appState.capabilities
                    try await appState.launchAgents.installStandaloneAgents(
                        runnerExecutable: node,
                        projectDirectory: paths.gatewayRoot,
                        runtimeDirectory: paths.runtimeDir,
                        dataDirectory: paths.dataDir,
                        envFileURL: paths.envFileURL,
                        pythonExecutable: caps?.pythonVenvPath ?? caps?.pythonPath,
                        codebuddyCLIPath: caps?.codebuddyPath,
                        colimaExecutable: caps?.colimaPath,
                        dockerExecutable: caps?.dockerPath
                    )
                    try await appState.launchAgents.bootstrap(label: DeploymentDetector.hubPlistLabel, plistURL: appState.launchAgents.hubPlistURL)
                    try await appState.launchAgents.bootstrap(label: DeploymentDetector.qqRuntimePlistLabel, plistURL: appState.launchAgents.qqRuntimePlistURL)
                } else {
                    throw NSError(domain: "GeneralServiceTab", code: 1, userInfo: [
                        NSLocalizedDescriptionKey: "未找到 Node.js 可执行文件，无法生成 LaunchAgent。"
                    ])
                }
                message = "已开启传统 launchd 后台保活服务。"
            } else {
                await appState.launchAgents.removePlist(label: DeploymentDetector.hubPlistLabel, plistURL: appState.launchAgents.hubPlistURL)
                await appState.launchAgents.removePlist(label: DeploymentDetector.qqRuntimePlistLabel, plistURL: appState.launchAgents.qqRuntimePlistURL)
                message = "已移除传统 launchd 后台配置。"
            }
            appState.launchAgentStatus = await appState.launchAgents.status()
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}
