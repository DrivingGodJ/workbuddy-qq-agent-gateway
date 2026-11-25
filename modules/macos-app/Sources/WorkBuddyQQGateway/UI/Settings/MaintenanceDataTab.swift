import AppKit
import SwiftUI

struct MaintenanceDataTab: View {
    @Bindable var appState: AppState

    @State private var selectedLogSource: LogSourceKind = .hubOut
    @State private var logText: String = "点击刷新加载日志…"
    @State private var isBusy = false
    @State private var isCleaningStorage = false
    @State private var showUninstallSheet = false
    @State private var statusMessage: String?
    @State private var errorMessage: String?

    private let uninstallService = UninstallService()

    var body: some View {
        Form {
            Section("存储防膨胀策略与即时清理") {
                if let report = appState.storageUsage {
                    storageRow("QQ 临时图片与文件（24 小时 / 200 MB 上限）", report.categories.media?.bytes)
                    storageRow("网关运行日志（单文件封顶 5 MB）", report.categories.logs?.bytes)
                    storageRow("临时识图任务与归档缓存", report.categories.tempJobs?.bytes)
                    storageRow("状态与今日空间数据（跨日自动清理）", report.categories.data?.bytes)
                    storageRow("收藏表情库", report.categories.stickers?.bytes)
                    storageRow("Python SDK 运行环境", report.categories.venv?.bytes)

                    LabeledContent("本地临时缓存合计") {
                        Text(UninstallService.formatByteCount(report.ephemeralBytes))
                            .font(.callout.monospacedDigit().weight(.semibold))
                    }
                    if let last = report.lastCleanupAt {
                        Text("上次自动/手动清理：\(DateFormatting.shortTime(last)) · 空闲群/私聊未读队最多保留 72 小时 / 120 条。")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    } else {
                        Text("系统每小时自动清理过期 QQ 临时媒体、冗余队列、超限日志与容器核心转储。")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                } else {
                    Text("点击「刷新占用」读取各目录实际磁盘空间。")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }

                HStack(spacing: 10) {
                    Button("刷新占用") {
                        Task { await appState.refreshStorageUsage() }
                    }
                    .disabled(isCleaningStorage)

                    Button(isCleaningStorage ? "清理中…" : "立即清理临时缓存") {
                        Task { await runStorageCleanup() }
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(isCleaningStorage)
                }
            }

            Section("实时运行日志") {
                HStack {
                    Picker("日志源", selection: $selectedLogSource) {
                        ForEach(LogSourceKind.allCases) { src in
                            Text(src.rawValue).tag(src)
                        }
                    }
                    .pickerStyle(.segmented)
                    Button("刷新日志") {
                        Task { await loadLog() }
                    }
                    .disabled(isBusy)
                }

                ScrollView {
                    Text(logText)
                        .font(.caption.monospaced())
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(6)
                }
                .frame(minHeight: 150, maxHeight: 220)
                .background(.black.opacity(0.06), in: RoundedRectangle(cornerRadius: 6))
            }

            Section("备份、离线镜像与诊断") {
                HStack(spacing: 10) {
                    Button {
                        backupDataDirectory()
                    } label: {
                        Label("备份数据目录…", systemImage: "folder.badge.plus")
                    }

                    Button {
                        Task { await exportSnowlumaImageArchive() }
                    } label: {
                        Label("导出 SnowLuma 离线镜像…", systemImage: "shippingbox")
                    }
                    .disabled(isBusy)

                    Button {
                        Task { await exportDiagnostics() }
                    } label: {
                        Label("导出脱敏诊断报告…", systemImage: "doc.text.magnifyingglass")
                    }
                }
            }

            Section("彻底卸载与空间回收") {
                Text("如果你以后不再使用本软件，强烈建议使用内置卸载器：除删除应用与数据外，还会自动移除约 10 GB 的 Colima / SnowLuma 虚拟机磁盘。")
                    .font(.caption)
                    .foregroundStyle(.secondary)

                HStack(spacing: 10) {
                    Button("打开彻底卸载向导…", role: .destructive) {
                        showUninstallSheet = true
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(.red)

                    if let scriptURL = uninstallService.locateBundledUninstallScript() {
                        Button("在 Finder 中显示卸载脚本") {
                            NSWorkspace.shared.activateFileViewerSelecting([scriptURL])
                        }
                        .controlSize(.small)
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
        .task {
            await appState.refreshStorageUsage()
        }
        .task(id: selectedLogSource) {
            await loadLog()
        }
        .sheet(isPresented: $showUninstallSheet) {
            UninstallSheetView(appState: appState)
        }
    }

    @ViewBuilder
    private func storageRow(_ title: String, _ bytes: Int64?) -> some View {
        LabeledContent(title) {
            Text(UninstallService.formatByteCount(bytes ?? 0))
                .font(.caption.monospacedDigit())
                .foregroundStyle(.secondary)
        }
    }

    private func runStorageCleanup() async {
        isCleaningStorage = true
        statusMessage = nil
        errorMessage = nil
        defer { isCleaningStorage = false }
        do {
            let res = try await appState.runStorageCleanup()
            let freed = UninstallService.formatByteCount(res.freedBytes)
            let containerNote = res.containerCleaned == true ? "（含容器核心转储/过期暂存）" : ""
            statusMessage = "清理完成：处理 \(res.removedItems) 项，释放 \(freed)\(containerNote)。"
        } catch {
            errorMessage = "存储清理失败：\(error.localizedDescription)"
        }
    }

    private func loadLog() async {
        isBusy = true
        defer { isBusy = false }
        let content = await appState.logsManager.readLog(source: selectedLogSource, paths: appState.runtimePaths)
        logText = content.isEmpty ? "（当前日志为空）" : content
    }

    private func backupDataDirectory() {
        let panel = NSSavePanel()
        panel.title = "选择数据目录备份位置"
        panel.nameFieldStringValue = "workbuddy-qq-data-backup-\(Int(Date().timeIntervalSince1970))"
        guard panel.runModal() == .OK, let dest = panel.url else { return }
        do {
            try FileManager.default.copyItem(at: appState.runtimePaths.dataDir, to: dest)
            statusMessage = "已备份数据目录到 \(dest.lastPathComponent)"
        } catch {
            errorMessage = "备份失败：\(error.localizedDescription)"
        }
    }

    private func exportDiagnostics() async {
        let panel = NSSavePanel()
        panel.title = "导出脱敏诊断报告"
        panel.nameFieldStringValue = "workbuddy-qq-diagnostics-redacted.md"
        guard panel.runModal() == .OK, let dest = panel.url else { return }
        do {
            try await appState.logsManager.exportRedactedDiagnostics(
                to: dest,
                paths: appState.runtimePaths,
                maintenance: appState.maintenance
            )
            statusMessage = "已导出脱敏诊断报告（已抹除令牌、QQ 号与个人目录名）。"
        } catch {
            errorMessage = "导出失败：\(error.localizedDescription)"
        }
    }

    private func exportSnowlumaImageArchive() async {
        let panel = NSSavePanel()
        panel.title = "导出 SnowLuma 离线镜像包"
        panel.message = "导出后可在新电脑安装向导 Step 4 直接导入，无需联网下载上游仓库"
        panel.nameFieldStringValue = "snowluma-image-backup.tar.gz"
        guard panel.runModal() == .OK, let dest = panel.url else { return }

        isBusy = true
        statusMessage = "正在导出 SnowLuma 离线镜像包（体积约 1~4 GB，可能需要 1–3 分钟）…"
        errorMessage = nil
        defer { isBusy = false }
        do {
            let exportedTag = try await appState.supervisor.exportSnowlumaImage(to: dest)
            statusMessage = "已导出镜像 \(exportedTag) 到 \(dest.lastPathComponent)。"
        } catch {
            errorMessage = "导出镜像失败：\(error.localizedDescription)"
        }
    }
}
