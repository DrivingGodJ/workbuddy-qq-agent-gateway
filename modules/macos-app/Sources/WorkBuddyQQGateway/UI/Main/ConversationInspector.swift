import SwiftUI

enum InspectorTab: String, CaseIterable, Identifiable {
    case settings = "参数"
    case subscriptions = "订阅"
    case session = "会话"
    case diagnostics = "诊断"

    var id: String { rawValue }
}

struct ConversationInspector: View {
    let target: ConversationTarget
    @Bindable var appState: AppState
    @State private var selectedTab: InspectorTab = .settings

    var body: some View {
        VStack(spacing: 0) {
            Picker("检查器标签", selection: $selectedTab) {
                ForEach(InspectorTab.allCases) { tab in
                    Text(tab.rawValue).tag(tab)
                }
            }
            .pickerStyle(.segmented)
            .padding(10)

            Divider()

            ScrollView {
                switch selectedTab {
                case .settings:
                    ConversationConfigTab(target: target, appState: appState)
                case .subscriptions:
                    ConversationSubscriptionsTab(target: target, appState: appState)
                case .session:
                    ConversationMaintenanceTab(target: target, appState: appState)
                case .diagnostics:
                    ConversationDiagnosticsTab(target: target, appState: appState)
                }
            }
        }
    }
}

// MARK: - Tab A: 会话参数

private struct ConversationConfigTab: View {
    let target: ConversationTarget
    @Bindable var appState: AppState
    @Environment(\.openSettings) private var openSettings

    @State private var model: String = "auto"
    @State private var effort: String = "auto"
    @State private var contextLimit: ContextTokenLimit = .auto
    @State private var permissionMode: String = "workspaceWrite"
    @State private var calendarEnabled: Bool = false
    @State private var haPermission: String = "owner"
    @State private var groupEssenceEnabled: Bool = false
    @State private var groupMuteEnabled: Bool = false
    @State private var greetings: [SpeakerGreetingPlan] = []
    @State private var contextLinkGroupId: String = ""
    @State private var showContextLinkConfirm = false
    @State private var isSaving = false
    @State private var statusMessage: String?
    @State private var errorMessage: String?

    private var availableModels: [AIModelDescriptor] {
        appState.gatewayState?.ai?.availableModels ?? []
    }

    private var currentModelDescriptor: AIModelDescriptor? {
        availableModels.first { $0.model == model } ?? availableModels.first
    }

    private var supportedEfforts: [ReasoningEffortOption] {
        currentModelDescriptor?.supportedReasoningEfforts ?? [ReasoningEffortOption(reasoningEffort: "auto", description: nil)]
    }

    private var isSharedPrivate: Bool {
        target.targetType == "private" && !(contextLinkGroupId.isEmpty) && target.contextLink != nil
    }

    private var isBusy: Bool {
        target.busy == true
            || target.activeReply?.running == true
            || target.qzoneActivity != nil
            || (target.contextQueue?.active != nil)
            || !(target.contextQueue?.queued?.isEmpty ?? true)
    }

    private var haReady: Bool { appState.homeAssistantReadiness?.ready == true }
    private var speakerReady: Bool { appState.homeAssistantReadiness?.speakerReady == true }
    private var canEditSpeakerPlans: Bool { speakerReady && haPermission != "disabled" }
    private var calendarReady: Bool { appState.permissionSummary.calendarRemindersReady }
    private var botIsGroupAdmin: Bool { target.targetType == "group" && target.botIsGroupAdmin }
    private var hasMissingWeekdays: Bool { canEditSpeakerPlans && greetings.contains { $0.days.isEmpty } }
    private var weatherCity: String? { appState.gatewayState?.ai?.speakerWeatherCity }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            if target.targetType == "private" {
                GroupBox("共享群聊上下文") {
                    VStack(alignment: .leading, spacing: 8) {
                        Picker("关联群聊", selection: $contextLinkGroupId) {
                            Text("独立私聊").tag("")
                            ForEach(appState.sortedGroups) { grp in
                                Text("\(grp.resolvedTitle) · \(grp.targetId)").tag(grp.targetId)
                            }
                        }
                        Text("绑定后共用群聊模型上下文与工作区，模型/思考/压缩阈值将锁定跟随群设置。")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        Button("保存上下文关联") {
                            showContextLinkConfirm = true
                        }
                        .disabled(isSaving || isBusy || contextLinkGroupId == (target.contextLink?.groupId ?? ""))
                    }
                    .padding(6)
                }
            }

            GroupBox("模型与执行权限") {
                VStack(alignment: .leading, spacing: 10) {
                    Picker("模型", selection: $model) {
                        ForEach(availableModels) { item in
                            Text(item.displayName ?? item.model).tag(item.model)
                        }
                    }
                    .disabled(isSharedPrivate)
                    .onChange(of: model) { _, _ in
                        if !supportedEfforts.contains(where: { $0.reasoningEffort == effort }) {
                            effort = supportedEfforts.first?.reasoningEffort ?? "auto"
                        }
                    }

                    Picker("思考强度", selection: $effort) {
                        ForEach(supportedEfforts, id: \.reasoningEffort) { opt in
                            Text(opt.reasoningEffort).tag(opt.reasoningEffort)
                        }
                    }
                    .disabled(isSharedPrivate)

                    Picker("自动压缩阈值", selection: $contextLimit) {
                        ForEach(appState.gatewayState?.ai?.contextTokenOptions ?? []) { opt in
                            Text(opt.label).tag(opt.value)
                        }
                    }
                    .disabled(isSharedPrivate)

                    if isSharedPrivate {
                        Text("当前私聊正在共享群上下文，模型/思考强度/压缩阈值跟随目标群聊。")
                            .font(.caption)
                            .foregroundStyle(.blue)
                    }

                    Divider()

                    Picker("执行权限", selection: $permissionMode) {
                        ForEach(filteredPermissionOptions) { opt in
                            Text(opt.label).tag(opt.value)
                        }
                    }
                    if let selectedPerm = filteredPermissionOptions.first(where: { $0.value == permissionMode }),
                       let desc = selectedPerm.description {
                        Text(desc)
                            .font(.caption)
                            .foregroundStyle(permissionMode == "dangerFullAccess" ? .orange : .secondary)
                    }

                    Toggle("日历与待办自动化权限", isOn: calendarReady ? $calendarEnabled : .constant(false))
                        .font(.callout)
                        .disabled(!calendarReady || isSaving || isBusy)
                    if !calendarReady {
                        permissionHelp("需要为老代授予日历与提醒事项的完全访问权限。")
                    }

                    Picker("智能家居与小爱权限", selection: $haPermission) {
                        ForEach(filteredHaOptions) { opt in
                            Text(opt.label).tag(opt.value)
                        }
                    }
                    .disabled(!haReady || isSaving || isBusy)
                    if !haReady {
                        permissionHelp(appState.homeAssistantReadiness?.reason ?? "网关尚未确认 Home Assistant 连接。")
                    }
                }
                .padding(6)
            }

            if target.targetType == "group" {
                GroupBox {
                    VStack(alignment: .leading, spacing: 8) {
                        Toggle(
                            "允许设置精华消息",
                            isOn: (botIsGroupAdmin || groupEssenceEnabled) ? $groupEssenceEnabled : .constant(false)
                        )
                        .disabled((!botIsGroupAdmin && !groupEssenceEnabled) || isSaving || isBusy)
                        Text("开启后自动在系统提示词中引导机器人将优质或重要消息设为精华，无需每次手动授权。")
                            .font(.caption)
                            .foregroundStyle(.secondary)

                        Toggle(
                            "允许管理群禁言（违反公序良俗酌情禁言）",
                            isOn: (botIsGroupAdmin || groupMuteEnabled) ? $groupMuteEnabled : .constant(false)
                        )
                        .disabled((!botIsGroupAdmin && !groupMuteEnabled) || isSaving || isBusy)
                        Text("开启后自动在系统提示词中引导机器人对违反公序良俗、恶意辱骂或刷屏的普通成员酌情限时禁言（最长 10 分钟）。")
                            .font(.caption)
                            .foregroundStyle(.secondary)

                        if !botIsGroupAdmin {
                            VStack(alignment: .leading, spacing: 4) {
                                Text("当前机器人在本群身份为「\(target.botRoleLabel)」，设为群管理员后点击右侧或顶部刷新即可开启上述权限。")
                                    .font(.caption)
                                    .foregroundStyle(.orange)
                                Button("立即刷新群身份") {
                                    Task { await appState.refreshNow(forceMetadata: true) }
                                }
                                .buttonStyle(.link)
                                .controlSize(.small)
                            }
                        }
                    }
                    .padding(6)
                } label: {
                    HStack {
                        Text("群管理员自主权限")
                        Spacer()
                        StatusPill(text: target.botRoleLabel, color: botIsGroupAdmin ? .green : .secondary)
                    }
                }
            }

            GroupBox("小爱定时播报 (\(greetings.count))") {
                VStack(alignment: .leading, spacing: 8) {
                    if haPermission == "disabled", haReady {
                        Text("先开启本会话的智能家居权限，再设置播报。")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    } else if !speakerReady {
                        permissionHelp(appState.homeAssistantReadiness?.reason ?? "网关尚未确认可用的小爱播报设备。")
                    }

                    VStack(alignment: .leading, spacing: 10) {
                        ForEach($greetings) { $plan in
                            SpeakerGreetingEditor(plan: $plan, weatherCity: weatherCity) {
                                let id = plan.id
                                greetings.removeAll { $0.id == id }
                            }
                        }
                        Button {
                            let newId = "plan-\(UUID().uuidString.lowercased())"
                            greetings.append(SpeakerGreetingPlan(id: newId, time: "08:00", days: [1, 2, 3, 4, 5], enabled: false, weather: false))
                        } label: {
                            Label("添加播报计划", systemImage: "plus")
                        }
                        .controlSize(.small)
                        .disabled(greetings.count >= 32)
                    }
                    .disabled(!canEditSpeakerPlans || isSaving || isBusy)
                }
                .padding(6)
            }

            if let errorMessage {
                ErrorBannerView(message: errorMessage)
            }
            if let statusMessage {
                InfoBannerView(message: statusMessage)
            }

            Button {
                Task { await saveConfig() }
            } label: {
                Text(isSaving ? "保存中…" : (isBusy ? "会话运行中，暂不可保存" : "保存会话参数"))
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .disabled(isSaving || isBusy || hasMissingWeekdays)
        }
        .padding(12)
        .onAppear { syncFromTarget() }
        .onChange(of: target.id) { _, _ in syncFromTarget() }
        .confirmationDialog(
            "确认更改共享群聊上下文？",
            isPresented: $showContextLinkConfirm,
            titleVisibility: .visible
        ) {
            Button("确认保存") {
                Task { await saveContextLink() }
            }
            Button("取消", role: .cancel) {}
        } message: {
            Text(contextLinkGroupId.isEmpty
                 ? "解除关联后将恢复原独立私聊会话；已进入群上下文的内容不会从群会话中抹除。"
                 : "绑定后该私聊将与所选群共用模型上下文与工作区；原私聊会话会搁置保留。")
        }
    }

    private func permissionHelp(_ text: String) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(text).font(.caption).foregroundStyle(.secondary)
            Button("打开智能家居与权限设置") {
                appState.settingsRequestedTab = "permissions"
                openSettings()
            }
            .buttonStyle(.link)
            .controlSize(.small)
        }
    }

    private var filteredPermissionOptions: [PermissionOption] {
        (appState.gatewayState?.ai?.permissionModeOptions ?? [])
            .filter { $0.targetTypes?.contains(target.targetType) ?? true }
    }

    private var filteredHaOptions: [PermissionOption] {
        (appState.gatewayState?.ai?.homeAssistantPermissionOptions ?? [])
            .filter { $0.targetTypes?.contains(target.targetType) ?? true }
    }

    private func syncFromTarget() {
        let cfg = target.effectiveConfig
        model = cfg.model ?? appState.gatewayState?.ai?.model ?? "auto"
        effort = cfg.reasoningEffort ?? appState.gatewayState?.ai?.reasoningEffort ?? "auto"
        contextLimit = cfg.contextTokenLimit ?? .auto
        permissionMode = cfg.permissionMode ?? "workspaceWrite"
        calendarEnabled = cfg.calendarRemindersEnabled ?? false
        haPermission = cfg.homeAssistantPermission ?? "owner"
        groupEssenceEnabled = cfg.groupEssenceEnabled ?? false
        groupMuteEnabled = cfg.groupMuteEnabled ?? false
        greetings = cfg.speakerGreetings ?? []
        contextLinkGroupId = target.contextLink?.groupId ?? ""
        statusMessage = nil
        errorMessage = nil
    }

    private func saveConfig() async {
        guard !hasMissingWeekdays else { return }
        isSaving = true
        errorMessage = nil
        statusMessage = nil
        defer { isSaving = false }
        let payload = AgentConfig(
            model: model,
            reasoningEffort: effort,
            contextTokenLimit: contextLimit,
            workingMode: "agent",
            permissionMode: permissionMode,
            calendarRemindersEnabled: calendarReady ? calendarEnabled : target.agentConfig?.calendarRemindersEnabled ?? false,
            homeAssistantPermission: haReady ? haPermission : target.agentConfig?.homeAssistantPermission ?? "owner",
            groupEssenceEnabled: target.targetType == "group" ? groupEssenceEnabled : false,
            groupMuteEnabled: target.targetType == "group" ? groupMuteEnabled : false,
            speakerGreetings: canEditSpeakerPlans ? greetings : target.agentConfig?.speakerGreetings
        )
        do {
            try await appState.apiClient.saveConfig(targetType: target.targetType, targetId: target.targetId, config: payload)
            statusMessage = "已保存；将从下一轮对话生效。"
            await appState.refreshNow()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func saveContextLink() async {
        isSaving = true
        errorMessage = nil
        statusMessage = nil
        defer { isSaving = false }
        do {
            try await appState.apiClient.setContextLink(
                privateId: target.targetId,
                groupId: contextLinkGroupId.isEmpty ? nil : contextLinkGroupId
            )
            statusMessage = "上下文关联已更新。"
            await appState.refreshNow()
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}

private struct SpeakerGreetingEditor: View {
    @Binding var plan: SpeakerGreetingPlan
    let weatherCity: String?
    let remove: () -> Void

    private static let weekdays = [
        (1, "一"), (2, "二"), (3, "三"), (4, "四"), (5, "五"), (6, "六"), (0, "日")
    ]

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                DatePicker("播报时间", selection: $plan.timeSelection, displayedComponents: [.hourAndMinute])
                    .datePickerStyle(.stepperField)
                    .environment(\.timeZone, SpeakerGreetingPlan.timeZone)
                    .environment(\.locale, Locale(identifier: "en_GB"))
                    .accessibilityHint("北京时间")
                Spacer(minLength: 0)
                Button(role: .destructive, action: remove) {
                    Image(systemName: "trash")
                }
                .buttonStyle(.borderless)
                .accessibilityLabel("删除播报计划")
            }

            Text("每周重复 · 北京时间")
                .font(.caption)
                .foregroundStyle(.secondary)
            LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 3), count: 7), spacing: 3) {
                ForEach(Self.weekdays, id: \.0) { day, name in
                    Toggle(name, isOn: weekday(day))
                        .toggleStyle(.button)
                        .controlSize(.small)
                        .accessibilityLabel("星期\(name)")
                }
            }
            if plan.days.isEmpty {
                Text("至少选择一天才能保存。")
                    .font(.caption)
                    .foregroundStyle(.orange)
            }

            Toggle("启用", isOn: $plan.enabled)
            Toggle(weatherCity.map { "播报\($0)天气" } ?? "播报天气", isOn: $plan.weather)
                .disabled(weatherCity == nil)
            if weatherCity == nil {
                Text("请在智能家居设置中填写天气城市。")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(8)
        .background(.quaternary.opacity(0.35), in: RoundedRectangle(cornerRadius: 6))
    }

    private func weekday(_ day: Int) -> Binding<Bool> {
        Binding(
            get: { plan.days.contains(day) },
            set: { plan.setWeekday(day, selected: $0) }
        )
    }
}

// MARK: - Tab B: 通知订阅

private struct ConversationSubscriptionsTab: View {
    let target: ConversationTarget
    @Bindable var appState: AppState

    @State private var showFormSheet = false
    @State private var editingSubscription: SubscriptionItem?
    @State private var errorMessage: String?

    private var subscriptions: [SubscriptionItem] {
        target.subscriptions ?? []
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text("已订阅通知源 (\(subscriptions.count))")
                    .font(.headline)
                Spacer()
                Button {
                    editingSubscription = nil
                    showFormSheet = true
                } label: {
                    Label("新增", systemImage: "plus")
                }
                .controlSize(.small)
            }

            if subscriptions.isEmpty {
                Text("当前会话尚未订阅任何只读通知源群。")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .padding(.vertical, 12)
            } else {
                ForEach(subscriptions) { sub in
                    GroupBox {
                        VStack(alignment: .leading, spacing: 6) {
                            HStack {
                                Text(sub.sourceGroupName ?? "群 \(sub.sourceGroupId)")
                                    .font(.callout.weight(.semibold))
                                Spacer()
                                StatusPill(text: sub.enabled ? "已启用" : "已停用", color: sub.enabled ? .green : .secondary)
                            }
                            Text("来源群号：\(sub.sourceGroupId)")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                            Text("范围：\(sub.intakeMode == "ADMIN_ONLY" ? "仅群管触发" : "全部消息") · 等待 \(String(format: "%.1f", sub.collectionDelayMinutes)) 分钟")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                            if let pending = sub.state?.pendingCount, pending > 0 {
                                Text("待汇总消息：\(pending) 条")
                                    .font(.caption)
                                    .foregroundStyle(.orange)
                            }
                            if let err = sub.state?.lastError {
                                Text(err)
                                    .font(.caption)
                                    .foregroundStyle(.red)
                            }
                            HStack {
                                Button("编辑") {
                                    editingSubscription = sub
                                    showFormSheet = true
                                }
                                .controlSize(.small)
                                Spacer()
                                Button("删除", role: .destructive) {
                                    Task { await deleteSubscription(sub.id) }
                                }
                                .controlSize(.small)
                            }
                        }
                        .padding(4)
                    }
                }
            }

            if let errorMessage {
                ErrorBannerView(message: errorMessage)
            }
        }
        .padding(12)
        .sheet(isPresented: $showFormSheet) {
            SubscriptionEditorSheet(target: target, existing: editingSubscription, appState: appState)
        }
    }

    private func deleteSubscription(_ id: String) async {
        errorMessage = nil
        do {
            try await appState.apiClient.deleteSubscription(id: id)
            await appState.refreshNow()
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}

private struct SubscriptionEditorSheet: View {
    let target: ConversationTarget
    let existing: SubscriptionItem?
    @Bindable var appState: AppState
    @Environment(\.dismiss) private var dismiss

    @State private var sourceGroupId: String = ""
    @State private var intakeMode: String = "ADMIN_ONLY"
    @State private var delayMinutes: Double = 10
    @State private var enabled: Bool = true
    @State private var isSaving = false
    @State private var errorMessage: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text(existing == nil ? "新增通知源订阅" : "编辑通知源订阅")
                .font(.headline)

            Form {
                if let candidates = appState.gatewayState?.qq?.availableSourceGroups, !candidates.isEmpty {
                    Picker("选择来源群", selection: $sourceGroupId) {
                        Text("请选择来源群").tag("")
                        ForEach(candidates) { cand in
                            Text("\(cand.groupName ?? "未命名群") · \(cand.groupId)").tag(cand.groupId)
                        }
                    }
                }
                TextField("来源 QQ 群号", text: $sourceGroupId)
                Picker("消息范围", selection: $intakeMode) {
                    Text("群管触发（附带上下文）").tag("ADMIN_ONLY")
                    Text("全部消息").tag("ALL")
                }
                TextField("最后消息后等待（分钟，0.1–1440）", value: $delayMinutes, format: .number)
                Toggle("启用订阅", isOn: $enabled)
            }
            .formStyle(.grouped)

            if let errorMessage {
                ErrorBannerView(message: errorMessage)
            }

            HStack {
                Spacer()
                Button("取消") { dismiss() }
                Button("保存订阅") {
                    Task { await save() }
                }
                .buttonStyle(.borderedProminent)
                .disabled(sourceGroupId.trimmingCharacters(in: .whitespaces).isEmpty || isSaving)
            }
        }
        .padding(20)
        .frame(width: 440)
        .onAppear {
            if let existing {
                sourceGroupId = existing.sourceGroupId
                intakeMode = existing.intakeMode
                delayMinutes = existing.collectionDelayMinutes
                enabled = existing.enabled
            } else if let first = appState.gatewayState?.qq?.availableSourceGroups?.first {
                sourceGroupId = first.groupId
            }
        }
    }

    private func save() async {
        isSaving = true
        errorMessage = nil
        defer { isSaving = false }
        do {
            _ = try await appState.apiClient.upsertSubscription(
                id: existing?.id,
                targetType: target.targetType,
                targetId: target.targetId,
                sourceGroupId: sourceGroupId.trimmingCharacters(in: .whitespacesAndNewlines),
                intakeMode: intakeMode,
                collectionDelayMinutes: min(1440, max(0.1, delayMinutes)),
                enabled: enabled
            )
            await appState.refreshNow()
            dismiss()
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}

// MARK: - Tab C: 会话状态与维护

private struct ConversationMaintenanceTab: View {
    let target: ConversationTarget
    @Bindable var appState: AppState

    @State private var actionStatus: String?
    @State private var errorMessage: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            GroupBox("会话状态") {
                Grid(alignment: .leading, horizontalSpacing: 12, verticalSpacing: 6) {
                    GridRow {
                        Text("threadId").foregroundStyle(.secondary)
                        Text(target.threadId ?? "—").textSelection(.enabled).font(.caption.monospaced())
                    }
                    GridRow {
                        Text("会话锁").foregroundStyle(.secondary)
                        Text(target.threadLock?.status ?? "—")
                    }
                    GridRow {
                        Text("创建时间").foregroundStyle(.secondary)
                        Text(DateFormatting.shortTime(target.threadCreatedAt))
                    }
                    GridRow {
                        Text("最近活动").foregroundStyle(.secondary)
                        Text(DateFormatting.shortTime(target.lastActivityAt))
                    }
                    GridRow {
                        Text("待处理消息").foregroundStyle(.secondary)
                        Text("\(target.pendingCount ?? 0)")
                    }
                    GridRow {
                        Text("Worker").foregroundStyle(.secondary)
                        Text(target.activeReply?.status ?? "idle")
                    }
                    GridRow {
                        Text("Trigger").foregroundStyle(.secondary)
                        Text(target.pendingTrigger?.reason ?? "—")
                    }
                }
                .font(.caption)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(6)
            }

            VStack(spacing: 8) {
                Button("查看会话 ID") {
                    Task { await runAction("session") }
                }
                .frame(maxWidth: .infinity)
                Button("重试待处理消息") {
                    Task { await runAction("retry") }
                }
                .frame(maxWidth: .infinity)
                Button("新建当前会话（清空工作区与记录）", role: .destructive) {
                    appState.pendingResetTarget = target
                }
                .frame(maxWidth: .infinity)
                .disabled(appState.isTargetBusy(target) || (target.targetType == "private" && target.contextLink != nil))
            }

            if let actionStatus {
                InfoBannerView(message: actionStatus)
            }
            if let errorMessage {
                ErrorBannerView(message: errorMessage)
            }

            Divider()

            GroupBox("删除会话与数据清理") {
                VStack(alignment: .leading, spacing: 8) {
                    Text("从网关白名单删除该会话，并彻底清空其工作目录、本地聊天记录、缓存媒体与 WorkBuddy 会话历史（不会退群或删好友）。")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Button("删除网关会话…", role: .destructive) {
                        appState.pendingDeleteTarget = target
                    }
                    .frame(maxWidth: .infinity)
                    .disabled(appState.isTargetBusy(target) || target.contextLink != nil)
                }
                .padding(6)
            }
        }
        .padding(12)
    }

    private func runAction(_ action: String) async {
        errorMessage = nil
        actionStatus = nil
        do {
            try await appState.apiClient.performTargetAction(targetType: target.targetType, targetId: target.targetId, action: action)
            actionStatus = "已提交操作：\(action)"
            await appState.refreshNow()
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}

// MARK: - Tab D: 本轮用量与诊断

private struct ConversationDiagnosticsTab: View {
    let target: ConversationTarget
    @Bindable var appState: AppState

    @State private var detailedDiagnostics: TurnDiagnosticsSnapshot?
    @State private var isLoadingPreview = false
    @State private var errorMessage: String?

    private var diag: TurnDiagnosticsSnapshot? {
        detailedDiagnostics ?? target.diagnostics
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            GroupBox("SDK 用量指标") {
                Grid(alignment: .leading, horizontalSpacing: 12, verticalSpacing: 6) {
                    metricRow("模型启动次数", diag?.requests.map(String.init))
                    metricRow("本轮工具调用", diag?.toolCalls.map(String.init))
                    metricRow("输入 Token", diag?.usage?.inputTokens.map { $0.formatted() })
                    metricRow("缓存读取", diag?.usage?.cachedTokens.map { $0.formatted() })
                    metricRow("缓存写入", diag?.usage?.cacheCreationTokens.map { $0.formatted() })
                    metricRow("输出 Token", diag?.usage?.outputTokens.map { $0.formatted() })
                    metricRow("SDK 轮次", diag?.usage?.modelCalls.map(String.init))
                    metricRow("本轮消息字符", diag?.inputChars.map { $0.formatted() })
                    metricRow("视觉图片数", diag?.imageCount.map(String.init))
                    metricRow("首段文字耗时", diag?.firstTextMs.map { String(format: "%.1f 秒", $0 / 1000) })
                }
                .font(.caption)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(6)
            }

            Button {
                Task { await loadPreview() }
            } label: {
                Text(isLoadingPreview ? "正在拉取…" : "拉取最新提交内容预览")
                    .frame(maxWidth: .infinity)
            }
            .disabled(isLoadingPreview)

            if let errorMessage {
                ErrorBannerView(message: errorMessage)
            }

            GroupBox("本轮实际提交文本预览") {
                ScrollView {
                    Text(previewText)
                        .font(.caption.monospaced())
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(6)
                }
                .frame(minHeight: 160, maxHeight: 320)
            }
        }
        .padding(12)
        .onChange(of: target.id) { _, _ in
            detailedDiagnostics = nil
            errorMessage = nil
        }
    }

    private var previewText: String {
        if let preview = detailedDiagnostics?.inputPreview, !preview.isEmpty {
            return preview + (detailedDiagnostics?.inputTruncated == true ? "\n（预览截断至 32,000 字符）" : "")
        }
        if diag?.stage == "complete" {
            return "本轮已正常完成，输入正文已清理。"
        }
        return "点击上方按钮可按需读取本轮提交文本预览（不含系统提示词）。"
    }

    @ViewBuilder
    private func metricRow(_ label: String, _ value: String?) -> some View {
        GridRow {
            Text(label).foregroundStyle(.secondary)
            Text(value ?? "未提供").monospacedDigit()
        }
    }

    private func loadPreview() async {
        isLoadingPreview = true
        errorMessage = nil
        defer { isLoadingPreview = false }
        do {
            detailedDiagnostics = try await appState.apiClient.fetchDiagnostics(
                targetType: target.targetType,
                targetId: target.targetId
            )
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}
