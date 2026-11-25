import Foundation

public struct ExistingDeployment: Equatable, Sendable {
    public var projectDirectory: URL?
    public var envFileURL: URL?
    public var dataDirectory: URL?
    public var runtimeDirectory: URL?
    public var isStandaloneInstall: Bool = false
    public var hubPort: Int
    public var ownerQQ: String?
    public var botQQ: String?
    public var hasHubLaunchAgent: Bool
    public var hasQQRuntimeLaunchAgent: Bool
    public var hasColimaSnowlumaProfile: Bool
    public var hasSnowlumaContainer: Bool
    public var snowlumaContainerRunning: Bool
    public var codebuddyCLIPath: String?
    public var hasHubTokenInKeychain: Bool
    public var hasOneBotTokenInKeychain: Bool

    public var isTakeoverCandidate: Bool {
        projectDirectory != nil
            || hasHubLaunchAgent
            || hasSnowlumaContainer
            || hasColimaSnowlumaProfile
            || (isStandaloneInstall && envFileURL != nil)
    }
}

public enum DeploymentMode: Equatable, Sendable {
    case existingTakeover(ExistingDeployment)
    case freshInstall
}

public struct EnvironmentCapabilities: Equatable, Sendable {
    public var brewPath: String?
    public var nodePath: String?
    public var pythonPath: String?
    public var pythonVenvPath: String?
    public var pythonSDKReady: Bool
    public var colimaPath: String?
    public var dockerPath: String?
    public var codebuddyPath: String?
    public var dockerBuildxReady: Bool
    public var bundledNodePath: String?
    public var bundledPythonPath: String?
}

public final class DeploymentDetector: Sendable {
    public static let hubPlistLabel = "local.workbuddy.qq-agent-gateway.chat-hub"
    public static let qqRuntimePlistLabel = "local.workbuddy.qq-agent-gateway.qq-runtime"

    public static func standaloneVenvDirectory(
        homeDirectory: URL = FileManager.default.homeDirectoryForCurrentUser
    ) -> URL {
        homeDirectory
            .appendingPathComponent("Library/Application Support/WorkBuddyQQGateway/runtime/venv", isDirectory: true)
    }

    private nonisolated(unsafe) let fileManager: FileManager
    private let runner: CommandRunning
    private let homeDirectory: URL
    private let launchAgentsDirectory: URL
    private let keychain: KeychainStore
    private let bundleResourceURL: URL?
    private let candidateProjectDirectories: [URL]

    public init(
        fileManager: FileManager = .default,
        runner: CommandRunning = ShellRunner(),
        homeDirectory: URL = FileManager.default.homeDirectoryForCurrentUser,
        launchAgentsDirectory: URL? = nil,
        keychain: KeychainStore = KeychainStore(),
        bundleResourceURL: URL? = Bundle.main.resourceURL,
        candidateProjectDirectories: [URL]? = nil
    ) {
        self.fileManager = fileManager
        self.runner = runner
        self.homeDirectory = homeDirectory
        self.launchAgentsDirectory = launchAgentsDirectory
            ?? homeDirectory.appendingPathComponent("Library/LaunchAgents", isDirectory: true)
        self.keychain = keychain
        self.bundleResourceURL = bundleResourceURL
        self.candidateProjectDirectories = candidateProjectDirectories ?? []
    }

    public func detect(probeContainers: Bool = true) async -> DeploymentMode {
        let hubPlistURL = launchAgentsDirectory.appendingPathComponent("\(Self.hubPlistLabel).plist")
        let qqPlistURL = launchAgentsDirectory.appendingPathComponent("\(Self.qqRuntimePlistLabel).plist")

        let hasHubPlist = fileManager.fileExists(atPath: hubPlistURL.path)
        let hasQQPlist = fileManager.fileExists(atPath: qqPlistURL.path)

        let plistEnv: [String: String] = {
            let fromHub = extractPlistEnv(fromPlistURL: hubPlistURL)
            if !fromHub.isEmpty { return fromHub }
            return extractPlistEnv(fromPlistURL: qqPlistURL)
        }()
        let plistEnvFile = plistEnv["WORKBUDDY_QQ_ENV_FILE"].map { URL(fileURLWithPath: $0) }
        let plistRuntimeDir = plistEnv["WORKBUDDY_QQ_RUNTIME_DIR"].map { URL(fileURLWithPath: $0, isDirectory: true) }
        let plistDataDir = plistEnv["WORKBUDDY_QQ_DATA_DIR"].map { URL(fileURLWithPath: $0, isDirectory: true) }

        var detectedProjectDir: URL? = extractProjectDir(fromPlistURL: hubPlistURL)
            ?? extractProjectDir(fromPlistURL: qqPlistURL)

        if detectedProjectDir == nil {
            for candidate in candidateProjectDirectories {
                if fileManager.fileExists(atPath: candidate.appendingPathComponent("src/server.js").path),
                   fileManager.fileExists(atPath: candidate.appendingPathComponent("config/qq-only.env").path) {
                    detectedProjectDir = candidate
                    break
                }
            }
        }

        let standaloneBase = homeDirectory.appendingPathComponent("Library/Application Support/WorkBuddyQQGateway", isDirectory: true)
        let standaloneEnvCandidate = standaloneBase.appendingPathComponent("config/qq-only.env")
        let envFile: URL? = plistEnvFile
            ?? detectedProjectDir?.appendingPathComponent("config/qq-only.env")
            ?? (fileManager.fileExists(atPath: standaloneEnvCandidate.path) ? standaloneEnvCandidate : nil)
        let envMap = envFile.flatMap { fileManager.fileExists(atPath: $0.path) ? parseEnvFile($0) : nil } ?? [:]

        let isStandaloneInstall =
            (detectedProjectDir?.path.contains(".app/Contents/Resources/gateway") == true)
            || (envFile?.path.contains("Application Support/WorkBuddyQQGateway") == true)
            || (plistRuntimeDir?.path.contains("Application Support/WorkBuddyQQGateway") == true)

        let resolvedRuntimeDir: URL? = plistRuntimeDir
            ?? (isStandaloneInstall ? standaloneBase.appendingPathComponent("runtime", isDirectory: true) : nil)

        let dataDir: URL? = {
            if let plistDataDir {
                return plistDataDir
            }
            if let explicit = envMap["WORKBUDDY_QQ_DATA_DIR"], !explicit.isEmpty {
                return URL(fileURLWithPath: explicit, isDirectory: true)
            }
            if let resolvedRuntimeDir {
                return resolvedRuntimeDir.appendingPathComponent("qq-only-data", isDirectory: true)
            }
            if let project = detectedProjectDir {
                let defaultData = project.appendingPathComponent("runtime/qq-only-data", isDirectory: true)
                if fileManager.fileExists(atPath: defaultData.path) {
                    return defaultData
                }
            }
            return nil
        }()

        let port = Int(envMap["WORKBUDDY_QQ_PORT"] ?? "") ?? 3789
        let ownerQQ = envMap["WORKBUDDY_QQ_OWNER_QQ_ID"]
        let botQQ = envMap["WORKBUDDY_QQ_BOT_QQ_ID"]

        let colimaProfileDir = homeDirectory.appendingPathComponent(".colima/snowluma", isDirectory: true)
        let colimaLimaDir = homeDirectory.appendingPathComponent(".colima/_lima/colima-snowluma", isDirectory: true)
        let hasColimaProfile = fileManager.fileExists(atPath: colimaProfileDir.path)
            || fileManager.fileExists(atPath: colimaLimaDir.path)

        var hasContainer = false
        var containerRunning = false
        if probeContainers, let dockerPath = findExecutable(named: "docker") {
            if let res = try? await runner.run(
                executable: dockerPath,
                arguments: ["--context", "colima-snowluma", "inspect", "-f", "{{.State.Running}}", "snowluma"],
                currentDirectory: nil,
                extraEnv: [:],
                timeoutSeconds: 6
            ), res.succeeded {
                hasContainer = true
                containerRunning = res.stdout.trimmingCharacters(in: .whitespacesAndNewlines) == "true"
            }
        }

        let cliPath = findCodeBuddyCLI()
        let hasHubToken = keychain.exists(account: .hubApiToken)
        let hasOneBotToken = keychain.exists(account: .oneBotApiToken)

        let existing = ExistingDeployment(
            projectDirectory: detectedProjectDir,
            envFileURL: plistEnvFile ?? envFile.flatMap { fileManager.fileExists(atPath: $0.path) ? $0 : nil },
            dataDirectory: dataDir,
            runtimeDirectory: resolvedRuntimeDir,
            isStandaloneInstall: isStandaloneInstall,
            hubPort: port,
            ownerQQ: ownerQQ,
            botQQ: botQQ,
            hasHubLaunchAgent: hasHubPlist,
            hasQQRuntimeLaunchAgent: hasQQPlist,
            hasColimaSnowlumaProfile: hasColimaProfile,
            hasSnowlumaContainer: hasContainer,
            snowlumaContainerRunning: containerRunning,
            codebuddyCLIPath: cliPath,
            hasHubTokenInKeychain: hasHubToken,
            hasOneBotTokenInKeychain: hasOneBotToken
        )

        return existing.isTakeoverCandidate ? .existingTakeover(existing) : .freshInstall
    }

    public func probeCapabilities() async -> EnvironmentCapabilities {
        let bundledNodeURL = bundleResourceURL?.appendingPathComponent("runtime/node")
        let bundledNode = bundledNodeURL.flatMap { fileManager.isExecutableFile(atPath: $0.path) ? $0.path : nil }
        let bundledPythonURL = bundleResourceURL?.appendingPathComponent("runtime/python/bin/python3")
        let bundledPython = bundledPythonURL.flatMap { fileManager.isExecutableFile(atPath: $0.path) ? $0.path : nil }

        let brewPath = findExecutable(named: "brew")
        let nodePath = bundledNode ?? findExecutable(named: "node")
        let colimaPath = findExecutable(named: "colima")
        let dockerPath = findExecutable(named: "docker")
        let codebuddyPath = findCodeBuddyCLI()

        var pythonVenvPath: String? = bundledPython
        if pythonVenvPath == nil {
            let standaloneVenvPy = Self.standaloneVenvDirectory(homeDirectory: homeDirectory)
                .appendingPathComponent("bin/python").path
            if fileManager.isExecutableFile(atPath: standaloneVenvPy) {
                pythonVenvPath = standaloneVenvPy
            }
        }
        if pythonVenvPath == nil {
            for candidate in candidateProjectDirectories {
                let venvPy = candidate.appendingPathComponent("modules/workbuddy-agent/.venv/bin/python").path
                if fileManager.isExecutableFile(atPath: venvPy) {
                    pythonVenvPath = venvPy
                    break
                }
            }
        }

        var venvSupported = false
        var pythonSDKReady = false
        if let venvPy = pythonVenvPath {
            venvSupported = await isPythonSupported(at: venvPy)
            if venvSupported, let res = try? await runner.run(
                executable: venvPy,
                arguments: ["-c", "import codebuddy_agent_sdk, anyio"],
                currentDirectory: nil,
                extraEnv: [:],
                timeoutSeconds: 5
            ), res.succeeded {
                pythonSDKReady = true
            }
        }
        let basePython = await findSupportedBasePython()
        let pythonPath = (venvSupported ? pythonVenvPath : nil) ?? basePython

        var buildxReady = false
        if let dockerPath {
            if let res = try? await runner.run(
                executable: dockerPath,
                arguments: ["buildx", "version"],
                currentDirectory: nil,
                extraEnv: [:],
                timeoutSeconds: 4
            ), res.succeeded {
                buildxReady = true
            }
        }

        return EnvironmentCapabilities(
            brewPath: brewPath,
            nodePath: nodePath,
            pythonPath: pythonPath,
            pythonVenvPath: pythonVenvPath,
            pythonSDKReady: pythonSDKReady,
            colimaPath: colimaPath,
            dockerPath: dockerPath,
            codebuddyPath: codebuddyPath,
            dockerBuildxReady: buildxReady,
            bundledNodePath: bundledNode,
            bundledPythonPath: bundledPython
        )
    }

    public static func parsePythonVersion(_ output: String) -> (major: Int, minor: Int)? {
        let range = NSRange(output.startIndex..<output.endIndex, in: output)
        guard let regex = try? NSRegularExpression(pattern: #"(\d+)\.(\d+)"#),
              let match = regex.firstMatch(in: output, range: range),
              let majorRange = Range(match.range(at: 1), in: output),
              let minorRange = Range(match.range(at: 2), in: output),
              let major = Int(output[majorRange]),
              let minor = Int(output[minorRange]) else {
            return nil
        }
        return (major, minor)
    }

    public static func isSupportedPythonVersion(_ output: String) -> Bool {
        guard let parsed = parsePythonVersion(output) else { return false }
        return parsed.major > 3 || (parsed.major == 3 && parsed.minor >= 10)
    }

    public func isPythonSupported(at executablePath: String) async -> Bool {
        guard let res = try? await runner.run(
            executable: executablePath,
            arguments: ["-c", "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')"],
            currentDirectory: nil,
            extraEnv: [:],
            timeoutSeconds: 4
        ), res.succeeded else {
            return false
        }
        return Self.isSupportedPythonVersion(res.stdout)
    }

    public func findBasePythonCandidates() -> [String] {
        let searchPaths = [
            homeDirectory.appendingPathComponent(".local/bin").path,
            "/opt/homebrew/bin",
            "/opt/homebrew/opt/python@3.14/bin",
            "/opt/homebrew/opt/python@3.13/bin",
            "/opt/homebrew/opt/python@3.12/bin",
            "/opt/homebrew/opt/python@3.11/bin",
            "/opt/homebrew/opt/python@3.10/bin",
            "/usr/local/bin",
            "/usr/local/opt/python@3.14/bin",
            "/usr/local/opt/python@3.13/bin",
            "/usr/local/opt/python@3.12/bin",
            "/usr/local/opt/python@3.11/bin",
            "/Library/Frameworks/Python.framework/Versions/3.14/bin",
            "/Library/Frameworks/Python.framework/Versions/3.13/bin",
            "/Library/Frameworks/Python.framework/Versions/3.12/bin",
            "/Library/Frameworks/Python.framework/Versions/3.11/bin",
            "/Library/Frameworks/Python.framework/Versions/3.10/bin",
            homeDirectory.appendingPathComponent("miniconda3/bin").path,
            homeDirectory.appendingPathComponent("anaconda3/bin").path,
            homeDirectory.appendingPathComponent("miniforge3/bin").path,
            homeDirectory.appendingPathComponent("mambaforge/bin").path,
            "/opt/miniconda3/bin",
            "/opt/anaconda3/bin",
            "/opt/homebrew/miniconda3/bin",
            "/opt/homebrew/anaconda3/bin",
            "/opt/homebrew/Caskroom/miniconda/base/bin",
            "/opt/homebrew/Caskroom/miniforge/base/bin",
            "/opt/homebrew/Caskroom/anaconda/base/bin",
            homeDirectory.appendingPathComponent(".pyenv/shims").path,
            "/usr/bin",
            "/bin"
        ]
        let names = ["python3.14", "python3.13", "python3.12", "python3.11", "python3.10", "python3"]
        var candidates: [String] = []
        var seen = Set<String>()
        for dir in searchPaths {
            for name in names {
                let candidate = (dir as NSString).appendingPathComponent(name)
                if !seen.contains(candidate), fileManager.isExecutableFile(atPath: candidate) {
                    seen.insert(candidate)
                    candidates.append(candidate)
                }
            }
        }
        return candidates
    }

    public func findBasePython() -> String? {
        findBasePythonCandidates().first
    }

    public func findSupportedBasePython() async -> String? {
        for candidate in findBasePythonCandidates() {
            if await isPythonSupported(at: candidate) {
                return candidate
            }
        }
        return nil
    }

    public var standaloneVenvPath: URL {
        Self.standaloneVenvDirectory(homeDirectory: homeDirectory)
    }

    public func findCodeBuddyCLI() -> String? {
        let standalone = homeDirectory.appendingPathComponent(".local/bin/codebuddy").path
        if fileManager.isExecutableFile(atPath: standalone) {
            return standalone
        }
        return findExecutable(named: "codebuddy")
    }

    public func findExecutable(named binary: String) -> String? {
        let searchPaths = [
            homeDirectory.appendingPathComponent(".local/bin").path,
            "/opt/homebrew/bin",
            "/usr/local/bin",
            "/usr/bin",
            "/bin"
        ]
        for dir in searchPaths {
            let candidate = (dir as NSString).appendingPathComponent(binary)
            if fileManager.isExecutableFile(atPath: candidate) {
                return candidate
            }
        }
        return nil
    }

    public func parseEnvFile(_ url: URL) -> [String: String] {
        guard let content = try? String(contentsOf: url, encoding: .utf8) else {
            return [:]
        }
        var result: [String: String] = [:]
        for rawLine in content.split(whereSeparator: \.isNewline) {
            let line = rawLine.trimmingCharacters(in: .whitespaces)
            if line.isEmpty || line.hasPrefix("#") { continue }
            guard let eq = line.firstIndex(of: "=") else { continue }
            let key = String(line[..<eq]).trimmingCharacters(in: .whitespaces)
            var value = String(line[line.index(after: eq)...]).trimmingCharacters(in: .whitespaces)
            if (value.hasPrefix("\"") && value.hasSuffix("\"")) || (value.hasPrefix("'") && value.hasSuffix("'")) {
                if value.count >= 2 {
                    value = String(value.dropFirst().dropLast())
                }
            }
            if !key.isEmpty {
                result[key] = value
            }
        }
        return result
    }

    private func extractPlistEnv(fromPlistURL plistURL: URL) -> [String: String] {
        guard let data = try? Data(contentsOf: plistURL),
              let plist = try? PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any],
              let env = plist["EnvironmentVariables"] as? [String: Any] else {
            return [:]
        }
        var result: [String: String] = [:]
        for (key, value) in env {
            if let str = value as? String {
                result[key] = str
            }
        }
        return result
    }

    private func extractProjectDir(fromPlistURL plistURL: URL) -> URL? {
        guard let data = try? Data(contentsOf: plistURL),
              let plist = try? PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any] else {
            return nil
        }
        if let env = plist["EnvironmentVariables"] as? [String: Any],
           let projectPath = env["WORKBUDDY_QQ_PROJECT_DIR"] as? String,
           fileManager.fileExists(atPath: projectPath) {
            return URL(fileURLWithPath: projectPath, isDirectory: true)
        }
        if let workingDir = plist["WorkingDirectory"] as? String,
           fileManager.fileExists(atPath: workingDir) {
            return URL(fileURLWithPath: workingDir, isDirectory: true)
        }
        return nil
    }
}
