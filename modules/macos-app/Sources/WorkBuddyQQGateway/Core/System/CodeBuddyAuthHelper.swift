import AppKit
import Darwin
import Foundation
import os

public enum CodeBuddyLoginSite: String, CaseIterable, Identifiable, Sendable {
    case chinese = "国内版（微信 / 腾讯云扫码）"
    case international = "国际版（GitHub / Google）"

    public var id: String { rawValue }
}

public struct CodeBuddyCLIStatus: Equatable, Sendable {
    public var path: String?
    public var version: String?
    public var loggedIn: Bool
    public var modelCount: Int
    public var detail: String?

    public init(path: String?, version: String?, loggedIn: Bool, modelCount: Int, detail: String? = nil) {
        self.path = path
        self.version = version
        self.loggedIn = loggedIn
        self.modelCount = modelCount
        self.detail = detail
    }
}

public final class CodeBuddyAuthHelper: Sendable {
    private final class ActivePTYBox: Sendable {
        private struct State: @unchecked Sendable {
            var process: Process?
            var masterFD: Int32 = -1
            var cancelled = false
        }

        private let lock = OSAllocatedUnfairLock(initialState: State())

        func attach(process: Process, masterFD: Int32) {
            lock.withLock { state in
                state.process = process
                state.masterFD = masterFD
                state.cancelled = false
            }
        }

        func clear() {
            lock.withLock { state in
                state.process = nil
                state.masterFD = -1
            }
        }

        var isCancelled: Bool {
            lock.withLock { $0.cancelled }
        }

        func cancel() {
            let (proc, fd): (Process?, Int32) = lock.withLock { state in
                state.cancelled = true
                return (state.process, state.masterFD)
            }
            if fd >= 0 {
                let esc: [UInt8] = [0x1b]
                _ = Darwin.write(fd, esc, 1)
            }
            if let proc, proc.isRunning {
                proc.terminate()
                let pid = proc.processIdentifier
                DispatchQueue.global().asyncAfter(deadline: .now() + 0.5) {
                    if proc.isRunning && pid > 0 {
                        Darwin.kill(pid, SIGKILL)
                    }
                }
            }
        }
    }

    private let detector: DeploymentDetector
    private let runner: CommandRunning
    private let activePTY = ActivePTYBox()

    public init(detector: DeploymentDetector = DeploymentDetector(), runner: CommandRunning = ShellRunner()) {
        self.detector = detector
        self.runner = runner
    }

    public static func stripANSI(_ raw: String) -> String {
        var text = raw.replacingOccurrences(of: "\r\n", with: "\n").replacingOccurrences(of: "\r", with: "\n")
        // Strip OSC sequences (\x1b]...BEL or ST) and CSI sequences (\x1b[...)
        let patterns = [
            #"\x1B\][^\x07\x1B]*(?:\x07|\x1B\\)"#,
            #"\x1B\[[0-9;?]*[ -/]*[@-~]"#,
            #"\x1B[@-Z\\-_]"#
        ]
        for pattern in patterns {
            if let regex = try? NSRegularExpression(pattern: pattern) {
                let range = NSRange(text.startIndex..<text.endIndex, in: text)
                text = regex.stringByReplacingMatches(in: text, range: range, withTemplate: "")
            }
        }
        return text
    }

    public static func parseAuthProbeOutput(_ output: String) -> (loggedIn: Bool, modelCount: Int) {
        let lower = output.lowercased()
        var seenModelsHeader = false
        var bulletCountAfterHeader = 0
        var totalBullets = 0

        for rawLine in output.split(whereSeparator: \.isNewline) {
            let trimmed = rawLine.trimmingCharacters(in: .whitespacesAndNewlines)
            if trimmed.lowercased().contains("currently supported models") {
                seenModelsHeader = true
                continue
            }
            if trimmed.hasPrefix("- ") && trimmed.count > 2 {
                totalBullets += 1
                if seenModelsHeader {
                    bulletCountAfterHeader += 1
                }
            }
        }

        let modelCount = seenModelsHeader ? bulletCountAfterHeader : totalBullets
        let authFailed = [
            "authentication required",
            "not logged in",
            "unauthorized",
            "login required",
            "please login",
            "please log in",
            "not authenticated"
        ].contains { lower.contains($0) }

        let loggedIn = !authFailed && (
            modelCount > 0
            || lower.contains("currently supported models")
            || (lower.contains("__probe__") && lower.contains("not found"))
        )
        return (loggedIn, loggedIn ? modelCount : 0)
    }

    public static func extractLoginURL(from rawOutput: String) -> URL? {
        let clean = stripANSI(rawOutput)
        let lines = clean.split(separator: "\n", omittingEmptySubsequences: false).map {
            String($0).trimmingCharacters(in: .whitespaces)
        }

        // Stitch URLs that were wrapped across terminal lines
        var stitchedLines: [String] = []
        var i = 0
        while i < lines.count {
            var current = lines[i]
            if current.contains("https://") {
                var j = i + 1
                while j < lines.count {
                    let next = lines[j]
                    if !next.isEmpty,
                       !next.contains("http://"),
                       !next.contains("https://"),
                       !next.contains(" "),
                       next.range(of: #"^[A-Za-z0-9\-._~:/?#\[\]@!$&'()*+,;=%]+$"#, options: .regularExpression) != nil {
                        current += next
                        j += 1
                    } else {
                        break
                    }
                }
                i = j
            } else {
                i += 1
            }
            stitchedLines.append(current)
        }

        let searchText = stitchedLines.joined(separator: "\n")
        let pattern = #"https://[^\s\]\)>"']+"#
        guard let regex = try? NSRegularExpression(pattern: pattern) else { return nil }
        let range = NSRange(searchText.startIndex..<searchText.endIndex, in: searchText)
        for match in regex.matches(in: searchText, range: range) {
            guard let r = Range(match.range, in: searchText) else { continue }
            let candidate = String(searchText[r]).trimmingCharacters(in: CharacterSet(charactersIn: ".,;"))
            guard let url = URL(string: candidate), let host = url.host?.lowercased() else { continue }
            if host == "127.0.0.1" || host == "localhost" { continue }
            let pathLower = url.path.lowercased()
            if pathLower == "/docs" || pathLower.hasPrefix("/docs/") { continue }
            let lower = candidate.lowercased()
            if lower.contains("login") || lower.contains("auth") || lower.contains("oauth") || lower.contains("state=") || lower.contains("platform=cli") {
                return url
            }
        }
        return nil
    }

    public static func extractAuthURL(from output: String) -> URL? {
        extractLoginURL(from: output)
    }

    public func inspectCLI() async -> CodeBuddyCLIStatus {
        guard let cli = detector.findCodeBuddyCLI() else {
            return CodeBuddyCLIStatus(
                path: nil,
                version: nil,
                loggedIn: false,
                modelCount: 0,
                detail: "未检测到 CodeBuddy CLI"
            )
        }
        let versionRes = try? await runner.run(
            executable: cli,
            arguments: ["--version"],
            currentDirectory: nil,
            extraEnv: [:],
            timeoutSeconds: 6
        )
        let rawVersion = versionRes?.stdout.trimmingCharacters(in: .whitespacesAndNewlines)
        let version = (rawVersion?.isEmpty == false) ? rawVersion : nil

        let probeRes = try? await runner.run(
            executable: cli,
            arguments: ["-p", "ping", "--model", "__probe__", "--permission-mode", "plan"],
            currentDirectory: nil,
            extraEnv: ShellRunner.systemProxyEnvironment(),
            timeoutSeconds: 20
        )
        let combined = [probeRes?.stdout ?? "", probeRes?.stderr ?? ""].joined(separator: "\n")
        let parsed = Self.parseAuthProbeOutput(combined)

        let detail: String
        if parsed.loggedIn {
            detail = parsed.modelCount > 0 ? "已登录（\(parsed.modelCount) 个可用模型）" : "已登录"
        } else if probeRes == nil || probeRes?.exitCode == 124 {
            detail = "账号状态探测超时或无响应，可点击「刷新登录状态」重试"
        } else {
            let preview = combined
                .split(whereSeparator: \.isNewline)
                .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
                .first { !$0.isEmpty }
            detail = preview.map { String($0.prefix(160)) } ?? "尚未登录 CodeBuddy 账号"
        }

        return CodeBuddyCLIStatus(
            path: cli,
            version: version,
            loggedIn: parsed.loggedIn,
            modelCount: parsed.modelCount,
            detail: detail
        )
    }

    public func cancelActiveLogin() {
        activePTY.cancel()
    }

    public func startAutomatedBrowserLogin(
        site: CodeBuddyLoginSite,
        workingDirectory: URL,
        wasAlreadyLoggedIn: Bool,
        onStage: @escaping @Sendable (String) -> Void,
        onAuthURL: @escaping @Sendable (URL) -> Void,
        onLog: @escaping @Sendable (String) -> Void
    ) async throws -> CodeBuddyCLIStatus {
        guard let cli = detector.findCodeBuddyCLI() else {
            throw NSError(domain: "CodeBuddyAuthHelper", code: 1, userInfo: [
                NSLocalizedDescriptionKey: "未找到独立版 CodeBuddy CLI（~/.local/bin/codebuddy），请先在 Step 2 安装。"
            ])
        }
        try FileManager.default.createDirectory(at: workingDirectory, withIntermediateDirectories: true)

        onStage("正在后台启动 CodeBuddy 登录流程…")
        let completedFlag = OSAllocatedUnfairLock(initialState: false)
        let activeBox = activePTY

        let authSuccess = try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Bool, Error>) in
            DispatchQueue.global(qos: .userInitiated).async {
                var ws = winsize(ws_row: 40, ws_col: 300, ws_xpixel: 0, ws_ypixel: 0)
                var masterFD: Int32 = -1
                var slaveFD: Int32 = -1
                guard openpty(&masterFD, &slaveFD, nil, nil, &ws) == 0 else {
                    continuation.resume(throwing: NSError(domain: "CodeBuddyAuthHelper", code: 2, userInfo: [
                        NSLocalizedDescriptionKey: "无法创建伪终端 PTY"
                    ]))
                    return
                }

                let masterHandle = FileHandle(fileDescriptor: masterFD, closeOnDealloc: true)
                let slaveHandle = FileHandle(fileDescriptor: slaveFD, closeOnDealloc: true)

                var env = ShellRunner.buildWhitelistedEnvironment(extraEnv: ShellRunner.systemProxyEnvironment())
                env["TERM"] = "xterm-256color"
                // Disable CLI auto-opening browser so we open cleanly once ourselves with NSWorkspace
                env["BROWSER"] = "/usr/bin/true"

                let process = Process()
                process.executableURL = URL(fileURLWithPath: cli)
                process.arguments = []
                process.currentDirectoryURL = workingDirectory
                process.environment = env
                process.standardInput = slaveHandle
                process.standardOutput = slaveHandle
                process.standardError = slaveHandle

                do {
                    try process.run()
                } catch {
                    try? slaveHandle.close()
                    try? masterHandle.close()
                    continuation.resume(throwing: error)
                    return
                }
                try? slaveHandle.close()
                activeBox.attach(process: process, masterFD: masterFD)
                defer { activeBox.clear() }

                var rawOutput = ""
                var trustedFolder = false
                var selectedMethod = false
                var bannerSeenAt: Date?
                var sentSlashLogin = false
                var openedURL: URL?
                var lastProbeAt = Date.distantPast
                let probeRunning = OSAllocatedUnfairLock(initialState: false)
                let startAt = Date()
                let timeoutAt = startAt.addingTimeInterval(180)
                var buf = [UInt8](repeating: 0, count: 8192)

                func sendPTY(_ text: String) {
                    let bytes = Array(text.utf8)
                    _ = bytes.withUnsafeBytes { ptr in
                        if let base = ptr.baseAddress {
                            return Darwin.write(masterFD, base, bytes.count)
                        }
                        return 0
                    }
                }

                var succeeded = false
                while Date() < timeoutAt {
                    if activeBox.isCancelled {
                        break
                    }
                    if completedFlag.withLock({ $0 }) {
                        succeeded = true
                        break
                    }

                    var pfd = pollfd(fd: masterFD, events: Int16(POLLIN), revents: 0)
                    let pollRC = Darwin.poll(&pfd, 1, 150)
                    if pollRC > 0 && (pfd.revents & Int16(POLLIN)) != 0 {
                        let n = Darwin.read(masterFD, &buf, buf.count)
                        if n > 0 {
                            let chunk = String(decoding: buf[0..<n], as: UTF8.self)
                            rawOutput += chunk
                            let strippedChunk = Self.stripANSI(chunk).trimmingCharacters(in: .whitespacesAndNewlines)
                            if !strippedChunk.isEmpty {
                                onLog(strippedChunk)
                            }
                        } else if n == 0 {
                            break
                        }
                    }

                    let clean = Self.stripANSI(rawOutput)
                    let cleanLower = clean.lowercased()

                    if !trustedFolder && (cleanLower.contains("do you trust") || cleanLower.contains("trust folder")) {
                        trustedFolder = true
                        onStage("已自动确认工作目录，正在拉起登录菜单…")
                        sendPTY("\r")
                    }

                    if !selectedMethod && cleanLower.contains("select login method") {
                        selectedMethod = true
                        onStage("已自动选择\(site.rawValue)，正在获取扫码链接…")
                        switch site {
                        case .chinese:
                            sendPTY("\r")
                        case .international:
                            sendPTY("\u{1b}[B")
                            Thread.sleep(forTimeInterval: 0.2)
                            sendPTY("\r")
                        }
                    }

                    if !selectedMethod && !sentSlashLogin && (cleanLower.contains("codebuddy code") || cleanLower.contains("tips for getting started")) {
                        if bannerSeenAt == nil {
                            bannerSeenAt = Date()
                        } else if let seen = bannerSeenAt, Date().timeIntervalSince(seen) >= 1.8 {
                            sentSlashLogin = true
                            onStage("检测到已有会话，正在唤起账号登录选择菜单…")
                            sendPTY("/login")
                            Thread.sleep(forTimeInterval: 0.15)
                            sendPTY("\r")
                        }
                    }

                    if openedURL == nil, let url = Self.extractLoginURL(from: rawOutput) {
                        openedURL = url
                        onAuthURL(url)
                        onStage("已在浏览器打开登录页面，请扫码完成授权（可随时点「取消登录」）…")
                        DispatchQueue.main.async {
                            NSWorkspace.shared.open(url)
                        }
                    }

                    if selectedMethod && (
                        cleanLower.contains("successfully logged in")
                        || cleanLower.contains("login successful")
                        || cleanLower.contains("logged in as")
                        || cleanLower.contains("登录成功")
                        || cleanLower.contains("authentication successful")
                    ) {
                        succeeded = true
                        break
                    }

                    if !wasAlreadyLoggedIn, openedURL != nil, Date().timeIntervalSince(lastProbeAt) >= 2.5 {
                        let alreadyProbing = probeRunning.withLock { running -> Bool in
                            if running { return true }
                            running = true
                            return false
                        }
                        if !alreadyProbing {
                            lastProbeAt = Date()
                            DispatchQueue.global(qos: .utility).async {
                                let probe = Process()
                                probe.executableURL = URL(fileURLWithPath: cli)
                                probe.arguments = ["-p", "ping", "--model", "__probe__", "--permission-mode", "plan"]
                                probe.environment = ShellRunner.buildWhitelistedEnvironment(extraEnv: ShellRunner.systemProxyEnvironment())
                                let outPipe = Pipe()
                                let errPipe = Pipe()
                                probe.standardOutput = outPipe
                                probe.standardError = errPipe
                                probe.standardInput = FileHandle.nullDevice
                                if (try? probe.run()) != nil {
                                    let outData = outPipe.fileHandleForReading.readDataToEndOfFile()
                                    let errData = errPipe.fileHandleForReading.readDataToEndOfFile()
                                    probe.waitUntilExit()
                                    let txt = (String(data: outData, encoding: .utf8) ?? "") + "\n" + (String(data: errData, encoding: .utf8) ?? "")
                                    if Self.parseAuthProbeOutput(txt).loggedIn {
                                        completedFlag.withLock { $0 = true }
                                    }
                                }
                                probeRunning.withLock { $0 = false }
                            }
                        }
                    }

                    if !process.isRunning {
                        break
                    }
                }

                if activeBox.isCancelled {
                    if process.isRunning { process.terminate() }
                    try? masterHandle.close()
                    continuation.resume(throwing: CancellationError())
                    return
                }

                if succeeded {
                    sendPTY("/exit")
                    Thread.sleep(forTimeInterval: 0.15)
                    sendPTY("\r")
                    Thread.sleep(forTimeInterval: 0.3)
                }
                if process.isRunning {
                    process.terminate()
                    let deadline = Date().addingTimeInterval(1.0)
                    while process.isRunning && Date() < deadline {
                        Thread.sleep(forTimeInterval: 0.05)
                    }
                    if process.isRunning {
                        Darwin.kill(process.processIdentifier, SIGKILL)
                    }
                }
                try? masterHandle.close()

                if !succeeded && Date() >= timeoutAt {
                    continuation.resume(throwing: NSError(domain: "CodeBuddyAuthHelper", code: 3, userInfo: [
                        NSLocalizedDescriptionKey: "等待浏览器扫码登录超时（180秒），请重试或切换为手动终端登录。"
                    ]))
                    return
                }

                continuation.resume(returning: succeeded)
            }
        }

        if authSuccess {
            onStage("浏览器授权完成，正在确认登录态与可用模型…")
        }
        return await inspectCLI()
    }

    public func logout(workingDirectory: URL) async throws -> CodeBuddyCLIStatus {
        guard let cli = detector.findCodeBuddyCLI() else {
            throw NSError(domain: "CodeBuddyAuthHelper", code: 1, userInfo: [
                NSLocalizedDescriptionKey: "未找到 CodeBuddy CLI"
            ])
        }
        try FileManager.default.createDirectory(at: workingDirectory, withIntermediateDirectories: true)

        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            DispatchQueue.global(qos: .userInitiated).async {
                var ws = winsize(ws_row: 40, ws_col: 300, ws_xpixel: 0, ws_ypixel: 0)
                var masterFD: Int32 = -1
                var slaveFD: Int32 = -1
                guard openpty(&masterFD, &slaveFD, nil, nil, &ws) == 0 else {
                    continuation.resume(throwing: NSError(domain: "CodeBuddyAuthHelper", code: 2, userInfo: [
                        NSLocalizedDescriptionKey: "无法创建伪终端 PTY"
                    ]))
                    return
                }

                let masterHandle = FileHandle(fileDescriptor: masterFD, closeOnDealloc: true)
                let slaveHandle = FileHandle(fileDescriptor: slaveFD, closeOnDealloc: true)

                var env = ShellRunner.buildWhitelistedEnvironment()
                env["TERM"] = "xterm-256color"

                let process = Process()
                process.executableURL = URL(fileURLWithPath: cli)
                process.arguments = []
                process.currentDirectoryURL = workingDirectory
                process.environment = env
                process.standardInput = slaveHandle
                process.standardOutput = slaveHandle
                process.standardError = slaveHandle

                do {
                    try process.run()
                } catch {
                    try? slaveHandle.close()
                    try? masterHandle.close()
                    continuation.resume(throwing: error)
                    return
                }
                try? slaveHandle.close()

                var rawOutput = ""
                var trustedFolder = false
                var bannerSeenAt: Date?
                var sentLogout = false
                var sentConfirm = false
                var logoutSentAt: Date?
                let deadline = Date().addingTimeInterval(20)
                var buf = [UInt8](repeating: 0, count: 8192)

                func sendPTY(_ text: String) {
                    let bytes = Array(text.utf8)
                    _ = bytes.withUnsafeBytes { ptr in
                        if let base = ptr.baseAddress {
                            return Darwin.write(masterFD, base, bytes.count)
                        }
                        return 0
                    }
                }

                while Date() < deadline {
                    var pfd = pollfd(fd: masterFD, events: Int16(POLLIN), revents: 0)
                    if Darwin.poll(&pfd, 1, 150) > 0 && (pfd.revents & Int16(POLLIN)) != 0 {
                        let n = Darwin.read(masterFD, &buf, buf.count)
                        if n > 0 {
                            rawOutput += String(decoding: buf[0..<n], as: UTF8.self)
                        } else if n == 0 {
                            break
                        }
                    }

                    let cleanLower = Self.stripANSI(rawOutput).lowercased()
                    if !trustedFolder && (cleanLower.contains("do you trust") || cleanLower.contains("trust folder")) {
                        trustedFolder = true
                        sendPTY("\r")
                    }
                    if !sentLogout && cleanLower.contains("select login method") {
                        // Already logged out
                        break
                    }
                    if !sentLogout && (cleanLower.contains("codebuddy code") || cleanLower.contains("tips for getting started")) {
                        if bannerSeenAt == nil {
                            bannerSeenAt = Date()
                        } else if let seen = bannerSeenAt, Date().timeIntervalSince(seen) >= 1.5 {
                            sentLogout = true
                            logoutSentAt = Date()
                            sendPTY("/logout")
                            Thread.sleep(forTimeInterval: 0.15)
                            sendPTY("\r")
                        }
                    }
                    if sentLogout, let at = logoutSentAt {
                        if !sentConfirm && Date().timeIntervalSince(at) >= 1.2 {
                            sentConfirm = true
                            sendPTY("\r")
                        }
                        let afterMarker = cleanLower.components(separatedBy: "/logout").last ?? cleanLower
                        if afterMarker.contains("select login method")
                            || afterMarker.contains("logged out")
                            || afterMarker.contains("signed out")
                            || afterMarker.contains("已退出")
                            || Date().timeIntervalSince(at) >= 5.0 {
                            break
                        }
                    }
                    if !process.isRunning {
                        break
                    }
                }

                if process.isRunning {
                    process.terminate()
                    let killDeadline = Date().addingTimeInterval(0.8)
                    while process.isRunning && Date() < killDeadline {
                        Thread.sleep(forTimeInterval: 0.05)
                    }
                    if process.isRunning {
                        Darwin.kill(process.processIdentifier, SIGKILL)
                    }
                }
                try? masterHandle.close()
                continuation.resume(returning: ())
            }
        }

        return await inspectCLI()
    }

    /// Manual fallback: opens macOS Terminal cleanly for interactive CodeBuddy TUI login.
    @discardableResult
    public func openTerminalForInteractiveLogin() async throws -> String {
        guard let cli = detector.findCodeBuddyCLI() else {
            throw NSError(domain: "CodeBuddyAuthHelper", code: 1, userInfo: [
                NSLocalizedDescriptionKey: "未找到独立版 CodeBuddy CLI（~/.local/bin/codebuddy），请先在 Step 2 安装。"
            ])
        }

        let quotedCLI = "'" + cli.replacingOccurrences(of: "'", with: "'\\''") + "'"
        let oneLineCmd = [
            "clear",
            "echo '=== CodeBuddy 交互登录指引 ==='",
            "echo '1. 首次启动请按屏幕提示选择登录方式并在浏览器完成授权'",
            "echo '2. 若已进入对话界面需登录或切换账号，请输入 /login 回车'",
            "echo '3. 登录成功后输入 /exit 退出，回到安装向导或设置页刷新状态'",
            "echo ''",
            "exec \(quotedCLI)"
        ].joined(separator: "; ")

        let appleEscaped = oneLineCmd
            .replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "\"", with: "\\\"")
        let script = """
        tell application "Terminal"
          activate
          do script "\(appleEscaped)"
        end tell
        """

        let res = try await runner.run(
            executable: "/usr/bin/osascript",
            arguments: ["-e", script],
            currentDirectory: nil,
            extraEnv: [:],
            timeoutSeconds: 10
        )
        guard res.succeeded else {
            throw NSError(domain: "CodeBuddyAuthHelper", code: Int(res.exitCode), userInfo: [
                NSLocalizedDescriptionKey: res.stderr.isEmpty ? "无法唤起 macOS 终端，请手动打开终端运行 codebuddy" : res.stderr
            ])
        }
        return cli
    }
}
