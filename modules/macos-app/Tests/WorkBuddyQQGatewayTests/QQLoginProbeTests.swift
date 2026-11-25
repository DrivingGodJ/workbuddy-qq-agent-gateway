import Foundation
import Testing
@testable import WorkBuddyQQGateway

private struct MockCommandRunner: CommandRunning {
    let result: CommandResult

    func run(
        executable: String,
        arguments: [String],
        currentDirectory: URL?,
        extraEnv: [String: String],
        timeoutSeconds: Double?
    ) async throws -> CommandResult {
        result
    }
}

@Suite("QQ Login Probe Tests")
struct QQLoginProbeTests {
    private func makeIsolatedHomeWithDockerBinary() throws -> URL {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("qq-login-probe-test-\(UUID().uuidString)", isDirectory: true)
        let binDir = root.appendingPathComponent(".local/bin", isDirectory: true)
        try FileManager.default.createDirectory(at: binDir, withIntermediateDirectories: true)
        let fakeDocker = binDir.appendingPathComponent("docker")
        try Data("#!/bin/sh\nexit 0\n".utf8).write(to: fakeDocker)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: fakeDocker.path)
        return root
    }

    @Test("inspectQQSavedLoginState detects saved QQ login profile")
    func detectsSavedLoginProfile() async throws {
        let home = try makeIsolatedHomeWithDockerBinary()
        defer { try? FileManager.default.removeItem(at: home) }

        let detector = DeploymentDetector(homeDirectory: home)
        let supervisor = RuntimeSupervisor(
            runner: MockCommandRunner(result: CommandResult(exitCode: 0, stdout: "saved\n", stderr: "")),
            detector: detector
        )

        let probe = await supervisor.inspectQQSavedLoginState()
        #expect(probe == QQContainerLoginProbe(containerRunning: true, hasSavedLoginProfile: true))
    }

    @Test("inspectQQSavedLoginState detects fresh container without saved profile")
    func detectsFreshContainer() async throws {
        let home = try makeIsolatedHomeWithDockerBinary()
        defer { try? FileManager.default.removeItem(at: home) }

        let detector = DeploymentDetector(homeDirectory: home)
        let supervisor = RuntimeSupervisor(
            runner: MockCommandRunner(result: CommandResult(exitCode: 0, stdout: "fresh\n", stderr: "")),
            detector: detector
        )

        let probe = await supervisor.inspectQQSavedLoginState()
        #expect(probe == QQContainerLoginProbe(containerRunning: true, hasSavedLoginProfile: false))
    }

    @Test("inspectQQSavedLoginState reports stopped container when docker exec fails")
    func detectsStoppedContainer() async throws {
        let home = try makeIsolatedHomeWithDockerBinary()
        defer { try? FileManager.default.removeItem(at: home) }

        let detector = DeploymentDetector(homeDirectory: home)
        let supervisor = RuntimeSupervisor(
            runner: MockCommandRunner(result: CommandResult(exitCode: 1, stdout: "", stderr: "Error: container is not running")),
            detector: detector
        )

        let probe = await supervisor.inspectQQSavedLoginState()
        #expect(probe == QQContainerLoginProbe(containerRunning: false, hasSavedLoginProfile: false))
    }
}
