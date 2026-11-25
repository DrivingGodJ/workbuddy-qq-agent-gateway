import SwiftUI

struct PermissionsHATab: View {
    @Bindable var appState: AppState

    private let haService = HomeAssistantService()

    @State private var haEnabled: Bool = false
    @State private var haBaseURL: String = ""
    @State private var haUsername: String = ""
    @State private var haPassword: String = ""
    @State private var pendingMfaFlowId: String?
    @State private var mfaCode: String = ""
    @State private var hasStoredToken: Bool = false

    @State private var greetingSpeakerId: String = ""
    @State private var haWeatherCity: String = ""
    @State private var savedWeatherLocation: String = ""
    @State private var haToken: String = ""

    @State private var catalog: HAEntityCatalog?
    @State private var isBusy: Bool = false
    @State private var testingSpeakerId: String?
    @State private var showAdvancedManual: Bool = false
    @State private var statusMessage: String?
    @State private var errorMessage: String?

    var body: some View {
        Form {
            Section("macOS 系统权限") {
                PermissionRow(
                    title: "Apple 日历",
                    status: appState.permissionSummary.calendar,
                    onRequest: {
                        Task {
                            _ = await appState.permissions.requestCalendarAccess()
                            appState.permissionSummary = await appState.permissions.currentSummary()
                        }
                    },
                    onOpenSettings: {
                        appState.permissions.openSystemSettingsPrivacy("calendar")
                    }
                )
                PermissionRow(
                    title: "Apple 提醒事项",
                    status: appState.permissionSummary.reminders,
                    onRequest: {
                        Task {
                            _ = await appState.permissions.requestRemindersAccess()
                            appState.permissionSummary = await appState.permissions.currentSummary()
                        }
                    },
                    onOpenSettings: {
                        appState.permissions.openSystemSettingsPrivacy("reminders")
                    }
                )
                PermissionRow(
                    title: "系统通知",
                    status: appState.permissionSummary.notifications,
                    onRequest: {
                        Task {
                            _ = await appState.permissions.requestNotificationsAccess()
                            appState.permissionSummary = await appState.permissions.currentSummary()
                        }
                    },
                    onOpenSettings: {
                        appState.permissions.openSystemSettingsPrivacy("notifications")
                    }
                )
            }

            Section("Home Assistant") {
                Toggle("启用 Home Assistant 联动", isOn: $haEnabled)

                Text("绑定后，拥有家居权限的会话可以使用网关支持的设备，包括红外、按钮和小爱音箱。")
                    .font(.callout)
                    .foregroundStyle(.secondary)

                TextField("HA 地址 / IP（例如 192.168.1.10:8123）", text: $haBaseURL)
                TextField("HA 账号", text: $haUsername)
                SecureField("HA 密码（仅用于向本机 HA 换取长效令牌，绝不落盘）", text: $haPassword)

                if pendingMfaFlowId != nil {
                    HStack(spacing: 8) {
                        TextField("二步验证码（MFA / TOTP）", text: $mfaCode)
                        Button("提交验证码") {
                            Task { await submitMFAFlow() }
                        }
                        .buttonStyle(.borderedProminent)
                        .disabled(isBusy)
                    }
                }

                HStack(spacing: 10) {
                    if hasStoredToken {
                        StatusPill(text: "已存长效令牌", color: .green)
                    }
                    Spacer()
                    if hasStoredToken || !haToken.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                        Button("刷新设备列表") {
                            Task { await refreshDevicesFromHA() }
                        }
                        .disabled(isBusy)
                    }
                    Button("登录 HA 并获取设备") {
                        Task { await loginAndFetchDevices() }
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(isBusy)
                }
            }

            Section("小爱定时播报") {
                if let catalog {
                    InfoBannerView(
                        message: "共发现 \(catalog.speakers.count + catalog.buttons.count + catalog.otherDeviceCount) 个受支持的实体，其中小爱音箱 \(catalog.speakers.count) 个。",
                        color: .green
                    )
                }
                Picker("定时播报音箱", selection: $greetingSpeakerId) {
                    Text("自动选择可用音箱").tag("")
                    ForEach(catalog?.speakers ?? []) { speaker in
                        Text(speaker.friendlyName).tag(speaker.entityId)
                    }
                    if !greetingSpeakerId.isEmpty, catalog?.speakers.contains(where: { $0.entityId == greetingSpeakerId }) != true {
                        Text(greetingSpeakerId).tag(greetingSpeakerId)
                    }
                }
                Text("这里仅设置定时播报用的音箱。聊天时可以指定任意受支持的小爱音箱。")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                if let speaker = speakerForTest {
                    Button(testingSpeakerId == speaker.entityId ? "发送中…" : "试播") {
                        Task { await testSpeaker(speaker) }
                    }
                    .controlSize(.small)
                    .disabled(testingSpeakerId != nil)
                }
            }

            Section("播报天气（可选）") {
                VStack(alignment: .leading, spacing: 7) {
                    Text("天气城市").font(.callout.weight(.semibold))
                    TextField("天气城市", text: $haWeatherCity, prompt: Text("手动输入城市名，例如江阴"))
                        .labelsHidden()
                        .textFieldStyle(.roundedBorder)
                        .frame(maxWidth: 380)
                    Text("请手动输入城市名。保存时匹配天气位置，留空则不播报天气。")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }

            Section("连接状态与保存") {
                if let readiness = appState.homeAssistantReadiness {
                    StatusPill(text: readiness.speakerReady ? "小爱可用" : readiness.ready ? "Home Assistant 已连接" : "Home Assistant 未连接",
                               color: readiness.ready ? .green : .orange)
                    if let reason = readiness.reason {
                        Text(reason).font(.caption).foregroundStyle(.secondary)
                    }
                }
                DisclosureGroup("高级：手动填写长效令牌", isExpanded: $showAdvancedManual) {
                    SecureField("手动长效 Token（留空则保持钥匙串现有值）", text: $haToken)
                }

                HStack(spacing: 10) {
                    Spacer()
                    Button("仅保存配置") {
                        Task { await saveHomeAssistantConfig(restart: false) }
                    }
                    .disabled(isBusy)

                    Button("保存并重启 Hub 生效") {
                        Task { await saveHomeAssistantConfig(restart: true) }
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(isBusy)
                }
            }

            if let statusMessage {
                InfoBannerView(message: statusMessage)
            }
            if let errorMessage {
                ErrorBannerView(message: errorMessage)
            }
        }
        .formStyle(.grouped)
        .disabled(isBusy)
        .onAppear { loadFromEnv() }
    }

    private var speakerForTest: HAEntityItem? {
        let available = catalog?.speakers.filter { $0.state != "unavailable" } ?? []
        return greetingSpeakerId.isEmpty
            ? available.min { $0.entityId < $1.entityId }
            : available.first { $0.entityId == greetingSpeakerId }
    }

    private func loadFromEnv() {
        let envURL = appState.runtimePaths.envFileURL ?? RuntimeSupervisor.defaultStandalonePaths().envFileURL
        if let envURL {
            let map = appState.detector.parseEnvFile(envURL)
            haEnabled = map["WORKBUDDY_QQ_HA_ENABLED"] == "1"
            haBaseURL = map["WORKBUDDY_QQ_HA_BASE_URL"] ?? ""
            let legacySpeaker = map["WORKBUDDY_QQ_HA_ALLOWED_SPEAKERS"]?.components(separatedBy: ",")
                .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
                .first { !$0.isEmpty }
            greetingSpeakerId = (map["WORKBUDDY_QQ_HA_GREETING_SPEAKER"] ?? legacySpeaker ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            savedWeatherLocation = map["WORKBUDDY_QQ_SPEAKER_WEATHER_LOCATION"] ?? ""
            haWeatherCity = SpeakerWeatherLocation.cityName(in: savedWeatherLocation)
        }
        hasStoredToken = appState.keychain.exists(account: .homeAssistantApiToken)
    }

    private func loginAndFetchDevices() async {
        isBusy = true
        statusMessage = nil
        errorMessage = nil
        pendingMfaFlowId = nil
        defer { isBusy = false }

        do {
            let normalizedURL = try HomeAssistantService.normalizeBaseURL(haBaseURL)
            haBaseURL = normalizedURL.absoluteString
            let outcome = try await haService.login(baseURL: normalizedURL, username: haUsername, password: haPassword)
            switch outcome {
            case .authenticated(let longLivedToken):
                try await applyAuthenticatedToken(longLivedToken, baseURL: normalizedURL)
            case .mfaRequired(let flowId, let message):
                pendingMfaFlowId = flowId
                statusMessage = message
            }
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func submitMFAFlow() async {
        guard let flowId = pendingMfaFlowId else { return }
        isBusy = true
        statusMessage = nil
        errorMessage = nil
        defer { isBusy = false }

        do {
            let normalizedURL = try HomeAssistantService.normalizeBaseURL(haBaseURL)
            haBaseURL = normalizedURL.absoluteString
            let outcome = try await haService.submitMFA(baseURL: normalizedURL, flowId: flowId, code: mfaCode)
            if case .authenticated(let longLivedToken) = outcome {
                try await applyAuthenticatedToken(longLivedToken, baseURL: normalizedURL)
            }
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func applyAuthenticatedToken(_ longLivedToken: String, baseURL: URL) async throws {
        try appState.keychain.write(longLivedToken, account: .homeAssistantApiToken)
        haPassword = ""
        mfaCode = ""
        pendingMfaFlowId = nil
        hasStoredToken = true
        haEnabled = true

        let fetched = try await haService.fetchEntities(baseURL: baseURL, token: longLivedToken)
        catalog = fetched
        statusMessage = "已登录 Home Assistant 并保存令牌。点击「保存并重启 Hub 生效」即可在获授权的会话中使用设备。"
    }

    private func refreshDevicesFromHA() async {
        isBusy = true
        statusMessage = nil
        errorMessage = nil
        defer { isBusy = false }

        do {
            let normalizedURL = try HomeAssistantService.normalizeBaseURL(haBaseURL)
            haBaseURL = normalizedURL.absoluteString
            guard let token = resolveActiveHAToken() else {
                errorMessage = "未找到可用的 Home Assistant 令牌，请使用账号密码登录。"
                return
            }
            let fetched = try await haService.fetchEntities(baseURL: normalizedURL, token: token)
            catalog = fetched
            statusMessage = "设备列表已刷新。"
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func testSpeaker(_ speaker: HAEntityItem) async {
        testingSpeakerId = speaker.entityId
        statusMessage = nil
        errorMessage = nil
        defer { testingSpeakerId = nil }

        do {
            let normalizedURL = try HomeAssistantService.normalizeBaseURL(haBaseURL)
            haBaseURL = normalizedURL.absoluteString
            guard let token = resolveActiveHAToken() else {
                errorMessage = "未找到可用的 Home Assistant 令牌，请先登录 HA。"
                return
            }
            try await haService.testSpeak(
                baseURL: normalizedURL,
                token: token,
                entityId: speaker.entityId,
                text: "你好，\(appState.agentName)已成功连接小爱音箱"
            )
            statusMessage = "已向「\(speaker.friendlyName)」发送试播文本，请听音箱是否播报。"
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func resolveActiveHAToken() -> String? {
        let manual = haToken.trimmingCharacters(in: .whitespacesAndNewlines)
        if !manual.isEmpty { return manual }
        return appState.keychain.read(account: .homeAssistantApiToken)
    }

    private func saveHomeAssistantConfig(restart: Bool) async {
        guard !isBusy else { return }
        statusMessage = nil
        errorMessage = nil
        isBusy = true
        defer { isBusy = false }

        do {
            let trimmedBase = haBaseURL.trimmingCharacters(in: .whitespacesAndNewlines)
            let canonicalBase = haEnabled || !trimmedBase.isEmpty
                ? try HomeAssistantService.normalizeBaseURL(trimmedBase).absoluteString
                : ""
            let weather = try await SpeakerWeatherLocation.resolve(haWeatherCity, keeping: savedWeatherLocation)

            let trimmedToken = haToken.trimmingCharacters(in: .whitespacesAndNewlines)
            if !trimmedToken.isEmpty {
                try appState.keychain.write(trimmedToken, account: .homeAssistantApiToken)
                haToken = ""
                hasStoredToken = true
            }

            if let envURL = appState.runtimePaths.envFileURL ?? RuntimeSupervisor.defaultStandalonePaths().envFileURL {
                var lines = (try? String(contentsOf: envURL, encoding: .utf8))?
                    .split(separator: "\n", omittingEmptySubsequences: false)
                    .map(String.init) ?? []
                if lines.count == 1 && lines[0].isEmpty { lines = [] }
                let updates: [(String, String)] = [
                    ("WORKBUDDY_QQ_HA_ENABLED", haEnabled ? "1" : "0"),
                    ("WORKBUDDY_QQ_HA_BASE_URL", canonicalBase),
                    ("WORKBUDDY_QQ_HA_GREETING_SPEAKER", greetingSpeakerId),
                    ("WORKBUDDY_QQ_SPEAKER_WEATHER_LOCATION", weather)
                ]
                for (key, value) in updates {
                    if let idx = lines.firstIndex(where: { $0.hasPrefix("\(key)=") }) {
                        lines[idx] = "\(key)=\(value)"
                    } else {
                        lines.append("\(key)=\(value)")
                    }
                }
                try FileManager.default.createDirectory(at: envURL.deletingLastPathComponent(), withIntermediateDirectories: true)
                let serialized = lines.joined(separator: "\n") + "\n"
                try serialized.write(to: envURL, atomically: true, encoding: .utf8)
                try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: envURL.path)
            }
            haBaseURL = canonicalBase
            savedWeatherLocation = weather
            haWeatherCity = SpeakerWeatherLocation.cityName(in: weather)
        } catch {
            errorMessage = error.localizedDescription
            return
        }

        guard restart else {
            statusMessage = "配置已保存，重启 Hub 后生效。"
            return
        }
        do {
            try await appState.supervisor.restartHub()
            await appState.refreshNow()
            if !haEnabled {
                statusMessage = "已保存配置并重启 Hub。Home Assistant 联动已关闭。"
            } else if appState.maintenance?.homeAssistant?.speakerReady == true {
                statusMessage = "Home Assistant 已连接，小爱播报可用。"
            } else if appState.maintenance?.homeAssistant?.ready == true {
                statusMessage = "Home Assistant 已连接。"
            } else {
                errorMessage = appState.maintenance?.homeAssistant?.reason ?? "已保存配置，尚未确认 Home Assistant 连接。"
            }
        } catch {
            errorMessage = "配置已保存，但重启 Hub 失败：\(error.localizedDescription)"
        }
    }
}

private struct PermissionRow: View {
    let title: String
    let status: PermissionAuthorizationStatus
    let onRequest: () -> Void
    let onOpenSettings: () -> Void

    var body: some View {
        HStack {
            Text(title)
            Spacer()
            StatusPill(text: status.rawValue, color: status.isGranted ? .green : .orange)
            Button("请求授权", action: onRequest)
                .controlSize(.small)
                .disabled(status.isGranted)
            Button("系统设置", action: onOpenSettings)
                .controlSize(.small)
        }
    }
}
