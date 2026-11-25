import SwiftUI

private enum QzoneTodayFilter: String, CaseIterable, Identifiable {
    case all = "all"
    case botEngaged = "engaged"
    case botPosts = "posts"

    var id: String { rawValue }

    func title(agentName: String) -> String {
        switch self {
        case .all: return "全部"
        case .botEngaged: return "\(agentName)参与"
        case .botPosts: return "\(agentName)发布"
        }
    }
}

struct QzonePanelView: View {
    @Bindable var appState: AppState

    @State private var todayFilter: QzoneTodayFilter = .all
    @State private var selectedBinding: String = ""
    @State private var autoPostEnabled: Bool = false
    @State private var autoEngageEnabled: Bool = false
    @State private var isSaving = false
    @State private var isRefreshingToday = false
    @State private var statusMessage: String?
    @State private var errorMessage: String?

    private var qzone: QzoneState {
        appState.gatewayState?.qq?.qzone ?? QzoneState()
    }

    private var availableTargets: [(key: String, title: String)] {
        var list: [(String, String)] = []
        if let ownerId = appState.gatewayState?.qq?.ownerId,
           let ownerChat = appState.gatewayState?.qq?.privateChats?[ownerId] {
            list.append(("private:\(ownerId)", "私聊 · \(ownerChat.resolvedTitle)（OWNER）"))
        }
        for group in appState.sortedGroups {
            list.append(("group:\(group.targetId)", "群聊 · \(group.resolvedTitle)"))
        }
        return list
    }

    private var todayFeeds: [QzoneTodayFeed] {
        let all = qzone.todayFeeds ?? []
        switch todayFilter {
        case .all:
            return all
        case .botEngaged:
            return all.filter { feed in
                feed.botLiked == true
                    || feed.isBotPost == true
                    || (feed.comments?.contains { $0.isBot } ?? false)
            }
        case .botPosts:
            return all.filter { $0.isBotPost == true }
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .center, spacing: 14) {
                VStack(alignment: .leading, spacing: 3) {
                    Text("QQ 空间动态")
                        .font(.title2.weight(.semibold))
                    Text("今日动态与评论仅作临时展示并跨日自动清理；左侧浏览动态，右侧常驻管理自动任务与记录。")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                Button {
                    Task { await refreshToday() }
                } label: {
                    if isRefreshingToday {
                        Label("刷新中…", systemImage: "arrow.clockwise")
                    } else {
                        Label("立即刷新今日动态", systemImage: "arrow.clockwise")
                    }
                }
                .disabled(isRefreshingToday)
            }
            .padding(.horizontal, 20)
            .padding(.vertical, 12)

            Divider()

            HStack(spacing: 0) {
                ScrollView {
                    VStack(alignment: .leading, spacing: 14) {
                        if let err = qzone.lastError {
                            ErrorBannerView(message: err)
                        }
                        if let errorMessage {
                            ErrorBannerView(message: errorMessage)
                        }
                        if let statusMessage {
                            InfoBannerView(message: statusMessage)
                        }
                        todayFeedsSection
                    }
                    .padding(20)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)

                Divider()

                ScrollView {
                    VStack(alignment: .leading, spacing: 16) {
                        configSection
                        historySection
                    }
                    .padding(16)
                }
                .frame(width: 340)
                .background(.windowBackground)
            }
        }
        .onAppear { syncFromState() }
        .onChange(of: qzone) { _, _ in syncFromState() }
    }

    @ViewBuilder
    private var todayFeedsSection: some View {
        let allCount = qzone.todayFeeds?.count ?? 0
        HStack(spacing: 10) {
            VStack(alignment: .leading, spacing: 2) {
                Text("今日刷到的动态（\(qzone.todayDate ?? "今日") · 共 \(allCount) 条）")
                    .font(.headline)
                Text("含好友与\(appState.agentName)的说说、点赞及全部评论；\(appState.agentName)发出的评论会高亮标出。")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer()
            Picker("筛选", selection: $todayFilter) {
                ForEach(QzoneTodayFilter.allCases) { item in
                    Text(item.title(agentName: appState.agentName)).tag(item)
                }
            }
            .pickerStyle(.segmented)
            .frame(maxWidth: 230)
        }

        if todayFeeds.isEmpty {
            GroupBox {
                VStack(spacing: 8) {
                    Image(systemName: "sparkles.rectangle.stack")
                        .font(.title2)
                        .foregroundStyle(.secondary)
                    Text(allCount == 0 ? "今日暂未刷到 QQ 空间动态" : "当前筛选条件下没有匹配的动态")
                        .font(.callout.weight(.medium))
                    Text("可点击右上角「立即刷新今日动态」拉取，或在右侧开启让\(appState.agentName)整点自动巡检。")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 36)
            }
        } else {
            ForEach(todayFeeds) { feed in
                feedCard(feed)
            }
        }

        Text("提示：仅保存今天（北京时间）刷到的动态文字与评论元数据，不下载原图，次日自动清理以免膨胀磁盘。")
            .font(.caption)
            .foregroundStyle(.secondary)
    }

    @ViewBuilder
    private func feedCard(_ feed: QzoneTodayFeed) -> some View {
        let comments = feed.comments ?? []
        let botCommented = comments.contains { $0.isBot }
        GroupBox {
            VStack(alignment: .leading, spacing: 10) {
                HStack(alignment: .center, spacing: 8) {
                    Text(feed.nickname)
                        .font(.headline)
                    Text("(\(feed.uin))")
                        .font(.caption.monospaced())
                        .foregroundStyle(.secondary)
                    if feed.isBotPost == true {
                        StatusPill(text: "\(appState.agentName)发布", color: .blue)
                    }
                    if feed.botLiked == true {
                        StatusPill(text: "\(appState.agentName)已赞", color: .green)
                    }
                    if botCommented {
                        StatusPill(text: "\(appState.agentName)已评", color: .teal)
                    }
                    Spacer()
                    Text(DateFormatting.shortTimestampMs(feed.timeMs))
                        .font(.caption.monospacedDigit())
                        .foregroundStyle(.secondary)
                }

                Text(feed.text.isEmpty ? "（无文字正文）" : feed.text)
                    .font(.body)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)

                HStack(spacing: 10) {
                    if let imgCount = feed.imageCount, imgCount > 0 {
                        Label("含 \(imgCount) 张图", systemImage: "photo.on.rectangle")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    Label("\(feed.likeCount ?? 0) 赞", systemImage: feed.botLiked == true ? "heart.fill" : "heart")
                        .font(.caption)
                        .foregroundStyle(feed.botLiked == true ? .pink : .secondary)
                    Label("\(comments.count) 评论", systemImage: "text.bubble")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }

                if !comments.isEmpty {
                    Divider()
                    VStack(alignment: .leading, spacing: 6) {
                        ForEach(comments) { comment in
                            VStack(alignment: .leading, spacing: 3) {
                                HStack(spacing: 6) {
                                    Text(comment.nickname)
                                        .font(.caption.weight(.semibold))
                                    if comment.isBot {
                                        StatusPill(text: "\(appState.agentName)评论", color: .blue)
                                    }
                                    Spacer()
                                    if let timeText = comment.timeText, !timeText.isEmpty {
                                        Text(timeText)
                                            .font(.caption2.monospacedDigit())
                                            .foregroundStyle(.secondary)
                                    }
                                }
                                Text(comment.content)
                                    .font(.callout)
                                    .textSelection(.enabled)
                            }
                            .padding(8)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .background(
                                comment.isBot ? Color.accentColor.opacity(0.14) : Color.primary.opacity(0.04),
                                in: RoundedRectangle(cornerRadius: 8)
                            )
                            .overlay(
                                RoundedRectangle(cornerRadius: 8)
                                    .stroke(comment.isBot ? Color.accentColor.opacity(0.45) : Color.clear, lineWidth: 1)
                            )
                        }
                    }
                }
            }
            .padding(6)
        }
    }

    @ViewBuilder
    private var configSection: some View {
        GroupBox("自动任务设置") {
            VStack(alignment: .leading, spacing: 12) {
                Picker("绑定会话", selection: $selectedBinding) {
                    Text("暂不绑定").tag("")
                    ForEach(availableTargets, id: \.key) { item in
                        Text(item.title).tag(item.key)
                    }
                }

                Toggle("早 / 中 / 晚自动决定是否发动态", isOn: $autoPostEnabled)
                Text("计划时段（北京时间）：\((qzone.scheduleTimes ?? []).joined(separator: "、"))")
                    .font(.caption)
                    .foregroundStyle(.secondary)

                Toggle("每小时检查新好友动态，按喜好点赞或评论", isOn: $autoEngageEnabled)
                Text("上次读到的最新动态：\(DateFormatting.shortTimestampMs(qzone.lastSeenFeedTimeMs))")
                    .font(.caption)
                    .foregroundStyle(.secondary)

                Button {
                    Task { await save() }
                } label: {
                    Text(isSaving ? "保存中…" : "保存 QQ 空间设置")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .disabled(isSaving)
            }
            .padding(8)
        }
    }

    @ViewBuilder
    private var historySection: some View {
        GroupBox("最近任务记录 (\(qzone.events?.count ?? 0))") {
            if let events = qzone.events, !events.isEmpty {
                VStack(spacing: 8) {
                    ForEach(events.prefix(15)) { ev in
                        VStack(alignment: .leading, spacing: 4) {
                            HStack {
                                StatusPill(text: eventLabel(ev.kind), color: ev.status == "failed" ? .red : .blue)
                                Spacer()
                                Text(DateFormatting.shortTime(ev.at))
                                    .font(.caption2.monospacedDigit())
                                    .foregroundStyle(.secondary)
                            }
                            Text(ev.message ?? ev.status ?? "")
                                .font(.caption)
                                .foregroundStyle(.primary)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                        .padding(.vertical, 3)
                        Divider()
                    }
                }
                .padding(6)
            } else {
                Text("尚无 QQ 空间任务记录。")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .padding(10)
            }
        }
    }

    private func syncFromState() {
        if let type = qzone.targetType, let id = qzone.targetId, !id.isEmpty {
            selectedBinding = "\(type):\(id)"
        } else {
            selectedBinding = ""
        }
        autoPostEnabled = qzone.autoPostEnabled ?? false
        autoEngageEnabled = qzone.autoEngageEnabled ?? false
    }

    private func refreshToday() async {
        isRefreshingToday = true
        errorMessage = nil
        statusMessage = nil
        defer { isRefreshingToday = false }
        do {
            let updated = try await appState.apiClient.refreshQzoneTodayFeeds()
            appState.gatewayState?.qq?.qzone = updated
            statusMessage = "已刷新今日动态（共 \(updated.todayFeeds?.count ?? 0) 条）。"
        } catch {
            errorMessage = "刷新今日动态失败：\(error.localizedDescription)"
        }
    }

    private func save() async {
        isSaving = true
        errorMessage = nil
        statusMessage = nil
        defer { isSaving = false }

        let parts = selectedBinding.split(separator: ":", maxSplits: 1).map(String.init)
        let targetType = parts.count == 2 ? parts[0] : nil
        let targetId = parts.count == 2 ? parts[1] : nil

        do {
            let saved = try await appState.apiClient.saveQzoneSettings(
                targetType: targetType,
                targetId: targetId,
                autoPostEnabled: autoPostEnabled,
                autoEngageEnabled: autoEngageEnabled
            )
            appState.gatewayState?.qq?.qzone = saved
            statusMessage = "QQ 空间设置已保存。"
            await appState.refreshNow()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func eventLabel(_ raw: String?) -> String {
        switch raw {
        case "scheduled-post": return "定时发动态"
        case "post": return "手动发动态"
        case "feed-scan": return "动态巡检"
        case "like": return "点赞"
        case "comment": return "评论"
        case "error": return "错误"
        default: return raw ?? "任务"
        }
    }
}
