import Foundation

@MainActor
public final class PowerManager {
    private var caffeinateProcess: Process?
    public private(set) var isKeepAwakeActive: Bool = false

    public init() {}

    public func setKeepAwake(_ enabled: Bool) {
        if enabled {
            startKeepAwake()
        } else {
            stopKeepAwake()
        }
    }

    public func startKeepAwake() {
        if let proc = caffeinateProcess, proc.isRunning {
            isKeepAwakeActive = true
            return
        }
        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: "/usr/bin/caffeinate")
        proc.arguments = ["-dims", "-w", String(ProcessInfo.processInfo.processIdentifier)]
        proc.standardInput = FileHandle.nullDevice
        proc.standardOutput = FileHandle.nullDevice
        proc.standardError = FileHandle.nullDevice
        do {
            try proc.run()
            caffeinateProcess = proc
            isKeepAwakeActive = true
        } catch {
            isKeepAwakeActive = false
        }
    }

    public func stopKeepAwake() {
        if let proc = caffeinateProcess, proc.isRunning {
            proc.terminate()
        }
        caffeinateProcess = nil
        isKeepAwakeActive = false
    }

    public func sleepDisplayKeepAwake(gatewayRoot: URL?) {
        startKeepAwake()
        if let gatewayRoot {
            let helper = gatewayRoot.appendingPathComponent("modules/system-control/keep-awake-display-off.command")
            if FileManager.default.isExecutableFile(atPath: helper.path) {
                let proc = Process()
                proc.executableURL = URL(fileURLWithPath: "/bin/zsh")
                proc.arguments = [helper.path]
                proc.standardInput = FileHandle.nullDevice
                proc.standardOutput = FileHandle.nullDevice
                proc.standardError = FileHandle.nullDevice
                try? proc.run()
                return
            }
        }
        let pmset = Process()
        pmset.executableURL = URL(fileURLWithPath: "/usr/bin/pmset")
        pmset.arguments = ["displaysleepnow"]
        try? pmset.run()
    }
}
