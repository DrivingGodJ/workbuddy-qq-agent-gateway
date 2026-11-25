import Foundation

struct AppRelease: Equatable, Sendable {
    let version: String
    let pageURL: URL
}

enum AppUpdateCheckResult: Equatable, Sendable {
    case noRelease
    case upToDate
    case available(AppRelease)
}

enum GitHubReleaseChecker {
    private static let repository = "DrivingGodJ/workbuddy-qq-agent-gateway"
    private static let releasePage = URL(string: "https://github.com/\(repository)/releases")!

    static var installedVersion: String {
        Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? ""
    }

    /// The public latest-release link redirects to the tag of the latest published stable release.
    static func check(installedVersion: String = GitHubReleaseChecker.installedVersion) async throws -> AppUpdateCheckResult {
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 8
        config.timeoutIntervalForResource = 12
        config.httpShouldSetCookies = false
        config.urlCredentialStorage = nil
        let session = URLSession(configuration: config)
        defer { session.finishTasksAndInvalidate() }

        var request = URLRequest(url: releasePage.appendingPathComponent("latest"), cachePolicy: .reloadIgnoringLocalCacheData)
        request.httpMethod = "HEAD"
        let (_, response) = try await session.data(for: request)
        guard let response = response as? HTTPURLResponse, (200..<300).contains(response.statusCode),
              let url = response.url else {
            throw URLError(.badServerResponse)
        }
        return try result(for: url, installedVersion: installedVersion)
    }

    static func result(for url: URL, installedVersion: String) throws -> AppUpdateCheckResult {
        let expectedPath = releasePage.pathComponents
        let path = url.pathComponents
        guard url.scheme == "https", url.host?.lowercased() == "github.com",
              path.prefix(expectedPath.count).map({ $0.lowercased() }) == expectedPath.map({ $0.lowercased() }) else {
            throw URLError(.badServerResponse)
        }
        if path.count == expectedPath.count { return .noRelease }

        guard path.count == expectedPath.count + 2, path[expectedPath.count] == "tag",
              let tag = path.last, let remote = versionParts(tag) else { return .noRelease }
        guard let local = versionParts(installedVersion) else { throw URLError(.cannotParseResponse) }
        guard local.lexicographicallyPrecedes(remote) else { return .upToDate }

        let version = remote.map(String.init).joined(separator: ".")
        let releaseURL = releasePage.appendingPathComponent("tag").appendingPathComponent(tag)
        return .available(AppRelease(version: version, pageURL: releaseURL))
    }

    private static func versionParts(_ tag: String) -> [Int]? {
        let version = tag.hasPrefix("v") || tag.hasPrefix("V") ? String(tag.dropFirst()) : tag
        guard version.range(of: #"^[0-9]+\.[0-9]+\.[0-9]+$"#, options: .regularExpression) != nil else { return nil }
        let numbers = version.split(separator: ".").compactMap { Int($0) }
        return numbers.count == 3 ? numbers : nil
    }
}
