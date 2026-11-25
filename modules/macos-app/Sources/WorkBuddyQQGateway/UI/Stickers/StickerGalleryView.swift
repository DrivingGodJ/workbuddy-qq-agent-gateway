import AppKit
import SwiftUI

enum StickerGallerySection: String, CaseIterable, Identifiable {
    case library = "表情库"
    case blacklist = "黑名单"

    var id: String { rawValue }
}

struct StickerGalleryView: View {
    @Bindable var appState: AppState
    @State private var section: StickerGallerySection = .library
    @State private var busyId: String?
    @State private var editingSticker: StickerItem?
    @State private var editingUsageText: String = ""
    @State private var actionMessage: String?
    @State private var errorMessage: String?

    private var stickers: StickerCollectionState? {
        appState.gatewayState?.qq?.stickers
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                HStack {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("表情展示台")
                            .font(.title2.weight(.semibold))
                        Text("查看表情库、AI 识别进度与黑名单；支持编辑备注、拉黑、恢复与彻底忘记。")
                            .font(.callout)
                            .foregroundStyle(.secondary)
                    }
                    Spacer()
                }

                // Summary Cards
                LazyVGrid(columns: [GridItem(.adaptive(minimum: 150), spacing: 12)], spacing: 12) {
                    SummaryMetricCard(title: "已入库", value: "\(stickers?.ready ?? 0) / \(stickers?.collectionLimit ?? 110)", color: .green)
                    SummaryMetricCard(title: "正在识别", value: "\(stickers?.awaitingAi ?? 0)", color: .blue)
                    SummaryMetricCard(title: "等待入库", value: "\(stickers?.awaitingCommit ?? 0)", color: .orange)
                    SummaryMetricCard(title: "识图模型", value: stickers?.labeling?.model ?? "hy3", color: .purple)
                }

                // Recognition & Curation status
                if let stickers {
                    let curationDesc = curationDescription(stickers.curation)
                    InfoBannerView(message: curationDesc, color: .secondary)
                }

                if let actionMessage {
                    InfoBannerView(message: actionMessage) { self.actionMessage = nil }
                }
                if let errorMessage {
                    ErrorBannerView(message: errorMessage) { self.errorMessage = nil }
                }

                HStack {
                    Picker("分区", selection: $section) {
                        Text("表情库 (\((stickers?.items?.count ?? 0) + (stickers?.candidates?.count ?? 0)))")
                            .tag(StickerGallerySection.library)
                        Text("黑名单 (\(stickers?.excludedCount ?? 0))")
                            .tag(StickerGallerySection.blacklist)
                    }
                    .pickerStyle(.segmented)
                    .frame(maxWidth: 340)

                    Spacer()

                    if section == .blacklist {
                        Button("清理黑名单本地文件") {
                            Task { await cleanBlacklistFiles() }
                        }
                        .disabled(busyId != nil || (stickers?.excludedCount ?? 0) == 0)

                        Button("清理黑名单 QQ 收藏", role: .destructive) {
                            Task { await cleanBlacklistFavorites() }
                        }
                        .disabled(busyId != nil || (stickers?.excludedCount ?? 0) == 0)
                    }
                }

                if section == .library {
                    if let candidates = stickers?.candidates, !candidates.isEmpty {
                        GroupBox("待识别 / 待入库队列 (\(candidates.count))") {
                            LazyVGrid(columns: [GridItem(.adaptive(minimum: 180), spacing: 12)], spacing: 12) {
                                ForEach(candidates) { cand in
                                    StickerCandidateCard(candidate: cand, apiClient: appState.apiClient)
                                }
                            }
                            .padding(8)
                        }
                    }

                    let items = (stickers?.items ?? []).sorted { ($0.lastSeenAt ?? "") > ($1.lastSeenAt ?? "") }
                    if items.isEmpty {
                        ContentUnavailableView("暂无已入库表情", systemImage: "face.smiling")
                            .padding(.vertical, 30)
                    } else {
                        LazyVGrid(columns: [GridItem(.adaptive(minimum: 190), spacing: 12)], spacing: 12) {
                            ForEach(items) { item in
                                StickerItemCard(
                                    item: item,
                                    apiClient: appState.apiClient,
                                    isBusy: busyId == item.id,
                                    onEdit: {
                                        editingSticker = item
                                        editingUsageText = item.usage ?? ""
                                    },
                                    onBlacklist: {
                                        Task { await performAction(id: item.id, action: "blacklist") }
                                    },
                                    onForget: {
                                        Task { await performAction(id: item.id, action: "forget") }
                                    }
                                )
                            }
                        }
                    }
                } else {
                    let excluded = (stickers?.excludedItems ?? []).sorted { ($0.excludedAt ?? "") > ($1.excludedAt ?? "") }
                    if excluded.isEmpty {
                        ContentUnavailableView("黑名单为空", systemImage: "hand.raised.slash")
                            .padding(.vertical, 30)
                    } else {
                        LazyVGrid(columns: [GridItem(.adaptive(minimum: 200), spacing: 12)], spacing: 12) {
                            ForEach(excluded) { item in
                                ExcludedStickerCard(
                                    item: item,
                                    apiClient: appState.apiClient,
                                    isBusy: busyId == item.id,
                                    onRestore: {
                                        Task { await performAction(id: item.id, action: "restore") }
                                    },
                                    onForget: {
                                        Task { await performAction(id: item.id, action: "forget") }
                                    }
                                )
                            }
                        }
                    }
                }
            }
            .padding(20)
        }
        .sheet(item: $editingSticker) { sticker in
            VStack(alignment: .leading, spacing: 14) {
                Text("编辑表情使用场景（2–80 字符）")
                    .font(.headline)
                TextField("中文使用场景描述", text: $editingUsageText)
                    .textFieldStyle(.roundedBorder)
                HStack {
                    Spacer()
                    Button("取消") { editingSticker = nil }
                    Button("保存") {
                        Task { await saveUsage(id: sticker.id) }
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(editingUsageText.trimmingCharacters(in: .whitespacesAndNewlines).count < 2)
                }
            }
            .padding(20)
            .frame(width: 400)
        }
    }

    private func curationDescription(_ curation: StickerCurationState?) -> String {
        switch curation?.status {
        case "queued": return "每日 05:00（北京时间）筛选已排队，等待 Agent 总开关开启。"
        case "waiting": return "表情筛选正在等待进行中的任务结束。"
        case "running":
            return "正在筛选表情：已审阅 \(curation?.progress?.reviewed ?? 0)/\(curation?.beforeCount ?? 0) 个。"
        case "completed":
            return "上次筛选保留 \(curation?.retainedCount ?? 0) 个，移除 \(curation?.removedCount ?? 0) 个。每日 05:00 自动检查。"
        default:
            return "每日 05:00（北京时间）检查表情库；超过 100 个时使用临时任务模型筛选保留 80 个。"
        }
    }

    private func saveUsage(id: String) async {
        busyId = id
        errorMessage = nil
        defer { busyId = nil }
        do {
            let updated = try await appState.apiClient.updateStickerUsage(id: id, usage: editingUsageText.trimmingCharacters(in: .whitespacesAndNewlines))
            appState.gatewayState?.qq?.stickers = updated
            editingSticker = nil
            actionMessage = "表情场景备注已更新。"
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func performAction(id: String, action: String) async {
        busyId = id
        errorMessage = nil
        defer { busyId = nil }
        do {
            let updated = try await appState.apiClient.performStickerAction(id: id, action: action)
            appState.gatewayState?.qq?.stickers = updated
            actionMessage = "操作已完成（\(action)）。"
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func cleanBlacklistFiles() async {
        busyId = "clean-files"
        errorMessage = nil
        defer { busyId = nil }
        do {
            let updated = try await appState.apiClient.cleanStickerBlacklistFiles()
            appState.gatewayState?.qq?.stickers = updated
            actionMessage = "已清理黑名单本地缓存文件。"
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func cleanBlacklistFavorites() async {
        busyId = "clean-fav"
        errorMessage = nil
        defer { busyId = nil }
        do {
            let updated = try await appState.apiClient.cleanStickerBlacklistFavorites()
            appState.gatewayState?.qq?.stickers = updated
            actionMessage = "已触发黑名单 QQ 收藏清理。"
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}

private struct SummaryMetricCard: View {
    let title: String
    let value: String
    let color: Color

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title)
                .font(.caption)
                .foregroundStyle(.secondary)
            Text(value)
                .font(.title3.weight(.semibold))
                .foregroundStyle(color)
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.quaternary.opacity(0.35), in: RoundedRectangle(cornerRadius: 10))
    }
}

private struct AuthenticatedStickerImage: View {
    let stickerId: String
    let apiClient: GatewayAPIClient
    @State private var image: NSImage?
    @State private var failed = false

    var body: some View {
        Group {
            if let image {
                Image(nsImage: image)
                    .resizable()
                    .scaledToFit()
            } else if failed {
                Image(systemName: "photo.badge.exclamationmark")
                    .font(.title2)
                    .foregroundStyle(.secondary)
            } else {
                ProgressView()
                    .controlSize(.small)
            }
        }
        .frame(height: 110)
        .frame(maxWidth: .infinity)
        .background(.quaternary.opacity(0.25), in: RoundedRectangle(cornerRadius: 8))
        .task(id: stickerId) {
            do {
                let data = try await apiClient.fetchStickerImage(id: stickerId)
                if let decoded = NSImage(data: data) {
                    image = decoded
                } else {
                    failed = true
                }
            } catch {
                failed = true
            }
        }
    }
}

private struct StickerCandidateCard: View {
    let candidate: StickerCandidate
    let apiClient: GatewayAPIClient

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            AuthenticatedStickerImage(stickerId: candidate.id, apiClient: apiClient)
            StatusPill(text: candidate.status ?? "识别中", color: .blue)
            if let usage = candidate.usage, !usage.isEmpty {
                Text(usage).font(.caption).lineLimit(2)
            }
            if let err = candidate.labelError {
                Text(err).font(.caption2).foregroundStyle(.red).lineLimit(2)
            }
        }
        .padding(10)
        .background(.quaternary.opacity(0.25), in: RoundedRectangle(cornerRadius: 10))
    }
}

private struct StickerItemCard: View {
    let item: StickerItem
    let apiClient: GatewayAPIClient
    let isBusy: Bool
    let onEdit: () -> Void
    let onBlacklist: () -> Void
    let onForget: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            AuthenticatedStickerImage(stickerId: item.id, apiClient: apiClient)
            Text(item.usage ?? "未填写使用场景")
                .font(.callout.weight(.medium))
                .lineLimit(2)
            HStack(spacing: 8) {
                Text("收 \(item.receiveCount ?? 0) · 发 \(item.sendCount ?? 0)")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                Spacer()
                if item.favoriteStatus != "added" {
                    StatusPill(text: "待同步收藏", color: .orange)
                }
            }
            HStack(spacing: 6) {
                Button("编辑", action: onEdit)
                    .controlSize(.small)
                Button("拉黑", action: onBlacklist)
                    .controlSize(.small)
                Spacer()
                Button("忘记", role: .destructive, action: onForget)
                    .controlSize(.small)
            }
            .disabled(isBusy)
        }
        .padding(10)
        .background(.quaternary.opacity(0.3), in: RoundedRectangle(cornerRadius: 10))
    }
}

private struct ExcludedStickerCard: View {
    let item: ExcludedStickerItem
    let apiClient: GatewayAPIClient
    let isBusy: Bool
    let onRestore: () -> Void
    let onForget: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if item.hasPreview == true {
                AuthenticatedStickerImage(stickerId: item.id, apiClient: apiClient)
            } else {
                Text("本地预览已清理")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .frame(height: 110)
                    .frame(maxWidth: .infinity)
                    .background(.quaternary.opacity(0.25), in: RoundedRectangle(cornerRadius: 8))
            }
            Text(item.usage?.isEmpty == false ? (item.usage ?? "") : "无备注")
                .font(.callout)
                .lineLimit(2)
            Text("原因：\(item.reason ?? "manual")")
                .font(.caption2)
                .foregroundStyle(.secondary)
            HStack {
                Button("恢复收录", action: onRestore)
                    .controlSize(.small)
                    .disabled(isBusy || item.canRestore == false)
                Spacer()
                Button("彻底忘记", role: .destructive, action: onForget)
                    .controlSize(.small)
                    .disabled(isBusy)
            }
        }
        .padding(10)
        .background(.quaternary.opacity(0.3), in: RoundedRectangle(cornerRadius: 10))
    }
}
