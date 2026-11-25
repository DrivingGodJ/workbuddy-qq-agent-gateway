import AppKit
import SwiftUI
import WebKit

private enum EmbeddedWebLoadPhase: Equatable {
    case loading
    case ready
    case retrying(String)
}

struct EmbeddedWebViewSheet: View {
    let kind: EmbeddedWebSheetKind
    let vncPassword: String?
    @Bindable var appState: AppState
    @Environment(\.dismiss) private var dismiss
    @State private var copiedToast = false
    @State private var reloadToken = 0
    @State private var loadPhase: EmbeddedWebLoadPhase = .loading

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 10) {
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 8) {
                        Text(kind.title)
                            .font(.headline)
                        if kind == .noVNC {
                            vncStatusPill
                        }
                    }
                    Text(kind.url.absoluteString)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                Button {
                    reloadToken += 1
                } label: {
                    Label("刷新", systemImage: "arrow.clockwise")
                }
                Button {
                    NSWorkspace.shared.open(kind.url)
                } label: {
                    Label("浏览器打开", systemImage: "safari")
                }
                if kind == .noVNC, let vncPassword, !vncPassword.isEmpty {
                    Button {
                        NSPasteboard.general.clearContents()
                        NSPasteboard.general.setString(vncPassword, forType: .string)
                        copiedToast = true
                    } label: {
                        Label(copiedToast ? "已复制 VNC 密码" : "复制 VNC 密码", systemImage: "doc.on.doc")
                    }
                }
                Button("完成") {
                    dismiss()
                }
                .buttonStyle(.borderedProminent)
                .tint(kind == .noVNC && appState.isQQOneBotOnline ? .green : .accentColor)
            }
            .padding(12)
            .background(.bar)

            if kind == .noVNC {
                noVNCGuidanceBanner
            }

            Divider()

            ZStack {
                LoopbackWebView(url: kind.url, reloadToken: reloadToken, loadPhase: $loadPhase)

                if case .retrying(let reason) = loadPhase {
                    VStack(spacing: 12) {
                        ProgressView()
                            .controlSize(.regular)
                        Text("正在等待 \(kind.title) 端口就绪，每 2.5 秒自动重试…")
                            .font(.headline)
                        Text(reason)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .multilineTextAlignment(.center)
                            .frame(maxWidth: 420)
                        Button("立即重试") {
                            reloadToken += 1
                        }
                        .buttonStyle(.borderedProminent)
                    }
                    .padding(24)
                    .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12))
                    .shadow(radius: 10)
                    .padding(24)
                }
            }
            .frame(minWidth: 900, minHeight: 620)
        }
    }

    @ViewBuilder
    private var vncStatusPill: some View {
        if appState.isQQOneBotOnline {
            let nickname = appState.qqLoginStatus?.login?.nickname ?? "在线"
            StatusPill(text: "QQ 已上线（\(nickname)）", color: .green)
        } else if appState.colimaSnapshot?.containerRunning != true {
            StatusPill(text: "容器唤醒中…", color: .orange)
        } else {
            StatusPill(text: "等待 QQ 登录…", color: .orange)
        }
    }

    @ViewBuilder
    private var noVNCGuidanceBanner: some View {
        if appState.isQQOneBotOnline {
            let nickname = appState.qqLoginStatus?.login?.nickname ?? "在线"
            HStack(spacing: 10) {
                Image(systemName: "checkmark.circle.fill")
                    .foregroundStyle(.green)
                Text("QQ 小号已上线并连通 OneBot（\(nickname)），可直接点击右上角「完成」关闭。")
                    .font(.callout.weight(.medium))
                Spacer()
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 10)
            .background(Color.green.opacity(0.12))
        } else {
            HStack(alignment: .top, spacing: 10) {
                Image(systemName: "exclamationmark.triangle.fill")
                    .foregroundStyle(.orange)
                    .padding(.top, 2)
                VStack(alignment: .leading, spacing: 3) {
                    Text(
                        appState.qqLoginPromptMode == .needsAutoLoginCheck
                            ? "请先勾选「自动登录」再点击「登录」"
                            : "请在下方登录机器人 QQ 小号（如出现「自动登录」请务必勾选）"
                    )
                    .font(.callout.weight(.semibold))
                    Text("首次扫码登录时 Linux QQ 不会显示「自动登录」选项，第二次启动才会出现。勾选后以后每次打开软件即可自动登录上线。")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer()
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 10)
            .background(Color.orange.opacity(0.14))
        }
    }
}

private struct LoopbackWebView: NSViewRepresentable {
    let url: URL
    let reloadToken: Int
    @Binding var loadPhase: EmbeddedWebLoadPhase

    func makeNSView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .default()
        let webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = context.coordinator
        context.coordinator.lastReloadToken = reloadToken
        webView.load(URLRequest(url: url))
        return webView
    }

    func updateNSView(_ nsView: WKWebView, context: Context) {
        context.coordinator.onPhaseChange = { phase in
            loadPhase = phase
        }
        if context.coordinator.lastReloadToken != reloadToken {
            context.coordinator.lastReloadToken = reloadToken
            context.coordinator.cancelRetry()
            Task { @MainActor in
                loadPhase = .loading
            }
            nsView.load(URLRequest(url: url))
        }
    }

    static func dismantleNSView(_ nsView: WKWebView, coordinator: Coordinator) {
        coordinator.cancelRetry()
    }

    func makeCoordinator() -> Coordinator {
        Coordinator(url: url) { phase in
            loadPhase = phase
        }
    }

    @MainActor
    final class Coordinator: NSObject, WKNavigationDelegate {
        let url: URL
        var lastReloadToken: Int = 0
        var onPhaseChange: (EmbeddedWebLoadPhase) -> Void
        private var retryTask: Task<Void, Never>?

        init(url: URL, onPhaseChange: @escaping (EmbeddedWebLoadPhase) -> Void) {
            self.url = url
            self.onPhaseChange = onPhaseChange
        }

        func cancelRetry() {
            retryTask?.cancel()
            retryTask = nil
        }

        func webView(
            _ webView: WKWebView,
            decidePolicyFor navigationAction: WKNavigationAction
        ) async -> WKNavigationActionPolicy {
            guard let targetURL = navigationAction.request.url,
                  let host = targetURL.host,
                  ["127.0.0.1", "localhost"].contains(host) else {
                return .cancel
            }
            return .allow
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            cancelRetry()
            onPhaseChange(.ready)
        }

        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: any Error) {
            handleLoadFailure(webView, error: error)
        }

        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: any Error) {
            handleLoadFailure(webView, error: error)
        }

        private func handleLoadFailure(_ webView: WKWebView, error: any Error) {
            let nsErr = error as NSError
            if nsErr.domain == NSURLErrorDomain && nsErr.code == NSURLErrorCancelled {
                return
            }
            onPhaseChange(.retrying(error.localizedDescription))
            cancelRetry()
            let targetURL = url
            retryTask = Task { [weak self, weak webView] in
                try? await Task.sleep(nanoseconds: 2_500_000_000)
                guard !Task.isCancelled, let self, let webView else { return }
                self.onPhaseChange(.loading)
                webView.load(URLRequest(url: targetURL))
            }
        }
    }
}
