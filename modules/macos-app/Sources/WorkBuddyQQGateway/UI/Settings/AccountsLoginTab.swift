import AppKit
import SwiftUI

struct AccountsLoginTab: View {
    @Bindable var appState: AppState
    @State private var cliPath: String = "未检测到"
    @State private var cliVersion: String = "—"
    @State private var cliLoggedIn: Bool = false
    @State private var cliModelCount: Int = 0
    @State private var selectedSite: CodeBuddyLoginSite = .chinese
    @State private var activeTask: String?
    @State private var stageStatus: String?
    @State private var capturedURL: URL?
    @State private var authLog: String = ""
    @State private var statusMessage: String?
    @State private var errorMessage: String?
    @State private var localWebSheet: EmbeddedWebSheetKind?

    var body: some View {
        Form {
            Section("WorkBuddy / CodeBuddy 账号") {
                LabeledContent("CLI 路径") {
                    Text(appState.maintenance?.engine?.cliPath ?? cliPath)
                        .font(.caption.monospaced())
                }
                LabeledContent("CLI / SDK 版本") {
                    Text("\(cliVersion) · SDK \(appState.maintenance?.engine?.sdkVersion ?? "—")")
                        .font(.caption)
                }
                LabeledContent("账号登录态") {
                    let logged = appState.maintenance?.engine?.account?.loggedIn ?? cliLoggedIn
                    let models = appState.maintenance?.engine?.account?.modelCount ?? cliModelCount
                    StatusPill(
                        text: logged ? (models > 0 ? "已登录（\(models) 个模型）" : "已登录") : "未登录或待探测",
                        color: logged ? .green : .orange
                    )
                }

                Picker("账号区域", selection: $selectedSite) {
                    ForEach(CodeBuddyLoginSite.allCases) { site in
                        Text(site.rawValue).tag(site)
                    }
                }
                .disabled(activeTask != nil)

                HStack(spacing: 10) {
                    if activeTask == "login" {
                        ProgressView().controlSize(.small)
                        Text(stageStatus ?? "正在登录…")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        Spacer()
                        Button("取消登录", role: .destructive) {
                            appState.authHelper.cancelActiveLogin()
                        }
                        if let capturedURL {
                            Button("重开浏览器") {
                                NSWorkspace.shared.open(capturedURL)
                            }
                            .controlSize(.small)
                        }
                    } else {
                        Button(cliLoggedIn ? "重新登录 / 切换账号" : "一键浏览器扫码登录") {
                            Task { await reloginWorkBuddy() }
                        }
                        .buttonStyle(.borderedProminent)
                        .disabled(activeTask != nil)

                        Button(activeTask == "probe" ? "探测中…" : "刷新探测") {
                            Task { await refreshCLI() }
                        }
                        .disabled(activeTask != nil)

                        if cliLoggedIn {
                            Button(activeTask == "logout" ? "退出中…" : "退出登录", role: .destructive) {
                                Task { await logoutWorkBuddy() }
                            }
                            .disabled(activeTask != nil)
                        }

                        Button("终端手动登录") {
                            Task { await openTerminalFallback() }
                        }
                        .disabled(activeTask != nil)
                    }
                }

                if !authLog.isEmpty {
                    ScrollView {
                        Text(authLog)
                            .font(.caption.monospaced())
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .frame(height: 84)
                }
            }

            Section("QQ 小号 & SnowLuma 容器") {
                LabeledContent("OneBot 状态") {
                    let ok = appState.isQQOneBotOnline
                    StatusPill(text: ok ? "已连通" : "未连接", color: ok ? .green : .red)
                }
                LabeledContent("在线昵称") {
                    Text(appState.isQQOneBotOnline ? appState.qqLoginStatus?.login?.nickname ?? "—" : "—")
                }
                LabeledContent("机器人 QQ 号") {
                    Text(appState.isQQOneBotOnline ? appState.qqLoginStatus?.login?.userIdString ?? "—" : "—")
                        .font(.caption.monospaced())
                }
                if let err = appState.qqLoginStatus?.error {
                    Text(err).font(.caption).foregroundStyle(.red)
                }
                HStack {
                    Button("打开 QQ 扫码桌面 (noVNC)") {
                        localWebSheet = .noVNC
                    }
                    Button("打开 SnowLuma 管理页") {
                        localWebSheet = .snowlumaWebUI
                    }
                }
            }

            if let statusMessage {
                InfoBannerView(message: statusMessage)
            }
            if let errorMessage {
                ErrorBannerView(message: errorMessage)
            }
        }
        .formStyle(.grouped)
        .task { await refreshCLI() }
        .sheet(item: $localWebSheet) { kind in
            EmbeddedWebViewSheet(
                kind: kind,
                vncPassword: appState.keychain.read(account: .snowlumaVncPassword),
                appState: appState
            )
        }
    }

    private func refreshCLI() async {
        activeTask = "probe"
        defer { activeTask = nil }
        let info = await appState.authHelper.inspectCLI()
        cliPath = info.path ?? "未找到 ~/.local/bin/codebuddy"
        cliVersion = info.version ?? "—"
        cliLoggedIn = info.loggedIn
        cliModelCount = info.modelCount
        await appState.refreshNow()
    }

    private func reloginWorkBuddy() async {
        activeTask = "login"
        stageStatus = "正在准备\(selectedSite.rawValue)浏览器登录…"
        capturedURL = nil
        authLog = ""
        statusMessage = nil
        errorMessage = nil
        defer {
            activeTask = nil
            stageStatus = nil
        }
        do {
            let status = try await appState.authHelper.startAutomatedBrowserLogin(
                site: selectedSite,
                workingDirectory: appState.runtimePaths.runtimeDir,
                wasAlreadyLoggedIn: cliLoggedIn,
                onStage: { stage in
                    Task { @MainActor in stageStatus = stage }
                },
                onAuthURL: { url in
                    Task { @MainActor in
                        capturedURL = url
                        statusMessage = "已在浏览器打开授权链接：\(url.absoluteString)"
                    }
                },
                onLog: { chunk in
                    Task { @MainActor in authLog += chunk + "\n" }
                }
            )
            cliPath = status.path ?? cliPath
            cliVersion = status.version ?? cliVersion
            cliLoggedIn = status.loggedIn
            cliModelCount = status.modelCount
            if status.loggedIn {
                statusMessage = status.detail ?? "WorkBuddy 账号登录成功。"
            }
            await appState.refreshNow()
        } catch is CancellationError {
            statusMessage = "已取消 WorkBuddy 登录。"
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func logoutWorkBuddy() async {
        activeTask = "logout"
        statusMessage = nil
        errorMessage = nil
        defer { activeTask = nil }
        do {
            let status = try await appState.authHelper.logout(workingDirectory: appState.runtimePaths.runtimeDir)
            cliLoggedIn = status.loggedIn
            cliModelCount = status.modelCount
            capturedURL = nil
            statusMessage = status.loggedIn ? "退出登录未生效：\(status.detail ?? "")" : "已退出 WorkBuddy 账号。"
            await appState.refreshNow()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func openTerminalFallback() async {
        do {
            let cli = try await appState.authHelper.openTerminalForInteractiveLogin()
            statusMessage = "已在「终端」打开 \(cli)；完成登录后点击「刷新探测」即可。"
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}
