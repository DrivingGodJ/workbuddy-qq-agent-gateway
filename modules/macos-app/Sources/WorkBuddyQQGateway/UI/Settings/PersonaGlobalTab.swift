import AppKit
import SwiftUI

struct PersonaGlobalTab: View {
    @Bindable var appState: AppState

    @State private var nameInput: String = ""
    @State private var catchphrases: [PersonaCatchphrase] = []
    @State private var stickerLabelModel: String = "hy3"
    @State private var showPreview = false

    @State private var pendingImport: (url: URL, bundle: PersonaBundle)?
    @State private var showImportConfirm = false

    @State private var isSaving = false
    @State private var statusMessage: String?
    @State private var errorMessage: String?

    private var persona: PersonaPublicState? {
        appState.gatewayState?.persona
    }

    var body: some View {
        Form {
            Section("人格备份导入与导出") {
                LabeledContent("当前人格来源") {
                    HStack(spacing: 8) {
                        Text(persona?.source ?? "未知")
                            .font(.callout)
                        StatusPill(
                            text: persona?.isImported == true ? "已导入自定义人格" : "基础配置",
                            color: persona?.isImported == true ? .blue : .secondary
                        )
                    }
                }

                Text("导出的 .laodai-persona.json 文件包含完整人格设定（核心规则、情境示例、昵称与口头禅），更新版本、换机或卸载重装前可随时导出保存。")
                    .font(.caption)
                    .foregroundStyle(.secondary)

                HStack(spacing: 10) {
                    Button {
                        Task { await appState.exportPersonaToPanel() }
                    } label: {
                        Label("导出人格到文件…", systemImage: "square.and.arrow.up")
                    }

                    Button {
                        if let picked = appState.pickPersonaBundleForImport() {
                            pendingImport = picked
                            showImportConfirm = true
                        }
                    } label: {
                        Label("从文件导入人格…", systemImage: "square.and.arrow.down")
                    }

                    if persona?.isImported == true {
                        Button("恢复默认人格", role: .destructive) {
                            Task { await appState.resetImportedPersona() }
                        }
                    }

                    Spacer()

                    Button("在 Finder 中打开") {
                        openPersonaFolderInFinder()
                    }
                    .controlSize(.small)
                }
            }

            Section("AI 昵称（所有会话共用）") {
                HStack {
                    TextField("2–16 个字符，不含空格和 @", text: $nameInput)
                    Button("保存昵称") {
                        Task { await saveName() }
                    }
                    .disabled(isSaving || nameInput.trimmingCharacters(in: .whitespaces).isEmpty)
                }
            }

            Section("固定口头禅 (\(catchphrases.count) / 20)") {
                ForEach(catchphrases.indices, id: \.self) { index in
                    HStack(spacing: 8) {
                        TextField("短句", text: $catchphrases[index].text)
                            .frame(width: 140)
                        TextField("适用场景", text: $catchphrases[index].when)
                        Button(role: .destructive) {
                            catchphrases.remove(at: index)
                        } label: {
                            Image(systemName: "trash")
                        }
                        .buttonStyle(.borderless)
                    }
                }

                HStack {
                    Button {
                        if catchphrases.count < 20 {
                            catchphrases.append(PersonaCatchphrase(text: "", when: ""))
                        }
                    } label: {
                        Label("添加口头禅", systemImage: "plus")
                    }
                    .disabled(catchphrases.count >= 20)
                    Spacer()
                    Button("保存口头禅") {
                        Task { await saveCatchphrases() }
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(isSaving)
                }
            }

            Section("临时任务共用模型（表情识图与每日筛选）") {
                HStack {
                    Picker("共用模型", selection: $stickerLabelModel) {
                        ForEach(appState.gatewayState?.ai?.availableModels ?? []) { item in
                            Text(item.displayName ?? item.model).tag(item.model)
                        }
                    }
                    Button("保存共用模型") {
                        Task { await saveStickerLabelModel() }
                    }
                    .disabled(isSaving)
                }

                DisclosureGroup("查看完整共用人格提示词预览", isExpanded: $showPreview) {
                    ScrollView {
                        Text(persona?.promptPreview ?? "—")
                            .font(.caption.monospaced())
                            .textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(6)
                    }
                    .frame(minHeight: 140, maxHeight: 240)
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
        .onAppear { syncFromState() }
        .onChange(of: appState.gatewayState?.persona) { _, _ in syncFromState() }
        .confirmationDialog(
            "确认导入人格「\(pendingImport?.bundle.effectiveName ?? "")」？",
            isPresented: $showImportConfirm,
            titleVisibility: .visible
        ) {
            Button("确认导入并覆盖当前人格") {
                if let bundle = pendingImport?.bundle {
                    Task { _ = await appState.importPersonaBundle(bundle) }
                }
                pendingImport = nil
            }
            Button("取消", role: .cancel) {
                pendingImport = nil
            }
        } message: {
            if let bundle = pendingImport?.bundle {
                Text("来源：\(bundle.core.source ?? "人工设定")\n情境示例：\(bundle.examples.examples.count) 条 · 口头禅：\(bundle.effectiveCatchphrases.count) 条\n导入后立即写入数据目录，下一轮对话生效。")
            }
        }
    }

    private func syncFromState() {
        nameInput = appState.agentName
        catchphrases = persona?.catchphrases ?? []
        stickerLabelModel = appState.gatewayState?.qq?.stickers?.labeling?.model ?? "hy3"
    }

    private func openPersonaFolderInFinder() {
        if let dir = appState.maintenance?.storage?.personaDir {
            NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: dir)])
            return
        }
        let importedDir = appState.runtimePaths.dataDir.appendingPathComponent("persona")
        if FileManager.default.fileExists(atPath: importedDir.path) {
            NSWorkspace.shared.activateFileViewerSelecting([importedDir])
        } else {
            NSWorkspace.shared.activateFileViewerSelecting([appState.runtimePaths.gatewayRoot.appendingPathComponent("persona")])
        }
    }

    private func saveName() async {
        isSaving = true
        statusMessage = nil
        errorMessage = nil
        defer { isSaving = false }
        do {
            let res = try await appState.apiClient.updatePersonaName(nameInput.trimmingCharacters(in: .whitespacesAndNewlines))
            appState.gatewayState?.persona = res.persona
            statusMessage = "AI 昵称已更新为「\(res.name)」。"
            await appState.refreshNow()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func saveCatchphrases() async {
        isSaving = true
        statusMessage = nil
        errorMessage = nil
        defer { isSaving = false }
        do {
            let cleaned = catchphrases.map {
                PersonaCatchphrase(
                    text: $0.text.trimmingCharacters(in: .whitespacesAndNewlines),
                    when: $0.when.trimmingCharacters(in: .whitespacesAndNewlines)
                )
            }
            let res = try await appState.apiClient.updatePersonaCatchphrases(cleaned)
            appState.gatewayState?.persona = res.persona
            statusMessage = "已保存 \(res.entries.count) 条固定口头禅。"
            await appState.refreshNow()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func saveStickerLabelModel() async {
        isSaving = true
        statusMessage = nil
        errorMessage = nil
        defer { isSaving = false }
        do {
            let updated = try await appState.apiClient.updateStickerLabelModel(stickerLabelModel)
            appState.gatewayState?.qq?.stickers?.labeling = updated
            statusMessage = "临时任务共用模型已更新为 \(stickerLabelModel)。"
            await appState.refreshNow()
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}
