import Foundation

public enum PersonaPortabilityError: LocalizedError, Sendable {
    case invalidFile(String)
    case missingLocalPersonaFiles(String)

    public var errorDescription: String? {
        switch self {
        case .invalidFile(let reason):
            return "人格文件校验失败：\(reason)"
        case .missingLocalPersonaFiles(let path):
            return "未在目录中找到完整的人格文件（core.json 与 examples.json）：\(path)"
        }
    }
}

public struct PersonaPortabilityService: Sendable {
    private nonisolated(unsafe) let fileManager: FileManager

    public init(fileManager: FileManager = .default) {
        self.fileManager = fileManager
    }

    public func validateBundle(_ bundle: PersonaBundle) throws {
        if let format = bundle.format, format != PersonaBundle.expectedFormat {
            throw PersonaPortabilityError.invalidFile("不支持的文件格式 \(format)")
        }
        if let version = bundle.formatVersion, version != PersonaBundle.currentFormatVersion {
            throw PersonaPortabilityError.invalidFile("不支持的格式版本 \(version)")
        }
        let coreName = bundle.core.name.trimmingCharacters(in: .whitespacesAndNewlines)
        if coreName.count < 2 || coreName.count > 40 {
            throw PersonaPortabilityError.invalidFile("人格名称须为 2–40 个字符")
        }
        if let nickname = bundle.ownerStyle?.agentName?.trimmingCharacters(in: .whitespacesAndNewlines),
           !nickname.isEmpty {
            if nickname.count < 2 || nickname.count > 16 || nickname.contains(" ") || nickname.contains("@") {
                throw PersonaPortabilityError.invalidFile("AI 昵称须为 2–16 个字符，且不含空格或 @")
            }
        }
    }

    /// Loads either a `.laodai-persona.json` bundle file OR a directory containing `core.json` & `examples.json`.
    public func loadBundle(from url: URL) throws -> PersonaBundle {
        var isDir: ObjCBool = false
        guard fileManager.fileExists(atPath: url.path, isDirectory: &isDir) else {
            throw PersonaPortabilityError.invalidFile("找不到文件：\(url.path)")
        }
        if isDir.boolValue {
            return try assembleReadOnlyBundle(fromDirectory: url)
        }
        let data = try Data(contentsOf: url)
        let decoder = JSONDecoder()
        if let bundle = try? decoder.decode(PersonaBundle.self, from: data) {
            try validateBundle(bundle)
            return bundle
        }
        // Fallback: allow importing a standalone core.json if examples.json sits next to it.
        if url.lastPathComponent == "core.json" {
            let folder = url.deletingLastPathComponent()
            if fileManager.fileExists(atPath: folder.appendingPathComponent("examples.json").path) {
                return try assembleReadOnlyBundle(fromDirectory: folder)
            }
        }
        throw PersonaPortabilityError.invalidFile("文件内容不是有效的人格备份包（.json / .laodai-persona.json）")
    }

    public func writeBundle(_ bundle: PersonaBundle, to destinationURL: URL) throws {
        try validateBundle(bundle)
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        var data = try encoder.encode(bundle)
        data.append(contentsOf: [0x0A])
        let parent = destinationURL.deletingLastPathComponent()
        try fileManager.createDirectory(at: parent, withIntermediateDirectories: true)
        try data.write(to: destinationURL, options: [.atomic])
        try? fileManager.setAttributes([.posixPermissions: 0o600], ofItemAtPath: destinationURL.path)
    }

    /// Reads an existing deployment or persona folder strictly read-only and builds a portable PersonaBundle.
    public func assembleReadOnlyBundle(fromDirectory directory: URL, dataDirectory: URL? = nil) throws -> PersonaBundle {
        let resolvedPaths = resolveReadOnlyPersonaPaths(directory: directory, dataDirectory: dataDirectory)
        guard let paths = resolvedPaths else {
            throw PersonaPortabilityError.missingLocalPersonaFiles(directory.path)
        }
        let decoder = JSONDecoder()
        let coreData = try Data(contentsOf: paths.coreURL)
        let examplesData = try Data(contentsOf: paths.examplesURL)
        let core = try decoder.decode(PersonaCore.self, from: coreData)
        let examples = try decoder.decode(PersonaExamplesFile.self, from: examplesData)
        var ownerStyle: PersonaOwnerStyle?
        if let ownerURL = paths.ownerStyleURL,
           fileManager.fileExists(atPath: ownerURL.path),
           let ownerData = try? Data(contentsOf: ownerURL) {
            ownerStyle = try? decoder.decode(PersonaOwnerStyle.self, from: ownerData)
        }
        let bundle = PersonaBundle(
            format: PersonaBundle.expectedFormat,
            formatVersion: PersonaBundle.currentFormatVersion,
            exportedAt: ISO8601DateFormatter().string(from: Date()),
            core: core,
            examples: examples,
            ownerStyle: ownerStyle
        )
        try validateBundle(bundle)
        return bundle
    }

    /// Offline write directly into `<dataDir>/persona/` + `persona-owner-style.json` for fresh setup or migration.
    public func writeBundleOffline(_ bundle: PersonaBundle, intoDataDirectory dataDir: URL) throws {
        try validateBundle(bundle)
        let personaDir = dataDir.appendingPathComponent("persona", isDirectory: true)
        try fileManager.createDirectory(at: personaDir, withIntermediateDirectories: true)

        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]

        var coreData = try encoder.encode(bundle.core)
        coreData.append(0x0A)
        let coreURL = personaDir.appendingPathComponent("core.json")
        try coreData.write(to: coreURL, options: [.atomic])
        try? fileManager.setAttributes([.posixPermissions: 0o600], ofItemAtPath: coreURL.path)

        var examplesData = try encoder.encode(bundle.examples)
        examplesData.append(0x0A)
        let examplesURL = personaDir.appendingPathComponent("examples.json")
        try examplesData.write(to: examplesURL, options: [.atomic])
        try? fileManager.setAttributes([.posixPermissions: 0o600], ofItemAtPath: examplesURL.path)

        if let ownerStyle = bundle.ownerStyle {
            var ownerData = try encoder.encode(ownerStyle)
            ownerData.append(0x0A)
            let ownerURL = dataDir.appendingPathComponent("persona-owner-style.json")
            try ownerData.write(to: ownerURL, options: [.atomic])
            try? fileManager.setAttributes([.posixPermissions: 0o600], ofItemAtPath: ownerURL.path)
        }
    }

    private func resolveReadOnlyPersonaPaths(
        directory: URL,
        dataDirectory: URL?
    ) -> (coreURL: URL, examplesURL: URL, ownerStyleURL: URL?)? {
        let ownerCandidate = dataDirectory?.appendingPathComponent("persona-owner-style.json")
            ?? directory.appendingPathComponent("runtime/qq-only-data/persona-owner-style.json")

        let candidates: [(URL, URL)] = [
            (directory.appendingPathComponent("core.json"), directory.appendingPathComponent("examples.json")),
            (directory.appendingPathComponent("runtime/qq-only-data/persona/core.json"),
             directory.appendingPathComponent("runtime/qq-only-data/persona/examples.json")),
            (directory.appendingPathComponent("config/private/persona/core.json"),
             directory.appendingPathComponent("config/private/persona/examples.json")),
            (directory.appendingPathComponent("persona/core.json"),
             directory.appendingPathComponent("persona/examples.json"))
        ]
        if let dataDirectory {
            let importedCore = dataDirectory.appendingPathComponent("persona/core.json")
            let importedExamples = dataDirectory.appendingPathComponent("persona/examples.json")
            if fileManager.fileExists(atPath: importedCore.path),
               fileManager.fileExists(atPath: importedExamples.path) {
                return (importedCore, importedExamples, ownerCandidate)
            }
        }
        for (coreURL, examplesURL) in candidates {
            if fileManager.fileExists(atPath: coreURL.path),
               fileManager.fileExists(atPath: examplesURL.path) {
                return (coreURL, examplesURL, ownerCandidate)
            }
        }
        return nil
    }
}
