import SwiftUI

struct SidebarView: View {
    @Bindable var appState: AppState
    @Environment(\.openSettings) private var openSettings
    @State private var showAddGroupSheet = false
    @State private var showAddPrivateSheet = false

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 6) {
                Image(systemName: "magnifyingglass")
                    .foregroundStyle(.secondary)
                TextField("搜索群聊、私聊或 QQ 号", text: $appState.searchQuery)
                    .textFieldStyle(.plain)
                if !appState.searchQuery.isEmpty {
                    Button {
                        appState.searchQuery = ""
                    } label: {
                        Image(systemName: "xmark.circle.fill")
                            .foregroundStyle(.secondary)
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(8)
            .background(.quaternary.opacity(0.6), in: RoundedRectangle(cornerRadius: 8))
            .padding(.horizontal, 10)
            .padding(.vertical, 8)

            List(selection: $appState.selectedTarget) {
                Section {
                    ForEach(appState.sortedGroups) { group in
                        let key = SelectedTargetKey.group(group.targetId)
                        ConversationSidebarRow(
                            target: group,
                            isSelected: appState.selectedTarget == key,
                            isBusy: appState.isTargetBusy(group),
                            onReset: { appState.pendingResetTarget = group },
                            onToggleReply: { Task { await appState.toggleReplyEnabled(!group.replyEnabled, target: group) } },
                            onDelete: { appState.pendingDeleteTarget = group }
                        )
                        .tag(key)
                    }
                } header: {
                    HStack {
                        Text("Agent 群聊 (\(appState.sortedGroups.count))")
                        Spacer()
                        Button {
                            showAddGroupSheet = true
                        } label: {
                            Image(systemName: "plus")
                        }
                        .buttonStyle(.borderless)
                        .help("从机器人已加入的群添加白名单")
                    }
                }

                Section {
                    ForEach(appState.sortedPrivateChats) { chat in
                        let key = SelectedTargetKey.privateChat(chat.targetId)
                        ConversationSidebarRow(
                            target: chat,
                            isSelected: appState.selectedTarget == key,
                            isBusy: appState.isTargetBusy(chat),
                            onReset: { appState.pendingResetTarget = chat },
                            onToggleReply: { Task { await appState.toggleReplyEnabled(!chat.replyEnabled, target: chat) } },
                            onDelete: { appState.pendingDeleteTarget = chat }
                        )
                        .tag(key)
                    }
                } header: {
                    HStack {
                        Text("Agent 私聊 (\(appState.sortedPrivateChats.count))")
                        Spacer()
                        Button {
                            showAddPrivateSheet = true
                        } label: {
                            Image(systemName: "plus")
                        }
                        .buttonStyle(.borderless)
                        .help("添加私聊 QQ 号白名单")
                    }
                }

                Section("只读通知源 (\(appState.sortedSourceGroups.count))") {
                    ForEach(appState.sortedSourceGroups) { source in
                        SourceSidebarRow(source: source)
                            .tag(SelectedTargetKey.source(source.groupId))
                    }
                }
            }
            .listStyle(.sidebar)

            Divider()
            BottomServiceStatusBar(appState: appState) { tab in
                appState.settingsRequestedTab = tab
                openSettings()
            }
        }
        .sheet(isPresented: $showAddGroupSheet) {
            AddGroupSheet(appState: appState)
        }
        .sheet(isPresented: $showAddPrivateSheet) {
            AddPrivateChatSheet(appState: appState)
        }
    }
}

private struct ConversationSidebarRow: View {
    let target: ConversationTarget
    let isSelected: Bool
    let isBusy: Bool
    let onReset: () -> Void
    let onToggleReply: () -> Void
    let onDelete: () -> Void

    @State private var isHovering = false

    private var canReset: Bool {
        !isBusy && !(target.targetType == "private" && target.contextLink != nil)
    }

    private var canDelete: Bool {
        !isBusy && target.contextLink == nil
    }

    var body: some View {
        HStack(spacing: 8) {
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 4) {
                    Text(target.resolvedTitle)
                        .lineLimit(1)
                        .font(.body.weight(.medium))
                    if target.contextLink != nil {
                        Image(systemName: "link")
                            .font(.caption2)
                            .foregroundStyle(.blue)
                            .help("已绑定共享群上下文")
                    }
                }
                Text(target.targetId)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
            Spacer()
            if target.activeReply?.running == true || target.busy == true {
                ProgressView()
                    .controlSize(.small)
            }
            if !target.replyEnabled {
                Image(systemName: "speaker.slash.fill")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .help("已静音（禁止回复）")
            }
            if let pending = target.pendingCount, pending > 0 {
                Text("\(pending)")
                    .font(.caption2.monospacedDigit().weight(.semibold))
                    .padding(.horizontal, 6)
                    .padding(.vertical, 2)
                    .background(Color.accentColor.opacity(0.2), in: Capsule())
            }
            if target.lastError != nil || target.failedDelivery != nil {
                Circle()
                    .fill(Color.red)
                    .frame(width: 7, height: 7)
                    .help(target.lastError ?? "发送未完成")
            }
            if isHovering || isSelected {
                Button(role: .destructive) {
                    onDelete()
                } label: {
                    Image(systemName: "trash")
                        .font(.caption)
                        .foregroundStyle(canDelete ? AnyShapeStyle(.red) : AnyShapeStyle(.tertiary))
                }
                .buttonStyle(.borderless)
                .disabled(!canDelete)
                .help(canDelete ? "删除会话并清理工作目录与记录" : (target.contextLink != nil ? "请先解除共享群上下文关联" : "会话运行中，暂不可删除"))
            }
        }
        .padding(.vertical, 2)
        .onHover { hovering in
            isHovering = hovering
        }
        .contextMenu {
            Button {
                onReset()
            } label: {
                Label("新建会话（清空工作区与记录）…", systemImage: "arrow.counterclockwise")
            }
            .disabled(!canReset)

            Button {
                onToggleReply()
            } label: {
                Label(target.replyEnabled ? "暂停回复当前会话" : "允许回复当前会话",
                      systemImage: target.replyEnabled ? "speaker.slash" : "speaker.wave.2")
            }

            Divider()

            Button(role: .destructive) {
                onDelete()
            } label: {
                Label("删除网关会话…", systemImage: "trash")
            }
            .disabled(!canDelete)
        }
    }
}

private struct SourceSidebarRow: View {
    let source: SourceGroupState

    var body: some View {
        HStack(spacing: 8) {
            VStack(alignment: .leading, spacing: 2) {
                Text(source.groupName ?? "群 \(source.groupId)")
                    .lineLimit(1)
                Text("只读源 · \(source.subscriptionCount ?? 0) 个订阅")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
            Spacer()
            if (source.failedSubscriberCount ?? 0) > 0 {
                Circle()
                    .fill(Color.red)
                    .frame(width: 7, height: 7)
            } else if (source.pendingSubscriberCount ?? 0) > 0 {
                Text("\(source.pendingSubscriberCount ?? 0)")
                    .font(.caption2.monospacedDigit())
                    .padding(.horizontal, 6)
                    .padding(.vertical, 2)
                    .background(Color.orange.opacity(0.2), in: Capsule())
            }
        }
        .padding(.vertical, 2)
    }
}

private struct BottomServiceStatusBar: View {
    let appState: AppState
    let onSelectTab: (String) -> Void

    private var hubColor: Color {
        if case .connected = appState.connectionStatus { return .green }
        if case .reconnecting = appState.connectionStatus { return .orange }
        return .red
    }

    private var oneBotColor: Color {
        guard let oneBot = appState.qqLoginStatus else { return .secondary }
        return oneBot.isOnline ? .green : .red
    }

    private var workbuddyColor: Color {
        guard let engine = appState.maintenance?.engine else { return .secondary }
        if engine.engineReady == false { return .orange }
        return (engine.activeTargets?.isEmpty ?? true) ? .green : .blue
    }

    var body: some View {
        HStack(spacing: 6) {
            ServiceLightButton(title: "Hub", color: hubColor) { onSelectTab("general") }
            ServiceLightButton(title: "QQ", color: oneBotColor) { onSelectTab("accounts") }
            ServiceLightButton(title: "WorkBuddy", color: workbuddyColor) { onSelectTab("accounts") }
        }
        .padding(8)
    }
}

private struct ServiceLightButton: View {
    let title: String
    let color: Color
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 4) {
                Circle().fill(color).frame(width: 7, height: 7)
                Text(title).font(.caption2.weight(.medium)).lineLimit(1)
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 4)
            .background(.quaternary.opacity(0.4), in: RoundedRectangle(cornerRadius: 6))
        }
        .buttonStyle(.plain)
    }
}

private struct AddGroupSheet: View {
    let appState: AppState
    @Environment(\.dismiss) private var dismiss
    @State private var candidates: [AvailableGroupCandidate] = []
    @State private var selectedGroupId: String = ""
    @State private var isLoading = false
    @State private var isSaving = false
    @State private var errorMessage: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("添加 Agent 群聊白名单")
                .font(.headline)
            Text("仅显示机器人已加入、且尚未作为 Agent 群或只读通知源管理的 QQ 群。")
                .font(.callout)
                .foregroundStyle(.secondary)

            if isLoading {
                HStack {
                    ProgressView()
                    Text("正在读取机器人已加入的群…")
                }
                .padding(.vertical, 20)
            } else if candidates.isEmpty {
                Text("暂无可加入的候选群聊，请确认 QQ 小号在线或点击刷新。")
                    .foregroundStyle(.secondary)
                    .padding(.vertical, 16)
            } else {
                Picker("选择 QQ 群", selection: $selectedGroupId) {
                    Text("请选择群聊").tag("")
                    ForEach(candidates) { group in
                        Text("\(group.groupName ?? "未命名群") · \(group.groupId)").tag(group.groupId)
                    }
                }
                .labelsHidden()
            }

            if let errorMessage {
                ErrorBannerView(message: errorMessage)
            }

            HStack {
                Button("刷新列表") {
                    Task { await loadCandidates() }
                }
                .disabled(isLoading || isSaving)
                Spacer()
                Button("取消") { dismiss() }
                Button("加入白名单") {
                    Task { await save() }
                }
                .buttonStyle(.borderedProminent)
                .disabled(selectedGroupId.isEmpty || isSaving)
            }
        }
        .padding(20)
        .frame(width: 440)
        .task { await loadCandidates() }
    }

    private func loadCandidates() async {
        isLoading = true
        errorMessage = nil
        defer { isLoading = false }
        do {
            candidates = try await appState.apiClient.fetchAvailableGroups()
            if selectedGroupId.isEmpty, let first = candidates.first {
                selectedGroupId = first.groupId
            }
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func save() async {
        guard !selectedGroupId.isEmpty else { return }
        isSaving = true
        errorMessage = nil
        defer { isSaving = false }
        do {
            try await appState.apiClient.addGroup(groupId: selectedGroupId)
            appState.selectedTarget = .group(selectedGroupId)
            await appState.refreshNow()
            dismiss()
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}

private enum PrivateChatAddMode: String, CaseIterable, Identifiable {
    case friendList = "从好友列表选择"
    case manualQQ = "手动输入 QQ 号"

    var id: String { rawValue }
}

private struct AddPrivateChatSheet: View {
    let appState: AppState
    @Environment(\.dismiss) private var dismiss
    @State private var mode: PrivateChatAddMode = .friendList
    @State private var friends: [AvailableFriendCandidate] = []
    @State private var selectedFriendId: String = ""
    @State private var friendSearch: String = ""
    @State private var isLoadingFriends = false
    @State private var qqNumber = ""
    @State private var displayName = ""
    @State private var lastAutoDisplayName = ""
    @State private var isSaving = false
    @State private var errorMessage: String?

    private var filteredFriends: [AvailableFriendCandidate] {
        let q = friendSearch.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !q.isEmpty else { return friends }
        return friends.filter { friend in
            friend.userId.lowercased().contains(q)
                || friend.resolvedLabel.lowercased().contains(q)
                || (friend.nickname?.lowercased().contains(q) ?? false)
                || (friend.remark?.lowercased().contains(q) ?? false)
        }
    }

    private var resolvedUserId: String {
        switch mode {
        case .friendList:
            return selectedFriendId.trimmingCharacters(in: .whitespacesAndNewlines)
        case .manualQQ:
            return qqNumber.trimmingCharacters(in: .whitespacesAndNewlines)
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("添加 Agent 私聊白名单")
                .font(.headline)

            Picker("添加方式", selection: $mode) {
                ForEach(PrivateChatAddMode.allCases) { item in
                    Text(item.rawValue).tag(item)
                }
            }
            .pickerStyle(.segmented)

            if mode == .friendList {
                VStack(alignment: .leading, spacing: 8) {
                    TextField("搜索好友昵称、备注或 QQ 号", text: $friendSearch)
                        .textFieldStyle(.roundedBorder)

                    if isLoadingFriends {
                        HStack(spacing: 8) {
                            ProgressView().controlSize(.small)
                            Text("正在读取机器人 QQ 好友列表…")
                                .font(.callout)
                                .foregroundStyle(.secondary)
                        }
                        .frame(maxWidth: .infinity, minHeight: 170)
                    } else if filteredFriends.isEmpty {
                        Text(friends.isEmpty ? "暂无可添加的好友（可能都已在白名单中或 QQ 离线），可点下方刷新或切换为手动输入。" : "没有匹配「\(friendSearch)」的好友。")
                            .font(.callout)
                            .foregroundStyle(.secondary)
                            .frame(maxWidth: .infinity, minHeight: 140, alignment: .center)
                    } else {
                        List(filteredFriends, selection: $selectedFriendId) { friend in
                            HStack(spacing: 8) {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(friend.resolvedLabel)
                                        .font(.callout.weight(.medium))
                                        .lineLimit(1)
                                    Text(friend.userId)
                                        .font(.caption2.monospaced())
                                        .foregroundStyle(.secondary)
                                }
                                Spacer()
                                if selectedFriendId == friend.userId {
                                    Image(systemName: "checkmark.circle.fill")
                                        .foregroundStyle(Color.accentColor)
                                }
                            }
                            .contentShape(Rectangle())
                            .tag(friend.userId)
                        }
                        .listStyle(.inset)
                        .frame(height: 190)
                        .clipShape(RoundedRectangle(cornerRadius: 8))
                        .overlay(
                            RoundedRectangle(cornerRadius: 8)
                                .stroke(Color.secondary.opacity(0.2), lineWidth: 1)
                        )
                    }

                    TextField("备注名（可选，留空自动使用好友昵称/备注）", text: $displayName)
                        .textFieldStyle(.roundedBorder)
                }
            } else {
                Form {
                    TextField("对方 QQ 号（5–14 位数字）", text: $qqNumber)
                    TextField("备注名（可选）", text: $displayName)
                }
                .formStyle(.grouped)
            }

            if let errorMessage {
                ErrorBannerView(message: errorMessage)
            }

            HStack {
                if mode == .friendList {
                    Button("刷新好友列表") {
                        Task { await loadFriends() }
                    }
                    .disabled(isLoadingFriends || isSaving)
                }
                Spacer()
                Button("取消") { dismiss() }
                Button("加入白名单") {
                    Task { await save() }
                }
                .buttonStyle(.borderedProminent)
                .disabled(resolvedUserId.isEmpty || isSaving)
            }
        }
        .padding(20)
        .frame(width: 460)
        .task { await loadFriends() }
        .onChange(of: selectedFriendId) { _, newValue in
            guard let chosen = friends.first(where: { $0.userId == newValue }) else { return }
            qqNumber = chosen.userId
            let autoName = chosen.displayName ?? chosen.remark ?? chosen.nickname ?? ""
            if displayName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || displayName == lastAutoDisplayName {
                displayName = autoName
                lastAutoDisplayName = autoName
            }
        }
    }

    private func loadFriends() async {
        isLoadingFriends = true
        errorMessage = nil
        defer { isLoadingFriends = false }
        do {
            friends = try await appState.apiClient.fetchAvailableFriends()
            if selectedFriendId.isEmpty, let first = friends.first {
                selectedFriendId = first.userId
            }
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func save() async {
        let cleanQQ = resolvedUserId
        guard !cleanQQ.isEmpty else { return }
        isSaving = true
        errorMessage = nil
        defer { isSaving = false }
        do {
            try await appState.apiClient.addPrivateChat(
                userId: cleanQQ,
                displayName: displayName.trimmingCharacters(in: .whitespacesAndNewlines)
            )
            appState.selectedTarget = .privateChat(cleanQQ)
            await appState.refreshNow()
            dismiss()
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}
