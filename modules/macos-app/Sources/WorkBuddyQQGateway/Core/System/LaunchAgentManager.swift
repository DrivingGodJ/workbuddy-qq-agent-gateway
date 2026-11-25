import Foundation

public struct LaunchAgentStatus: Equatable, Sendable {
    public var hubPlistExists: Bool
    public var qqRuntimePlistExists: Bool
    public var hubLoaded: Bool
    public var qqRuntimeLoaded: Bool
}

public final class LaunchAgentManager: Sendable {
    public static let appLoginPlistLabel = "local.workbuddy.qq-agent-gateway.login"

    private nonisolated(unsafe) let fileManager: FileManager
    private let runner: CommandRunning
    private let homeDirectory: URL
    private let launchAgentsDirectory: URL

    public init(
        fileManager: FileManager = .default,
        runner: CommandRunning = ShellRunner(),
        homeDirectory: URL = FileManager.default.homeDirectoryForCurrentUser,
        launchAgentsDirectory: URL? = nil
    ) {
        self.fileManager = fileManager
        self.runner = runner
        self.homeDirectory = homeDirectory
        self.launchAgentsDirectory = launchAgentsDirectory
            ?? homeDirectory.appendingPathComponent("Library/LaunchAgents", isDirectory: true)
    }

    public var hubPlistURL: URL {
        launchAgentsDirectory.appendingPathComponent("\(DeploymentDetector.hubPlistLabel).plist")
    }

    public var qqRuntimePlistURL: URL {
        launchAgentsDirectory.appendingPathComponent("\(DeploymentDetector.qqRuntimePlistLabel).plist")
    }

    public var appLoginPlistURL: URL {
        launchAgentsDirectory.appendingPathComponent("\(Self.appLoginPlistLabel).plist")
    }

    public func isAppLoginAgentInstalled() -> Bool {
        fileManager.fileExists(atPath: appLoginPlistURL.path)
    }

    public func installAppLoginAgent(appBundlePath: String = Bundle.main.bundlePath) async throws {
        try fileManager.createDirectory(at: launchAgentsDirectory, withIntermediateDirectories: true)
        let resolvedPath = appBundlePath.hasSuffix(".app")
            ? appBundlePath
            : "/Applications/WorkBuddyQQGateway.app"
        let plist: [String: Any] = [
            "Label": Self.appLoginPlistLabel,
            "ProgramArguments": ["/usr/bin/open", "-a", resolvedPath],
            "RunAtLoad": true,
            "ProcessType": "Interactive"
        ]
        try writePlist(plist, to: appLoginPlistURL)
    }

    public func removeAppLoginAgent() async {
        await removePlist(label: Self.appLoginPlistLabel, plistURL: appLoginPlistURL)
    }

    public func status() async -> LaunchAgentStatus {
        let hubExists = fileManager.fileExists(atPath: hubPlistURL.path)
        let qqExists = fileManager.fileExists(atPath: qqRuntimePlistURL.path)
        let uid = String(getuid())
        let hubLoaded = (try? await runner.run(
            executable: "/bin/launchctl",
            arguments: ["print", "gui/\(uid)/\(DeploymentDetector.hubPlistLabel)"],
            currentDirectory: nil,
            extraEnv: [:],
            timeoutSeconds: 4
        ).succeeded) ?? false
        let qqLoaded = (try? await runner.run(
            executable: "/bin/launchctl",
            arguments: ["print", "gui/\(uid)/\(DeploymentDetector.qqRuntimePlistLabel)"],
            currentDirectory: nil,
            extraEnv: [:],
            timeoutSeconds: 4
        ).succeeded) ?? false

        return LaunchAgentStatus(
            hubPlistExists: hubExists,
            qqRuntimePlistExists: qqExists,
            hubLoaded: hubLoaded,
            qqRuntimeLoaded: qqLoaded
        )
    }

    public func installFromProject(projectDirectory: URL) async throws {
        let installer = projectDirectory.appendingPathComponent("modules/install-launchd-plist.command")
        guard fileManager.fileExists(atPath: installer.path) else {
            throw NSError(domain: "LaunchAgentManager", code: 1, userInfo: [
                NSLocalizedDescriptionKey: "未找到安装脚本：\(installer.path)"
            ])
        }
        let result = try await runner.run(
            executable: "/bin/zsh",
            arguments: [installer.path],
            currentDirectory: projectDirectory,
            extraEnv: [:],
            timeoutSeconds: 15
        )
        guard result.succeeded else {
            throw NSError(domain: "LaunchAgentManager", code: Int(result.exitCode), userInfo: [
                NSLocalizedDescriptionKey: result.stderr.isEmpty ? "安装开机自启 plist 失败" : result.stderr
            ])
        }
    }

    public func installStandaloneAgents(
        runnerExecutable: String,
        projectDirectory: URL,
        runtimeDirectory: URL,
        dataDirectory: URL,
        envFileURL: URL?,
        pythonExecutable: String? = nil,
        codebuddyCLIPath: String? = nil,
        colimaExecutable: String? = nil,
        dockerExecutable: String? = nil
    ) async throws {
        try fileManager.createDirectory(at: launchAgentsDirectory, withIntermediateDirectories: true)
        let logsDir = runtimeDirectory.appendingPathComponent("logs", isDirectory: true)
        try fileManager.createDirectory(at: logsDir, withIntermediateDirectories: true)
        let workspaceDir = runtimeDirectory.appendingPathComponent("workspace", isDirectory: true)
        try fileManager.createDirectory(at: workspaceDir, withIntermediateDirectories: true)

        let runnerDir = homeDirectory.appendingPathComponent(".workbuddy-qq-gateway", isDirectory: true)
        try fileManager.createDirectory(at: runnerDir, withIntermediateDirectories: true)

        let hubRunner = projectDirectory.appendingPathComponent("modules/run-qq-only.command")
        let qqRunner = projectDirectory.appendingPathComponent("modules/run-qq-runtime.command")
        let installedHubRunner = runnerDir.appendingPathComponent("run-qq-only.command")
        let installedQQRunner = runnerDir.appendingPathComponent("run-qq-runtime.command")

        if fileManager.fileExists(atPath: hubRunner.path) {
            try? fileManager.removeItem(at: installedHubRunner)
            try fileManager.copyItem(at: hubRunner, to: installedHubRunner)
            try fileManager.setAttributes([.posixPermissions: 0o755], ofItemAtPath: installedHubRunner.path)
        }
        if fileManager.fileExists(atPath: qqRunner.path) {
            try? fileManager.removeItem(at: installedQQRunner)
            try fileManager.copyItem(at: qqRunner, to: installedQQRunner)
            try fileManager.setAttributes([.posixPermissions: 0o755], ofItemAtPath: installedQQRunner.path)
        }

        // Only pass structural runtime/binary paths in LaunchAgent EnvironmentVariables so
        // mutable settings in qq-only.env (like Home Assistant & speakers) reload dynamically.
        var envVars: [String: String] = [
            "WORKBUDDY_QQ_PROJECT_DIR": projectDirectory.path,
            "WORKBUDDY_QQ_RUNTIME_DIR": runtimeDirectory.path,
            "WORKBUDDY_QQ_DATA_DIR": dataDirectory.path,
            "WORKBUDDY_QQ_WORKSPACE_DIR": workspaceDir.path,
            "WB_AGENT_SESSION_MAP_PATH": dataDirectory.appendingPathComponent("workbuddy-session-map.json").path
        ]
        if let envFileURL {
            envVars["WORKBUDDY_QQ_ENV_FILE"] = envFileURL.path
        }
        if fileManager.isExecutableFile(atPath: runnerExecutable) {
            envVars["WORKBUDDY_QQ_NODE_PATH"] = runnerExecutable
        }
        if let pythonExecutable, fileManager.isExecutableFile(atPath: pythonExecutable) {
            envVars["WORKBUDDY_QQ_WB_PYTHON"] = pythonExecutable
        }
        if let codebuddyCLIPath, fileManager.isExecutableFile(atPath: codebuddyCLIPath) {
            envVars["WB_AGENT_CLI"] = codebuddyCLIPath
        }
        if let colimaExecutable, fileManager.isExecutableFile(atPath: colimaExecutable) {
            envVars["WORKBUDDY_QQ_COLIMA_PATH"] = colimaExecutable
        }
        if let dockerExecutable, fileManager.isExecutableFile(atPath: dockerExecutable) {
            envVars["WORKBUDDY_QQ_DOCKER_PATH"] = dockerExecutable
        }

        let hubPlist: [String: Any] = [
            "Label": DeploymentDetector.hubPlistLabel,
            "ProgramArguments": ["/bin/zsh", installedHubRunner.path],
            "WorkingDirectory": projectDirectory.path,
            "EnvironmentVariables": envVars,
            "StandardOutPath": logsDir.appendingPathComponent("chat-hub.log").path,
            "StandardErrorPath": logsDir.appendingPathComponent("chat-hub.err.log").path,
            "RunAtLoad": true,
            "ProcessType": "Background",
            "ThrottleInterval": 15,
            "KeepAlive": ["SuccessfulExit": false]
        ]
        let qqPlist: [String: Any] = [
            "Label": DeploymentDetector.qqRuntimePlistLabel,
            "ProgramArguments": ["/bin/zsh", installedQQRunner.path],
            "WorkingDirectory": projectDirectory.path,
            "EnvironmentVariables": envVars,
            "RunAtLoad": true,
            "StartInterval": 60,
            "ProcessType": "Background",
            "StandardOutPath": logsDir.appendingPathComponent("qq-runtime.log").path,
            "StandardErrorPath": logsDir.appendingPathComponent("qq-runtime.err.log").path
        ]

        try writePlist(hubPlist, to: hubPlistURL)
        try writePlist(qqPlist, to: qqRuntimePlistURL)
    }

    public func bootstrap(label: String, plistURL: URL) async throws {
        let uid = String(getuid())
        let bootoutRes = try? await runner.run(
            executable: "/bin/launchctl",
            arguments: ["bootout", "gui/\(uid)/\(label)"],
            currentDirectory: nil,
            extraEnv: [:],
            timeoutSeconds: 6
        )
        if bootoutRes?.succeeded == true {
            for _ in 0..<12 {
                try? await Task.sleep(nanoseconds: 250_000_000)
                let probe = try? await runner.run(
                    executable: "/bin/launchctl",
                    arguments: ["print", "gui/\(uid)/\(label)"],
                    currentDirectory: nil,
                    extraEnv: [:],
                    timeoutSeconds: 4
                )
                if probe?.succeeded != true {
                    break
                }
            }
        }
        let res = try await runner.run(
            executable: "/bin/launchctl",
            arguments: ["bootstrap", "gui/\(uid)", plistURL.path],
            currentDirectory: nil,
            extraEnv: [:],
            timeoutSeconds: 10
        )
        guard res.succeeded else {
            throw NSError(domain: "LaunchAgentManager", code: Int(res.exitCode), userInfo: [
                NSLocalizedDescriptionKey: res.stderr.isEmpty ? "加载 LaunchAgent \(label) 失败" : res.stderr
            ])
        }
    }

    public func bootout(label: String) async {
        let uid = String(getuid())
        _ = try? await runner.run(
            executable: "/bin/launchctl",
            arguments: ["bootout", "gui/\(uid)/\(label)"],
            currentDirectory: nil,
            extraEnv: [:],
            timeoutSeconds: 6
        )
    }

    public func kickstart(label: String) async throws {
        let uid = String(getuid())
        let res = try await runner.run(
            executable: "/bin/launchctl",
            arguments: ["kickstart", "-k", "gui/\(uid)/\(label)"],
            currentDirectory: nil,
            extraEnv: [:],
            timeoutSeconds: 10
        )
        guard res.succeeded else {
            throw NSError(domain: "LaunchAgentManager", code: Int(res.exitCode), userInfo: [
                NSLocalizedDescriptionKey: res.stderr.isEmpty ? "重启服务 \(label) 失败" : res.stderr
            ])
        }
    }

    public func removePlist(label: String, plistURL: URL) async {
        await bootout(label: label)
        try? fileManager.removeItem(at: plistURL)
    }

    private func writePlist(_ dict: [String: Any], to url: URL) throws {
        let data = try PropertyListSerialization.data(fromPropertyList: dict, format: .xml, options: 0)
        try data.write(to: url, options: [.atomic])
        try fileManager.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
    }
}
