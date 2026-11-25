import SwiftUI

struct StatusPill: View {
    let text: String
    let color: Color
    var systemImage: String? = nil

    var body: some View {
        HStack(spacing: 4) {
            if let systemImage {
                Image(systemName: systemImage)
                    .font(.caption2)
            } else {
                Circle()
                    .fill(color)
                    .frame(width: 7, height: 7)
            }
            Text(text)
                .font(.caption.weight(.medium))
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
        .background(color.opacity(0.14), in: Capsule())
        .foregroundStyle(color)
    }
}

struct ErrorBannerView: View {
    let message: String
    var onDismiss: (() -> Void)?

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(.red)
            Text(message)
                .font(.callout)
                .lineLimit(3)
            Spacer()
            if let onDismiss {
                Button("关闭", action: onDismiss)
                    .buttonStyle(.borderless)
                    .font(.caption)
            }
        }
        .padding(10)
        .background(Color.red.opacity(0.12), in: RoundedRectangle(cornerRadius: 8))
    }
}

struct InfoBannerView: View {
    let message: String
    var color: Color = .blue
    var onDismiss: (() -> Void)?

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "checkmark.circle.fill")
                .foregroundStyle(color)
            Text(message)
                .font(.callout)
                .lineLimit(3)
            Spacer()
            if let onDismiss {
                Button("知道了", action: onDismiss)
                    .buttonStyle(.borderless)
                    .font(.caption)
            }
        }
        .padding(10)
        .background(color.opacity(0.12), in: RoundedRectangle(cornerRadius: 8))
    }
}

enum DateFormatting {
    static func shortTime(_ isoOrMs: String?) -> String {
        guard let isoOrMs, !isoOrMs.isEmpty else { return "—" }
        let iso = ISO8601DateFormatter()
        iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = iso.date(from: isoOrMs) ?? ISO8601DateFormatter().date(from: isoOrMs) {
            let fmt = DateFormatter()
            fmt.dateFormat = "MM-dd HH:mm:ss"
            return fmt.string(from: date)
        }
        return isoOrMs
    }

    static func shortTimestampMs(_ ms: Double?) -> String {
        guard let ms, ms > 0 else { return "尚无" }
        let date = Date(timeIntervalSince1970: ms / 1000.0)
        let fmt = DateFormatter()
        fmt.dateFormat = "MM-dd HH:mm:ss"
        return fmt.string(from: date)
    }
}
