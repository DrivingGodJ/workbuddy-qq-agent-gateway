import Foundation

public struct PersonaCatchphrase: Codable, Hashable, Sendable, Identifiable {
    public var id: String { "\(text)::\(when)" }
    public var text: String
    public var when: String

    public init(text: String, when: String) {
        self.text = text
        self.when = when
    }
}

public struct PersonaPublicState: Codable, Sendable, Equatable {
    public var version: Int?
    public var name: String
    public var source: String?
    public var isImported: Bool?
    public var summary: [String]?
    public var exampleCount: Int?
    public var injectedExampleCount: Int?
    public var catchphrases: [PersonaCatchphrase]?
    public var promptPreview: String?

    public init(
        version: Int? = nil,
        name: String = "小伴",
        source: String? = nil,
        isImported: Bool? = nil,
        summary: [String]? = nil,
        exampleCount: Int? = nil,
        injectedExampleCount: Int? = nil,
        catchphrases: [PersonaCatchphrase]? = nil,
        promptPreview: String? = nil
    ) {
        self.version = version
        self.name = name
        self.source = source
        self.isImported = isImported
        self.summary = summary
        self.exampleCount = exampleCount
        self.injectedExampleCount = injectedExampleCount
        self.catchphrases = catchphrases
        self.promptPreview = promptPreview
    }
}

public struct PersonaCore: Codable, Sendable, Equatable {
    public var version: Int?
    public var name: String
    public var source: String?
    public var highPriorityStyle: [String]?
    public var identity: [String]?
    public var speech: [String]?
    public var judgement: [String]?
    public var social: [String]?
    public var actions: [String]?
    public var rhythm: [String]?
    public var subjectivity: [String]?
    public var adaptation: [String]?
    public var catchphrases: [PersonaCatchphrase]?
    public var antiAi: [String]?
    public var interests: [String]?
    public var baseline: [String: Double]?

    public init(
        version: Int? = 1,
        name: String,
        source: String? = nil,
        highPriorityStyle: [String]? = nil,
        identity: [String]? = nil,
        speech: [String]? = nil,
        judgement: [String]? = nil,
        social: [String]? = nil,
        actions: [String]? = nil,
        rhythm: [String]? = nil,
        subjectivity: [String]? = nil,
        adaptation: [String]? = nil,
        catchphrases: [PersonaCatchphrase]? = nil,
        antiAi: [String]? = nil,
        interests: [String]? = nil,
        baseline: [String: Double]? = nil
    ) {
        self.version = version
        self.name = name
        self.source = source
        self.highPriorityStyle = highPriorityStyle
        self.identity = identity
        self.speech = speech
        self.judgement = judgement
        self.social = social
        self.actions = actions
        self.rhythm = rhythm
        self.subjectivity = subjectivity
        self.adaptation = adaptation
        self.catchphrases = catchphrases
        self.antiAi = antiAi
        self.interests = interests
        self.baseline = baseline
    }
}

public struct PersonaExample: Codable, Sendable, Equatable, Identifiable {
    public var id: String?
    public var tags: [String]?
    public var source: String?
    public var situation: String
    public var behavior: String
    public var examples: [String]?
    public var avoid: [String]?

    public init(
        id: String? = nil,
        tags: [String]? = nil,
        source: String? = nil,
        situation: String,
        behavior: String,
        examples: [String]? = nil,
        avoid: [String]? = nil
    ) {
        self.id = id
        self.tags = tags
        self.source = source
        self.situation = situation
        self.behavior = behavior
        self.examples = examples
        self.avoid = avoid
    }
}

public struct PersonaExamplesFile: Codable, Sendable, Equatable {
    public var version: Int?
    public var examples: [PersonaExample]

    public init(version: Int? = 1, examples: [PersonaExample]) {
        self.version = version
        self.examples = examples
    }
}

public struct PersonaOwnerStyle: Codable, Sendable, Equatable {
    public var agentName: String?
    public var activeCatchphrases: [PersonaCatchphrase]?

    public init(agentName: String? = nil, activeCatchphrases: [PersonaCatchphrase]? = nil) {
        self.agentName = agentName
        self.activeCatchphrases = activeCatchphrases
    }
}

public struct PersonaBundle: Codable, Sendable, Equatable {
    public static let expectedFormat = "workbuddy-qq-persona"
    public static let currentFormatVersion = 1

    public var format: String?
    public var formatVersion: Int?
    public var exportedAt: String?
    public var core: PersonaCore
    public var examples: PersonaExamplesFile
    public var ownerStyle: PersonaOwnerStyle?

    public init(
        format: String? = PersonaBundle.expectedFormat,
        formatVersion: Int? = PersonaBundle.currentFormatVersion,
        exportedAt: String? = ISO8601DateFormatter().string(from: Date()),
        core: PersonaCore,
        examples: PersonaExamplesFile,
        ownerStyle: PersonaOwnerStyle? = nil
    ) {
        self.format = format
        self.formatVersion = formatVersion
        self.exportedAt = exportedAt
        self.core = core
        self.examples = examples
        self.ownerStyle = ownerStyle
    }

    public var effectiveName: String {
        if let custom = ownerStyle?.agentName?.trimmingCharacters(in: .whitespacesAndNewlines), !custom.isEmpty {
            return custom
        }
        return core.name
    }

    public var effectiveCatchphrases: [PersonaCatchphrase] {
        ownerStyle?.activeCatchphrases ?? core.catchphrases ?? []
    }
}

public struct PersonaImportResult: Codable, Sendable {
    public var imported: Bool?
    public var reset: Bool?
    public var name: String?
    public var exampleCount: Int?
    public var catchphraseCount: Int?
    public var persona: PersonaPublicState
}

public struct PersonaNameUpdateResponse: Codable, Sendable {
    public var name: String
    public var persona: PersonaPublicState
}

public struct PersonaCatchphrasesUpdateResponse: Codable, Sendable {
    public var entries: [PersonaCatchphrase]
    public var persona: PersonaPublicState
}
