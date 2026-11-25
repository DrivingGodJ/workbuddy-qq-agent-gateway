import Foundation

public enum OnboardingStep: Int, CaseIterable, Identifiable, Sendable {
    case detectMode = 1
    case runtimeDependencies = 2
    case workbuddyLogin = 3
    case vmAndContainer = 4
    case qqScanAndOneBot = 5
    case permissionsAndLaunch = 6

    public var id: Int { rawValue }

    public var title: String {
        switch self {
        case .detectMode: return "环境检测与模式选择"
        case .runtimeDependencies: return "运行环境准备"
        case .workbuddyLogin: return "WorkBuddy 账号登录"
        case .vmAndContainer: return "初始化 QQ 虚拟机与容器"
        case .qqScanAndOneBot: return "QQ 小号扫码与 OneBot 对接"
        case .permissionsAndLaunch: return "权限、人格与开机自启"
        }
    }
}

public enum OnboardingInstallChoice: String, Sendable {
    case pending
    case takeover
    case freshInstall
}

public enum SnowlumaImageSourceMode: String, CaseIterable, Identifiable, Sendable {
    case existingLocalImage = "本机已有镜像"
    case offlineArchiveTar = "导入离线镜像包 (.tar / .tar.gz)"
    case localProjectFolder = "从本地 / NAS 工程目录构建"

    public var id: String { rawValue }
}

@MainActor
@Observable
public final class OnboardingOrchestrator {
    public var currentStep: OnboardingStep = .detectMode
    public var detectionMode: DeploymentMode = .freshInstall
    public var capabilities: EnvironmentCapabilities?
    public var installChoice: OnboardingInstallChoice = .pending
    public var dryRun: Bool

    public var isBusy: Bool = false
    public var activeTaskKey: String? = nil
    public var activeTaskStatus: String? = nil
    public var commandLogs: [String] = []
    public var lastError: String?

    // Step 3
    public var selectedLoginSite: CodeBuddyLoginSite = .chinese
    public var workbuddyLoggedIn: Bool = false
    public var workbuddyVersion: String?
    public var workbuddyModelCount: Int = 0
    public var workbuddyStatusDetail: String?
    public var capturedAuthURL: URL?

    // Step 4
    public var colimaRunning: Bool = false
    public var containerReady: Bool = false
    public var generatedVNCPassword: String?
    public var imageSourceMode: SnowlumaImageSourceMode = .existingLocalImage
    public var allDockerImages: [String] = []
    public var availableDockerImages: [String] = []
    public var showAllDockerImages: Bool = false
    public var selectedImageTag: String = "snowluma-local:v1.14.15"
    public var selectedArchiveURL: URL?
    public var selectedProjectFolderURL: URL?

    public var displayedDockerImages: [String] {
        let filtered = Self.filterSnowlumaImages(from: allDockerImages)
        if showAllDockerImages || filtered.isEmpty {
            return allDockerImages
        }
        return filtered
    }

    // Step 5
    public var ownerQQ: String = ""
    public var botQQ: String = ""
    public var credentialsGenerated: Bool = false
    public var twoWayConnectivityOK: Bool = false
    public var twoWayConnectivityMessage: String = ""

    // Step 6
    public var permissionSummary = SystemPermissionSummary(calendar: .notDetermined, reminders: .notDetermined, notifications: .notDetermined)
    public var enableLaunchAtLogin: Bool = true
    public var importedPersonaPreview: String?
    public var importedPersonaBundle: PersonaBundle?

    private let detector: DeploymentDetector
    private let runner: CommandRunning
    private let keychain: KeychainStore
    private let authHelper: CodeBuddyAuthHelper
    private let launchAgents: LaunchAgentManager
    private let permissions: PermissionManager
    private let personaPortability: PersonaPortabilityService

    public init(
        dryRun: Bool = false,
        detector: DeploymentDetector = DeploymentDetector(),
        runner: CommandRunning = ShellRunner(),
        keychain: KeychainStore = KeychainStore(),
        authHelper: CodeBuddyAuthHelper = CodeBuddyAuthHelper(),
        launchAgents: LaunchAgentManager = LaunchAgentManager(),
        permissions: PermissionManager = PermissionManager(),
        personaPortability: PersonaPortabilityService = PersonaPortabilityService()
    ) {
        self.dryRun = dryRun
        self.detector = detector
        self.runner = runner
        self.keychain = keychain
        self.authHelper = authHelper
        self.launchAgents = launchAgents
        self.permissions = permissions
        self.personaPortability = personaPortability
    }

    public func appendLog(_ line: String) {
        let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        commandLogs.append(trimmed)
        if commandLogs.count > 400 {
            commandLogs.removeFirst(commandLogs.count - 400)
        }
    }

    public func runStep1Detection() async {
        guard !isBusy else { return }
        isBusy = true
        activeTaskKey = "detect"
        activeTaskStatus = "正在检测本机环境与已安装组件…"
        lastError = nil
        defer {
            isBusy = false
            activeTaskKey = nil
            activeTaskStatus = nil
        }

        detectionMode = await detector.detect(probeContainers: !dryRun)
        capabilities = await detector.probeCapabilities()

        switch detectionMode {
        case .existingTakeover(let existing):
            installChoice = .takeover
            if let owner = existing.ownerQQ { ownerQQ = owner }
            if let bot = existing.botQQ { botQQ = bot }
            colimaRunning = existing.hasColimaSnowlumaProfile
            containerReady = existing.hasSnowlumaContainer
            credentialsGenerated = existing.hasHubTokenInKeychain && existing.hasOneBotTokenInKeychain
            appendLog("检测到现有 QQ Gateway 部署：\(existing.projectDirectory?.path ?? "LaunchAgents / SnowLuma")")
        case .freshInstall:
            installChoice = .freshInstall
            appendLog("未检测到已有部署，将引导全新图形化安装。")
        }

        let cliInfo = await authHelper.inspectCLI()
        workbuddyVersion = cliInfo.version
        workbuddyLoggedIn = cliInfo.loggedIn
        workbuddyModelCount = cliInfo.modelCount
        workbuddyStatusDetail = cliInfo.detail
        permissionSummary = await permissions.currentSummary()
    }

    public func chooseTakeover() {
        installChoice = .takeover
        appendLog("已选择「无损接管现有部署」模式，严禁重建容器或覆盖数据。")
    }

    public func chooseFreshInstall() {
        installChoice = .freshInstall
        currentStep = .runtimeDependencies
    }

    public func openTerminalToInstallHomebrew() async {
        lastError = nil
        if dryRun {
            appendLog("[Dry-Run] 模拟在终端打开 Homebrew 安装脚本（清华镜像优先）。")
            return
        }
        let bashCmd = #"export HOMEBREW_INSTALL_FROM_API=1 HOMEBREW_API_DOMAIN=https://mirrors.tuna.tsinghua.edu.cn/homebrew-bottles/api HOMEBREW_BOTTLE_DOMAIN=https://mirrors.tuna.tsinghua.edu.cn/homebrew-bottles HOMEBREW_BREW_GIT_REMOTE=https://mirrors.tuna.tsinghua.edu.cn/git/homebrew/brew.git HOMEBREW_CORE_GIT_REMOTE=https://mirrors.tuna.tsinghua.edu.cn/git/homebrew/homebrew-core.git; rm -rf /tmp/brew-install; (git clone --depth=1 https://mirrors.tuna.tsinghua.edu.cn/git/homebrew/install.git /tmp/brew-install && /bin/bash /tmp/brew-install/install.sh) || /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"; rm -rf /tmp/brew-install"#
        let escaped = bashCmd
            .replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "\"", with: "\\\"")
        let script = """
        tell application "Terminal"
          activate
          do script "\(escaped)"
        end tell
        """
        _ = try? await runner.run(
            executable: "/usr/bin/osascript",
            arguments: ["-e", script],
            currentDirectory: nil,
            extraEnv: [:],
            timeoutSeconds: 10
        )
        appendLog("已打开「终端」执行 Homebrew 安装（清华镜像优先，失败自动回退官方源）；安装完成后请点击「刷新检测」。")
    }

    public func setupPythonSDKVenv() async {
        guard !isBusy else { return }
        isBusy = true
        activeTaskKey = "python-sdk"
        activeTaskStatus = "正在准备 WorkBuddy Python SDK 虚拟环境…"
        lastError = nil
        defer {
            isBusy = false
            activeTaskKey = nil
            activeTaskStatus = nil
        }

        if dryRun {
            appendLog("[Dry-Run] 模拟创建 Python venv 并安装 codebuddy-agent-sdk 与 anyio。")
            capabilities = await detector.probeCapabilities()
            return
        }

        guard let basePython = await detector.findSupportedBasePython() else {
            lastError = "未找到 Python 3.10 及以上版本（macOS 自带的 Python 3.9 不兼容 codebuddy-agent-sdk）。请先点击上方「Python 3 (>= 3.10)」右侧的「一键安装」，或先安装 python@3.12 后重试。"
            return
        }

        let venvDir = detector.standaloneVenvPath
        let venvPip = venvDir.appendingPathComponent("bin/pip").path
        let venvPython = venvDir.appendingPathComponent("bin/python").path

        do {
            try FileManager.default.createDirectory(at: venvDir.deletingLastPathComponent(), withIntermediateDirectories: true)
            if FileManager.default.isExecutableFile(atPath: venvPython),
               !(await detector.isPythonSupported(at: venvPython)) {
                appendLog("检测到已有虚拟环境 Python 版本低于 3.10，正在删除并使用 \(basePython) 重建…")
                try? FileManager.default.removeItem(at: venvDir)
            }
            if !FileManager.default.isExecutableFile(atPath: venvPython) {
                appendLog("检测到可用 Python：\(basePython)")
                appendLog("正在创建独立 Python 虚拟环境：\(venvDir.path)…")
                let createRes = try await runner.run(
                    executable: basePython,
                    arguments: ["-m", "venv", venvDir.path],
                    currentDirectory: nil,
                    extraEnv: [:],
                    timeoutSeconds: 60
                )
                appendLog(createRes.stdout)
                guard createRes.succeeded else {
                    throw NSError(domain: "Onboarding", code: Int(createRes.exitCode), userInfo: [
                        NSLocalizedDescriptionKey: createRes.stderr.isEmpty ? "创建虚拟环境失败" : createRes.stderr
                    ])
                }
            }

            let proxyEnv = ShellRunner.systemProxyEnvironment()
            let sources: [(label: String, indexURL: String?, timeout: Double)] = [
                ("清华 PyPI 镜像", "https://pypi.tuna.tsinghua.edu.cn/simple", 600),
                ("阿里云 PyPI 镜像", "https://mirrors.aliyun.com/pypi/simple", 600),
                ("PyPI 官方源", nil, 900)
            ]

            var installed = false
            var lastFailureMessage = "安装 Python SDK 失败"
            var lastFailureCode: Int32 = 1

            for source in sources {
                let statusText = "正在从\(source.label)安装 codebuddy-agent-sdk 与 anyio…"
                activeTaskStatus = statusText
                appendLog(statusText)
                var pipArgs = ["install", "--disable-pip-version-check", "--no-input"]
                if let indexURL = source.indexURL {
                    pipArgs.append(contentsOf: ["-i", indexURL])
                }
                pipArgs.append(contentsOf: ["codebuddy-agent-sdk", "anyio"])

                let pipRes = try await runner.run(
                    executable: venvPip,
                    arguments: pipArgs,
                    currentDirectory: nil,
                    extraEnv: proxyEnv,
                    timeoutSeconds: source.timeout
                )
                appendLog(pipRes.stdout)
                if pipRes.succeeded {
                    installed = true
                    break
                }
                lastFailureCode = pipRes.exitCode
                let detail = pipRes.stderr.trimmingCharacters(in: .whitespacesAndNewlines)
                lastFailureMessage = detail.isEmpty ? "安装 Python SDK 失败（退出码 \(pipRes.exitCode)）" : detail
                appendLog("\(source.label)安装未成功：\(lastFailureMessage)")
            }

            guard installed else {
                throw NSError(domain: "Onboarding", code: Int(lastFailureCode), userInfo: [
                    NSLocalizedDescriptionKey: lastFailureMessage
                ])
            }
            capabilities = await detector.probeCapabilities()
            appendLog("WorkBuddy Python SDK 虚拟环境已就绪。")
        } catch {
            lastError = error.localizedDescription
            appendLog("错误：\(error.localizedDescription)")
        }
    }

    public func installMissingDependency(_ toolName: String) async {
        guard !isBusy else { return }
        isBusy = true
        activeTaskKey = toolName
        activeTaskStatus = "正在安装 \(toolName)…"
        lastError = nil
        defer {
            isBusy = false
            activeTaskKey = nil
            activeTaskStatus = nil
        }

        if dryRun {
            appendLog("[Dry-Run] 模拟安装 \(toolName) 完成。")
            capabilities = await detector.probeCapabilities()
            return
        }

        let proxyEnv = ShellRunner.systemProxyEnvironment()

        do {
            switch toolName {
            case "codebuddy":
                let cliSources: [(label: String, script: String)] = [
                    ("CodeBuddy 官方国内加速源 (codebuddy.cn)", "curl -fsSL https://www.codebuddy.cn/cli/install.sh | bash"),
                    ("CodeBuddy 官方备用源 (copilot.tencent.com)", "curl -fsSL https://copilot.tencent.com/cli/install.sh | bash")
                ]
                var installed = false
                var lastErr = "安装 CodeBuddy CLI 失败"
                var lastCode: Int32 = 1

                for source in cliSources {
                    let statusText = "正在从\(source.label)安装独立版 CodeBuddy CLI…"
                    activeTaskStatus = statusText
                    appendLog(statusText)
                    let res = try await runner.run(
                        executable: "/bin/zsh",
                        arguments: ["-lc", source.script],
                        currentDirectory: nil,
                        extraEnv: proxyEnv,
                        timeoutSeconds: 600
                    )
                    appendLog(res.stdout)
                    if res.succeeded {
                        installed = true
                        break
                    }
                    lastCode = res.exitCode
                    let detail = res.stderr.trimmingCharacters(in: .whitespacesAndNewlines)
                    lastErr = detail.isEmpty ? "退出码 \(res.exitCode)" : detail
                    appendLog("\(source.label)安装未成功：\(lastErr)")
                }

                if !installed, let npm = detector.findExecutable(named: "npm") {
                    activeTaskStatus = "正在通过淘宝 npmmirror 镜像安装 @tencent-ai/codebuddy-code…"
                    appendLog("尝试通过淘宝 npmmirror 镜像安装 @tencent-ai/codebuddy-code…")
                    let npmRes = try await runner.run(
                        executable: npm,
                        arguments: ["install", "-g", "@tencent-ai/codebuddy-code", "--registry=https://registry.npmmirror.com"],
                        currentDirectory: nil,
                        extraEnv: proxyEnv,
                        timeoutSeconds: 600
                    )
                    appendLog(npmRes.stdout)
                    if npmRes.succeeded {
                        installed = true
                    } else {
                        lastCode = npmRes.exitCode
                        let detail = npmRes.stderr.trimmingCharacters(in: .whitespacesAndNewlines)
                        lastErr = detail.isEmpty ? lastErr : detail
                    }
                }

                if !installed {
                    throw NSError(domain: "Onboarding", code: Int(lastCode), userInfo: [
                        NSLocalizedDescriptionKey: lastErr
                    ])
                }
            default:
                guard let brew = detector.findExecutable(named: "brew") else {
                    throw NSError(domain: "Onboarding", code: 2, userInfo: [
                        NSLocalizedDescriptionKey: "未找到 Homebrew，请先点击上方的「在终端中安装 Homebrew」。"
                    ])
                }
                var tunaEnv = proxyEnv
                tunaEnv["HOMEBREW_NO_AUTO_UPDATE"] = "1"
                tunaEnv["HOMEBREW_INSTALL_FROM_API"] = "1"
                tunaEnv["HOMEBREW_API_DOMAIN"] = "https://mirrors.tuna.tsinghua.edu.cn/homebrew-bottles/api"
                tunaEnv["HOMEBREW_BOTTLE_DOMAIN"] = "https://mirrors.tuna.tsinghua.edu.cn/homebrew-bottles"

                activeTaskStatus = "正在通过清华 Homebrew 镜像安装 \(toolName)…"
                appendLog("正在通过清华 Homebrew 镜像安装 \(toolName)…")
                let tunaRes = try await runner.run(
                    executable: brew,
                    arguments: ["install", toolName],
                    currentDirectory: nil,
                    extraEnv: tunaEnv,
                    timeoutSeconds: 600
                )
                appendLog(tunaRes.stdout)
                if !tunaRes.succeeded {
                    let tunaErr = tunaRes.stderr.trimmingCharacters(in: .whitespacesAndNewlines)
                    activeTaskStatus = "清华镜像未成功，正在回退 Homebrew 官方源安装 \(toolName)…"
                    appendLog("清华镜像安装 \(toolName) 未成功（\(tunaErr)），回退 Homebrew 官方源重试…")
                    var officialEnv = proxyEnv
                    officialEnv["HOMEBREW_NO_AUTO_UPDATE"] = "1"
                    let res = try await runner.run(
                        executable: brew,
                        arguments: ["install", toolName],
                        currentDirectory: nil,
                        extraEnv: officialEnv,
                        timeoutSeconds: 600
                    )
                    appendLog(res.stdout)
                    if !res.succeeded {
                        throw NSError(domain: "Onboarding", code: Int(res.exitCode), userInfo: [
                            NSLocalizedDescriptionKey: res.stderr.isEmpty ? "安装 \(toolName) 失败" : res.stderr
                        ])
                    }
                }
                if toolName == "docker-buildx" {
                    ensureDockerBuildxPluginSymlink()
                }
            }
            capabilities = await detector.probeCapabilities()
        } catch {
            lastError = error.localizedDescription
            appendLog("错误：\(error.localizedDescription)")
        }
    }

    private func ensureDockerBuildxPluginSymlink() {
        let fm = FileManager.default
        let pluginDir = fm.homeDirectoryForCurrentUser.appendingPathComponent(".docker/cli-plugins", isDirectory: true)
        let dest = pluginDir.appendingPathComponent("docker-buildx")
        if fm.fileExists(atPath: dest.path) { return }
        let candidates = [
            "/opt/homebrew/opt/docker-buildx/bin/docker-buildx",
            "/usr/local/opt/docker-buildx/bin/docker-buildx"
        ]
        for src in candidates where fm.isExecutableFile(atPath: src) {
            try? fm.createDirectory(at: pluginDir, withIntermediateDirectories: true)
            try? fm.createSymbolicLink(atPath: dest.path, withDestinationPath: src)
            break
        }
    }

    private var defaultLoginWorkspaceURL: URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support/WorkBuddyQQGateway/runtime", isDirectory: true)
    }

    public func refreshWorkBuddyLoginStatus() async {
        guard !isBusy else { return }
        isBusy = true
        activeTaskKey = "workbuddy-probe"
        activeTaskStatus = "正在检测 WorkBuddy / CodeBuddy 账号登录状态…"
        lastError = nil
        defer {
            isBusy = false
            activeTaskKey = nil
            activeTaskStatus = nil
        }

        if dryRun {
            workbuddyLoggedIn = true
            workbuddyModelCount = 16
            workbuddyStatusDetail = "已登录（16 个模拟模型）"
            return
        }

        let cliInfo = await authHelper.inspectCLI()
        workbuddyVersion = cliInfo.version
        workbuddyLoggedIn = cliInfo.loggedIn
        workbuddyModelCount = cliInfo.modelCount
        workbuddyStatusDetail = cliInfo.detail

        if cliInfo.loggedIn {
            appendLog("WorkBuddy 登录已就绪：\(cliInfo.detail ?? "已登录")")
        } else {
            appendLog("WorkBuddy 账号探测结果：\(cliInfo.detail ?? "尚未登录")")
        }
    }

    public func cancelWorkBuddyLogin() {
        authHelper.cancelActiveLogin()
        appendLog("已取消 WorkBuddy 登录。")
    }

    public func startWorkBuddyLogin() async {
        guard !isBusy else { return }
        isBusy = true
        activeTaskKey = "workbuddy-login"
        activeTaskStatus = "正在准备\(selectedLoginSite.rawValue)浏览器登录…"
        lastError = nil
        capturedAuthURL = nil
        defer {
            isBusy = false
            activeTaskKey = nil
            activeTaskStatus = nil
        }

        if dryRun {
            workbuddyLoggedIn = true
            workbuddyModelCount = 16
            workbuddyStatusDetail = "已登录（模拟）"
            return
        }

        do {
            let status = try await authHelper.startAutomatedBrowserLogin(
                site: selectedLoginSite,
                workingDirectory: defaultLoginWorkspaceURL,
                wasAlreadyLoggedIn: workbuddyLoggedIn,
                onStage: { [weak self] stage in
                    Task { @MainActor [weak self] in
                        self?.activeTaskStatus = stage
                    }
                },
                onAuthURL: { [weak self] url in
                    Task { @MainActor [weak self] in
                        self?.capturedAuthURL = url
                    }
                },
                onLog: { [weak self] chunk in
                    Task { @MainActor [weak self] in
                        self?.appendLog(chunk)
                    }
                }
            )
            workbuddyVersion = status.version
            workbuddyLoggedIn = status.loggedIn
            workbuddyModelCount = status.modelCount
            workbuddyStatusDetail = status.detail
            if status.loggedIn {
                appendLog("WorkBuddy 账号登录成功：\(status.detail ?? "已登录")")
            }
        } catch is CancellationError {
            appendLog("已取消 WorkBuddy 账号登录。")
        } catch {
            lastError = error.localizedDescription
            appendLog("WorkBuddy 登录未完成：\(error.localizedDescription)")
        }
    }

    public func logoutWorkBuddy() async {
        guard !isBusy else { return }
        isBusy = true
        activeTaskKey = "workbuddy-logout"
        activeTaskStatus = "正在退出当前 WorkBuddy / CodeBuddy 账号…"
        lastError = nil
        defer {
            isBusy = false
            activeTaskKey = nil
            activeTaskStatus = nil
        }

        if dryRun {
            workbuddyLoggedIn = false
            workbuddyModelCount = 0
            workbuddyStatusDetail = "尚未登录"
            capturedAuthURL = nil
            return
        }

        do {
            let status = try await authHelper.logout(workingDirectory: defaultLoginWorkspaceURL)
            workbuddyVersion = status.version
            workbuddyLoggedIn = status.loggedIn
            workbuddyModelCount = status.modelCount
            workbuddyStatusDetail = status.detail
            capturedAuthURL = nil
            appendLog(status.loggedIn ? "退出登录未生效：\(status.detail ?? "")" : "已退出 WorkBuddy 账号。")
        } catch {
            lastError = error.localizedDescription
            appendLog("退出登录失败：\(error.localizedDescription)")
        }
    }

    public func openTerminalFallbackLogin() async {
        guard !isBusy else { return }
        lastError = nil
        do {
            let cli = try await authHelper.openTerminalForInteractiveLogin()
            appendLog("已打开「终端」手动执行 \(cli)；完成登录后请点击「刷新登录状态」。")
        } catch {
            lastError = error.localizedDescription
        }
    }

    public nonisolated static func filterSnowlumaImages(from images: [String]) -> [String] {
        let keywords = ["snowluma", "qq", "napcat", "llonebot", "onebot"]
        return images
            .filter { image in
                let lower = image.lowercased()
                return keywords.contains { lower.contains($0) }
            }
            .sorted { lhs, rhs in
                let lMatch = lhs.lowercased().contains("snowluma")
                let rMatch = rhs.lowercased().contains("snowluma")
                if lMatch != rMatch { return lMatch }
                return lhs < rhs
            }
    }

    public nonisolated static func parseLoadedDockerImage(from output: String) -> String? {
        for rawLine in output.split(whereSeparator: \.isNewline) {
            let line = rawLine.trimmingCharacters(in: .whitespacesAndNewlines)
            if line.hasPrefix("Loaded image:") {
                let tag = line.replacingOccurrences(of: "Loaded image:", with: "").trimmingCharacters(in: .whitespaces)
                if !tag.isEmpty { return tag }
            }
            if line.hasPrefix("Loaded image ID:") {
                let id = line.replacingOccurrences(of: "Loaded image ID:", with: "").trimmingCharacters(in: .whitespaces)
                if !id.isEmpty { return id }
            }
        }
        return nil
    }

    public func refreshLocalDockerImages(dockerContext: String = "colima-snowluma") async {
        guard let docker = detector.findExecutable(named: "docker") else { return }
        guard let res = try? await runner.run(
            executable: docker,
            arguments: ["--context", dockerContext, "images", "--format", "{{.Repository}}:{{.Tag}}"],
            currentDirectory: nil,
            extraEnv: [:],
            timeoutSeconds: 8
        ), res.succeeded else {
            return
        }
        let images = res.stdout
            .split(whereSeparator: \.isNewline)
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty && !$0.contains("<none>") }
            .sorted { lhs, rhs in
                let lMatch = lhs.lowercased().contains("snowluma")
                let rMatch = rhs.lowercased().contains("snowluma")
                if lMatch != rMatch { return lMatch }
                return lhs < rhs
            }
        allDockerImages = images
        let filtered = Self.filterSnowlumaImages(from: images)
        availableDockerImages = filtered.isEmpty ? images : filtered
        if !displayedDockerImages.contains(selectedImageTag), let first = displayedDockerImages.first {
            selectedImageTag = first
        }
    }

    public func readKeychainSecretForCopy(_ account: KeychainAccount) -> String? {
        keychain.read(account: account)
    }

    public func initializeColimaAndSnowluma(
        colimaProfile: String = "snowluma",
        dockerContext: String = "colima-snowluma",
        containerName: String = "snowluma",
        imageTag: String? = nil
    ) async {
        guard !isBusy else { return }
        isBusy = true
        activeTaskKey = "vm-init"
        activeTaskStatus = "1/4 正在启动 Colima ARM64 虚拟机…"
        lastError = nil
        defer {
            isBusy = false
            activeTaskKey = nil
            activeTaskStatus = nil
        }

        if case .existingTakeover(let existing) = detectionMode, existing.hasSnowlumaContainer {
            appendLog("检测到已有 snowluma 容器，严格遵守零破坏铁律，跳过初始化。")
            colimaRunning = true
            containerReady = true
            return
        }

        if dryRun {
            generatedVNCPassword = "dryrun-vnc-password"
            colimaRunning = true
            containerReady = true
            appendLog("[Dry-Run] 模拟以「\(imageSourceMode.rawValue)」模式初始化 Colima(\(colimaProfile)) 与容器(\(containerName))。")
            return
        }

        guard let colima = detector.findExecutable(named: "colima"),
              let docker = detector.findExecutable(named: "docker") else {
            lastError = "缺少 Colima 或 Docker CLI，请返回 Step 2 安装。"
            return
        }

        do {
            appendLog("1/4 启动 Colima ARM64 虚拟机（profile: \(colimaProfile)）…")
            let vmRes = try await runner.run(
                executable: colima,
                arguments: [
                    "start", "--profile", colimaProfile,
                    "--runtime", "docker", "--arch", "aarch64",
                    "--vm-type", "vz", "--mount-type", "virtiofs",
                    "--cpus", "4", "--memory", "6", "--disk", "20"
                ],
                currentDirectory: nil,
                extraEnv: ShellRunner.systemProxyEnvironment(),
                timeoutSeconds: 900
            )
            appendLog(vmRes.stdout)
            guard vmRes.succeeded else {
                throw NSError(domain: "Onboarding", code: Int(vmRes.exitCode), userInfo: [
                    NSLocalizedDescriptionKey: vmRes.stderr.isEmpty ? "Colima 启动失败" : vmRes.stderr
                ])
            }
            colimaRunning = true

            // Guard against overwriting an existing container
            let inspectRes = try await runner.run(
                executable: docker,
                arguments: ["--context", dockerContext, "inspect", containerName],
                currentDirectory: nil,
                extraEnv: [:],
                timeoutSeconds: 6
            )
            if inspectRes.succeeded {
                appendLog("容器 \(containerName) 已存在，直接启动而不重建。")
                _ = try await runner.run(
                    executable: docker,
                    arguments: ["--context", dockerContext, "start", containerName],
                    currentDirectory: nil,
                    extraEnv: [:],
                    timeoutSeconds: 30
                )
                containerReady = true
                return
            }

            // 2/4 Prepare SnowLuma image from selected offline/local/NAS source
            var resolvedImageTag = imageTag ?? selectedImageTag
            switch imageSourceMode {
            case .existingLocalImage:
                await refreshLocalDockerImages(dockerContext: dockerContext)
                if !displayedDockerImages.isEmpty && !displayedDockerImages.contains(resolvedImageTag) {
                    resolvedImageTag = displayedDockerImages.first ?? resolvedImageTag
                }
                let imgCheck = try await runner.run(
                    executable: docker,
                    arguments: ["--context", dockerContext, "image", "inspect", resolvedImageTag],
                    currentDirectory: nil,
                    extraEnv: [:],
                    timeoutSeconds: 6
                )
                guard imgCheck.succeeded else {
                    throw NSError(domain: "Onboarding", code: 10, userInfo: [
                        NSLocalizedDescriptionKey: "本机未找到镜像 \(resolvedImageTag)，请切换为「导入离线镜像包」或「从本地 / NAS 工程目录构建」。"
                    ])
                }
                appendLog("2/4 使用本机已有镜像：\(resolvedImageTag)")

            case .offlineArchiveTar:
                guard let archiveURL = selectedArchiveURL else {
                    throw NSError(domain: "Onboarding", code: 11, userInfo: [
                        NSLocalizedDescriptionKey: "请先选择 SnowLuma 离线镜像包（.tar 或 .tar.gz）。"
                    ])
                }
                activeTaskStatus = "2/4 正在导入离线镜像包：\(archiveURL.lastPathComponent)（解压约需 1–3 分钟）…"
                appendLog("2/4 正在导入离线镜像包：\(archiveURL.lastPathComponent)…")
                let loadRes = try await runner.run(
                    executable: docker,
                    arguments: ["--context", dockerContext, "load", "-i", archiveURL.path],
                    currentDirectory: nil,
                    extraEnv: [:],
                    timeoutSeconds: 600
                )
                appendLog(loadRes.stdout)
                guard loadRes.succeeded else {
                    throw NSError(domain: "Onboarding", code: Int(loadRes.exitCode), userInfo: [
                        NSLocalizedDescriptionKey: loadRes.stderr.isEmpty ? "导入离线镜像包失败" : loadRes.stderr
                    ])
                }
                if let loaded = Self.parseLoadedDockerImage(from: loadRes.stdout) {
                    resolvedImageTag = loaded
                    selectedImageTag = loaded
                } else {
                    await refreshLocalDockerImages(dockerContext: dockerContext)
                    if let first = availableDockerImages.first {
                        resolvedImageTag = first
                        selectedImageTag = first
                    }
                }
                appendLog("离线镜像导入完成：\(resolvedImageTag)")

            case .localProjectFolder:
                guard let folderURL = selectedProjectFolderURL else {
                    throw NSError(domain: "Onboarding", code: 12, userInfo: [
                        NSLocalizedDescriptionKey: "请先选择包含 Dockerfile 的 SnowLuma 工程目录（本地或已挂载 NAS）。"
                    ])
                }
                let dockerfile = folderURL.appendingPathComponent("Dockerfile")
                guard FileManager.default.fileExists(atPath: dockerfile.path) else {
                    throw NSError(domain: "Onboarding", code: 13, userInfo: [
                        NSLocalizedDescriptionKey: "所选目录下未找到 Dockerfile：\(folderURL.path)"
                    ])
                }
                resolvedImageTag = "snowluma-local:custom"
                activeTaskStatus = "2/4 正在从工程目录构建 linux/arm64 镜像（可能需要数分钟）…"
                appendLog("2/4 正在从工程目录构建 linux/arm64 镜像（可能需要数分钟）：\(folderURL.path)…")
                let buildxRes = try await runner.run(
                    executable: docker,
                    arguments: [
                        "--context", dockerContext, "buildx", "build",
                        "--platform", "linux/arm64", "-t", resolvedImageTag, "--load", folderURL.path
                    ],
                    currentDirectory: folderURL,
                    extraEnv: [:],
                    timeoutSeconds: 1800
                )
                appendLog(buildxRes.stdout)
                if !buildxRes.succeeded {
                    appendLog("buildx 构建未成功，尝试使用标准 docker build…")
                    let fallbackBuild = try await runner.run(
                        executable: docker,
                        arguments: [
                            "--context", dockerContext, "build",
                            "--platform", "linux/arm64", "-t", resolvedImageTag, folderURL.path
                        ],
                        currentDirectory: folderURL,
                        extraEnv: [:],
                        timeoutSeconds: 1800
                    )
                    appendLog(fallbackBuild.stdout)
                    guard fallbackBuild.succeeded else {
                        throw NSError(domain: "Onboarding", code: Int(fallbackBuild.exitCode), userInfo: [
                            NSLocalizedDescriptionKey: fallbackBuild.stderr.isEmpty ? "构建 SnowLuma 镜像失败" : fallbackBuild.stderr
                        ])
                    }
                }
                selectedImageTag = resolvedImageTag
            }

            activeTaskStatus = "3/4 正在生成 VNC 密码并写入钥匙串…"
            appendLog("3/4 生成随机 VNC 密码并写入 macOS 钥匙串…")
            let vncPass = String((try KeychainStore.generateHexSecret(byteCount: 8)).prefix(16))
            try keychain.write(vncPass, account: .snowlumaVncPassword)
            generatedVNCPassword = vncPass

            activeTaskStatus = "4/4 正在创建数据卷并启动 \(containerName) 容器…"
            appendLog("4/4 创建持久化数据卷与 \(containerName) 容器（仅绑定 127.0.0.1）…")
            for volume in ["snowluma-data", "snowluma-qq-config", "snowluma-qq-data"] {
                _ = try await runner.run(
                    executable: docker,
                    arguments: ["--context", dockerContext, "volume", "create", volume],
                    currentDirectory: nil,
                    extraEnv: [:],
                    timeoutSeconds: 10
                )
            }

            let runRes = try await runner.run(
                executable: docker,
                arguments: [
                    "--context", dockerContext, "run", "-d",
                    "--name", containerName,
                    "--restart", "unless-stopped",
                    "--cap-add=SYS_PTRACE",
                    "--security-opt", "seccomp=unconfined",
                    "-e", "VNC_PASSWD=\(vncPass)",
                    "-v", "snowluma-data:/app/data",
                    "-v", "snowluma-qq-config:/app/.config",
                    "-v", "snowluma-qq-data:/app/.local/share",
                    "-p", "127.0.0.1:3000:3000",
                    "-p", "127.0.0.1:3001:3001",
                    "-p", "127.0.0.1:5099:5099",
                    "-p", "127.0.0.1:6081:6081",
                    "--add-host", "host.docker.internal:host-gateway",
                    resolvedImageTag
                ],
                currentDirectory: nil,
                extraEnv: [:],
                timeoutSeconds: 120
            )
            appendLog(runRes.stdout)
            guard runRes.succeeded else {
                throw NSError(domain: "Onboarding", code: Int(runRes.exitCode), userInfo: [
                    NSLocalizedDescriptionKey: runRes.stderr.isEmpty ? "创建 SnowLuma 容器失败" : runRes.stderr
                ])
            }
            containerReady = true
        } catch {
            lastError = error.localizedDescription
            appendLog("错误：\(error.localizedDescription)")
        }
    }

    public func validateQQInputs() -> String? {
        let pattern = #"^[1-9][0-9]{4,13}$"#
        let owner = ownerQQ.trimmingCharacters(in: .whitespacesAndNewlines)
        let bot = botQQ.trimmingCharacters(in: .whitespacesAndNewlines)
        guard owner.range(of: pattern, options: .regularExpression) != nil else {
            return "管理员 QQ 号须为 5–14 位数字"
        }
        guard bot.range(of: pattern, options: .regularExpression) != nil else {
            return "机器人小号 QQ 号须为 5–14 位数字"
        }
        guard owner != bot else {
            return "管理员 QQ 号与机器人小号 QQ 号不能相同"
        }
        return nil
    }

    public nonisolated static func buildMergedOneBotConfigJSON(
        existingJSON: String?,
        accessToken: String,
        hubPort: Int
    ) throws -> String {
        var root: [String: Any] = [
            "mode": "snapshot",
            "networks": [
                "httpServers": [] as [[String: Any]],
                "httpClients": [] as [[String: Any]],
                "wsServers": [] as [[String: Any]],
                "wsClients": [] as [[String: Any]]
            ]
        ]

        if let existingJSON,
           let data = existingJSON.data(using: .utf8),
           let parsed = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            for (k, v) in parsed {
                root[k] = v
            }
        }

        var networks = (root["networks"] as? [String: Any]) ?? [:]
        var httpServers = (networks["httpServers"] as? [[String: Any]]) ?? []
        var httpClients = (networks["httpClients"] as? [[String: Any]]) ?? []
        if networks["wsServers"] == nil { networks["wsServers"] = [] as [[String: Any]] }
        if networks["wsClients"] == nil { networks["wsClients"] = [] as [[String: Any]] }

        if let idx = httpServers.firstIndex(where: {
            ($0["name"] as? String) == "http-default" || ($0["port"] as? Int) == 3000
        }) {
            var item = httpServers[idx]
            item["name"] = (item["name"] as? String) ?? "http-default"
            item["accessToken"] = accessToken
            item["messageFormat"] = "array"
            item["reportSelfMessage"] = false
            item["host"] = "0.0.0.0"
            item["port"] = 3000
            item["path"] = "/"
            item["enableWebSocket"] = false
            httpServers[idx] = item
        } else {
            httpServers.append([
                "name": "http-default",
                "accessToken": accessToken,
                "messageFormat": "array",
                "reportSelfMessage": false,
                "host": "0.0.0.0",
                "port": 3000,
                "path": "/",
                "enableWebSocket": false
            ])
        }

        let callbackURL = "http://host.docker.internal:\(String(hubPort))/api/onebot/event"
        if let idx = httpClients.firstIndex(where: {
            ($0["name"] as? String) == "workbuddy-qq-gateway"
                || (($0["url"] as? String)?.contains("/api/onebot/event") == true)
        }) {
            var item = httpClients[idx]
            item["name"] = "workbuddy-qq-gateway"
            item["accessToken"] = accessToken
            item["messageFormat"] = "array"
            item["reportSelfMessage"] = false
            item["url"] = callbackURL
            httpClients[idx] = item
        } else {
            httpClients.append([
                "name": "workbuddy-qq-gateway",
                "accessToken": accessToken,
                "messageFormat": "array",
                "reportSelfMessage": false,
                "url": callbackURL
            ])
        }

        networks["httpServers"] = httpServers
        networks["httpClients"] = httpClients
        root["networks"] = networks

        let encoded = try JSONSerialization.data(
            withJSONObject: root,
            options: [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        )
        guard let str = String(data: encoded, encoding: .utf8) else {
            throw NSError(domain: "Onboarding", code: 40, userInfo: [
                NSLocalizedDescriptionKey: "序列化 OneBot 配置失败"
            ])
        }
        return str + "\n"
    }

    public func generateAndSaveCredentials(runtimePaths: RuntimePaths) async {
        lastError = nil
        do {
            _ = try saveCredentialsInternal(runtimePaths: runtimePaths)
            credentialsGenerated = true
            appendLog("已生成高熵凭据并写入 macOS 钥匙串与配置文件。")
        } catch {
            lastError = error.localizedDescription
        }
    }

    private func saveCredentialsInternal(runtimePaths: RuntimePaths) throws -> (hubToken: String, oneBotToken: String) {
        if let err = validateQQInputs() {
            throw NSError(domain: "Onboarding", code: 41, userInfo: [NSLocalizedDescriptionKey: err])
        }
        if dryRun {
            return ("dryrun-hub", "dryrun-onebot")
        }
        let hubToken: String
        if let existing = keychain.read(account: .hubApiToken), !existing.isEmpty {
            hubToken = existing
        } else {
            hubToken = try KeychainStore.generateHexSecret(byteCount: 32)
        }
        let oneBotToken: String
        if let existing = keychain.read(account: .oneBotApiToken), !existing.isEmpty {
            oneBotToken = existing
        } else {
            oneBotToken = try KeychainStore.generateHexSecret(byteCount: 32)
        }
        try keychain.write(hubToken, account: .hubApiToken)
        try keychain.write(oneBotToken, account: .oneBotApiToken)

        if let envFile = runtimePaths.envFileURL {
            try FileManager.default.createDirectory(at: envFile.deletingLastPathComponent(), withIntermediateDirectories: true)
            var lines = (try? String(contentsOf: envFile, encoding: .utf8))?
                .split(separator: "\n", omittingEmptySubsequences: false)
                .map(String.init) ?? []
            if lines.count == 1 && lines[0].isEmpty { lines = [] }
            let updates: [(String, String)] = [
                ("WORKBUDDY_QQ_OWNER_QQ_ID", ownerQQ.trimmingCharacters(in: .whitespacesAndNewlines)),
                ("WORKBUDDY_QQ_BOT_QQ_ID", botQQ.trimmingCharacters(in: .whitespacesAndNewlines)),
                ("WORKBUDDY_QQ_HOST", "127.0.0.1"),
                ("WORKBUDDY_QQ_PORT", "\(String(runtimePaths.hubPort))"),
                ("WORKBUDDY_QQ_DISABLE_AUTH", "0"),
                ("ONEBOT_API_BASE", "http://127.0.0.1:3000")
            ]
            for (key, value) in updates {
                if let idx = lines.firstIndex(where: { $0.hasPrefix("\(key)=") }) {
                    lines[idx] = "\(key)=\(value)"
                } else {
                    lines.append("\(key)=\(value)")
                }
            }
            let serialized = lines.joined(separator: "\n") + "\n"
            try serialized.write(to: envFile, atomically: true, encoding: .utf8)
            try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: envFile.path)
        }
        return (hubToken, oneBotToken)
    }

    public func syncSnowlumaOneBotConfig(
        runtimePaths: RuntimePaths,
        containerName: String = "snowluma",
        dockerContext: String = "colima-snowluma"
    ) async {
        guard !isBusy else { return }
        isBusy = true
        activeTaskKey = "onebot-sync"
        activeTaskStatus = "正在生成凭据并写入 SnowLuma OneBot 配置…"
        lastError = nil
        defer {
            isBusy = false
            activeTaskKey = nil
            activeTaskStatus = nil
        }

        if dryRun {
            credentialsGenerated = true
            twoWayConnectivityOK = true
            twoWayConnectivityMessage = "已自动同步 OneBot 配置（模拟）。"
            return
        }

        do {
            let (_, oneBotToken) = try saveCredentialsInternal(runtimePaths: runtimePaths)
            credentialsGenerated = true
            let cleanBotQQ = botQQ.trimmingCharacters(in: .whitespacesAndNewlines)

            guard let docker = detector.findExecutable(named: "docker") else {
                throw NSError(domain: "Onboarding", code: 42, userInfo: [
                    NSLocalizedDescriptionKey: "未找到 Docker CLI，请确认 Step 2/4 已就绪。"
                ])
            }

            let configPath = "/app/data/config/onebot_\(cleanBotQQ).json"
            let readRes = try? await runner.run(
                executable: docker,
                arguments: ["--context", dockerContext, "exec", "-u", "node", containerName, "cat", configPath],
                currentDirectory: nil,
                extraEnv: [:],
                timeoutSeconds: 10
            )
            let existingJSON = (readRes?.succeeded == true) ? readRes?.stdout : nil
            let mergedJSON = try Self.buildMergedOneBotConfigJSON(
                existingJSON: existingJSON,
                accessToken: oneBotToken,
                hubPort: runtimePaths.hubPort
            )

            activeTaskStatus = "正在把新令牌与回调地址写入容器 (\(configPath))…"
            let writerJS = "const fs=require('fs');const p='/app/data/config/onebot_'+process.argv[1]+'.json';fs.mkdirSync('/app/data/config',{recursive:true});const data=fs.readFileSync(0,'utf8');fs.writeFileSync(p,data,{mode:0o600});"
            let writeRes = try await ShellRunner().runWithStdin(
                executable: docker,
                arguments: ["--context", dockerContext, "exec", "-i", "-u", "node", containerName, "node", "-e", writerJS, cleanBotQQ],
                stdinData: Data(mergedJSON.utf8),
                currentDirectory: nil,
                extraEnv: [:],
                timeoutSeconds: 15
            )
            guard writeRes.succeeded else {
                throw NSError(domain: "Onboarding", code: Int(writeRes.exitCode), userInfo: [
                    NSLocalizedDescriptionKey: writeRes.stderr.isEmpty ? "写入 SnowLuma 配置失败，请确认容器处于运行状态。" : writeRes.stderr
                ])
            }

            activeTaskStatus = "正在检测 OneBot 3000 端口当前状态…"
            var req = URLRequest(url: URL(string: "http://127.0.0.1:3000/get_login_info")!)
            req.httpMethod = "GET"
            req.timeoutInterval = 3
            req.setValue("Bearer \(oneBotToken)", forHTTPHeaderField: "Authorization")

            let pendingLoginMessage = "OneBot 配置已写入容器。请打开下方扫码桌面登录，向导会自动检测 QQ 状态。"
            if let (data, resp) = try? await URLSession.shared.data(for: req),
               let http = resp as? HTTPURLResponse {
                if (200..<300).contains(http.statusCode) {
                    if let login = Self.parseOneBotLoginInfo(from: data) {
                        let suffix = login.uid.map { " (\($0))" } ?? ""
                        twoWayConnectivityOK = true
                        twoWayConnectivityMessage = "OneBot 配置已同步！QQ 小号「\(login.nickname)」\(suffix) 已在线连通，无需重启容器。"
                    } else {
                        twoWayConnectivityOK = false
                        twoWayConnectivityMessage = pendingLoginMessage
                    }
                } else if http.statusCode == 401 || http.statusCode == 403 {
                    activeTaskStatus = "检测到容器正在使用旧令牌，正在重启 \(containerName) 加载新令牌…"
                    appendLog("已写入 \(configPath)，检测到旧令牌仍在生效，正在重启 \(containerName) 容器…")
                    let restartRes = try await runner.run(
                        executable: docker,
                        arguments: ["--context", dockerContext, "restart", containerName],
                        currentDirectory: nil,
                        extraEnv: [:],
                        timeoutSeconds: 60
                    )
                    guard restartRes.succeeded else {
                        throw NSError(domain: "Onboarding", code: Int(restartRes.exitCode), userInfo: [
                            NSLocalizedDescriptionKey: restartRes.stderr.isEmpty ? "重启 SnowLuma 容器失败。" : restartRes.stderr
                        ])
                    }
                    twoWayConnectivityOK = false
                    twoWayConnectivityMessage = "新令牌已写入并重启 SnowLuma 容器。请打开下方扫码桌面重新登录，向导会自动检测 QQ 状态。"
                } else {
                    twoWayConnectivityOK = false
                    twoWayConnectivityMessage = pendingLoginMessage
                }
            } else {
                twoWayConnectivityOK = false
                twoWayConnectivityMessage = pendingLoginMessage
            }
            appendLog(twoWayConnectivityMessage)
        } catch {
            lastError = error.localizedDescription
            appendLog("同步 SnowLuma 配置失败：\(error.localizedDescription)")
        }
    }

    private nonisolated static func parseOneBotLoginInfo(from data: Data) -> (nickname: String, uid: String?)? {
        guard let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let payload = obj["data"] as? [String: Any] else {
            return nil
        }
        let status = (obj["status"] as? String)?.lowercased()
        let retcode = obj["retcode"] as? Int
        let nick = (payload["nickname"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
        let uid: String? = {
            if let n = payload["user_id"] as? Int64 { return String(n) }
            if let n = payload["user_id"] as? Int { return String(n) }
            if let s = payload["user_id"] as? String { return s }
            return nil
        }()
        guard status != "failed", retcode == nil || retcode == 0,
              let uid, let userId = Int64(uid), userId > 0 else {
            return nil
        }
        return (nickname: (nick?.isEmpty == false) ? nick! : "已登录", uid: uid)
    }

    private func requestLocalOneBotLogin() async throws -> (Data, URLResponse) {
        var request = URLRequest(url: URL(string: "http://127.0.0.1:3000/get_login_info")!)
        request.cachePolicy = .reloadIgnoringLocalCacheData
        request.timeoutInterval = 3
        if let oneBotToken = keychain.read(account: .oneBotApiToken), !oneBotToken.isEmpty {
            request.setValue("Bearer \(oneBotToken)", forHTTPHeaderField: "Authorization")
        }
        return try await URLSession.shared.data(for: request)
    }

    func probeLocalQQLogin() async -> OneBotMaintenanceInfo? {
        guard !dryRun,
              let (data, response) = try? await requestLocalOneBotLogin(),
              let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode),
              let login = Self.parseOneBotLoginInfo(from: data), let userId = login.uid.flatMap(Int64.init)
        else { return nil }
        return OneBotMaintenanceInfo(ok: true, login: .init(user_id: userId, nickname: login.nickname), status: nil, error: nil)
    }

    public func testTwoWayConnectivity(supervisor: RuntimeSupervisor) async {
        guard !isBusy else { return }
        isBusy = true
        activeTaskKey = "connectivity"
        activeTaskStatus = "正在检测 OneBot 与 QQ 小号连通状态…"
        lastError = nil
        defer {
            isBusy = false
            activeTaskKey = nil
            activeTaskStatus = nil
        }

        if dryRun {
            twoWayConnectivityOK = true
            twoWayConnectivityMessage = "[Dry-Run] 双向连通校验通过（Hub ⇄ OneBot）。"
            appendLog(twoWayConnectivityMessage)
            return
        }

        do {
            if await supervisor.checkHubHealth()?.ok == true {
                let token = keychain.read(account: .hubApiToken) ?? ""
                let client = GatewayAPIClient(baseURL: await supervisor.hubBaseURL(), token: token)
                let status = try await client.fetchQQLoginStatus()
                if status?.isOnline == true {
                    let nick = status?.login?.nickname ?? "已登录"
                    twoWayConnectivityOK = true
                    twoWayConnectivityMessage = "双向连通正常：QQ 小号「\(nick)」在线。"
                } else {
                    twoWayConnectivityOK = false
                    twoWayConnectivityMessage = status?.error ?? "OneBot 尚未就绪，请确认已完成扫码并开启 HTTP 3000。"
                }
                return
            }

            // During Step 5 of a fresh install the Hub starts in Step 6, so probe OneBot HTTP directly.
            let (data, response) = try await requestLocalOneBotLogin()
            guard let http = response as? HTTPURLResponse else {
                twoWayConnectivityOK = false
                twoWayConnectivityMessage = "OneBot 返回了无效响应，请确认 SnowLuma 容器正在运行。"
                return
            }
            if http.statusCode == 401 || http.statusCode == 403 {
                twoWayConnectivityOK = false
                twoWayConnectivityMessage = "OneBot 令牌不匹配（HTTP \(http.statusCode)），请点击上方第 2 步「一键写入 SnowLuma 配置」（或在 5099 手动更新令牌）。"
                return
            }
            guard (200..<300).contains(http.statusCode) else {
                twoWayConnectivityOK = false
                twoWayConnectivityMessage = "OneBot 暂未就绪（HTTP \(http.statusCode)），请确认已在 noVNC (6081) 扫码登录 QQ 并在 5099 开启 HTTP 3000。"
                return
            }
            if let login = Self.parseOneBotLoginInfo(from: data) {
                let uidSuffix = login.uid.map { " (\($0))" } ?? ""
                twoWayConnectivityOK = true
                twoWayConnectivityMessage = "OneBot 正向连通正常：QQ 小号「\(login.nickname)」\(uidSuffix) 在线。进入 Step 6 启动网关后将自动完成双向对接。"
                appendLog(twoWayConnectivityMessage)
                return
            }
            twoWayConnectivityOK = false
            twoWayConnectivityMessage = "OneBot 已响应但尚未检测到 QQ 登录态，请先点击第 3 步「打开 QQ 扫码桌面 (noVNC 6081)」扫码登录机器人小号。"
        } catch {
            twoWayConnectivityOK = false
            var webUIReq = URLRequest(url: URL(string: "http://127.0.0.1:5099/")!)
            webUIReq.httpMethod = "GET"
            webUIReq.timeoutInterval = 2
            if let (_, resp) = try? await URLSession.shared.data(for: webUIReq),
               resp is HTTPURLResponse {
                twoWayConnectivityMessage = "SnowLuma 容器与管理页 (5099) 正常，但 OneBot 3000 端口尚未开启——通常是因为机器人 QQ 小号还未在 noVNC (6081) 完成登录。请先点击上方第 3 步登录 QQ 后再测试。"
            } else {
                twoWayConnectivityMessage = "连通性检测失败（\(error.localizedDescription)）。请确认 Step 4 容器已启动，并在 SnowLuma 管理页 (5099) 开启了正向 HTTP 3000 与反向 HTTP 上报。"
            }
        }
    }

    public func stagePersonaFileFromURL(_ url: URL) {
        do {
            let bundle = try personaPortability.loadBundle(from: url)
            importedPersonaBundle = bundle
            importedPersonaPreview = "已选择人格「\(bundle.effectiveName)」（\(bundle.examples.examples.count) 条情境示例，\(bundle.effectiveCatchphrases.count) 条口头禅）"
            appendLog(importedPersonaPreview ?? "")
        } catch {
            lastError = error.localizedDescription
        }
    }

    public func finishOnboarding(supervisor: RuntimeSupervisor, appState: AppState) async -> Bool {
        guard !isBusy else { return false }
        isBusy = true
        activeTaskKey = "finish"
        activeTaskStatus = "正在启动后台网关并连接主界面…"
        lastError = nil
        defer {
            isBusy = false
            activeTaskKey = nil
            activeTaskStatus = nil
        }

        let paths = await supervisor.currentPaths()
        do {
            if let bundle = importedPersonaBundle, !dryRun {
                try personaPortability.writeBundleOffline(bundle, intoDataDirectory: paths.dataDir)
                appendLog("已将人格「\(bundle.effectiveName)」导入数据目录。")
            }
            if !dryRun {
                if !paths.isTakeover {
                    await launchAgents.removePlist(label: DeploymentDetector.hubPlistLabel, plistURL: launchAgents.hubPlistURL)
                    await launchAgents.removePlist(label: DeploymentDetector.qqRuntimePlistLabel, plistURL: launchAgents.qqRuntimePlistURL)
                    if enableLaunchAtLogin {
                        try await launchAgents.installAppLoginAgent()
                    } else {
                        await launchAgents.removeAppLoginAgent()
                    }
                }
                try await supervisor.startHub()
                appendLog(enableLaunchAtLogin && !paths.isTakeover ? "已开启随开机启动应用，网关已就绪。" : "本地网关已就绪。")
            }
            await appState.reconnectAfterOnboarding()
            return true
        } catch {
            lastError = error.localizedDescription
            appendLog("启动网关失败：\(error.localizedDescription)")
            return false
        }
    }
}
