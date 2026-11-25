import CFNetwork
import Foundation
import os

public struct CommandResult: Sendable {
    public var exitCode: Int32
    public var stdout: String
    public var stderr: String

    public var succeeded: Bool { exitCode == 0 }
}

public protocol CommandRunning: Sendable {
    func run(
        executable: String,
        arguments: [String],
        currentDirectory: URL?,
        extraEnv: [String: String],
        timeoutSeconds: Double?
    ) async throws -> CommandResult
}

public struct ShellRunner: CommandRunning {
    public static let baseWhitelistKeys: Set<String> = [
        "HOME", "USER", "LOGNAME", "SHELL", "TERM", "TMPDIR",
        "LANG", "LC_ALL", "LC_CTYPE", "__CF_USER_TEXT_ENCODING", "TZ"
    ]

    public init() {}

    public static func buildWhitelistedEnvironment(extraEnv: [String: String] = [:]) -> [String: String] {
        let host = ProcessInfo.processInfo.environment
        var env: [String: String] = [:]
        for key in baseWhitelistKeys {
            if let value = host[key], !value.isEmpty {
                env[key] = value
            }
        }
        let defaultPath = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
        if let home = env["HOME"], !home.isEmpty {
            env["PATH"] = "\(home)/.local/bin:\(defaultPath)"
        } else {
            env["PATH"] = defaultPath
        }
        if env["LANG"] == nil { env["LANG"] = "en_US.UTF-8" }
        for (key, value) in extraEnv {
            env[key] = value
        }
        return env
    }

    public static func systemProxyEnvironment() -> [String: String] {
        guard let raw = CFNetworkCopySystemProxySettings()?.takeRetainedValue() as? [String: Any] else {
            return [:]
        }
        return parseSystemProxySettings(raw)
    }

    public static func parseSystemProxySettings(_ settings: [String: Any]) -> [String: String] {
        var env: [String: String] = [:]
        if (settings["HTTPEnable"] as? NSNumber)?.intValue == 1,
           let host = settings["HTTPProxy"] as? String, !host.isEmpty,
           let port = (settings["HTTPPort"] as? NSNumber)?.intValue, port > 0 {
            let url = "http://\(host):\(port)"
            env["HTTP_PROXY"] = url
            env["http_proxy"] = url
        }
        if (settings["HTTPSEnable"] as? NSNumber)?.intValue == 1,
           let host = settings["HTTPSProxy"] as? String, !host.isEmpty,
           let port = (settings["HTTPSPort"] as? NSNumber)?.intValue, port > 0 {
            let url = "http://\(host):\(port)"
            env["HTTPS_PROXY"] = url
            env["https_proxy"] = url
        }
        if (settings["SOCKSEnable"] as? NSNumber)?.intValue == 1,
           let host = settings["SOCKSProxy"] as? String, !host.isEmpty,
           let port = (settings["SOCKSPort"] as? NSNumber)?.intValue, port > 0 {
            let url = "socks5h://\(host):\(port)"
            env["ALL_PROXY"] = url
            env["all_proxy"] = url
        }
        if !env.isEmpty {
            let bypass = "127.0.0.1,localhost,::1,.local"
            env["NO_PROXY"] = bypass
            env["no_proxy"] = bypass
        }
        return env
    }

    public func run(
        executable: String,
        arguments: [String] = [],
        currentDirectory: URL? = nil,
        extraEnv: [String: String] = [:],
        timeoutSeconds: Double? = 30
    ) async throws -> CommandResult {
        try await executeProcess(
            executable: executable,
            arguments: arguments,
            stdinData: nil,
            currentDirectory: currentDirectory,
            extraEnv: extraEnv,
            timeoutSeconds: timeoutSeconds
        )
    }

    public func runWithStdin(
        executable: String,
        arguments: [String] = [],
        stdinData: Data,
        currentDirectory: URL? = nil,
        extraEnv: [String: String] = [:],
        timeoutSeconds: Double? = 30
    ) async throws -> CommandResult {
        try await executeProcess(
            executable: executable,
            arguments: arguments,
            stdinData: stdinData,
            currentDirectory: currentDirectory,
            extraEnv: extraEnv,
            timeoutSeconds: timeoutSeconds
        )
    }

    private func executeProcess(
        executable: String,
        arguments: [String],
        stdinData: Data?,
        currentDirectory: URL?,
        extraEnv: [String: String],
        timeoutSeconds: Double?
    ) async throws -> CommandResult {
        try await withCheckedThrowingContinuation { continuation in
            DispatchQueue.global(qos: .userInitiated).async {
                let process = Process()
                process.executableURL = URL(fileURLWithPath: executable)
                process.arguments = arguments
                process.currentDirectoryURL = currentDirectory
                process.environment = Self.buildWhitelistedEnvironment(extraEnv: extraEnv)

                let stdoutPipe = Pipe()
                let stderrPipe = Pipe()
                process.standardOutput = stdoutPipe
                process.standardError = stderrPipe

                let stdinPipe: Pipe?
                if stdinData != nil {
                    let pipe = Pipe()
                    process.standardInput = pipe
                    stdinPipe = pipe
                } else {
                    process.standardInput = FileHandle.nullDevice
                    stdinPipe = nil
                }

                do {
                    try process.run()
                } catch {
                    continuation.resume(throwing: error)
                    return
                }

                if let stdinPipe, let stdinData {
                    DispatchQueue.global(qos: .userInitiated).async {
                        if !stdinData.isEmpty {
                            stdinPipe.fileHandleForWriting.write(stdinData)
                        }
                        try? stdinPipe.fileHandleForWriting.close()
                    }
                }

                let stdoutBox = OSAllocatedUnfairLock(initialState: Data())
                let stderrBox = OSAllocatedUnfairLock(initialState: Data())
                let readGroup = DispatchGroup()

                readGroup.enter()
                DispatchQueue.global(qos: .userInitiated).async {
                    let data = stdoutPipe.fileHandleForReading.readDataToEndOfFile()
                    stdoutBox.withLock { $0 = data }
                    readGroup.leave()
                }
                readGroup.enter()
                DispatchQueue.global(qos: .userInitiated).async {
                    let data = stderrPipe.fileHandleForReading.readDataToEndOfFile()
                    stderrBox.withLock { $0 = data }
                    readGroup.leave()
                }

                let timeoutBox = OSAllocatedUnfairLock(initialState: false)
                let timeoutWorkItem = DispatchWorkItem {
                    if process.isRunning {
                        timeoutBox.withLock { $0 = true }
                        process.terminate()
                    }
                }
                if let timeoutSeconds, timeoutSeconds > 0 {
                    DispatchQueue.global().asyncAfter(deadline: .now() + timeoutSeconds, execute: timeoutWorkItem)
                }

                process.waitUntilExit()
                timeoutWorkItem.cancel()
                readGroup.wait()

                let didTimeout = timeoutBox.withLock { $0 }
                let stdout = String(data: stdoutBox.withLock { $0 }, encoding: .utf8) ?? ""
                var stderr = String(data: stderrBox.withLock { $0 }, encoding: .utf8) ?? ""
                if didTimeout {
                    stderr += (stderr.isEmpty ? "" : "\n") + "Command timed out after \(Int(timeoutSeconds ?? 0))s"
                }

                continuation.resume(returning: CommandResult(
                    exitCode: didTimeout ? 124 : process.terminationStatus,
                    stdout: stdout,
                    stderr: stderr
                ))
            }
        }
    }
}
