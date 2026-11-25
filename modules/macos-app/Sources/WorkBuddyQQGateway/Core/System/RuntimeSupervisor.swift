import Foundation

public struct RuntimePaths: Equatable, Sendable {
    public var modeLabel: String
    public var isTakeover: Bool
    public var gatewayRoot: URL
    public var runtimeDir: URL
    public var dataDir: URL
    public var envFileURL: URL?
    public var hubPort: Int
    public var colimaProfile: String
    public var dockerContext: String
    public var snowlumaContainer: String
}

public struct ColimaDockerSnapshot: Equatable, Sendable {
    public var colimaInstalled: Bool
    public var dockerInstalled: Bool
    public var colimaRunning: Bool
    public var containerExists: Bool
    public var containerRunning: Bool
    public var statusMessage: String
}

public struct QQContainerLoginProbe: Equatable, Sendable {
    public var containerRunning: Bool
    public var hasSavedLoginProfile: Bool

    public init(containerRunning: Bool, hasSavedLoginProfile: Bool) {
        self.containerRunning = containerRunning
        self.hasSavedLoginProfile = hasSavedLoginProfile
    }
}

public actor RuntimeSupervisor {
    private let fileManager: FileManager
    private let runner: CommandRunning
    private let detector: DeploymentDetector
    private let launchAgents: LaunchAgentManager
    private let keychain: KeychainStore
    private var managedHubProcess: Process?
    private var paths: RuntimePaths

    public init(
        fileManager: FileManager = .default,
        runner: CommandRunning = ShellRunner(),
        detector: DeploymentDetector = DeploymentDetector(),
        launchAgents: LaunchAgentManager = LaunchAgentManager(),
        keychain: KeychainStore = KeychainStore()
    ) {
        self.fileManager = fileManager
        self.runner = runner
        self.detector = detector
        self.launchAgents = launchAgents
        self.keychain = keychain
        self.paths = Self.defaultStandalonePaths(fileManager: fileManager)
    }

    public static func defaultStandalonePaths(fileManager: FileManager = .default) -> RuntimePaths {
        let appSupport = fileManager.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? fileManager.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support", isDirectory: true)
        let base = appSupport.appendingPathComponent("WorkBuddyQQGateway", isDirectory: true)
        let runtimeDir = base.appendingPathComponent("runtime", isDirectory: true)
        let dataDir = runtimeDir.appendingPathComponent("qq-only-data", isDirectory: true)
        let gatewayRoot = Bundle.main.resourceURL?.appendingPathComponent("gateway", isDirectory: true)
            ?? URL(fileURLWithPath: fileManager.currentDirectoryPath, isDirectory: true)
        return RuntimePaths(
            modeLabel: "独立运行模式",
            isTakeover: false,
            gatewayRoot: gatewayRoot,
            runtimeDir: runtimeDir,
            dataDir: dataDir,
            envFileURL: base.appendingPathComponent("config/qq-only.env"),
            hubPort: 3789,
            colimaProfile: "snowluma",
            dockerContext: "colima-snowluma",
            snowlumaContainer: "snowluma"
        )
    }

    public func configure(from detection: DeploymentMode) -> RuntimePaths {
        switch detection {
        case .existingTakeover(let existing):
            let appSupportPaths = Self.defaultStandalonePaths(fileManager: fileManager)
            if existing.isStandaloneInstall {
                let standalone = RuntimePaths(
                    modeLabel: "独立运行模式",
                    isTakeover: false,
                    gatewayRoot: appSupportPaths.gatewayRoot,
                    runtimeDir: existing.runtimeDirectory ?? appSupportPaths.runtimeDir,
                    dataDir: existing.dataDirectory ?? appSupportPaths.dataDir,
                    envFileURL: existing.envFileURL ?? appSupportPaths.envFileURL,
                    hubPort: existing.hubPort,
                    colimaProfile: "snowluma",
                    dockerContext: "colima-snowluma",
                    snowlumaContainer: "snowluma"
                )
                self.paths = standalone
                return standalone
            }
            let projectDir = existing.projectDirectory ?? appSupportPaths.gatewayRoot
            let runtimeDir = existing.runtimeDirectory ?? projectDir.appendingPathComponent("runtime", isDirectory: true)
            let dataDir = existing.dataDirectory ?? runtimeDir.appendingPathComponent("qq-only-data", isDirectory: true)
            let updated = RuntimePaths(
                modeLabel: "无损接管模式",
                isTakeover: true,
                gatewayRoot: projectDir,
                runtimeDir: runtimeDir,
                dataDir: dataDir,
                envFileURL: existing.envFileURL,
                hubPort: existing.hubPort,
                colimaProfile: "snowluma",
                dockerContext: "colima-snowluma",
                snowlumaContainer: "snowluma"
            )
            self.paths = updated
            return updated
        case .freshInstall:
            let standalone = Self.defaultStandalonePaths(fileManager: fileManager)
            self.paths = standalone
            return standalone
        }
    }

    public func currentPaths() -> RuntimePaths {
        paths
    }

    public func hubBaseURL() -> URL {
        URL(string: "http://127.0.0.1:\(paths.hubPort)")!
    }

    public func checkHubHealth() async -> HealthResponse? {
        let client = GatewayAPIClient(baseURL: hubBaseURL(), token: "")
        return try? await client.health()
    }

    public func inspectColimaAndDocker() async -> ColimaDockerSnapshot {
        let colima = detector.findExecutable(named: "colima")
        let docker = detector.findExecutable(named: "docker")
        guard let colima, let docker else {
            return ColimaDockerSnapshot(
                colimaInstalled: colima != nil,
                dockerInstalled: docker != nil,
                colimaRunning: false,
                containerExists: false,
                containerRunning: false,
                statusMessage: "缺少 Colima 或 Docker CLI"
            )
        }

        let colimaProbe = try? await runner.run(
            executable: colima,
            arguments: ["status", "--profile", paths.colimaProfile],
            currentDirectory: nil,
            extraEnv: [:],
            timeoutSeconds: 6
        )
        let colimaRunning = colimaProbe?.succeeded == true

        let inspect = try? await runner.run(
            executable: docker,
            arguments: ["--context", paths.dockerContext, "inspect", "-f", "{{.State.Running}}", paths.snowlumaContainer],
            currentDirectory: nil,
            extraEnv: [:],
            timeoutSeconds: 6
        )
        let containerExists = inspect?.succeeded == true
        let containerRunning = inspect?.stdout.trimmingCharacters(in: .whitespacesAndNewlines) == "true"

        let msg: String
        if containerRunning {
            msg = "SnowLuma 容器运行正常"
        } else if containerExists {
            msg = "SnowLuma 容器已停止"
        } else if colimaRunning {
            msg = "Colima VM 运行中，尚未创建 SnowLuma 容器"
        } else {
            msg = "Colima VM 未启动"
        }

        return ColimaDockerSnapshot(
            colimaInstalled: true,
            dockerInstalled: true,
            colimaRunning: colimaRunning,
            containerExists: containerExists,
            containerRunning: containerRunning,
            statusMessage: msg
        )
    }

    public func inspectQQSavedLoginState() async -> QQContainerLoginProbe {
        guard let docker = detector.findExecutable(named: "docker") else {
            return QQContainerLoginProbe(containerRunning: false, hasSavedLoginProfile: false)
        }
        let res = try? await runner.run(
            executable: docker,
            arguments: [
                "--context", paths.dockerContext,
                "exec", paths.snowlumaContainer,
                "sh", "-c",
                "test -f /app/.config/QQ/auth/login.enc && echo saved || echo fresh"
            ],
            currentDirectory: nil,
            extraEnv: [:],
            timeoutSeconds: 6
        )
        guard let res, res.succeeded else {
            return QQContainerLoginProbe(containerRunning: false, hasSavedLoginProfile: false)
        }
        let marker = res.stdout.trimmingCharacters(in: .whitespacesAndNewlines)
        return QQContainerLoginProbe(
            containerRunning: true,
            hasSavedLoginProfile: marker == "saved"
        )
    }

    public func startHub() async throws {
        if await checkHubHealth()?.ok == true {
            return
        }
        let launchStatus = await launchAgents.status()
        if launchStatus.hubPlistExists {
            if launchStatus.hubLoaded {
                try await launchAgents.kickstart(label: DeploymentDetector.hubPlistLabel)
            } else {
                try await launchAgents.bootstrap(label: DeploymentDetector.hubPlistLabel, plistURL: launchAgents.hubPlistURL)
            }
            try await waitForHubReady()
            return
        }
        try await spawnHubDirectly()
        try await waitForHubReady()
    }

    public func stopHub() async throws {
        let launchStatus = await launchAgents.status()
        if launchStatus.hubLoaded {
            await launchAgents.bootout(label: DeploymentDetector.hubPlistLabel)
        }
        if launchStatus.qqRuntimeLoaded {
            await launchAgents.bootout(label: DeploymentDetector.qqRuntimePlistLabel)
        }
        if let proc = managedHubProcess, proc.isRunning {
            proc.terminate()
            for _ in 0..<12 where proc.isRunning {
                try? await Task.sleep(nanoseconds: 150_000_000)
            }
            if proc.isRunning {
                kill(proc.processIdentifier, SIGKILL)
            }
            managedHubProcess = nil
        }
        await terminateExternalHubProcessesOnPort(paths.hubPort)
    }

    public func ensureQQRuntimeRunning() async throws -> String {
        guard let colima = detector.findExecutable(named: "colima"),
              let docker = detector.findExecutable(named: "docker") else {
            return "未检测到 Colima / Docker，跳过容器启动。"
        }
        let snapshot = await inspectColimaAndDocker()
        if snapshot.containerRunning {
            return "SnowLuma 容器已在运行。"
        }
        let home = fileManager.homeDirectoryForCurrentUser
        let profileDir = home.appendingPathComponent(".colima/\(paths.colimaProfile)", isDirectory: true)
        let limaDir = home.appendingPathComponent(".colima/_lima/colima-\(paths.colimaProfile)", isDirectory: true)
        guard fileManager.fileExists(atPath: profileDir.path) || fileManager.fileExists(atPath: limaDir.path) else {
            return "尚未初始化 Colima(\(paths.colimaProfile))，可在安装向导中初始化。"
        }

        if !snapshot.colimaRunning {
            _ = try? await repairColimaStaleState()
            let vmRes = try await runner.run(
                executable: colima,
                arguments: ["start", "--profile", paths.colimaProfile],
                currentDirectory: nil,
                extraEnv: ShellRunner.systemProxyEnvironment(),
                timeoutSeconds: 240
            )
            if !vmRes.succeeded {
                throw NSError(domain: "RuntimeSupervisor", code: Int(vmRes.exitCode), userInfo: [
                    NSLocalizedDescriptionKey: vmRes.stderr.isEmpty ? "启动 Colima VM 失败" : vmRes.stderr
                ])
            }
        }

        let inspect = try? await runner.run(
            executable: docker,
            arguments: ["--context", paths.dockerContext, "inspect", paths.snowlumaContainer],
            currentDirectory: nil,
            extraEnv: [:],
            timeoutSeconds: 8
        )
        if inspect?.succeeded == true {
            let startRes = try await runner.run(
                executable: docker,
                arguments: ["--context", paths.dockerContext, "start", paths.snowlumaContainer],
                currentDirectory: nil,
                extraEnv: [:],
                timeoutSeconds: 45
            )
            if !startRes.succeeded {
                throw NSError(domain: "RuntimeSupervisor", code: Int(startRes.exitCode), userInfo: [
                    NSLocalizedDescriptionKey: startRes.stderr.isEmpty ? "启动 snowluma 容器失败" : startRes.stderr
                ])
            }
            return "Colima 虚拟机与 SnowLuma 容器已启动。"
        }
        return "Colima 虚拟机已启动（容器尚未创建）。"
    }

    public func stopQQRuntime() async {
        await launchAgents.bootout(label: DeploymentDetector.qqRuntimePlistLabel)
        if let docker = detector.findExecutable(named: "docker") {
            _ = try? await runner.run(
                executable: docker,
                arguments: ["--context", paths.dockerContext, "stop", "-t", "6", paths.snowlumaContainer],
                currentDirectory: nil,
                extraEnv: [:],
                timeoutSeconds: 15
            )
        }
        if let colima = detector.findExecutable(named: "colima") {
            _ = try? await runner.run(
                executable: colima,
                arguments: ["stop", "--profile", paths.colimaProfile],
                currentDirectory: nil,
                extraEnv: [:],
                timeoutSeconds: 25
            )
        }
    }

    public func stopAllServices(stopQQRuntime: Bool) async {
        try? await stopHub()
        if stopQQRuntime {
            await self.stopQQRuntime()
        }
    }

    private func terminateExternalHubProcessesOnPort(_ port: Int) async {
        guard fileManager.isExecutableFile(atPath: "/usr/sbin/lsof") else { return }
        guard let res = try? await runner.run(
            executable: "/usr/sbin/lsof",
            arguments: ["-nP", "-tiTCP:\(String(port))", "-sTCP:LISTEN"],
            currentDirectory: nil,
            extraEnv: [:],
            timeoutSeconds: 5
        ), res.succeeded else {
            return
        }
        let pids = res.stdout
            .split(whereSeparator: \.isNewline)
            .compactMap { Int32($0.trimmingCharacters(in: .whitespacesAndNewlines)) }
            .filter { $0 > 1 }
        guard !pids.isEmpty else { return }

        var hubPids: [Int32] = []
        for pid in pids {
            if let psRes = try? await runner.run(
                executable: "/bin/ps",
                arguments: ["-p", String(pid), "-o", "command="],
                currentDirectory: nil,
                extraEnv: [:],
                timeoutSeconds: 3
            ), psRes.succeeded, psRes.stdout.contains("src/server.js") {
                hubPids.append(pid)
                kill(pid, SIGTERM)
            }
        }
        guard !hubPids.isEmpty else { return }
        for _ in 0..<12 {
            try? await Task.sleep(nanoseconds: 150_000_000)
            let anyAlive = hubPids.contains { kill($0, 0) == 0 }
            if !anyAlive { break }
        }
        for pid in hubPids where kill(pid, 0) == 0 {
            kill(pid, SIGKILL)
        }
    }

    public func restartHub() async throws {
        let launchStatus = await launchAgents.status()
        if launchStatus.hubPlistExists {
            if launchStatus.hubLoaded {
                try await launchAgents.kickstart(label: DeploymentDetector.hubPlistLabel)
            } else {
                try await launchAgents.bootstrap(label: DeploymentDetector.hubPlistLabel, plistURL: launchAgents.hubPlistURL)
            }
            try await waitForHubReady()
            return
        }
        try await stopHub()
        try await Task.sleep(nanoseconds: 400_000_000)
        try await spawnHubDirectly()
        try await waitForHubReady()
    }

    public func restartQQRuntime() async throws {
        guard let colima = detector.findExecutable(named: "colima"),
              let docker = detector.findExecutable(named: "docker") else {
            throw NSError(domain: "RuntimeSupervisor", code: 2, userInfo: [
                NSLocalizedDescriptionKey: "未找到 Colima 或 Docker 可执行文件"
            ])
        }
        let snapshot = await inspectColimaAndDocker()
        if !snapshot.colimaRunning {
            _ = try await repairColimaStaleState()
            let startVM = try await runner.run(
                executable: colima,
                arguments: ["start", "--profile", paths.colimaProfile],
                currentDirectory: nil,
                extraEnv: [:],
                timeoutSeconds: 120
            )
            if !startVM.succeeded {
                throw NSError(domain: "RuntimeSupervisor", code: Int(startVM.exitCode), userInfo: [
                    NSLocalizedDescriptionKey: startVM.stderr.isEmpty ? "启动 Colima VM 失败" : startVM.stderr
                ])
            }
        }
        var containerReady = snapshot.containerExists
        if !containerReady {
            let check = try? await runner.run(
                executable: docker,
                arguments: ["--context", paths.dockerContext, "inspect", paths.snowlumaContainer],
                currentDirectory: nil,
                extraEnv: [:],
                timeoutSeconds: 6
            )
            containerReady = check?.succeeded == true
        }
        guard containerReady else {
            throw NSError(domain: "RuntimeSupervisor", code: 3, userInfo: [
                NSLocalizedDescriptionKey: "未检测到现有 snowluma 容器，为保护数据拒绝自动重建"
            ])
        }
        let restart = try await runner.run(
            executable: docker,
            arguments: ["--context", paths.dockerContext, "restart", paths.snowlumaContainer],
            currentDirectory: nil,
            extraEnv: [:],
            timeoutSeconds: 45
        )
        if !restart.succeeded {
            throw NSError(domain: "RuntimeSupervisor", code: Int(restart.exitCode), userInfo: [
                NSLocalizedDescriptionKey: restart.stderr.isEmpty ? "重启 snowluma 容器失败" : restart.stderr
            ])
        }
    }

    public func repairColimaStaleState() async throws -> String {
        let capabilities = await detector.probeCapabilities()
        guard let node = capabilities.nodePath else {
            return "未检测到 Node.js，跳过残留清理。"
        }
        let script = paths.gatewayRoot.appendingPathComponent("scripts/colima-stale-state.mjs")
        guard fileManager.fileExists(atPath: script.path) else {
            return "未找到 colima-stale-state.mjs。"
        }
        let limaDir = fileManager.homeDirectoryForCurrentUser
            .appendingPathComponent(".colima/_lima/colima-\(paths.colimaProfile)")
        let res = try await runner.run(
            executable: node,
            arguments: [script.path, limaDir.path],
            currentDirectory: paths.gatewayRoot,
            extraEnv: [:],
            timeoutSeconds: 10
        )
        return res.succeeded ? "Colima 状态检查通过，残留锁已清理（如有）。" : (res.stderr.isEmpty ? "Colima 当前仍在运行或状态不确定，未执行清理。" : res.stderr)
    }

    /// Exports the active SnowLuma Docker image as a portable `.tar.gz` archive (read-only on Docker/container).
    public func exportSnowlumaImage(to destinationURL: URL) async throws -> String {
        guard let docker = detector.findExecutable(named: "docker") else {
            throw NSError(domain: "RuntimeSupervisor", code: 20, userInfo: [
                NSLocalizedDescriptionKey: "未找到 Docker CLI"
            ])
        }

        // Prefer the image currently backing snowluma container, else first snowluma image
        var imageTag: String?
        if let inspect = try? await runner.run(
            executable: docker,
            arguments: ["--context", paths.dockerContext, "inspect", "-f", "{{.Config.Image}}", paths.snowlumaContainer],
            currentDirectory: nil,
            extraEnv: [:],
            timeoutSeconds: 6
        ), inspect.succeeded {
            let candidate = inspect.stdout.trimmingCharacters(in: .whitespacesAndNewlines)
            if !candidate.isEmpty { imageTag = candidate }
        }
        if imageTag == nil, let listRes = try? await runner.run(
            executable: docker,
            arguments: ["--context", paths.dockerContext, "images", "--format", "{{.Repository}}:{{.Tag}}"],
            currentDirectory: nil,
            extraEnv: [:],
            timeoutSeconds: 8
        ), listRes.succeeded {
            imageTag = listRes.stdout
                .split(whereSeparator: \.isNewline)
                .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
                .first { $0.lowercased().contains("snowluma") }
        }

        guard let resolvedImage = imageTag else {
            throw NSError(domain: "RuntimeSupervisor", code: 21, userInfo: [
                NSLocalizedDescriptionKey: "未找到可导出的 SnowLuma 镜像，请先确认 Colima 虚拟机正在运行。"
            ])
        }

        let context = paths.dockerContext
        try fileManager.createDirectory(at: destinationURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        _ = fileManager.createFile(atPath: destinationURL.path, contents: nil)
        let outFile = try FileHandle(forWritingTo: destinationURL)
        defer { try? outFile.close() }

        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            DispatchQueue.global(qos: .userInitiated).async {
                let pipe = Pipe()
                let saveProc = Process()
                saveProc.executableURL = URL(fileURLWithPath: docker)
                saveProc.arguments = ["--context", context, "save", resolvedImage]
                saveProc.environment = ShellRunner.buildWhitelistedEnvironment()
                saveProc.standardOutput = pipe
                saveProc.standardError = FileHandle.nullDevice

                let gzipProc = Process()
                gzipProc.executableURL = URL(fileURLWithPath: "/usr/bin/gzip")
                gzipProc.arguments = ["-c"]
                gzipProc.standardInput = pipe
                gzipProc.standardOutput = outFile
                gzipProc.standardError = FileHandle.nullDevice

                do {
                    try gzipProc.run()
                    try saveProc.run()
                } catch {
                    continuation.resume(throwing: error)
                    return
                }

                saveProc.waitUntilExit()
                try? pipe.fileHandleForWriting.close()
                gzipProc.waitUntilExit()

                if saveProc.terminationStatus != 0 || gzipProc.terminationStatus != 0 {
                    continuation.resume(throwing: NSError(domain: "RuntimeSupervisor", code: 22, userInfo: [
                        NSLocalizedDescriptionKey: "导出 Docker 镜像 \(resolvedImage) 失败（退出码 \(saveProc.terminationStatus)/\(gzipProc.terminationStatus)）"
                    ]))
                } else {
                    continuation.resume(returning: ())
                }
            }
        }
        try? fileManager.setAttributes([.posixPermissions: 0o600], ofItemAtPath: destinationURL.path)
        return resolvedImage
    }

    private func spawnHubDirectly() async throws {
        let capabilities = await detector.probeCapabilities()
        guard let node = capabilities.nodePath else {
            throw NSError(domain: "RuntimeSupervisor", code: 4, userInfo: [
                NSLocalizedDescriptionKey: "未找到 Node.js 可执行文件，请先完成环境准备。"
            ])
        }
        let serverJS = paths.gatewayRoot.appendingPathComponent("src/server.js")
        guard fileManager.fileExists(atPath: serverJS.path) else {
            throw NSError(domain: "RuntimeSupervisor", code: 5, userInfo: [
                NSLocalizedDescriptionKey: "未找到网关入口：\(serverJS.path)"
            ])
        }
        try fileManager.createDirectory(at: paths.runtimeDir, withIntermediateDirectories: true)
        try fileManager.createDirectory(at: paths.dataDir, withIntermediateDirectories: true)
        let logsDir = paths.runtimeDir.appendingPathComponent("logs", isDirectory: true)
        try fileManager.createDirectory(at: logsDir, withIntermediateDirectories: true)

        var extraEnv: [String: String] = [:]
        if let envFile = paths.envFileURL, fileManager.fileExists(atPath: envFile.path) {
            extraEnv.merge(detector.parseEnvFile(envFile)) { _, new in new }
            extraEnv["WORKBUDDY_QQ_ENV_FILE"] = envFile.path
        }
        extraEnv["WORKBUDDY_QQ_RUNTIME_DIR"] = paths.runtimeDir.path
        extraEnv["WORKBUDDY_QQ_DATA_DIR"] = paths.dataDir.path
        extraEnv["WORKBUDDY_QQ_WORKSPACE_DIR"] = paths.runtimeDir.appendingPathComponent("workspace").path
        extraEnv["WB_AGENT_SESSION_MAP_PATH"] = paths.dataDir.appendingPathComponent("workbuddy-session-map.json").path
        if let py = capabilities.pythonVenvPath ?? capabilities.pythonPath {
            extraEnv["WORKBUDDY_QQ_WB_PYTHON"] = py
        }
        if let cli = capabilities.codebuddyPath {
            extraEnv["WB_AGENT_CLI"] = cli
        }
        if let colima = capabilities.colimaPath {
            extraEnv["WORKBUDDY_QQ_COLIMA_PATH"] = colima
        }
        if let docker = capabilities.dockerPath {
            extraEnv["WORKBUDDY_QQ_DOCKER_PATH"] = docker
        }
        if extraEnv["WORKBUDDY_QQ_API_TOKEN"] == nil, let hubToken = keychain.read(account: .hubApiToken) {
            extraEnv["WORKBUDDY_QQ_API_TOKEN"] = hubToken
        }
        if extraEnv["ONEBOT_ACCESS_TOKEN"] == nil, let oneBotToken = keychain.read(account: .oneBotApiToken) {
            extraEnv["ONEBOT_ACCESS_TOKEN"] = oneBotToken
        }
        if extraEnv["WORKBUDDY_QQ_HA_ENABLED"] == "1",
           extraEnv["WORKBUDDY_QQ_HA_TOKEN"] == nil,
           let haToken = keychain.read(account: .homeAssistantApiToken) {
            extraEnv["WORKBUDDY_QQ_HA_TOKEN"] = haToken
        }

        let logFile = logsDir.appendingPathComponent("chat-hub.log")
        let errFile = logsDir.appendingPathComponent("chat-hub.err.log")
        if !fileManager.fileExists(atPath: logFile.path) { fileManager.createFile(atPath: logFile.path, contents: nil) }
        if !fileManager.fileExists(atPath: errFile.path) { fileManager.createFile(atPath: errFile.path, contents: nil) }

        let outHandle = try FileHandle(forWritingTo: logFile)
        _ = try? outHandle.seekToEnd()
        let errHandle = try FileHandle(forWritingTo: errFile)
        _ = try? errHandle.seekToEnd()

        let process = Process()
        process.executableURL = URL(fileURLWithPath: node)
        process.arguments = [serverJS.path]
        process.currentDirectoryURL = paths.runtimeDir
        process.environment = ShellRunner.buildWhitelistedEnvironment(extraEnv: extraEnv)
        process.standardInput = FileHandle.nullDevice
        process.standardOutput = outHandle
        process.standardError = errHandle
        try process.run()
        managedHubProcess = process
    }

    public func waitForHubReady() async throws {
        for _ in 0..<120 {
            if await checkHubHealth()?.ok == true {
                return
            }
            try await Task.sleep(nanoseconds: 250_000_000)
        }
        throw NSError(domain: "RuntimeSupervisor", code: 6, userInfo: [
            NSLocalizedDescriptionKey: "Hub 启动超时，请查看运行日志排查原因。"
        ])
    }
}
