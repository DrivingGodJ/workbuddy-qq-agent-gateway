import AppKit
import CoreImage
import CoreImage.CIFilterBuiltins
import SwiftUI

struct LanControlTab: View {
    @Bindable var appState: AppState

    @State private var enabled: Bool = false
    @State private var portText: String = "3790"
    @State private var bonjourEnabled: Bool = true
    @State private var newPassword: String = ""
    @State private var generatedPlainPassword: String?
    @State private var selectedQrURL: String = ""

    @State private var isBusy = false
    @State private var statusMessage: String?
    @State private var errorMessage: String?

    private var lanStatus: LanPanelStatus? {
        appState.maintenance?.lanPanel ?? appState.gatewayState?.lanPanel
    }

    var body: some View {
        Form {
            Section("局域网广播控制面板") {
                LabeledContent("运行状态") {
                    StatusPill(
                        text: lanStatus?.running == true ? "广播运行中" : "已关闭",
                        color: lanStatus?.running == true ? .green : .secondary
                    )
                }

                Toggle("向同一 Wi-Fi / 局域网设备开放网页面板", isOn: $enabled)

                TextField("监听端口", text: $portText)

                Toggle("通过 Bonjour (mDNS) 广播 .local 域名", isOn: $bonjourEnabled)

                Text("支持在手机、平板或其他电脑浏览器中输入独立密码登录，调整模型、人格、开关与查看今日空间；OneBot 回调和本页开关仅限本机操作。")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            Section(lanStatus?.hasPassword == true ? "访问密码（留空则沿用已保存密码）" : "设置访问密码（至少 6 位）") {
                HStack(spacing: 8) {
                    SecureField("输入 6–128 位局域网访问密码", text: $newPassword)
                    Button("一键生成强密码") {
                        generateStrongPassword()
                    }
                }

                if let generatedPlainPassword {
                    HStack {
                        Text("新生成密码：\(generatedPlainPassword)")
                            .font(.caption.monospaced())
                            .textSelection(.enabled)
                        Spacer()
                        Button("复制密码") {
                            NSPasteboard.general.clearContents()
                            NSPasteboard.general.setString(generatedPlainPassword, forType: .string)
                            statusMessage = "已复制新密码到剪贴板。"
                        }
                        .controlSize(.small)
                    }
                }

                HStack {
                    if (lanStatus?.activeSessions ?? 0) > 0 {
                        Button("踢出所有已登录设备 (\(lanStatus?.activeSessions ?? 0))", role: .destructive) {
                            Task { await saveConfig(revokeSessions: true) }
                        }
                        .disabled(isBusy)
                    }
                    Spacer()
                    Button {
                        Task { await saveConfig(revokeSessions: false) }
                    } label: {
                        Text(isBusy ? "应用中…" : "保存并应用")
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(isBusy)
                }
            }

            if let lanStatus, lanStatus.running {
                Section("可访问的局域网网址与扫码入口") {
                    HStack(alignment: .top, spacing: 18) {
                        VStack(alignment: .leading, spacing: 8) {
                            Text("当前已登录设备数：\(lanStatus.activeSessions)")
                                .font(.caption)
                                .foregroundStyle(.secondary)

                            if let bonjour = lanStatus.bonjourHost {
                                urlRow(label: "Bonjour", url: bonjour)
                            }
                            ForEach(lanStatus.urls) { entry in
                                urlRow(label: entry.interface, url: entry.url)
                            }
                            if lanStatus.urls.isEmpty && lanStatus.bonjourHost == nil {
                                Text("暂未检测到非回环 IPv4 网卡地址，请检查 Wi-Fi/以太网连接。")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                        }
                        Spacer()
                        if !selectedQrURL.isEmpty, let qrImage = makeQRCode(for: selectedQrURL) {
                            VStack(spacing: 6) {
                                Image(nsImage: qrImage)
                                    .interpolation(.none)
                                    .resizable()
                                    .scaledToFit()
                                    .frame(width: 132, height: 132)
                                    .padding(6)
                                    .background(Color.white, in: RoundedRectangle(cornerRadius: 8))
                                Text("手机扫码打开")
                                    .font(.caption2)
                                    .foregroundStyle(.secondary)
                            }
                        }
                    }
                }
            }

            if let err = lanStatus?.lastError {
                ErrorBannerView(message: err)
            }
            if let errorMessage {
                ErrorBannerView(message: errorMessage)
            }
            if let statusMessage {
                InfoBannerView(message: statusMessage)
            }
        }
        .formStyle(.grouped)
        .onAppear { syncFromState() }
        .onChange(of: appState.maintenance?.lanPanel) { _, _ in syncFromState() }
        .onChange(of: appState.gatewayState?.lanPanel) { _, _ in syncFromState() }
    }

    @ViewBuilder
    private func urlRow(label: String, url: String) -> some View {
        HStack(spacing: 8) {
            Text(label)
                .font(.caption)
                .foregroundStyle(.secondary)
                .frame(width: 68, alignment: .leading)
            Text(url)
                .font(.callout.monospaced())
                .textSelection(.enabled)
            Button("复制") {
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString(url, forType: .string)
                selectedQrURL = url
                statusMessage = "已复制地址：\(url)"
            }
            .controlSize(.small)
            Button("打开") {
                if let u = URL(string: url) {
                    NSWorkspace.shared.open(u)
                }
            }
            .controlSize(.small)
        }
    }

    private func syncFromState() {
        guard let lanStatus else { return }
        enabled = lanStatus.enabled
        portText = String(lanStatus.port)
        bonjourEnabled = lanStatus.bonjourEnabled
        if selectedQrURL.isEmpty || !(lanStatus.urls.contains { $0.url == selectedQrURL } || lanStatus.bonjourHost == selectedQrURL) {
            selectedQrURL = lanStatus.urls.first?.url ?? lanStatus.bonjourHost ?? ""
        }
    }

    private func generateStrongPassword() {
        let alphabet = Array("ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789")
        let generated = String((0..<12).compactMap { _ in alphabet.randomElement() })
        newPassword = generated
        generatedPlainPassword = generated
    }

    private func saveConfig(revokeSessions: Bool) async {
        isBusy = true
        statusMessage = nil
        errorMessage = nil
        defer { isBusy = false }

        guard let port = Int(portText.trimmingCharacters(in: .whitespacesAndNewlines)),
              (1024...65535).contains(port) else {
            errorMessage = "请输入 1024–65535 之间的有效端口号。"
            return
        }

        do {
            let trimmedPass = newPassword.trimmingCharacters(in: .whitespacesAndNewlines)
            let updated = try await appState.apiClient.updateLanPanelConfig(
                enabled: enabled,
                port: port,
                password: trimmedPass.isEmpty ? nil : trimmedPass,
                bonjourEnabled: bonjourEnabled,
                revokeSessions: revokeSessions
            )
            appState.maintenance?.lanPanel = updated
            appState.gatewayState?.lanPanel = updated
            newPassword = ""
            if revokeSessions {
                statusMessage = "已注销所有已登录局域网设备。"
            } else if updated.running {
                let firstUrl = updated.urls.first?.url ?? updated.bonjourHost ?? "http://127.0.0.1:\(String(updated.port))"
                selectedQrURL = firstUrl
                statusMessage = "局域网控制面板已启动：\(firstUrl)"
            } else {
                statusMessage = "局域网控制面板已关闭。"
            }
            await appState.refreshNow()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func makeQRCode(for text: String) -> NSImage? {
        let filter = CIFilter.qrCodeGenerator()
        filter.message = Data(text.utf8)
        filter.correctionLevel = "M"
        guard let output = filter.outputImage else { return nil }
        let scaled = output.transformed(by: CGAffineTransform(scaleX: 8, y: 8))
        let rep = NSCIImageRep(ciImage: scaled)
        let img = NSImage(size: rep.size)
        img.addRepresentation(rep)
        return img
    }
}
