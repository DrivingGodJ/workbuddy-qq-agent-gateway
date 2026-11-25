import SwiftUI

struct UninstallSheetView: View {
    @Bindable var appState: AppState
    @Environment(\.dismiss) private var dismiss

    private let service = UninstallService()
    @State private var scanReport: UninstallScanReport?
    @State private var isScanning = false
    @State private var options = UninstallOptions()
    @State private var showConfirm = false
    @State private var errorMessage: String?

    private var selectedReclaimBytes: Int64 {
        guard let scanReport else { return 0 }
        var total: Int64 = 0
        for item in scanReport.items {
            switch item.id {
            case "vm" where options.vmMode == .entireVM: total += item.bytes
            case "data" where options.removeAppData: total += item.bytes
            case "app" where options.removeAppAndPreferences: total += item.bytes
            case "codebuddy" where options.removeCodeBuddyCLI: total += item.bytes
            default: break
            }
        }
        return total
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack {
                VStack(alignment: .leading, spacing: 3) {
                    Text("彻底卸载与空间回收")
                        .font(.title3.weight(.semibold))
                    Text("勾选要删除的组件；预计可释放磁盘空间约 \(UninstallService.formatByteCount(selectedReclaimBytes))。")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                Button("取消") { dismiss() }
            }

            if isScanning {
                HStack(spacing: 10) {
                    ProgressView().controlSize(.small)
                    Text("正在扫描虚拟机磁盘、运行数据与缓存占用…")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity, minHeight: 140)
            } else if let scanReport {
                Form {
                    if let vmItem = scanReport.items.first(where: { $0.id == "vm" }) {
                        Section("Colima 虚拟机与 SnowLuma 容器（虚拟机磁盘约 \(UninstallService.formatByteCount(vmItem.bytes))）") {
                            Picker("清理方式", selection: $options.vmMode) {
                                ForEach(UninstallVMMode.allCases) { mode in
                                    Text(mode.title).tag(mode)
                                }
                            }
                            .pickerStyle(.radioGroup)
                            .labelsHidden()
                        }
                    }

                    Section("其他要移除的项目") {
                        ForEach(scanReport.items.filter { $0.id != "vm" }) { item in
                            Toggle(isOn: binding(for: item.id)) {
                                HStack(alignment: .top) {
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(item.title)
                                            .font(.callout.weight(.medium))
                                        Text(item.detail)
                                            .font(.caption)
                                            .foregroundStyle(.secondary)
                                    }
                                    Spacer()
                                    Text(UninstallService.formatByteCount(item.bytes))
                                        .font(.caption.monospacedDigit())
                                        .foregroundStyle(.secondary)
                                }
                            }
                            .toggleStyle(.checkbox)
                        }
                    }

                    Section("安全提示") {
                        Text("卸载不会删除你导出的 .laodai-persona.json 人格备份，也不会改动「文稿」「桌面」或「下载」中的任何个人文件。")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        HStack {
                            Button("卸载前先导出人格备份…") {
                                Task { await appState.exportPersonaToPanel() }
                            }
                            Spacer()
                            Button("重新扫描") {
                                Task { await runScan() }
                            }
                            .controlSize(.small)
                        }
                    }
                }
                .formStyle(.grouped)
                .frame(minHeight: 280)
            }

            if let errorMessage {
                ErrorBannerView(message: errorMessage)
            }

            HStack {
                Button("取消") { dismiss() }
                Spacer()
                Button("开始彻底卸载…", role: .destructive) {
                    showConfirm = true
                }
                .buttonStyle(.borderedProminent)
                .tint(.red)
                .disabled(isScanning)
            }
        }
        .padding(20)
        .frame(width: 600, height: 540)
        .task { await runScan() }
        .confirmationDialog(
            "确认开始彻底卸载并停止全部服务？",
            isPresented: $showConfirm,
            titleVisibility: .visible
        ) {
            Button("确认停止服务并打开终端完成卸载", role: .destructive) {
                executeUninstall()
            }
            Button("取消", role: .cancel) {}
        } message: {
            Text("应用将立即退出并停止后台服务，同时在「终端」执行清理脚本，预计释放 \(UninstallService.formatByteCount(selectedReclaimBytes)) 磁盘空间。")
        }
    }

    private func binding(for id: String) -> Binding<Bool> {
        switch id {
        case "vm":
            return $options.removeVM
        case "data":
            return $options.removeAppData
        case "app":
            return Binding(
                get: { options.removeAppAndPreferences },
                set: {
                    options.removeAppAndPreferences = $0
                    options.removeKeychain = $0
                }
            )
        case "codebuddy":
            return $options.removeCodeBuddyCLI
        default:
            return .constant(false)
        }
    }

    private func runScan() async {
        isScanning = true
        defer { isScanning = false }
        scanReport = await service.scan()
    }

    private func executeUninstall() {
        do {
            try service.launchDetachedUninstall(options: options, appState: appState)
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}
