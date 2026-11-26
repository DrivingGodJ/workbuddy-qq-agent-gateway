import Foundation
import Testing
@testable import WorkBuddyQQGateway

@Suite("WorkBuddy QQ Gateway Core Tests")
struct GatewayCoreTests {
    @Test("One SSE data line delivers a chat update without an empty separator")
    func gatewayStreamReadsChatDelta() throws {
        let line = #"data: {"type":"target-update","targets":{"group:10001":{"groupId":"10001","targetType":"group","targetId":"10001","replyEnabled":true,"activeReply":{"running":true,"text":"实时输出"}}},"activeTargets":["group:10001"]}"#
        let payload = try #require(GatewayEventStream.payload(fromDataLine: line))
        guard case .targetUpdate(let targets, let activeTargets, _) = payload else {
            Issue.record("Expected a conversation update")
            return
        }
        #expect(targets["group:10001"]?.activeReply?.text == "实时输出")
        #expect(activeTargets == ["group:10001"])
        #expect(GatewayEventStream.payload(fromDataLine: ": heartbeat") == nil)
        #expect(GatewayEventStream.payload(fromDataLine: "data: invalid") == nil)
    }

    @Test("GitHub update check recognizes only newer stable releases of this app")
    func githubReleaseCheck() throws {
        let releases = try #require(URL(string: "https://github.com/DrivingGodJ/workbuddy-qq-agent-gateway/releases"))
        let newer = releases.appendingPathComponent("tag").appendingPathComponent("v0.2.10")
        #expect(try GitHubReleaseChecker.result(for: newer, installedVersion: "0.2.9") ==
            .available(AppRelease(version: "0.2.10", pageURL: newer)))
        #expect(try GitHubReleaseChecker.result(for: newer, installedVersion: "0.2.10") == .upToDate)
        #expect(try GitHubReleaseChecker.result(for: newer, installedVersion: "0.3.0") == .upToDate)
        #expect(try GitHubReleaseChecker.result(for: releases, installedVersion: "0.2.6") == .noRelease)

        let preview = releases.appendingPathComponent("tag").appendingPathComponent("v0.3.0-beta.1")
        #expect(try GitHubReleaseChecker.result(for: preview, installedVersion: "0.2.6") == .noRelease)

        let unrelated = try #require(URL(string: "https://github.com/example/another-repo/releases/tag/v9.0.0"))
        #expect(throws: URLError.self) {
            try GitHubReleaseChecker.result(for: unrelated, installedVersion: "0.2.6")
        }
    }

    @Test("Speaker schedules preserve Chinese local time and independent weekdays")
    func speakerScheduleEditing() throws {
        var plan = SpeakerGreetingPlan(id: "weekly", time: "00:05", days: [1, 5], enabled: true, weather: false)
        let original = plan.timeSelection
        #expect(ISO8601DateFormatter().string(from: original) == "2000-12-31T16:05:00Z")
        plan.timeSelection = original.addingTimeInterval(1430 * 60)
        plan.setWeekday(0, selected: true)
        plan.setWeekday(1, selected: false)
        plan.setWeekday(5, selected: true)
        let decoded = try JSONDecoder().decode(SpeakerGreetingPlan.self, from: JSONEncoder().encode(plan))
        #expect(decoded.time == "23:55")
        #expect(decoded.days == [0, 5])
    }

    @Test("Calendar and Reminders must both have full access")
    func automationPermissions() {
        var state = SystemPermissionSummary(calendar: .writeOnly, reminders: .granted, notifications: .denied)
        #expect(!state.calendarRemindersReady)
        state.calendar = .granted
        state.reminders = .denied
        #expect(!state.calendarRemindersReady)
        state.reminders = .granted
        #expect(state.calendarRemindersReady)
    }

    @Test("Python version check requires 3.10 or newer")
    func pythonVersionSupport() {
        #expect(!DeploymentDetector.isSupportedPythonVersion("Python 3.9.6"))
        #expect(!DeploymentDetector.isSupportedPythonVersion("3.9"))
        #expect(!DeploymentDetector.isSupportedPythonVersion("2.7.18"))
        #expect(!DeploymentDetector.isSupportedPythonVersion(""))
        #expect(DeploymentDetector.isSupportedPythonVersion("3.10"))
        #expect(DeploymentDetector.isSupportedPythonVersion("Python 3.12.13"))
        #expect(DeploymentDetector.isSupportedPythonVersion("3.14.0"))
    }

    @Test("ContextTokenLimit decodes both auto and integer token limits")
    func contextTokenLimitCoding() throws {
        let autoJSON = Data(#""auto""#.utf8)
        let intJSON = Data("200000".utf8)
        let decodedAuto = try JSONDecoder().decode(ContextTokenLimit.self, from: autoJSON)
        let decodedInt = try JSONDecoder().decode(ContextTokenLimit.self, from: intJSON)
        #expect(decodedAuto == .auto)
        #expect(decodedInt == .tokens(200000))

        let reencoded = try JSONEncoder().encode(decodedInt)
        #expect(String(data: reencoded, encoding: .utf8) == "200000")
    }

    @Test("GatewayState and MaintenanceState decode full JSON snapshots cleanly")
    func gatewayAndMaintenanceDecoding() throws {
        let stateJSON = """
        {
          "version": 5,
          "architecture": "target-owned-read-only-source-subscriptions",
          "agentDispatch": { "enabled": true },
          "persona": {
            "version": 1,
            "name": "老代",
            "isImported": false,
            "catchphrases": [{ "text": "这么好", "when": "意外不错" }]
          },
          "ai": {
            "provider": "workbuddy-agent-sdk",
            "model": "auto",
            "availableModels": [
              {
                "model": "auto",
                "displayName": "auto",
                "supportedReasoningEfforts": [{ "reasoningEffort": "auto", "description": "自动" }]
              }
            ],
            "contextTokenOptions": [
              { "value": "auto", "label": "自动" },
              { "value": 200000, "label": "轻量 · 200K" }
            ]
          },
          "qq": {
            "ownerId": "100000001",
            "groups": {
              "999999": {
                "groupId": "999999",
                "replyEnabled": true,
                "targetType": "group",
                "targetId": "999999",
                "agentConfig": { "model": "auto", "contextTokenLimit": "auto" }
              }
            },
            "privateChats": {},
            "sourceGroups": {},
            "stickers": { "total": 2, "ready": 2 },
            "qzone": { "autoPostEnabled": false, "autoEngageEnabled": false }
          }
        }
        """
        let state = try JSONDecoder().decode(GatewayState.self, from: Data(stateJSON.utf8))
        #expect(state.persona?.name == "老代")
        #expect(state.qq?.groups?["999999"]?.effectiveConfig.contextTokenLimit == .auto)
        #expect(state.ai?.contextTokenOptions?.last?.value == .tokens(200000))

        let maintJSON = """
        {
          "ok": true,
          "hub": { "host": "127.0.0.1", "port": 3789, "authDisabled": false },
          "oneBot": { "ok": true, "login": { "user_id": 100000002, "nickname": "Bot" } },
          "engine": {
            "engine": "workbuddy",
            "engineReady": true,
            "sdkVersion": "0.3.261",
            "account": { "probed": true, "loggedIn": true, "modelCount": 17 }
          },
          "storage": { "personaImported": true }
        }
        """
        let maint = try JSONDecoder().decode(MaintenanceState.self, from: Data(maintJSON.utf8))
        #expect(maint.ok == true)
        #expect(maint.oneBot?.login?.userIdString == "100000002")
        #expect(maint.engine?.account?.loggedIn == true)
        #expect(maint.storage?.personaImported == true)
    }

    @Test("PersonaPortabilityService exports, loads, validates, and writes offline persona files")
    func personaPortabilityRoundTrip() throws {
        let fm = FileManager.default
        let tempRoot = fm.temporaryDirectory.appendingPathComponent("swift-persona-test-\(UUID().uuidString)", isDirectory: true)
        defer { try? fm.removeItem(at: tempRoot) }

        let deployDir = tempRoot.appendingPathComponent("deploy", isDirectory: true)
        let privatePersonaDir = deployDir.appendingPathComponent("config/private/persona", isDirectory: true)
        let dataDir = deployDir.appendingPathComponent("runtime/qq-only-data", isDirectory: true)
        try fm.createDirectory(at: privatePersonaDir, withIntermediateDirectories: true)
        try fm.createDirectory(at: dataDir, withIntermediateDirectories: true)

        try """
        {
          "version": 2,
          "name": "老代测试",
          "source": "测试问卷",
          "identity": ["你是老代测试"],
          "baseline": { "energy": 0.7, "patience": 0.8 }
        }
        """.write(to: privatePersonaDir.appendingPathComponent("core.json"), atomically: true, encoding: .utf8)

        try """
        {
          "version": 1,
          "examples": [
            { "id": "e1", "tags": ["日常"], "situation": "打招呼", "behavior": "简短回应", "examples": ["早"], "avoid": ["您好请问有什么可以帮助您"] }
          ]
        }
        """.write(to: privatePersonaDir.appendingPathComponent("examples.json"), atomically: true, encoding: .utf8)

        try """
        {
          "agentName": "小代代",
          "activeCatchphrases": [{ "text": "这么好", "when": "惊喜时" }]
        }
        """.write(to: dataDir.appendingPathComponent("persona-owner-style.json"), atomically: true, encoding: .utf8)

        let service = PersonaPortabilityService()
        let assembled = try service.assembleReadOnlyBundle(fromDirectory: deployDir, dataDirectory: dataDir)
        #expect(assembled.effectiveName == "小代代")
        #expect(assembled.core.baseline?["energy"] == 0.7)
        #expect(assembled.examples.examples.count == 1)

        let bundleFile = tempRoot.appendingPathComponent("backup.laodai-persona.json")
        try service.writeBundle(assembled, to: bundleFile)

        let loaded = try service.loadBundle(from: bundleFile)
        #expect(loaded == assembled)

        let newDataDir = tempRoot.appendingPathComponent("new-data", isDirectory: true)
        try service.writeBundleOffline(loaded, intoDataDirectory: newDataDir)
        #expect(fm.fileExists(atPath: newDataDir.appendingPathComponent("persona/core.json").path))
        #expect(fm.fileExists(atPath: newDataDir.appendingPathComponent("persona/examples.json").path))
        #expect(fm.fileExists(atPath: newDataDir.appendingPathComponent("persona-owner-style.json").path))
    }

    @Test("DeploymentDetector detects fresh install vs existing takeover strictly in isolated temp dirs")
    func deploymentDetectorIsolation() async throws {
        let fm = FileManager.default
        let tempRoot = fm.temporaryDirectory.appendingPathComponent("swift-detect-test-\(UUID().uuidString)", isDirectory: true)
        defer { try? fm.removeItem(at: tempRoot) }

        let fakeHome = tempRoot.appendingPathComponent("home", isDirectory: true)
        let fakeLaunchAgents = fakeHome.appendingPathComponent("Library/LaunchAgents", isDirectory: true)
        try fm.createDirectory(at: fakeLaunchAgents, withIntermediateDirectories: true)

        let keychain = KeychainStore(serviceName: "WorkBuddy QQ Gateway Test \(UUID().uuidString)")
        let freshDetector = DeploymentDetector(
            fileManager: fm,
            homeDirectory: fakeHome,
            launchAgentsDirectory: fakeLaunchAgents,
            keychain: keychain,
            bundleResourceURL: nil,
            candidateProjectDirectories: []
        )
        let freshResult = await freshDetector.detect(probeContainers: false)
        #expect(freshResult == .freshInstall)

        // Create synthetic deployment + LaunchAgent plist
        let fakeProject = tempRoot.appendingPathComponent("legacy-deploy", isDirectory: true)
        try fm.createDirectory(at: fakeProject.appendingPathComponent("src"), withIntermediateDirectories: true)
        try fm.createDirectory(at: fakeProject.appendingPathComponent("config"), withIntermediateDirectories: true)
        try fm.createDirectory(at: fakeProject.appendingPathComponent("runtime/qq-only-data"), withIntermediateDirectories: true)
        try "// server".write(to: fakeProject.appendingPathComponent("src/server.js"), atomically: true, encoding: .utf8)
        try """
        WORKBUDDY_QQ_OWNER_QQ_ID=100000001
        WORKBUDDY_QQ_BOT_QQ_ID=100000002
        WORKBUDDY_QQ_PORT=13789
        """.write(to: fakeProject.appendingPathComponent("config/qq-only.env"), atomically: true, encoding: .utf8)

        let plistDict: [String: Any] = [
            "Label": DeploymentDetector.hubPlistLabel,
            "WorkingDirectory": fakeProject.path
        ]
        let plistData = try PropertyListSerialization.data(fromPropertyList: plistDict, format: .xml, options: 0)
        try plistData.write(to: fakeLaunchAgents.appendingPathComponent("\(DeploymentDetector.hubPlistLabel).plist"))

        let takeoverDetector = DeploymentDetector(
            fileManager: fm,
            homeDirectory: fakeHome,
            launchAgentsDirectory: fakeLaunchAgents,
            keychain: keychain,
            bundleResourceURL: nil,
            candidateProjectDirectories: [fakeProject]
        )
        let takeoverResult = await takeoverDetector.detect(probeContainers: false)
        if case .existingTakeover(let existing) = takeoverResult {
            #expect(existing.projectDirectory == fakeProject)
            #expect(existing.hubPort == 13789)
            #expect(existing.ownerQQ == "100000001")
            #expect(existing.botQQ == "100000002")
            #expect(existing.hasHubLaunchAgent == true)
        } else {
            Issue.record("Expected existingTakeover deployment mode")
        }
    }

    @Test("OnboardingOrchestrator validates QQ IDs and handles dry-run flow safely")
    @MainActor
    func onboardingDryRunFlow() async {
        let fm = FileManager.default
        let tempRoot = fm.temporaryDirectory.appendingPathComponent("swift-onboard-test-\(UUID().uuidString)", isDirectory: true)
        defer { try? fm.removeItem(at: tempRoot) }

        let detector = DeploymentDetector(
            homeDirectory: tempRoot,
            launchAgentsDirectory: tempRoot.appendingPathComponent("LaunchAgents"),
            keychain: KeychainStore(serviceName: "TestOnboard-\(UUID().uuidString)"),
            bundleResourceURL: nil,
            candidateProjectDirectories: []
        )
        let orchestrator = OnboardingOrchestrator(dryRun: true, detector: detector)
        await orchestrator.runStep1Detection()
        #expect(orchestrator.installChoice == .freshInstall)

        orchestrator.ownerQQ = "100000001"
        orchestrator.botQQ = "100000001"
        #expect(orchestrator.validateQQInputs() != nil)

        orchestrator.botQQ = "100000002"
        #expect(orchestrator.validateQQInputs() == nil)

        await orchestrator.startWorkBuddyLogin()
        #expect(orchestrator.workbuddyLoggedIn == true)

        await orchestrator.initializeColimaAndSnowluma()
        #expect(orchestrator.colimaRunning == true)
        #expect(orchestrator.containerReady == true)

        await orchestrator.setupPythonSDKVenv()
        orchestrator.imageSourceMode = .existingLocalImage
        await orchestrator.initializeColimaAndSnowluma()
        orchestrator.imageSourceMode = .offlineArchiveTar
        await orchestrator.initializeColimaAndSnowluma()
        orchestrator.imageSourceMode = .localProjectFolder
        await orchestrator.initializeColimaAndSnowluma()
        #expect(orchestrator.containerReady == true)
        #expect(orchestrator.isBusy == false)
        #expect(orchestrator.activeTaskKey == nil)
        #expect(orchestrator.activeTaskStatus == nil)
    }

    @Test("OnboardingOrchestrator resolves SnowLuma mirror presets and falls back on pull failure")
    @MainActor
    func snowlumaMirrorPresetsAndFallback() async throws {
        #expect(
            OnboardingOrchestrator.resolveRemoteImageCandidates(preset: .autoFallback, customImageReference: "")
                == [SnowlumaMirrorPreset.njuImageRef, SnowlumaMirrorPreset.officialImageRef]
        )
        #expect(
            OnboardingOrchestrator.resolveRemoteImageCandidates(preset: .njuMirror, customImageReference: "")
                == [SnowlumaMirrorPreset.njuImageRef]
        )
        #expect(
            OnboardingOrchestrator.resolveRemoteImageCandidates(preset: .ghcrOfficial, customImageReference: "")
                == [SnowlumaMirrorPreset.officialImageRef]
        )
        #expect(
            OnboardingOrchestrator.resolveRemoteImageCandidates(preset: .custom, customImageReference: "  ghcr.io/example/snowluma:v1  ")
                == ["ghcr.io/example/snowluma:v1"]
        )
        #expect(OnboardingOrchestrator.resolveRemoteImageCandidates(preset: .custom, customImageReference: "   ").isEmpty)
        #expect(OnboardingOrchestrator.resolveRemoteImageCandidates(preset: .custom, customImageReference: "ghcr.io/bad image:latest").isEmpty)

        actor MockPullRunner: CommandRunning {
            var recordedCalls: [[String]] = []
            private let failAll: Bool

            init(failAll: Bool = false) {
                self.failAll = failAll
            }

            func run(
                executable: String,
                arguments: [String],
                currentDirectory: URL?,
                extraEnv: [String: String],
                timeoutSeconds: TimeInterval?
            ) async throws -> CommandResult {
                recordedCalls.append(arguments)
                let callIndex = recordedCalls.count

                if failAll || callIndex == 1 {
                    return CommandResult(exitCode: 1, stdout: "", stderr: "timeout connecting mirror \(callIndex)")
                }
                return CommandResult(exitCode: 0, stdout: "Status: Downloaded newer image", stderr: "")
            }
        }

        let runner = MockPullRunner()
        let orchestrator = OnboardingOrchestrator(dryRun: false, runner: runner)
        let pulled = try await orchestrator.pullSnowlumaImage(
            dockerExecutable: "/usr/bin/docker",
            dockerContext: "colima-snowluma",
            candidates: SnowlumaMirrorPreset.builtinImageCandidates
        )
        let calls = await runner.recordedCalls
        #expect(pulled == SnowlumaMirrorPreset.officialImageRef)
        #expect(calls.count == 2)
        #expect(calls[0] == ["--context", "colima-snowluma", "pull", "--platform", "linux/arm64", SnowlumaMirrorPreset.njuImageRef])
        #expect(calls[1] == ["--context", "colima-snowluma", "pull", "--platform", "linux/arm64", SnowlumaMirrorPreset.officialImageRef])
        #expect(orchestrator.commandLogs.contains { $0.contains("自动回退到下一个备用源") })

        let failingRunner = MockPullRunner(failAll: true)
        let failingOrchestrator = OnboardingOrchestrator(dryRun: false, runner: failingRunner)
        var capturedMessage = ""
        do {
            _ = try await failingOrchestrator.pullSnowlumaImage(
                dockerExecutable: "/usr/bin/docker",
                dockerContext: "colima-snowluma",
                candidates: SnowlumaMirrorPreset.builtinImageCandidates
            )
            Issue.record("Expected pullSnowlumaImage to throw when all mirrors fail")
        } catch {
            capturedMessage = error.localizedDescription
        }
        #expect(capturedMessage.contains(SnowlumaMirrorPreset.njuImageRef))
        #expect(capturedMessage.contains(SnowlumaMirrorPreset.officialImageRef))
    }

    @Test("OnboardingOrchestrator parses docker load output and DeploymentDetector resolves standalone venv path")
    func offlineImageParsingAndVenvPath() {
        let parsed = OnboardingOrchestrator.parseLoadedDockerImage(from: "Loaded image: snowluma-local:v1.14.15\n")
        #expect(parsed == "snowluma-local:v1.14.15")

        let fakeHome = URL(fileURLWithPath: "/tmp/test-home", isDirectory: true)
        let venv = DeploymentDetector.standaloneVenvDirectory(homeDirectory: fakeHome)
        #expect(venv.path == "/tmp/test-home/Library/Application Support/WorkBuddyQQGateway/runtime/venv")
    }

    @Test("LogDiagnosticsManager scrubs sensitive tokens, QQ IDs, and local user paths")
    func diagnosticsRedaction() {
        let fakeBearer = ["Bearer", "token_" + String(repeating: "x", count: 24)].joined(separator: " ")
        let fakeUserPath = ["", "Users", "alice", "Documents", "secret", "config.json"].joined(separator: "/")
        let raw = """
        Authorization: \(fakeBearer)
        ONEBOT_ACCESS_TOKEN=abcdef1234567890
        Path: \(fakeUserPath)
        Sender QQ 1999999999 sent message
        Hash: 0123456789abcdef0123456789abcdef
        """
        let clean = LogDiagnosticsManager.redact(raw)
        #expect(!clean.contains(String(repeating: "x", count: 24)))
        #expect(!clean.contains("abcdef1234567890"))
        #expect(!clean.contains("alice"))
        #expect(!clean.contains("1999999999"))
        #expect(!clean.contains("0123456789abcdef0123456789abcdef"))
        #expect(clean.contains("[REDACTED]"))
        #expect(clean.contains("[USER]"))
        #expect(clean.contains("[QQ_ID]"))
    }

    @Test("LanPanelStatus decodes LAN broadcast state")
    func lanPanelStatusDecoding() throws {
        let json = """
        {
          "enabled": true,
          "running": true,
          "port": 3790,
          "bonjourEnabled": true,
          "bonjourActive": true,
          "hasPassword": true,
          "activeSessions": 2,
          "urls": [{ "interface": "en0", "address": "192.168.1.50", "url": "http://192.168.1.50:3790" }],
          "bonjourHost": "http://my-mac.local:3790",
          "lastError": null
        }
        """
        let status = try JSONDecoder().decode(LanPanelStatus.self, from: Data(json.utf8))
        #expect(status.enabled == true)
        #expect(status.running == true)
        #expect(status.port == 3790)
        #expect(status.activeSessions == 2)
        #expect(status.urls.first?.url == "http://192.168.1.50:3790")
        #expect(status.bonjourHost == "http://my-mac.local:3790")
    }

    @Test("HomeAssistantService normalizes LAN addresses and rejects invalid URLs")
    func homeAssistantURLNormalization() throws {
        #expect(try HomeAssistantService.normalizeBaseURL("192.168.1.10").absoluteString == "http://192.168.1.10:8123")
        #expect(try HomeAssistantService.normalizeBaseURL("192.168.1.10:8123").absoluteString == "http://192.168.1.10:8123")
        #expect(try HomeAssistantService.normalizeBaseURL("http://192.168.1.10:8123/").absoluteString == "http://192.168.1.10:8123")
        #expect(try HomeAssistantService.normalizeBaseURL("https://ha.local/").absoluteString == "https://ha.local")

        #expect(throws: Error.self) { _ = try HomeAssistantService.normalizeBaseURL("") }
        #expect(throws: Error.self) { _ = try HomeAssistantService.normalizeBaseURL("ftp://192.168.1.10") }
        #expect(throws: Error.self) { _ = try HomeAssistantService.normalizeBaseURL("http://192.168.1.10:8123/lovelace") }
        #expect(throws: Error.self) { _ = try HomeAssistantService.normalizeBaseURL("http://user:pass@192.168.1.10:8123") }
    }

    @Test("HomeAssistantService filters XiaoAi speakers, buttons, and readable devices")
    func homeAssistantEntityCategorization() {
        let states = [
            HARawState(entityId: "notify.xiaomi_demo_l05c_play_text_a_5_3", state: "unknown", attributes: HARawAttributes(friendlyName: "客厅小爱 播放文本")),
            HARawState(entityId: "notify.mobile_app_phone", state: "unknown", attributes: HARawAttributes(friendlyName: "手机通知")),
            HARawState(entityId: "button.miir_demo_fan_power", state: "unknown", attributes: HARawAttributes(friendlyName: "风扇开关")),
            HARawState(entityId: "light.living_room", state: "on", attributes: HARawAttributes(friendlyName: "客厅主灯")),
            HARawState(entityId: "sensor.temp_living", state: "24.5", attributes: HARawAttributes(friendlyName: "客厅温度"))
        ]
        let catalog = HomeAssistantService.categorizeStates(states)
        #expect(catalog.speakers.count == 1)
        #expect(catalog.speakers.first?.entityId == "notify.xiaomi_demo_l05c_play_text_a_5_3")
        #expect(catalog.buttons.count == 1)
        #expect(catalog.buttons.first?.entityId == "button.miir_demo_fan_power")
        #expect(catalog.otherDeviceCount == 2)
        #expect(catalog.totalStatesCount == 5)
    }

    @Test("LaunchAgentManager writes structural standalone paths without freezing qq-only.env values and DeploymentDetector restores them")
    func standaloneLaunchAgentAndDetectorRoundTrip() async throws {
        let fm = FileManager.default
        let tempRoot = fm.temporaryDirectory.appendingPathComponent("swift-standalone-agent-\(UUID().uuidString)", isDirectory: true)
        defer { try? fm.removeItem(at: tempRoot) }

        let fakeHome = tempRoot.appendingPathComponent("home", isDirectory: true)
        let launchAgentsDir = fakeHome.appendingPathComponent("Library/LaunchAgents", isDirectory: true)
        let fakeAppGateway = tempRoot.appendingPathComponent("Applications/WorkBuddyQQGateway.app/Contents/Resources/gateway", isDirectory: true)
        let appSupport = fakeHome.appendingPathComponent("Library/Application Support/WorkBuddyQQGateway", isDirectory: true)
        let runtimeDir = appSupport.appendingPathComponent("runtime", isDirectory: true)
        let dataDir = runtimeDir.appendingPathComponent("qq-only-data", isDirectory: true)
        let envFile = appSupport.appendingPathComponent("config/qq-only.env")
        let binDir = tempRoot.appendingPathComponent("bin", isDirectory: true)

        try fm.createDirectory(at: fakeAppGateway.appendingPathComponent("modules"), withIntermediateDirectories: true)
        try fm.createDirectory(at: envFile.deletingLastPathComponent(), withIntermediateDirectories: true)
        try fm.createDirectory(at: binDir, withIntermediateDirectories: true)
        try "#!/bin/zsh\n".write(to: fakeAppGateway.appendingPathComponent("modules/run-qq-only.command"), atomically: true, encoding: .utf8)
        try "#!/bin/zsh\n".write(to: fakeAppGateway.appendingPathComponent("modules/run-qq-runtime.command"), atomically: true, encoding: .utf8)
        try """
        WORKBUDDY_QQ_OWNER_QQ_ID=100000001
        WORKBUDDY_QQ_BOT_QQ_ID=100000002
        WORKBUDDY_QQ_PORT=13799
        WORKBUDDY_QQ_HA_ENABLED=1
        """.write(to: envFile, atomically: true, encoding: .utf8)

        let fakeExecs = ["node", "python", "codebuddy", "colima", "docker"].map { name -> String in
            let url = binDir.appendingPathComponent(name)
            try? "#!/bin/sh\nexit 0\n".write(to: url, atomically: true, encoding: .utf8)
            try? fm.setAttributes([.posixPermissions: 0o755], ofItemAtPath: url.path)
            return url.path
        }

        let manager = LaunchAgentManager(fileManager: fm, homeDirectory: fakeHome, launchAgentsDirectory: launchAgentsDir)
        try await manager.installStandaloneAgents(
            runnerExecutable: fakeExecs[0],
            projectDirectory: fakeAppGateway,
            runtimeDirectory: runtimeDir,
            dataDirectory: dataDir,
            envFileURL: envFile,
            pythonExecutable: fakeExecs[1],
            codebuddyCLIPath: fakeExecs[2],
            colimaExecutable: fakeExecs[3],
            dockerExecutable: fakeExecs[4]
        )

        let plistData = try Data(contentsOf: manager.hubPlistURL)
        let plist = try #require(PropertyListSerialization.propertyList(from: plistData, format: nil) as? [String: Any])
        let envVars = try #require(plist["EnvironmentVariables"] as? [String: String])
        #expect(envVars["WORKBUDDY_QQ_ENV_FILE"] == envFile.path)
        #expect(envVars["WORKBUDDY_QQ_WB_PYTHON"] == fakeExecs[1])
        #expect(envVars["WB_AGENT_CLI"] == fakeExecs[2])
        #expect(envVars["WORKBUDDY_QQ_WORKSPACE_DIR"] == runtimeDir.appendingPathComponent("workspace").path)
        #expect(envVars["WORKBUDDY_QQ_COLIMA_PATH"] == fakeExecs[3])
        #expect(envVars["WORKBUDDY_QQ_DOCKER_PATH"] == fakeExecs[4])
        #expect(envVars["WORKBUDDY_QQ_HA_ENABLED"] == nil)

        let detector = DeploymentDetector(
            fileManager: fm,
            homeDirectory: fakeHome,
            launchAgentsDirectory: launchAgentsDir,
            keychain: KeychainStore(serviceName: "TestStandalone-\(UUID().uuidString)"),
            bundleResourceURL: nil,
            candidateProjectDirectories: []
        )
        let mode = await detector.detect(probeContainers: false)
        if case .existingTakeover(let existing) = mode {
            #expect(existing.isStandaloneInstall == true)
            #expect(existing.runtimeDirectory == runtimeDir)
            #expect(existing.envFileURL == envFile)
            #expect(existing.dataDirectory == dataDir)
            #expect(existing.hubPort == 13799)
        } else {
            Issue.record("Expected standalone DeploymentDetector result")
        }
    }

    @Test("ShellRunner parses macOS system proxy settings cleanly and respects host state")
    func systemProxyEnvironmentParsing() {
        let parsed = ShellRunner.parseSystemProxySettings([
            "HTTPEnable": 1,
            "HTTPProxy": "127.0.0.1",
            "HTTPPort": 7890,
            "HTTPSEnable": 1,
            "HTTPSProxy": "127.0.0.1",
            "HTTPSPort": 7890,
            "SOCKSEnable": 1,
            "SOCKSProxy": "127.0.0.1",
            "SOCKSPort": 7891
        ])
        #expect(parsed["HTTP_PROXY"] == "http://127.0.0.1:7890")
        #expect(parsed["HTTPS_PROXY"] == "http://127.0.0.1:7890")
        #expect(parsed["ALL_PROXY"] == "socks5h://127.0.0.1:7891")
        #expect(parsed["NO_PROXY"] == "127.0.0.1,localhost,::1,.local")

        let disabled = ShellRunner.parseSystemProxySettings(["HTTPEnable": 0, "HTTPProxy": "127.0.0.1", "HTTPPort": 7890])
        #expect(disabled.isEmpty)

        let hostEnv = ShellRunner.systemProxyEnvironment()
        if !hostEnv.isEmpty {
            #expect(hostEnv["NO_PROXY"] != nil)
        }
    }

    @Test("CodeBuddyAuthHelper parses model probe output accurately and skips docs URLs")
    func codeBuddyAuthProbeAndURLFilter() {
        let loggedInOutput = """
        400 model [__probe__] service info not found
        Currently supported models for your account:
          - hy4std
          - deepseek-v4.1-flash
        Please use --model <model_id> to specify a valid model.
        """
        let parsedOK = CodeBuddyAuthHelper.parseAuthProbeOutput(loggedInOutput)
        #expect(parsedOK.loggedIn == true)
        #expect(parsedOK.modelCount == 2)

        let unauthOutput = "Error: Authentication required. Please run /login."
        let parsedFail = CodeBuddyAuthHelper.parseAuthProbeOutput(unauthOutput)
        #expect(parsedFail.loggedIn == false)
        #expect(parsedFail.modelCount == 0)

        let genericErr = CodeBuddyAuthHelper.parseAuthProbeOutput("Usage: codebuddy [options]")
        #expect(genericErr.loggedIn == false)
        #expect(genericErr.modelCount == 0)

        let docsOnly = "Docs: https://copilot.tencent.com/docs/cli\n"
        #expect(CodeBuddyAuthHelper.extractAuthURL(from: docsOnly) == nil)

        let wrappedLoginPTY = """
        \u{1b}[2K\u{1b}[1GBrowser didn't open? Use the url below to sign in:
        \u{1b}[36mhttps://copilot.tencent.com/login?platform=CLI&state=abc123
        def456&version=2.186.0\u{1b}[0m
        Also ignore http://127.0.0.1:61340 and https://copilot.tencent.com/docs/cli
        """
        let cleanText = CodeBuddyAuthHelper.stripANSI(wrappedLoginPTY)
        #expect(!cleanText.contains("\u{1b}[36m"))
        let extracted = CodeBuddyAuthHelper.extractLoginURL(from: wrappedLoginPTY)
        #expect(extracted?.absoluteString == "https://copilot.tencent.com/login?platform=CLI&state=abc123def456&version=2.186.0")
    }

    @Test("OnboardingOrchestrator filters SnowLuma images and merges OneBot config cleanly")
    func imageFilteringAndOneBotConfigMerge() throws {
        let mixed = [
            "other-project-ci:latest",
            "mcr.microsoft.com/devcontainers/javascript-node:1-22-bookworm",
            "snowluma-local:v1.14.15",
            "napcat-qq:latest"
        ]
        let filtered = OnboardingOrchestrator.filterSnowlumaImages(from: mixed)
        #expect(filtered == ["snowluma-local:v1.14.15", "napcat-qq:latest"])

        let existing = """
        {
          "mode": "snapshot",
          "networks": {
            "httpServers": [
              { "name": "http-default", "host": "0.0.0.0", "port": 3000, "accessToken": "old_token" }
            ],
            "httpClients": [
              { "name": "workbuddy-qq-gateway", "url": "http://host.docker.internal:3789/api/onebot/event", "accessToken": "old_token" }
            ],
            "wsServers": [
              { "name": "ws-default", "port": 3001 }
            ]
          },
          "statusCommand": { "enabled": true, "trigger": "#sl" }
        }
        """
        let merged = try OnboardingOrchestrator.buildMergedOneBotConfigJSON(
            existingJSON: existing,
            accessToken: "fresh_secret_token_xyz",
            hubPort: 3789
        )
        let data = try #require(merged.data(using: .utf8))
        let json = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
        let networks = try #require(json["networks"] as? [String: Any])
        let servers = try #require(networks["httpServers"] as? [[String: Any]])
        let clients = try #require(networks["httpClients"] as? [[String: Any]])
        let wsServers = try #require(networks["wsServers"] as? [[String: Any]])

        #expect((servers.first?["accessToken"] as? String) == "fresh_secret_token_xyz")
        #expect((clients.first?["accessToken"] as? String) == "fresh_secret_token_xyz")
        #expect((clients.first?["url"] as? String) == "http://host.docker.internal:3789/api/onebot/event")
        #expect(wsServers.count == 1)
        #expect((json["statusCommand"] as? [String: Any])?["trigger"] as? String == "#sl")
    }

    @Test("QzoneState decodes todayFeeds & bot comments and StorageUsageReport decodes metrics")
    func qzoneTodayAndStorageDecoding() throws {
        let qzoneJSON = """
        {
          "targetType": "group",
          "targetId": "10001",
          "autoPostEnabled": true,
          "autoEngageEnabled": true,
          "todayDate": "2026-11-24",
          "todayFeeds": [
            {
              "id": "100000001:tid_1",
              "uin": "100000001",
              "tid": "tid_1",
              "nickname": "好友A",
              "timeMs": 1795514400000,
              "text": "测试动态",
              "imageCount": 2,
              "likeCount": 5,
              "botLiked": true,
              "isBotPost": false,
              "comments": [
                {
                  "id": "c:1",
                  "uin": "100000002",
                  "nickname": "老代",
                  "content": "我也这么觉得",
                  "timeText": "13:05",
                  "isBot": true
                }
              ]
            }
          ]
        }
        """
        let qzone = try JSONDecoder().decode(QzoneState.self, from: Data(qzoneJSON.utf8))
        #expect(qzone.todayDate == "2026-11-24")
        #expect(qzone.todayFeeds?.count == 1)
        #expect(qzone.todayFeeds?.first?.comments?.first?.isBot == true)
        #expect(qzone.todayFeeds?.first?.comments?.first?.content == "我也这么觉得")

        let storageJSON = """
        {
          "updatedAt": "2026-11-24T12:00:00Z",
          "totalBytes": 1048576,
          "ephemeralBytes": 262144,
          "categories": {
            "media": { "label": "QQ 临时图片/文件", "bytes": 131072 },
            "logs": { "label": "网关运行日志", "bytes": 131072 }
          },
          "policy": {
            "mediaTtlHours": 24,
            "mediaMaxMb": 200,
            "chatQueueTtlHours": 72,
            "chatQueueMaxPerTarget": 120,
            "qzoneRetention": "today-only",
            "logMaxMb": 5
          }
        }
        """
        let storage = try JSONDecoder().decode(StorageUsageReport.self, from: Data(storageJSON.utf8))
        #expect(storage.totalBytes == 1048576)
        #expect(storage.categories.media?.bytes == 131072)
        #expect(storage.policy?.qzoneRetention == "today-only")
    }

    @Test("LaunchAgentManager installs/removes app login plist and UninstallService scans isolated temp tree")
    func appLoginAgentAndUninstallScan() async throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("uninstall-scan-test-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }

        let launchDir = root.appendingPathComponent("Library/LaunchAgents", isDirectory: true)
        let manager = LaunchAgentManager(homeDirectory: root, launchAgentsDirectory: launchDir)
        try await manager.installAppLoginAgent(appBundlePath: "/Applications/WorkBuddyQQGateway.app")
        #expect(manager.isAppLoginAgentInstalled() == true)
        let plistData = try Data(contentsOf: manager.appLoginPlistURL)
        let plistText = String(data: plistData, encoding: .utf8) ?? ""
        #expect(plistText.contains("/usr/bin/open"))
        #expect(plistText.contains("WorkBuddyQQGateway.app"))

        let vmDisk = root.appendingPathComponent(".colima/_lima/_disks/colima-snowluma", isDirectory: true)
        let appSupport = root.appendingPathComponent("Library/Application Support/WorkBuddyQQGateway", isDirectory: true)
        let fakeApp = root.appendingPathComponent("WorkBuddyQQGateway.app", isDirectory: true)
        try FileManager.default.createDirectory(at: vmDisk, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: appSupport, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: fakeApp, withIntermediateDirectories: true)
        try Data(repeating: 0xAA, count: 4096).write(to: vmDisk.appendingPathComponent("diffdisk"))
        try Data(repeating: 0xBB, count: 2048).write(to: appSupport.appendingPathComponent("db.json"))

        let uninstall = UninstallService(homeDirectory: root, appBundleURL: fakeApp, bundleResourceURL: nil)
        let report = await uninstall.scan()
        #expect(report.items.count == 4)
        let vmItem = try #require(report.items.first { $0.id == "vm" })
        let dataItem = try #require(report.items.first { $0.id == "data" })
        #expect(vmItem.bytes >= 4096)
        #expect(dataItem.bytes >= 2048)
    }

    @Test("AgentConfig and ConversationTarget decode group admin role and permission toggles")
    func groupAdminPermissionsDecoding() throws {
        let json = """
        {
          "groupId": "999999",
          "replyEnabled": true,
          "groupName": "测试群",
          "botRole": "admin",
          "isBotGroupAdmin": true,
          "targetType": "group",
          "targetId": "999999",
          "agentConfig": {
            "model": "auto",
            "groupEssenceEnabled": true,
            "groupMuteEnabled": false
          }
        }
        """
        let target = try JSONDecoder().decode(ConversationTarget.self, from: Data(json.utf8))
        #expect(target.botRole == "admin")
        #expect(target.isBotGroupAdmin == true)
        #expect(target.botIsGroupAdmin == true)
        #expect(target.botRoleLabel == "管理员")
        #expect(target.effectiveConfig.groupEssenceEnabled == true)
        #expect(target.effectiveConfig.groupMuteEnabled == false)
    }

    @Test("AvailableFriendCandidate decodes and formats remark and nickname cleanly")
    func availableFriendCandidateFormatting() throws {
        let json = """
        {
          "friends": [
            { "userId": "100000001", "nickname": "原昵称", "remark": "备注名", "displayName": "备注名" },
            { "userId": "100000002", "nickname": "只有昵称", "remark": null, "displayName": "只有昵称" },
            { "userId": "100000003", "nickname": null, "remark": "只有备注", "displayName": "只有备注" },
            { "userId": "100000004" }
          ]
        }
        """
        struct Envelope: Decodable { let friends: [AvailableFriendCandidate] }
        let decoded = try JSONDecoder().decode(Envelope.self, from: Data(json.utf8)).friends
        #expect(decoded.count == 4)
        #expect(decoded[0].resolvedLabel == "备注名（原昵称）")
        #expect(decoded[1].resolvedLabel == "只有昵称")
        #expect(decoded[2].resolvedLabel == "只有备注")
        #expect(decoded[3].resolvedLabel == "QQ 100000004")
    }
}
