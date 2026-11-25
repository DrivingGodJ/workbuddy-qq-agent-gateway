import SwiftUI

struct ConversationView: View {
    let target: ConversationTarget
    @Bindable var appState: AppState

    @State private var draftMessage = ""
    @State private var autoScrollPinned = true
    @State private var showJumpToLatest = false

    private var timelineMessages: [ConversationMessage] {
        target.messageTimeline ?? target.pendingMessages ?? []
    }

    private var isRunning: Bool {
        target.activeReply?.running == true || target.busy == true
    }

    private var activityDescription: String {
        if let active = target.activeReply {
            if active.waiting == true {
                return "正在等待后续消息…"
            }
            if active.uploading == true {
                return "正在上传文件或图片…"
            }
            if active.running == true {
                switch target.diagnostics?.stage {
                case "tool":
                    return "正在执行工具：\(target.diagnostics?.toolName ?? "Agent 工具")"
                case "compacting":
                    return "正在自动压缩上下文…"
                case "recovering":
                    return "上游瞬时波动，正在恢复本轮…"
                case "text", "response":
                    return "正在生成回复…"
                default:
                    return "正在思考…"
                }
            }
        }
        if let trigger = target.pendingTrigger?.reason {
            return "待触发（\(trigger)）"
        }
        if (target.pendingCount ?? 0) > 0 {
            return "有 \(target.pendingCount ?? 0) 条消息等待处理"
        }
        return "等待消息"
    }

    var body: some View {
        VStack(spacing: 0) {
            conversationHeader
            Divider()

            ZStack(alignment: .bottomTrailing) {
                ScrollViewReader { proxy in
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 10) {
                            if let lastReply = target.lastCompletedReply,
                               let text = lastReply.text, !text.isEmpty {
                                LastCompletedReplyCard(agentName: appState.agentName, reply: lastReply)
                            }

                            if timelineMessages.isEmpty && target.activeReply?.running != true {
                                ContentUnavailableView(
                                    "当前暂无待处理消息",
                                    systemImage: "tray",
                                    description: Text("新到达的 QQ 消息会实时显示在此处；可在下方以 OWNER 身份直接发送指令。")
                                )
                                .padding(.top, 40)
                            } else {
                                ForEach(timelineMessages) { msg in
                                    MessageBubbleCard(message: msg, agentName: appState.agentName)
                                        .id(msg.id)
                                }
                            }

                            if let active = target.activeReply,
                               (active.running == true || active.uploading == true || !(active.text ?? "").isEmpty) {
                                ActiveReplyCard(agentName: appState.agentName, active: active, statusText: activityDescription)
                                    .id("active-reply-anchor")
                            }

                            Color.clear
                                .frame(height: 1)
                                .id("bottom-anchor")
                                .onAppear {
                                    autoScrollPinned = true
                                    showJumpToLatest = false
                                }
                                .onDisappear {
                                    autoScrollPinned = false
                                    showJumpToLatest = true
                                }
                        }
                        .padding(16)
                    }
                    .onChange(of: timelineMessages.count) { _, _ in
                        if autoScrollPinned {
                            withAnimation { proxy.scrollTo("bottom-anchor", anchor: .bottom) }
                        } else {
                            showJumpToLatest = true
                        }
                    }
                    .onChange(of: target.activeReply?.text) { _, _ in
                        if autoScrollPinned {
                            proxy.scrollTo("bottom-anchor", anchor: .bottom)
                        }
                    }
                    .overlay(alignment: .bottomTrailing) {
                        if showJumpToLatest {
                            Button {
                                autoScrollPinned = true
                                showJumpToLatest = false
                                withAnimation {
                                    proxy.scrollTo("bottom-anchor", anchor: .bottom)
                                }
                            } label: {
                                Label("回到最新消息", systemImage: "arrow.down.circle.fill")
                                    .font(.callout.weight(.medium))
                                    .padding(.horizontal, 12)
                                    .padding(.vertical, 6)
                                    .background(.regularMaterial, in: Capsule())
                                    .shadow(radius: 3)
                            }
                            .buttonStyle(.plain)
                            .padding(16)
                        }
                    }
                }
            }

            if let err = target.lastError ?? target.resumeError {
                ErrorBannerView(message: err)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 6)
            }

            Divider()
            composerBar
        }
    }

    private var conversationHeader: some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(target.resolvedTitle)
                        .font(.title3.weight(.semibold))
                    Text(target.targetType == "private" ? "私聊 · \(target.targetId)" : "群聊 · \(target.targetId)")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    if let link = target.contextLink {
                        StatusPill(
                            text: "共享群 \(link.groupName ?? link.groupId ?? "")",
                            color: .blue,
                            systemImage: "link"
                        )
                    }
                }
                HStack(spacing: 8) {
                    if isRunning {
                        ProgressView().controlSize(.mini)
                    }
                    Text(activityDescription)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }

            Spacer()

            Toggle(
                "允许回复",
                isOn: Binding(
                    get: { target.replyEnabled },
                    set: { newValue in
                        Task { await appState.toggleReplyEnabled(newValue) }
                    }
                )
            )
            .toggleStyle(.switch)
            .controlSize(.small)

            Button {
                appState.pendingResetTarget = target
            } label: {
                Label("新建会话", systemImage: "arrow.counterclockwise")
            }
            .controlSize(.small)
            .buttonStyle(.bordered)
            .disabled(isRunning || (target.targetType == "private" && target.contextLink != nil))
            .help("清空旧会话的工作目录、聊天记录与上下文并新建会话")

            Button(role: .destructive) {
                appState.pendingDeleteTarget = target
            } label: {
                Label("删除会话", systemImage: "trash")
            }
            .controlSize(.small)
            .buttonStyle(.bordered)
            .disabled(isRunning || target.contextLink != nil)
            .help(target.contextLink != nil ? "请先在右侧操作栏解除共享群聊上下文关联，再删除会话" : "从白名单删除并清理工作目录与记录")

            Button(role: .destructive) {
                Task { await appState.cancelCurrentTurn() }
            } label: {
                Label("立即终止", systemImage: "stop.circle.fill")
            }
            .disabled(!isRunning)
            .controlSize(.small)
            .buttonStyle(.bordered)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .background(.bar)
    }

    private var composerBar: some View {
        HStack(alignment: .bottom, spacing: 10) {
            TextEditor(text: $draftMessage)
                .font(.body)
                .frame(minHeight: 44, maxHeight: 110)
                .padding(6)
                .background(.quaternary.opacity(0.35), in: RoundedRectangle(cornerRadius: 8))
                .overlay(alignment: .topLeading) {
                    if draftMessage.isEmpty {
                        Text("以 OWNER 身份向 \(target.resolvedTitle) 发送消息或控制指令（⌘↩ 发送）")
                            .font(.callout)
                            .foregroundStyle(.tertiary)
                            .padding(.horizontal, 10)
                            .padding(.vertical, 10)
                            .allowsHitTesting(false)
                    }
                }
                .onKeyPress(keys: [.return]) { press in
                    if press.modifiers.contains(.command) {
                        sendDraft()
                        return .handled
                    }
                    return .ignored
                }

            Button {
                sendDraft()
            } label: {
                Label("发送", systemImage: "paperplane.fill")
                    .padding(.horizontal, 8)
                    .padding(.vertical, 6)
            }
            .buttonStyle(.borderedProminent)
            .keyboardShortcut(.return, modifiers: .command)
            .disabled(draftMessage.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        }
        .padding(12)
    }

    private func sendDraft() {
        let text = draftMessage.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        draftMessage = ""
        Task { await appState.sendOwnerMessage(text: text) }
    }
}

private struct LastCompletedReplyCard: View {
    let agentName: String
    let reply: CompletedReplySummary

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Label("\(agentName) 上一条已发回复", systemImage: "checkmark.message")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
                Spacer()
                Text(reply.displayTime ?? DateFormatting.shortTime(reply.sentAt))
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
                if reply.recalled == true {
                    StatusPill(text: "已撤回", color: .orange)
                }
            }
            Text(reply.text ?? "")
                .font(.callout)
                .textSelection(.enabled)
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.green.opacity(0.08), in: RoundedRectangle(cornerRadius: 10))
    }
}

private struct MessageBubbleCard: View {
    let message: ConversationMessage
    let agentName: String

    private var isOutgoing: Bool { message.direction == "outgoing" }
    private var isOwner: Bool { message.trust == "OWNER" }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                Text(isOutgoing ? agentName : (message.senderName ?? message.senderId ?? "成员"))
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(isOwner ? .blue : (isOutgoing ? .green : .primary))
                if isOwner {
                    StatusPill(text: "OWNER", color: .blue)
                } else if message.senderRole == "owner" || message.senderRole == "admin" {
                    StatusPill(text: message.senderRole == "owner" ? "群主" : "管理", color: .purple)
                }
                if message.mentionedBot == true {
                    StatusPill(text: "提及", color: .orange)
                }
                if message.recalled == true {
                    StatusPill(text: "已撤回", color: .red)
                }
                Spacer()
                Text(message.displayTime ?? DateFormatting.shortTime(message.timestamp))
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }

            if let quoted = message.quotedMessage {
                VStack(alignment: .leading, spacing: 2) {
                    Text("引用 \(quoted.senderName ?? quoted.senderId ?? "消息")：")
                        .font(.caption2.weight(.medium))
                        .foregroundStyle(.secondary)
                    Text(quoted.text ?? "")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(3)
                }
                .padding(6)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(.quaternary.opacity(0.4), in: RoundedRectangle(cornerRadius: 6))
            } else if let quoteErr = message.quoteError {
                Text("引用：\(quoteErr)")
                    .font(.caption)
                    .foregroundStyle(.orange)
            }

            if let text = message.text, !text.isEmpty {
                Text(text)
                    .font(.body)
                    .textSelection(.enabled)
            }

            if let images = message.images, !images.isEmpty {
                Label("附带 \(images.count) 张图片", systemImage: "photo")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            if let attachments = message.attachments, !attachments.isEmpty {
                ForEach(Array(attachments.enumerated()), id: \.offset) { _, file in
                    Label(file.fileName ?? file.name ?? "附件", systemImage: "doc")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            isOutgoing ? Color.accentColor.opacity(0.10) : Color.secondary.opacity(0.08),
            in: RoundedRectangle(cornerRadius: 10)
        )
    }
}

private struct ActiveReplyCard: View {
    let agentName: String
    let active: ActiveReplyState
    let statusText: String

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                ProgressView().controlSize(.small)
                Text("\(agentName) · \(statusText)")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(Color.accentColor)
                Spacer()
            }
            if let text = active.text, !text.isEmpty {
                Text(text)
                    .font(.body)
                    .textSelection(.enabled)
            } else {
                Text("等待模型返回文本…")
                    .font(.callout)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.accentColor.opacity(0.12), in: RoundedRectangle(cornerRadius: 10))
        .overlay(
            RoundedRectangle(cornerRadius: 10)
                .stroke(Color.accentColor.opacity(0.35), lineWidth: 1)
        )
    }
}
