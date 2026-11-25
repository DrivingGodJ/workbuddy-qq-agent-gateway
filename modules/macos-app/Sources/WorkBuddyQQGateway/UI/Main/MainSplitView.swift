import SwiftUI

struct MainSplitView: View {
    @Bindable var appState: AppState
    @Environment(\.openSettings) private var openSettings
    @Environment(\.openWindow) private var openWindow

    @State private var isOperatingTarget = false
    @State private var sheetErrorMessage: String?

    var body: some View {
        VStack(spacing: 0) {
            if appState.shouldPromptOnboarding {
                HStack {
                    Image(systemName: "wand.and.stars")
                        .foregroundStyle(.blue)
                    Text("检测到本机尚未配置网关服务，可通过图形化向导一键完成环境准备与登录。")
                        .font(.callout)
                    Spacer()
                    Button("打开安装向导") {
                        openWindow(id: "onboarding")
                    }
                    .buttonStyle(.borderedProminent)
                    Button("稍后") {
                        appState.shouldPromptOnboarding = false
                    }
                    .buttonStyle(.borderless)
                }
                .padding(10)
                .background(Color.blue.opacity(0.10))
            }

            if let status = appState.statusBanner {
                InfoBannerView(message: status) {
                    appState.statusBanner = nil
                }
                .padding(.horizontal, 12)
                .padding(.top, 8)
            }

            if let err = appState.errorBanner {
                ErrorBannerView(message: err) {
                    appState.errorBanner = nil
                }
                .padding(.horizontal, 12)
                .padding(.top, 8)
            }

            if let mode = appState.qqLoginPromptMode,
               !appState.qqLoginPromptDismissed,
               !appState.isQQOneBotOnline {
                HStack(spacing: 12) {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .font(.title3)
                        .foregroundStyle(.orange)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(mode == .needsAutoLoginCheck ? "检测到 QQ 停留在登录页，请勾选「自动登录」并登录" : "检测到 QQ 小号尚未登录")
                            .font(.callout.weight(.semibold))
                        Text("首次扫码登录时 Linux QQ 不会显示「自动登录」，第二次启动才会出现该勾选框；勾选一次并点击「登录」后，之后启动就会自动上线。")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    Spacer()
                    Button("打开 QQ 登录桌面 (noVNC)") {
                        appState.embeddedWebSheet = .noVNC
                    }
                    .buttonStyle(.borderedProminent)
                    Button("重新检测") {
                        Task { await appState.checkQQLoginStateNow() }
                    }
                    Button("稍后") {
                        appState.qqLoginPromptDismissed = true
                    }
                    .buttonStyle(.borderless)
                }
                .padding(10)
                .background(Color.orange.opacity(0.14), in: RoundedRectangle(cornerRadius: 8))
                .padding(.horizontal, 12)
                .padding(.top, 8)
            }

            rootContent
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .toolbar {
            ToolbarItem(placement: .principal) {
                Picker("功能视图", selection: $appState.activeSection) {
                    ForEach(MainWorkspaceSection.allCases) { section in
                        if section == .stickers {
                            let count = appState.gatewayState?.qq?.stickers?.total ?? 0
                            Label("表情包 (\(count))", systemImage: section.symbolName).tag(section)
                        } else {
                            Label(section.rawValue, systemImage: section.symbolName).tag(section)
                        }
                    }
                }
                .pickerStyle(.segmented)
                .frame(minWidth: 270)
            }

            ToolbarItemGroup(placement: .primaryAction) {
                Toggle(
                    "Agent 派发",
                    isOn: Binding(
                        get: { appState.gatewayState?.agentDispatch?.enabled ?? true },
                        set: { newValue in
                            Task { await appState.setAgentDispatch(newValue) }
                        }
                    )
                )
                .toggleStyle(.switch)
                .help("关闭后仅记录 QQ 消息，不触发新的模型请求")

                Button {
                    appState.settingsRequestedTab = "general"
                    openSettings()
                } label: {
                    StatusPill(
                        text: appState.connectionStatus.label,
                        color: connectionColor
                    )
                }
                .buttonStyle(.plain)
                .help("点击查看网关与服务运行状态")

                Button {
                    Task { await appState.refreshNow(forceMetadata: true) }
                } label: {
                    Label("刷新", systemImage: "arrow.clockwise")
                }

                if appState.activeSection == .conversations {
                    Button {
                        withAnimation(.easeInOut(duration: 0.16)) {
                            appState.inspectorPresented.toggle()
                        }
                    } label: {
                        Label(appState.inspectorPresented ? "收起操作栏" : "展开操作栏", systemImage: "sidebar.right")
                    }
                    .help(appState.inspectorPresented ? "隐藏右侧会话操作栏" : "固定显示右侧会话操作栏")
                }

                Button {
                    openSettings()
                } label: {
                    Label("设置", systemImage: "gearshape")
                }
                .keyboardShortcut(",", modifiers: .command)
            }
        }
        .sheet(item: $appState.embeddedWebSheet) { kind in
            EmbeddedWebViewSheet(
                kind: kind,
                vncPassword: appState.keychain.read(account: .snowlumaVncPassword),
                appState: appState
            )
        }
        .sheet(item: $appState.pendingDeleteTarget) { target in
            DeleteConversationConfirmSheet(
                target: target,
                isWorking: $isOperatingTarget,
                errorMessage: $sheetErrorMessage,
                onConfirm: {
                    isOperatingTarget = true
                    sheetErrorMessage = nil
                    defer { isOperatingTarget = false }
                    do {
                        try await appState.deleteConversation(target)
                        appState.pendingDeleteTarget = nil
                    } catch {
                        sheetErrorMessage = error.localizedDescription
                    }
                },
                onCancel: {
                    sheetErrorMessage = nil
                    appState.pendingDeleteTarget = nil
                }
            )
        }
        .confirmationDialog(
            "确认新建会话「\(appState.pendingResetTarget?.resolvedTitle ?? "")」？",
            isPresented: Binding(
                get: { appState.pendingResetTarget != nil },
                set: { if !$0 { appState.pendingResetTarget = nil } }
            ),
            titleVisibility: .visible
        ) {
            Button("确认清空并新建会话", role: .destructive) {
                guard let target = appState.pendingResetTarget else { return }
                appState.pendingResetTarget = nil
                Task {
                    do {
                        try await appState.resetConversation(target)
                    } catch {
                        appState.errorBanner = error.localizedDescription
                    }
                }
            }
            Button("取消", role: .cancel) {
                appState.pendingResetTarget = nil
            }
        } message: {
            Text("将删除当前会话的 WorkBuddy 历史、本地聊天记录与缓存媒体，并重置该会话的独立工作目录，然后初始化全新上下文。")
        }
        .onAppear {
            appState.openMainWindowAction = {
                openWindow(id: "main")
                NSApp.activate(ignoringOtherApps: true)
            }
        }
    }

    private var connectionColor: Color {
        switch appState.connectionStatus {
        case .connected: return .green
        case .connecting, .reconnecting: return .orange
        case .offline: return .red
        }
    }

    @ViewBuilder
    private var rootContent: some View {
        switch appState.activeSection {
        case .conversations:
            conversationsRootView
        case .qzone:
            QzonePanelView(appState: appState)
        case .stickers:
            StickerGalleryView(appState: appState)
        }
    }

    private var conversationsRootView: some View {
        HStack(spacing: 0) {
            SidebarView(appState: appState)
                .frame(width: 256)
                .background(.windowBackground)

            Divider()

            centerConversationPane
                .frame(maxWidth: .infinity, maxHeight: .infinity)

            if appState.inspectorPresented {
                Divider()
                dockedRightInspector
                    .frame(width: 340)
                    .background(.windowBackground)
            }
        }
    }

    @ViewBuilder
    private var centerConversationPane: some View {
        if let conversation = appState.currentConversation {
            ConversationView(target: conversation, appState: appState)
        } else if let source = appState.currentSourceGroup {
            SourceGroupView(source: source)
        } else {
            ContentUnavailableView(
                "选择一个会话",
                systemImage: "bubble.left.and.bubble.right",
                description: Text("从左侧选择 Agent 群聊、私聊或只读通知源开始查看与管理。")
            )
        }
    }

    @ViewBuilder
    private var dockedRightInspector: some View {
        if let conversation = appState.currentConversation {
            ConversationInspector(target: conversation, appState: appState)
                .id(conversation.id)
        } else {
            ContentUnavailableView(
                "右侧操作栏已就绪",
                systemImage: "sidebar.right",
                description: Text("在左侧选中任意 Agent 群聊或私聊后，可在此直接配置模型权限、订阅通知、查看诊断并新建或删除会话。")
            )
        }
    }
}

private struct DeleteConversationConfirmSheet: View {
    let target: ConversationTarget
    @Binding var isWorking: Bool
    @Binding var errorMessage: String?
    let onConfirm: () async -> Void
    let onCancel: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 10) {
                Image(systemName: "trash.circle.fill")
                    .font(.title2)
                    .foregroundStyle(.red)
                VStack(alignment: .leading, spacing: 2) {
                    Text("确认删除网关会话？")
                        .font(.headline)
                    Text("\(target.resolvedTitle)（\(target.targetType == "private" ? "QQ" : "群号") \(target.targetId)）")
                        .font(.callout.weight(.medium))
                        .foregroundStyle(.secondary)
                }
            }

            VStack(alignment: .leading, spacing: 6) {
                Text("确认后将立即执行以下清理：")
                    .font(.callout.weight(.medium))
                Text("1. 将该会话移出网关白名单，并解除通知订阅与动态绑定。")
                Text("2. 彻底删除上一个会话的工作目录、WorkBuddy 历史、本地聊天记录与缓存媒体。")
                Text("3. 不会退出 QQ 群，也不会删除 QQ 好友。")
            }
            .font(.caption)
            .foregroundStyle(.secondary)
            .padding(10)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(.quaternary.opacity(0.4), in: RoundedRectangle(cornerRadius: 8))

            if let errorMessage {
                ErrorBannerView(message: errorMessage)
            }

            HStack {
                Spacer()
                Button("取消") { onCancel() }
                    .disabled(isWorking)
                Button(isWorking ? "正在删除并清理…" : "确认删除并清理", role: .destructive) {
                    Task { await onConfirm() }
                }
                .buttonStyle(.borderedProminent)
                .tint(.red)
                .disabled(isWorking)
            }
        }
        .padding(20)
        .frame(width: 440)
    }
}
