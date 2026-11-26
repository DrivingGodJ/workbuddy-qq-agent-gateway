import AppKit
import SwiftUI
import UniformTypeIdentifiers

struct OnboardingWindow: View {
    @Bindable var appState: AppState
    @Environment(\.dismiss) private var dismiss
    @State private var showCommandLogs = false
    @State private var showManualOneBot = false
    @State private var showManualCodeBuddy = false
    @State private var copiedHint: String?
    @State private var localWebSheet: EmbeddedWebSheetKind?

    private var wizard: OnboardingOrchestrator {
        appState.onboarding
    }

    var body: some View {
        VStack(spacing: 0) {
            // Header & Stepper
            VStack(alignment: .leading, spacing: 10) {
                HStack {
                    Text("WorkBuddy QQ Gateway 安装与登录向导")
                        .font(.title3.weight(.semibold))
                    Spacer()
                    StatusPill(
                        text: "第 \(wizard.currentStep.rawValue) / 6 步",
                        color: .accentColor,
                        systemImage: "sparkles"
                    )
                }

                HStack(spacing: 8) {
                    ForEach(OnboardingStep.allCases) { step in
                        Button {
                            wizard.currentStep = step
                        } label: {
                            HStack(spacing: 4) {
                                Text("\(step.rawValue)")
                                    .font(.caption.bold())
                                    .frame(width: 18, height: 18)
                                    .background(step == wizard.currentStep ? Color.accentColor : Color.secondary.opacity(0.25), in: Circle())
                                    .foregroundStyle(step == wizard.currentStep ? .white : .primary)
                                Text(step.title)
                                    .font(.caption)
                                    .lineLimit(1)
                            }
                        }
                        .buttonStyle(.plain)
                        .disabled(wizard.isBusy)
                    }
                }
            }
            .padding(16)
            .background(.bar)

            Divider()

            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    stepBody

                    if wizard.isBusy {
                        VStack(alignment: .leading, spacing: 8) {
                            HStack(spacing: 8) {
                                ProgressView()
                                    .controlSize(.small)
                                Text(wizard.activeTaskStatus ?? "正在执行，请稍候…")
                                    .font(.callout.weight(.medium))
                                Spacer()
                                if wizard.activeTaskKey == "workbuddy-login" {
                                    Button("取消登录", role: .destructive) {
                                        wizard.cancelWorkBuddyLogin()
                                    }
                                    .controlSize(.small)
                                }
                                Button(showCommandLogs ? "收起日志" : "查看日志") {
                                    showCommandLogs.toggle()
                                }
                                .controlSize(.small)
                            }
                            ProgressView()
                                .progressViewStyle(.linear)
                        }
                        .padding(10)
                        .background(Color.accentColor.opacity(0.08), in: RoundedRectangle(cornerRadius: 8))
                    }

                    if let copiedHint {
                        InfoBannerView(message: copiedHint) { self.copiedHint = nil }
                    }
                    if let err = wizard.lastError {
                        ErrorBannerView(message: err)
                    }
                }
                .padding(20)
            }

            Divider()

            // Collapsible Live Command Logs
            DisclosureGroup("命令执行日志 (\(wizard.commandLogs.count))", isExpanded: $showCommandLogs) {
                ScrollView {
                    Text(wizard.commandLogs.joined(separator: "\n"))
                        .font(.caption.monospaced())
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(8)
                }
                .frame(height: 110)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 6)

            Divider()

            HStack {
                if wizard.currentStep.rawValue > 1 {
                    Button("上一步") {
                        if let prev = OnboardingStep(rawValue: wizard.currentStep.rawValue - 1) {
                            wizard.currentStep = prev
                        }
                    }
                    .disabled(wizard.isBusy)
                }
                Spacer()
                if wizard.currentStep == .permissionsAndLaunch {
                    if wizard.activeTaskKey == "finish" {
                        runningBadge("启动中…")
                    } else {
                        Button("启动网关并进入主界面") {
                            Task {
                                let ok = await wizard.finishOnboarding(supervisor: appState.supervisor, appState: appState)
                                if ok {
                                    appState.shouldPromptOnboarding = false
                                    dismiss()
                                }
                            }
                        }
                        .buttonStyle(.borderedProminent)
                        .disabled(wizard.isBusy)
                    }
                } else {
                    Button("下一步") {
                        if let next = OnboardingStep(rawValue: wizard.currentStep.rawValue + 1) {
                            wizard.currentStep = next
                        }
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(wizard.isBusy)
                }
            }
            .padding(14)
        }
        .task {
            await wizard.runStep1Detection()
            await wizard.refreshLocalDockerImages()
        }
        .onChange(of: wizard.currentStep) { _, newStep in
            if newStep == .workbuddyLogin && !wizard.isBusy && !wizard.workbuddyLoggedIn {
                Task { await wizard.refreshWorkBuddyLoginStatus() }
            }
        }
        .sheet(item: $localWebSheet) { kind in
            EmbeddedWebViewSheet(
                kind: kind,
                vncPassword: appState.keychain.read(account: .snowlumaVncPassword),
                appState: appState
            )
        }
    }

    @ViewBuilder
    private var stepBody: some View {
        switch wizard.currentStep {
        case .detectMode:
            step1View
        case .runtimeDependencies:
            step2View
        case .workbuddyLogin:
            step3View
        case .vmAndContainer:
            step4View
        case .qqScanAndOneBot:
            step5View
        case .permissionsAndLaunch:
            step6View
        }
    }

    // MARK: - Step 1

    @ViewBuilder
    private var step1View: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Step 1 · 环境检测与模式选择")
                        .font(.headline)
                    Text("自动识别本机是首次全新安装，还是可以无损接管已有的部署与容器。")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                if wizard.activeTaskKey == "detect" {
                    runningBadge("扫描中…")
                } else {
                    Button("重新扫描") {
                        Task { await wizard.runStep1Detection() }
                    }
                    .disabled(wizard.isBusy)
                }
            }

            if case .existingTakeover(let existing) = wizard.detectionMode {
                InfoBannerView(
                    message: "检测到本机已有部署（\(existing.projectDirectory?.path ?? "LaunchAgents / snowluma")）。推荐使用无损接管模式，绝不重建容器或覆盖聊天/人格数据。",
                    color: .green
                )
                HStack(spacing: 12) {
                    Button("无损接管并进入主界面") {
                        wizard.chooseTakeover()
                        appState.shouldPromptOnboarding = false
                        dismiss()
                    }
                    .buttonStyle(.borderedProminent)

                    Button("按向导逐项复查环境") {
                        wizard.chooseTakeover()
                        wizard.currentStep = .runtimeDependencies
                    }
                }
            } else {
                stepCard(number: "1", title: "即将为您完成的配置流程", subtitle: "全程图形化引导，预计 3–5 分钟") {
                    VStack(alignment: .leading, spacing: 6) {
                        Label("准备本地运行环境（Node.js、Python SDK、Colima、Docker、CodeBuddy CLI）", systemImage: "wrench.and.screwdriver")
                        Label("浏览器一键扫码登录 WorkBuddy / CodeBuddy 账号", systemImage: "person.badge.key")
                        Label("初始化 Colima Linux 虚拟机并导入 SnowLuma QQ 容器", systemImage: "shippingbox")
                        Label("扫码登录机器人 QQ 小号，自动同步 OneBot 双向通信并启动网关", systemImage: "bubble.left.and.bubble.right")
                    }
                    .font(.callout)
                }

                HStack {
                    Spacer()
                    Button("开始全新图形化安装 →") {
                        wizard.chooseFreshInstall()
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(wizard.isBusy)
                }
            }
        }
    }

    // MARK: - Step 2

    @ViewBuilder
    private var step2View: some View {
        let caps = wizard.capabilities
        let essentialCount = [
            caps?.nodePath != nil,
            caps?.pythonPath != nil,
            caps?.pythonSDKReady == true,
            caps?.colimaPath != nil,
            caps?.dockerPath != nil,
            caps?.codebuddyPath != nil
        ].filter { $0 }.count

        VStack(alignment: .leading, spacing: 10) {
            HStack {
                VStack(alignment: .leading, spacing: 3) {
                    Text("Step 2 · 运行环境体检与一键准备")
                        .font(.headline)
                    Text("只需点击标「待安装」项右侧按钮即可自动走国内镜像补齐；若用离线 `.tar.gz` 导入，可跳过 docker-buildx。")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                StatusPill(
                    text: "必备依赖 \(essentialCount) / 6",
                    color: essentialCount == 6 ? .green : .orange
                )
                if wizard.activeTaskKey == "detect" {
                    runningBadge("检测中…")
                } else {
                    Button("刷新检测") {
                        Task { await wizard.runStep1Detection() }
                    }
                    .disabled(wizard.isBusy)
                }
            }

            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Homebrew 包管理器（空白新机前置依赖）").font(.callout.weight(.medium))
                    Text(caps?.brewPath ?? "未安装 — 点击右侧按钮在终端输入开机密码自动通过清华镜像安装")
                        .font(.caption.monospaced())
                        .foregroundStyle(.secondary)
                }
                Spacer()
                if caps?.brewPath != nil {
                    StatusPill(text: "已就绪", color: .green)
                } else {
                    Button("在终端安装 Homebrew") {
                        Task { await wizard.openTerminalToInstallHomebrew() }
                    }
                    .disabled(wizard.isBusy)
                }
            }
            .padding(8)
            .background(.quaternary.opacity(0.3), in: RoundedRectangle(cornerRadius: 8))

            depRow("Node.js (>= 20.6)", path: caps?.nodePath, installArg: "node")
            depRow("Python 3 (>= 3.10)", path: caps?.pythonPath, installArg: "python")

            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text("WorkBuddy Python SDK 虚拟环境 (codebuddy-agent-sdk + anyio)")
                        .font(.callout.weight(.medium))
                    Text(caps?.pythonVenvPath ?? "未创建 — 将在 Application Support 创建独立 venv 并从清华镜像安装")
                        .font(.caption.monospaced())
                        .foregroundStyle(.secondary)
                }
                Spacer()
                if caps?.pythonSDKReady == true {
                    StatusPill(text: "SDK 已就绪", color: .green)
                } else if wizard.activeTaskKey == "python-sdk" {
                    runningBadge("安装中…")
                } else {
                    Button("一键创建并安装 SDK") {
                        Task { await wizard.setupPythonSDKVenv() }
                    }
                    .disabled(wizard.isBusy)
                }
            }
            .padding(8)
            .background(.quaternary.opacity(0.3), in: RoundedRectangle(cornerRadius: 8))

            depRow("Colima", path: caps?.colimaPath, installArg: "colima")
            depRow("Docker CLI", path: caps?.dockerPath, installArg: "docker")

            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text("docker-buildx（可选，仅从工程目录源码构建镜像时需要）")
                        .font(.callout.weight(.medium))
                    Text(caps?.dockerBuildxReady == true ? "可用" : "未检测到（使用 .tar.gz 离线镜像包时可跳过）")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                if caps?.dockerBuildxReady == true {
                    StatusPill(text: "已就绪", color: .green)
                } else if wizard.activeTaskKey == "docker-buildx" {
                    runningBadge("安装中…")
                } else {
                    Button("一键安装") {
                        Task { await wizard.installMissingDependency("docker-buildx") }
                    }
                    .disabled(wizard.isBusy)
                }
            }
            .padding(8)
            .background(.quaternary.opacity(0.3), in: RoundedRectangle(cornerRadius: 8))

            depRow("CodeBuddy 独立 CLI", path: caps?.codebuddyPath, installArg: "codebuddy")
        }
    }

    // MARK: - Step 3

    @ViewBuilder
    private var step3View: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Step 3 · WorkBuddy / CodeBuddy 账号登录")
                .font(.headline)

            stepCard(number: "1", title: "当前账号状态", subtitle: "进入本页会自动探测，也可随时手动刷新或退出当前账号") {
                VStack(alignment: .leading, spacing: 8) {
                    HStack(spacing: 10) {
                        StatusPill(
                            text: wizard.workbuddyLoggedIn
                                ? (wizard.workbuddyModelCount > 0 ? "已就绪（\(wizard.workbuddyModelCount) 个可用模型）" : "已就绪")
                                : "尚未登录",
                            color: wizard.workbuddyLoggedIn ? .green : .orange
                        )
                        if let version = wizard.workbuddyVersion {
                            Text("CLI v\(version)")
                                .font(.caption.monospaced())
                                .foregroundStyle(.secondary)
                        }
                        Spacer()

                        if wizard.activeTaskKey == "workbuddy-probe" {
                            runningBadge("检测中…")
                        } else {
                            Button("刷新登录状态") {
                                Task { await wizard.refreshWorkBuddyLoginStatus() }
                            }
                            .disabled(wizard.isBusy)
                        }

                        if wizard.activeTaskKey == "workbuddy-logout" {
                            runningBadge("退出中…")
                        } else if wizard.workbuddyLoggedIn {
                            Button("退出登录", role: .destructive) {
                                Task { await wizard.logoutWorkBuddy() }
                            }
                            .disabled(wizard.isBusy)
                        }
                    }

                    if let detail = wizard.workbuddyStatusDetail, !detail.isEmpty {
                        Text(detail)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
            }

            stepCard(number: "2", title: "一键浏览器扫码登录", subtitle: "全自动在后台完成 CLI 引导并拉起默认浏览器授权，您只需在浏览器扫码确认") {
                VStack(alignment: .leading, spacing: 10) {
                    Picker("账号区域", selection: Bindable(wizard).selectedLoginSite) {
                        ForEach(CodeBuddyLoginSite.allCases) { site in
                            Text(site.rawValue).tag(site)
                        }
                    }
                    .pickerStyle(.segmented)
                    .disabled(wizard.isBusy)

                    HStack(spacing: 10) {
                        if wizard.activeTaskKey == "workbuddy-login" {
                            runningBadge(wizard.activeTaskStatus ?? "正在登录…")
                            Button("取消登录", role: .destructive) {
                                wizard.cancelWorkBuddyLogin()
                            }
                            if let url = wizard.capturedAuthURL {
                                Button("重新打开浏览器") {
                                    NSWorkspace.shared.open(url)
                                }
                                Button("复制登录链接") {
                                    copyValue(url.absoluteString, label: "CodeBuddy 登录链接")
                                }
                            }
                        } else if wizard.workbuddyLoggedIn {
                            Button("重新登录 / 切换账号") {
                                Task { await wizard.startWorkBuddyLogin() }
                            }
                            .disabled(wizard.isBusy)
                        } else {
                            Button("一键打开浏览器扫码登录") {
                                Task { await wizard.startWorkBuddyLogin() }
                            }
                            .buttonStyle(.borderedProminent)
                            .disabled(wizard.isBusy)
                        }
                    }

                    if let url = wizard.capturedAuthURL, wizard.activeTaskKey != "workbuddy-login" {
                        Text("最近授权地址：\(url.absoluteString)")
                            .font(.caption2.monospaced())
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                            .truncationMode(.middle)
                    }
                }
            }

            DisclosureGroup("备选方案：打开系统「终端」手动登录", isExpanded: $showManualCodeBuddy) {
                VStack(alignment: .leading, spacing: 8) {
                    Text("如果浏览器扫码遇到环境限制，可点下方按钮打开系统「终端」，在交互界面按提示选择账号区或输入 `/login`，完成后输入 `/exit` 并点击上面「刷新登录状态」。")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Button("打开「终端」手动登录") {
                        Task { await wizard.openTerminalFallbackLogin() }
                    }
                    .controlSize(.small)
                    .disabled(wizard.isBusy)
                }
                .padding(.top, 4)
            }
        }
    }

    // MARK: - Step 4

    @ViewBuilder
    private var step4View: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Step 4 · 初始化 QQ 虚拟机与 SnowLuma 容器")
                .font(.headline)

            stepCard(number: "1", title: "选择 SnowLuma 镜像来源", subtitle: "推荐直接从内置镜像源在线下载，也支持本机已有镜像、离线 .tar.gz 镜像包或本地/NAS 工程目录构建") {
                VStack(alignment: .leading, spacing: 10) {
                    Picker("镜像来源", selection: Bindable(wizard).imageSourceMode) {
                        ForEach(SnowlumaImageSourceMode.allCases) { mode in
                            Text(mode.rawValue).tag(mode)
                        }
                    }
                    .pickerStyle(.radioGroup)
                    .disabled(wizard.isBusy)

                    switch wizard.imageSourceMode {
                    case .remoteRegistryPull:
                        VStack(alignment: .leading, spacing: 8) {
                            Picker("镜像源", selection: Bindable(wizard).selectedMirrorPreset) {
                                ForEach(SnowlumaMirrorPreset.allCases) { preset in
                                    Text(preset.rawValue).tag(preset)
                                }
                            }
                            .disabled(wizard.isBusy)

                            if wizard.selectedMirrorPreset == .custom {
                                TextField("镜像地址（如 ghcr.nju.edu.cn/zhx57/snowluma:latest）", text: Bindable(wizard).customRemoteImageRef)
                                    .textFieldStyle(.roundedBorder)
                                    .disabled(wizard.isBusy)
                            }

                            let candidates = OnboardingOrchestrator.resolveRemoteImageCandidates(
                                preset: wizard.selectedMirrorPreset,
                                customImageReference: wizard.customRemoteImageRef
                            )
                            Text(
                                candidates.count > 1
                                    ? "拉取顺序：\(candidates.joined(separator: " → "))"
                                    : "目标镜像：\(candidates.first ?? "请输入有效镜像地址")"
                            )
                            .font(.caption.monospaced())
                            .foregroundStyle(.secondary)
                            .textSelection(.enabled)

                            Text("来源为第三方开源社区镜像（zhx57/SnowLuma，原生 linux/arm64）；首次拉取约需 1–5 分钟，若国内源不可用将自动回退官方源。")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }

                    case .existingLocalImage:
                        VStack(alignment: .leading, spacing: 8) {
                            HStack {
                                if wizard.displayedDockerImages.isEmpty {
                                    TextField("镜像标签（如 snowluma-local:v1.14.15）", text: Bindable(wizard).selectedImageTag)
                                        .textFieldStyle(.roundedBorder)
                                } else {
                                    Picker("选择 SnowLuma 镜像", selection: Bindable(wizard).selectedImageTag) {
                                        ForEach(wizard.displayedDockerImages, id: \.self) { img in
                                            Text(img).tag(img)
                                        }
                                    }
                                }
                                Button("刷新列表") {
                                    Task { await wizard.refreshLocalDockerImages() }
                                }
                                .disabled(wizard.isBusy)
                            }
                            if !wizard.allDockerImages.isEmpty {
                                Toggle(
                                    "显示虚拟机内全部镜像（共 \(wizard.allDockerImages.count) 个，已自动隐藏无关项目镜像）",
                                    isOn: Bindable(wizard).showAllDockerImages
                                )
                                .font(.caption)
                                .foregroundStyle(.secondary)
                                .onChange(of: wizard.showAllDockerImages) { _, _ in
                                    if !wizard.displayedDockerImages.contains(wizard.selectedImageTag),
                                       let first = wizard.displayedDockerImages.first {
                                        wizard.selectedImageTag = first
                                    }
                                }
                            }
                        }

                    case .offlineArchiveTar:
                        HStack {
                            Text(wizard.selectedArchiveURL?.path ?? "请选择导出的 .tar 或 .tar.gz 离线镜像包")
                                .font(.caption.monospaced())
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                                .truncationMode(.middle)
                            Spacer()
                            Button("连接 NAS（访达）") {
                                openConnectToServerInFinder()
                            }
                            Button("选择镜像包…") {
                                pickArchiveFile()
                            }
                        }

                    case .localProjectFolder:
                        HStack {
                            Text(wizard.selectedProjectFolderURL?.path ?? "请选择包含 Dockerfile 的 SnowLuma 工程目录")
                                .font(.caption.monospaced())
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                                .truncationMode(.middle)
                            Spacer()
                            Button("连接 NAS（访达）") {
                                openConnectToServerInFinder()
                            }
                            Button("选择工程目录…") {
                                pickProjectFolder()
                            }
                        }
                    }
                }
            }

            stepCard(number: "2", title: "启动虚拟机与容器", subtitle: "仅在 127.0.0.1 绑定端口，绝不暴露容器管理口到局域网") {
                HStack {
                    StatusPill(text: wizard.colimaRunning ? "Colima VM 就绪" : "Colima 待启动", color: wizard.colimaRunning ? .green : .orange)
                    StatusPill(text: wizard.containerReady ? "SnowLuma 容器就绪" : "容器待初始化", color: wizard.containerReady ? .green : .orange)
                    Spacer()
                    if wizard.activeTaskKey == "vm-init" {
                        runningBadge("初始化中…")
                    } else {
                        Button(wizard.containerReady ? "检查 / 重新启动容器" : "一键初始化并启动") {
                            Task { await wizard.initializeColimaAndSnowluma() }
                        }
                        .buttonStyle(.borderedProminent)
                        .disabled(wizard.isBusy)
                    }
                }
            }
        }
    }

    // MARK: - Step 5

    @ViewBuilder
    private var step5View: some View {
        let portText = String(appState.runtimePaths.hubPort)
        let callbackURL = "http://host.docker.internal:\(portText)/api/onebot/event"

        VStack(alignment: .leading, spacing: 14) {
            Text("Step 5 · QQ 小号扫码登录与 OneBot 对接")
                .font(.headline)

            stepCard(number: "1", title: "填写 QQ 号并生成安全凭据", subtitle: "请输入您的管理员 QQ（接收/指挥）与专用机器人 QQ 小号") {
                VStack(alignment: .leading, spacing: 10) {
                    Form {
                        TextField("管理员（你本人）QQ 号", text: Bindable(wizard).ownerQQ)
                        TextField("机器人小号 QQ 号", text: Bindable(wizard).botQQ)
                    }
                    .formStyle(.grouped)

                    HStack(spacing: 10) {
                        Button("保存 QQ 号并生成钥匙串凭据") {
                            Task { await wizard.generateAndSaveCredentials(runtimePaths: appState.runtimePaths) }
                        }
                        .disabled(wizard.isBusy)

                        if wizard.credentialsGenerated {
                            StatusPill(text: "凭据已写入钥匙串", color: .green)
                        }
                    }
                }
            }

            stepCard(number: "2", title: "自动同步 OneBot 配置到 SnowLuma", subtitle: "先把新令牌与回调地址写入容器，避免后续重启打断 QQ 登录") {
                VStack(alignment: .leading, spacing: 10) {
                    HStack(spacing: 10) {
                        if wizard.activeTaskKey == "onebot-sync" {
                            runningBadge("正在写入配置…")
                        } else {
                            Button("一键写入 SnowLuma 配置") {
                                Task { await wizard.syncSnowlumaOneBotConfig(runtimePaths: appState.runtimePaths) }
                            }
                            .buttonStyle(.borderedProminent)
                            .disabled(wizard.isBusy)
                        }
                        Text("回调地址：\(callbackURL)")
                            .font(.caption2.monospaced())
                            .foregroundStyle(.secondary)
                    }

                    DisclosureGroup("高级：手动打开 SnowLuma 管理页 (5099) 核对/修改", isExpanded: $showManualOneBot) {
                        VStack(alignment: .leading, spacing: 8) {
                            Text("如需手动核对：正向 HTTP（端口 3000）与反向上报客户端（workbuddy-qq-gateway）须同时使用同一份 OneBot 访问令牌。")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                            HStack(spacing: 8) {
                                Button("打开 SnowLuma 管理页 (5099)") {
                                    localWebSheet = .snowlumaWebUI
                                }
                                .controlSize(.small)
                                Button("复制回调地址") {
                                    copyValue(callbackURL, label: "反向 HTTP 上报地址")
                                }
                                .controlSize(.small)
                                Button("复制 OneBot 令牌") {
                                    if let token = wizard.readKeychainSecretForCopy(.oneBotApiToken) {
                                        copyValue(token, label: "OneBot 访问令牌")
                                    } else {
                                        wizard.lastError = "请先在第 1 步点击「保存 QQ 号并生成钥匙串凭据」。"
                                    }
                                }
                                .controlSize(.small)
                            }
                        }
                        .padding(.top, 4)
                    }
                }
            }

            stepCard(number: "3", title: "打开远程桌面登录机器人 QQ 小号", subtitle: "在远程桌面里点击登录或使用机器人小号扫码；若刚刚重启过容器，也请在此确认 QQ 已进入主界面") {
                VStack(alignment: .leading, spacing: 8) {
                    HStack(spacing: 10) {
                        Button("打开 QQ 扫码桌面 (noVNC 6081)") {
                            localWebSheet = .noVNC
                        }
                        Button("复制 VNC 密码") {
                            if let pass = wizard.readKeychainSecretForCopy(.snowlumaVncPassword) {
                                copyValue(pass, label: "VNC 密码")
                            } else {
                                wizard.lastError = "未在钥匙串找到 VNC 密码（若容器开启了免密 VNC 则无需密码直接进）。"
                            }
                        }
                    }
                    Text("提示：首次扫码登录时 Linux QQ 不会显示「自动登录」选项；下次重启软件出现快速登录页时，请务必勾选「自动登录」再点「登录」，之后即可全自动上线。")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }

            stepCard(number: "4", title: "QQ 登录状态", subtitle: "扫码后自动检测，QQ 在线后即可进入最后一步") {
                VStack(alignment: .leading, spacing: 10) {
                    HStack(spacing: 10) {
                        if wizard.activeTaskKey == "connectivity" {
                            runningBadge("检测中…")
                        } else {
                            Button("测试连通性") {
                                Task { await wizard.testTwoWayConnectivity(supervisor: appState.supervisor) }
                            }
                            .disabled(wizard.isBusy)
                        }
                        if appState.isQQOneBotOnline {
                            let nickname = appState.qqLoginStatus?.login?.nickname ?? "已登录"
                            StatusPill(text: "QQ 已上线（\(nickname)）", color: .green)
                        }
                    }
                    if !appState.isQQOneBotOnline, !wizard.twoWayConnectivityMessage.isEmpty,
                       !wizard.twoWayConnectivityOK || wizard.dryRun {
                        InfoBannerView(
                            message: wizard.twoWayConnectivityMessage,
                            color: wizard.twoWayConnectivityOK ? .green : .orange
                        )
                    }
                }
            }
        }
    }

    // MARK: - Step 6

    @ViewBuilder
    private var step6View: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Step 6 · 人格恢复、系统权限与启动网关")
                .font(.headline)

            stepCard(number: "1", title: "导入已有人格备份（可选）", subtitle: "如果之前导出了 .laodai-persona.json 文件，现在可以直接放回") {
                HStack(spacing: 10) {
                    Button("选择人格备份文件…") {
                        if let picked = appState.pickPersonaBundleForImport() {
                            wizard.stagePersonaFileFromURL(picked.url)
                        }
                    }
                    if let preview = wizard.importedPersonaPreview {
                        Text(preview)
                            .font(.caption)
                            .foregroundStyle(.green)
                    }
                }
            }

            stepCard(number: "2", title: "授予 macOS 系统权限（可选）", subtitle: "用于让机器人写入 Apple 日历日程、创建提醒事项和弹出桌面通知") {
                VStack(spacing: 8) {
                    permissionQuickRow("Apple 日历", status: wizard.permissionSummary.calendar) {
                        Task {
                            _ = await appState.permissions.requestCalendarAccess()
                            wizard.permissionSummary = await appState.permissions.currentSummary()
                        }
                    }
                    permissionQuickRow("Apple 提醒事项", status: wizard.permissionSummary.reminders) {
                        Task {
                            _ = await appState.permissions.requestRemindersAccess()
                            wizard.permissionSummary = await appState.permissions.currentSummary()
                        }
                    }
                    permissionQuickRow("系统通知", status: wizard.permissionSummary.notifications) {
                        Task {
                            _ = await appState.permissions.requestNotificationsAccess()
                            wizard.permissionSummary = await appState.permissions.currentSummary()
                        }
                    }
                }
            }

            stepCard(number: "3", title: "开机自启与后续配置", subtitle: "完成启动后，可在主界面按下 Cmd + , 进入「权限与智能家居」登录 HA 并选择小爱音箱") {
                Toggle("登录后自动启动后台服务（推荐开启）", isOn: Bindable(wizard).enableLaunchAtLogin)
            }
        }
    }

    // MARK: - Shared Helpers

    @ViewBuilder
    private func stepCard<Content: View>(
        number: String,
        title: String,
        subtitle: String,
        @ViewBuilder content: () -> Content
    ) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .top, spacing: 10) {
                Text(number)
                    .font(.caption.bold())
                    .frame(width: 22, height: 22)
                    .background(Color.accentColor.opacity(0.18), in: Circle())
                    .foregroundStyle(Color.accentColor)
                VStack(alignment: .leading, spacing: 2) {
                    Text(title)
                        .font(.subheadline.weight(.semibold))
                    Text(subtitle)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer()
            }
            content()
        }
        .padding(12)
        .background(.quaternary.opacity(0.28), in: RoundedRectangle(cornerRadius: 10))
    }

    @ViewBuilder
    private func permissionQuickRow(_ title: String, status: PermissionAuthorizationStatus, action: @escaping () -> Void) -> some View {
        HStack {
            Text(title)
                .font(.callout)
            Spacer()
            StatusPill(text: status.rawValue, color: status.isGranted ? .green : .orange)
            Button("请求授权", action: action)
                .controlSize(.small)
                .disabled(status.isGranted)
        }
    }

    @ViewBuilder
    private func runningBadge(_ label: String) -> some View {
        HStack(spacing: 6) {
            ProgressView()
                .controlSize(.small)
            Text(label)
                .font(.caption.weight(.medium))
                .foregroundStyle(.secondary)
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
        .background(.quaternary.opacity(0.45), in: Capsule())
    }

    @ViewBuilder
    private func depRow(_ name: String, path: String?, installArg: String) -> some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text(name).font(.callout.weight(.medium))
                Text(path ?? "未检测到")
                    .font(.caption.monospaced())
                    .foregroundStyle(.secondary)
            }
            Spacer()
            if path != nil {
                StatusPill(text: "已就绪", color: .green)
            } else if wizard.activeTaskKey == installArg {
                runningBadge("安装中…")
            } else {
                Button("一键安装") {
                    Task { await wizard.installMissingDependency(installArg) }
                }
                .disabled(wizard.isBusy)
            }
        }
        .padding(8)
        .background(.quaternary.opacity(0.3), in: RoundedRectangle(cornerRadius: 8))
    }

    private func pickArchiveFile() {
        let panel = NSOpenPanel()
        panel.title = "选择 SnowLuma 离线镜像包"
        panel.message = "支持 docker save 导出的 .tar 或 .tar.gz 文件（本地磁盘或已挂载 NAS /Volumes/ 目录）"
        panel.canChooseFiles = true
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = false
        panel.allowedContentTypes = [UTType.gzip, UTType(filenameExtension: "tar") ?? .data]
        if panel.runModal() == .OK {
            wizard.selectedArchiveURL = panel.url
        }
    }

    private func pickProjectFolder() {
        let panel = NSOpenPanel()
        panel.title = "选择含 Dockerfile 的 SnowLuma 工程目录"
        panel.message = "请选择本机或 NAS 挂载目录下包含 Dockerfile 的 SnowLuma 文件夹"
        panel.canChooseFiles = false
        panel.canChooseDirectories = true
        panel.allowsMultipleSelection = false
        if panel.runModal() == .OK {
            wizard.selectedProjectFolderURL = panel.url
        }
    }

    private func openConnectToServerInFinder() {
        let script = "tell application \"Finder\" to activate\ntell application \"System Events\" to keystroke \"k\" using command down"
        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
        proc.arguments = ["-e", script]
        try? proc.run()
    }

    private func copyValue(_ value: String, label: String) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(value, forType: .string)
        copiedHint = "已复制「\(label)」到剪贴板。"
    }
}
