import SwiftUI

struct SourceGroupView: View {
    let source: SourceGroupState

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                HStack {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(source.groupName ?? "只读通知源 \(source.groupId)")
                            .font(.title2.weight(.semibold))
                        Text("群号 \(source.groupId) · 仅接收消息并汇总给订阅会话，绝不主动在此群发言")
                            .font(.callout)
                            .foregroundStyle(.secondary)
                    }
                    Spacer()
                    StatusPill(text: "只读通知源", color: .orange, systemImage: "bell.badge")
                }

                GroupBox("各订阅目标处理进度 (\(source.subscriberProgress?.count ?? 0))") {
                    if let progressList = source.subscriberProgress, !progressList.isEmpty {
                        VStack(spacing: 8) {
                            ForEach(progressList) { item in
                                HStack {
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text("\(item.targetType == "private" ? "私聊" : "群聊") · \(item.targetName ?? item.targetId)")
                                            .font(.callout.weight(.medium))
                                        if let err = item.lastError {
                                            Text(err)
                                                .font(.caption)
                                                .foregroundStyle(.red)
                                        } else if let deadline = item.collectionDeadline {
                                            Text("收集截止：\(DateFormatting.shortTime(deadline))")
                                                .font(.caption)
                                                .foregroundStyle(.secondary)
                                        }
                                    }
                                    Spacer()
                                    if let pending = item.pendingCount, pending > 0 {
                                        Text("待汇总 \(pending)")
                                            .font(.caption)
                                            .foregroundStyle(.secondary)
                                    }
                                    StatusPill(text: statusLabel(item.status), color: statusColor(item.status))
                                }
                                .padding(.vertical, 4)
                                Divider()
                            }
                        }
                        .padding(6)
                    } else {
                        Text("当前暂无启用中的订阅目标。")
                            .foregroundStyle(.secondary)
                            .padding(8)
                    }
                }

                GroupBox("近期来源消息 (\(source.visibleMessages?.count ?? 0))") {
                    if let messages = source.visibleMessages, !messages.isEmpty {
                        LazyVStack(alignment: .leading, spacing: 8) {
                            ForEach(messages) { msg in
                                VStack(alignment: .leading, spacing: 3) {
                                    HStack {
                                        Text(msg.senderName ?? msg.senderId ?? "群成员")
                                            .font(.caption.weight(.semibold))
                                        if msg.retainedBySubscription == true {
                                            StatusPill(text: "待订阅消费", color: .blue)
                                        }
                                        Spacer()
                                        Text(msg.displayTime ?? DateFormatting.shortTime(msg.timestamp))
                                            .font(.caption2)
                                            .foregroundStyle(.secondary)
                                    }
                                    Text(msg.text ?? "")
                                        .font(.callout)
                                        .textSelection(.enabled)
                                }
                                .padding(8)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .background(.quaternary.opacity(0.35), in: RoundedRectangle(cornerRadius: 8))
                            }
                        }
                        .padding(6)
                    } else {
                        Text("尚无缓存的来源群消息。")
                            .foregroundStyle(.secondary)
                            .padding(8)
                    }
                }
            }
            .padding(20)
        }
    }

    private func statusLabel(_ raw: String) -> String {
        switch raw {
        case "collecting": return "收集等待中"
        case "queued": return "排队处理"
        case "running": return "正在汇总"
        case "sending": return "正在发送"
        case "paused": return "已暂停"
        case "failed": return "失败"
        case "complete": return "已完成"
        default: return raw
        }
    }

    private func statusColor(_ raw: String) -> Color {
        switch raw {
        case "complete": return .green
        case "running", "sending": return .blue
        case "collecting", "queued": return .orange
        case "failed": return .red
        default: return .secondary
        }
    }
}
