import AppKit
import SwiftUI

struct MenuBarStatusView: View {
    @Bindable var appState: AppState
    @Environment(\.openWindow) private var openWindow
    @Environment(\.openSettings) private var openSettings

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("WorkBuddy QQ Gateway")
                .font(.headline)
            Text("模式：\(appState.runtimePaths.modeLabel)")
                .font(.caption)
                .foregroundStyle(.secondary)

            Divider()

            Text("Hub :\(String(appState.runtimePaths.hubPort)) — \(appState.connectionStatus.label)")
            Text("QQ / OneBot — \(appState.isQQOneBotOnline ? (appState.qqLoginStatus?.login?.nickname ?? "在线") : "离线或未登录")")
            Text("WorkBuddy 引擎 — \(appState.maintenance?.engine?.engineReady == true ? "就绪" : "待机/未启动")")
            Text("Colima 虚拟机 — \(appState.colimaSnapshot?.containerRunning == true ? "运行中" : (appState.colimaSnapshot?.colimaRunning == true ? "虚拟机在线" : "已停止"))")
            if let lan = appState.maintenance?.lanPanel, lan.running {
                Text("局域网面板 — \(lan.urls.first?.url ?? ":\(String(lan.port))")")
            } else {
                Text("局域网面板 — 已关闭")
            }

            Divider()

            Toggle(
                "Agent 派发总开关",
                isOn: Binding(
                    get: { appState.gatewayState?.agentDispatch?.enabled ?? true },
                    set: { newValue in
                        Task { await appState.setAgentDispatch(newValue) }
                    }
                )
            )

            Divider()

            Button("打开 / 显示主窗口") {
                NSApp.activate(ignoringOtherApps: true)
                openWindow(id: "main")
            }

            Button("隐藏主窗口（菜单栏常驻）") {
                for window in NSApp.windows where window.title == "WorkBuddy QQ Gateway" {
                    window.close()
                }
            }

            Button(appState.qqLoginPromptMode != nil && !appState.isQQOneBotOnline ? "⚠️ QQ 待勾选自动登录 — 打开桌面 (noVNC)" : "打开 QQ 扫码桌面 (noVNC)") {
                NSApp.activate(ignoringOtherApps: true)
                openWindow(id: "main")
                appState.embeddedWebSheet = .noVNC
            }

            Button("打开设置…") {
                NSApp.activate(ignoringOtherApps: true)
                openSettings()
            }

            if let lan = appState.maintenance?.lanPanel, lan.running, let url = lan.urls.first?.url ?? lan.bonjourHost {
                Button("复制局域网面板网址") {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(url, forType: .string)
                }
            } else {
                Button("配置局域网广播面板…") {
                    appState.settingsRequestedTab = "lan"
                    NSApp.activate(ignoringOtherApps: true)
                    openSettings()
                }
            }

            Divider()

            Button("重启 Hub 网关") {
                Task {
                    try? await appState.supervisor.restartHub()
                    await appState.connectStreamsAndRefresh()
                }
            }

            Button("启动 / 重启 QQ 容器与虚拟机") {
                Task {
                    if appState.colimaSnapshot?.containerRunning == true {
                        try? await appState.supervisor.restartQQRuntime()
                    } else {
                        _ = try? await appState.supervisor.ensureQQRuntimeRunning()
                    }
                    appState.colimaSnapshot = await appState.supervisor.inspectColimaAndDocker()
                    await appState.refreshNow()
                    if appState.colimaSnapshot?.containerRunning == true {
                        appState.scheduleQQLoginCheckAfterStartup(graceSeconds: 22, autoOpenNoVNC: true)
                    }
                }
            }

            Divider()

            Toggle(
                "防休眠保持运行",
                isOn: Binding(
                    get: { appState.keepAwakeEnabled },
                    set: { appState.setKeepAwake($0) }
                )
            )

            Button("息屏但保持运行") {
                appState.powerManager.sleepDisplayKeepAwake(gatewayRoot: appState.runtimePaths.gatewayRoot)
                appState.keepAwakeEnabled = appState.powerManager.isKeepAwakeActive
            }

            Divider()

            Button("退出 WorkBuddy QQ Gateway") {
                Task { await appState.shutdownAllServicesAndQuit(stopQQRuntime: true) }
            }
        }
        .padding(8)
    }
}
