import Foundation

public enum LogSourceKind: String, CaseIterable, Identifiable, Sendable {
    case hubOut = "Hub 标准输出"
    case hubErr = "Hub 错误日志"
    case qqRuntime = "QQ Runtime"
    case snowlumaDocker = "SnowLuma 容器"

    public var id: String { rawValue }
}

public final class LogDiagnosticsManager: Sendable {
    private nonisolated(unsafe) let fileManager: FileManager
    private let runner: CommandRunning
    private let detector: DeploymentDetector

    public init(
        fileManager: FileManager = .default,
        runner: CommandRunning = ShellRunner(),
        detector: DeploymentDetector = DeploymentDetector()
    ) {
        self.fileManager = fileManager
        self.runner = runner
        self.detector = detector
    }

    public func readLog(source: LogSourceKind, paths: RuntimePaths, tailLines: Int = 200) async -> String {
        switch source {
        case .hubOut:
            return readTail(url: paths.runtimeDir.appendingPathComponent("logs/chat-hub.log"), maxLines: tailLines)
        case .hubErr:
            return readTail(url: paths.runtimeDir.appendingPathComponent("logs/chat-hub.err.log"), maxLines: tailLines)
        case .qqRuntime:
            let out = readTail(url: paths.runtimeDir.appendingPathComponent("logs/qq-runtime.log"), maxLines: tailLines)
            let err = readTail(url: paths.runtimeDir.appendingPathComponent("logs/qq-runtime.err.log"), maxLines: tailLines)
            return [out, err].filter { !$0.isEmpty }.joined(separator: "\n--- stderr ---\n")
        case .snowlumaDocker:
            guard let docker = detector.findExecutable(named: "docker") else {
                return "未检测到 Docker CLI。"
            }
            guard let res = try? await runner.run(
                executable: docker,
                arguments: ["--context", paths.dockerContext, "logs", "--tail", String(tailLines), paths.snowlumaContainer],
                currentDirectory: nil,
                extraEnv: [:],
                timeoutSeconds: 8
            ) else {
                return "读取 SnowLuma 容器日志失败。"
            }
            let combined = [res.stdout, res.stderr].filter { !$0.isEmpty }.joined(separator: "\n")
            return combined.isEmpty ? "（容器日志为空）" : combined
        }
    }

    /// Produces a scrubbed diagnostics report safe to share (strips tokens, QQ IDs, /Users/<name>, and never includes chat text).
    public func exportRedactedDiagnostics(
        to destinationURL: URL,
        paths: RuntimePaths,
        maintenance: MaintenanceState?
    ) async throws {
        var sections: [String] = []
        sections.append("# WorkBuddy QQ Gateway 脱敏诊断报告")
        sections.append("生成时间: \(ISO8601DateFormatter().string(from: Date()))")
        sections.append("运行模式: \(paths.modeLabel)")
        sections.append("系统版本: \(ProcessInfo.processInfo.operatingSystemVersionString)")
        sections.append("Hub 端口: \(paths.hubPort)")
        if let maintenance {
            sections.append("Hub 状态: \(maintenance.ok ? "ok" : "degraded")")
            sections.append("OneBot 在线: \(maintenance.oneBot?.ok == true ? "yes" : "no")")
            sections.append("WorkBuddy 引擎就绪: \(maintenance.engine?.engineReady == true ? "yes" : "no")")
            sections.append("WorkBuddy SDK: \(maintenance.engine?.sdkVersion ?? "unknown")")
            sections.append("已导入自定义人格: \(maintenance.storage?.personaImported == true ? "yes" : "no")")
        }
        sections.append("")

        for source in LogSourceKind.allCases {
            let raw = await readLog(source: source, paths: paths, tailLines: 150)
            sections.append("## \(source.rawValue)")
            sections.append(Self.redact(raw.isEmpty ? "（无内容）" : raw))
            sections.append("")
        }

        let report = Self.redact(sections.joined(separator: "\n"))
        try fileManager.createDirectory(at: destinationURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        try report.write(to: destinationURL, atomically: true, encoding: .utf8)
        try? fileManager.setAttributes([.posixPermissions: 0o600], ofItemAtPath: destinationURL.path)
    }

    public static func redact(_ text: String) -> String {
        var out = text
        let patterns: [(String, String)] = [
            (#"Bearer\s+[A-Za-z0-9._-]+"#, "Bearer [REDACTED]"),
            (#"([A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWD|PASSWORD|KEY)=)[^\s"']+"#, "$1[REDACTED]"),
            (#"(/Users/)[^/\s:"']+"#, "$1[USER]"),
            (#"\b([1-9][0-9]{4,13})\b"#, "[QQ_ID]"),
            (#"([A-Fa-f0-9]{32,})"#, "[HEX_REDACTED]")
        ]
        for (pattern, replacement) in patterns {
            if let regex = try? NSRegularExpression(pattern: pattern, options: []) {
                let range = NSRange(out.startIndex..<out.endIndex, in: out)
                out = regex.stringByReplacingMatches(in: out, options: [], range: range, withTemplate: replacement)
            }
        }
        return out
    }

    private func readTail(url: URL, maxLines: Int) -> String {
        guard fileManager.fileExists(atPath: url.path),
              let content = try? String(contentsOf: url, encoding: .utf8) else {
            return ""
        }
        let lines = content.split(separator: "\n", omittingEmptySubsequences: false)
        return lines.suffix(maxLines).joined(separator: "\n")
    }
}
