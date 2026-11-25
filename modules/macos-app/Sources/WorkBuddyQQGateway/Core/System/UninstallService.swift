import AppKit
import Foundation

public struct UninstallScannedItem: Identifiable, Equatable, Sendable {
    public var id: String
    public var title: String
    public var detail: String
    public var bytes: Int64
    public var paths: [String]
}

public struct UninstallScanReport: Equatable, Sendable {
    public var items: [UninstallScannedItem]
    public var totalBytes: Int64
}

public enum UninstallVMMode: String, CaseIterable, Identifiable, Equatable, Sendable {
    case snowlumaOnly = "snowluma_only"
    case entireVM = "entire_vm"
    case keep = "keep"

    public var id: String { rawValue }

    public var title: String {
        switch self {
        case .snowlumaOnly:
            return "仅删除虚拟机内的 SnowLuma 容器、镜像与数据卷（保留虚拟机及其他容器）"
        case .entireVM:
            return "删除整个 Colima(snowluma) 虚拟机磁盘（彻底释放最大空间，同虚拟机内其他容器也会删除）"
        case .keep:
            return "完全保留虚拟机与 SnowLuma 容器"
        }
    }
}

public struct UninstallOptions: Equatable, Sendable {
    public var vmMode: UninstallVMMode = .snowlumaOnly
    public var removeAppData: Bool = true
    public var removeAppAndPreferences: Bool = true
    public var removeKeychain: Bool = true
    public var removeCodeBuddyCLI: Bool = false

    public var removeVM: Bool {
        get { vmMode == .entireVM }
        set { vmMode = newValue ? .entireVM : .keep }
    }

    public init(
        vmMode: UninstallVMMode = .snowlumaOnly,
        removeAppData: Bool = true,
        removeAppAndPreferences: Bool = true,
        removeKeychain: Bool = true,
        removeCodeBuddyCLI: Bool = false
    ) {
        self.vmMode = vmMode
        self.removeAppData = removeAppData
        self.removeAppAndPreferences = removeAppAndPreferences
        self.removeKeychain = removeKeychain
        self.removeCodeBuddyCLI = removeCodeBuddyCLI
    }
}

public final class UninstallService: Sendable {
    private nonisolated(unsafe) let fileManager: FileManager
    private let homeDirectory: URL
    private let appBundleURL: URL
    private let bundleResourceURL: URL?

    public init(
        fileManager: FileManager = .default,
        homeDirectory: URL = FileManager.default.homeDirectoryForCurrentUser,
        appBundleURL: URL = URL(fileURLWithPath: "/Applications/WorkBuddyQQGateway.app"),
        bundleResourceURL: URL? = Bundle.main.resourceURL
    ) {
        self.fileManager = fileManager
        self.homeDirectory = homeDirectory
        self.appBundleURL = appBundleURL
        self.bundleResourceURL = bundleResourceURL
    }

    public func scan() async -> UninstallScanReport {
        let vmPaths = [
            homeDirectory.appendingPathComponent(".colima/_lima/_disks/colima-snowluma"),
            homeDirectory.appendingPathComponent(".colima/_lima/colima-snowluma"),
            homeDirectory.appendingPathComponent(".colima/snowluma")
        ]
        let supportDir = homeDirectory.appendingPathComponent("Library/Application Support/WorkBuddyQQGateway")
        let cacheDir = homeDirectory.appendingPathComponent("Library/Caches/local.workbuddy.qq-agent-gateway")
        let prefsFile = homeDirectory.appendingPathComponent("Library/Preferences/local.workbuddy.qq-agent-gateway.plist")
        let runnerDir = homeDirectory.appendingPathComponent(".workbuddy-qq-gateway")
        let cbBin = homeDirectory.appendingPathComponent(".local/bin/codebuddy")
        let cbHome = homeDirectory.appendingPathComponent(".codebuddy")

        let vmBytes = vmPaths.reduce(Int64(0)) { $0 + Self.measureBytes(at: $1, fileManager: fileManager) }
        let dataBytes = Self.measureBytes(at: supportDir, fileManager: fileManager)
            + Self.measureBytes(at: cacheDir, fileManager: fileManager)
        let appBytes = Self.measureBytes(at: appBundleURL, fileManager: fileManager)
            + Self.measureBytes(at: prefsFile, fileManager: fileManager)
            + Self.measureBytes(at: runnerDir, fileManager: fileManager)
        let cbBytes = Self.measureBytes(at: cbBin, fileManager: fileManager)
            + Self.measureBytes(at: cbHome, fileManager: fileManager)

        let items = [
            UninstallScannedItem(
                id: "vm",
                title: "Colima 虚拟机与 SnowLuma 容器磁盘",
                detail: "包含 QQ 容器及 10GB+ 虚拟磁盘，卸载后空间会立即释放（个人导出备份不受影响）。",
                bytes: vmBytes,
                paths: vmPaths.map(\.path)
            ),
            UninstallScannedItem(
                id: "data",
                title: "应用运行数据、Python SDK 环境与临时缓存",
                detail: "包含 Application Support 下的对话索引、表情库、日志与 venv。",
                bytes: dataBytes,
                paths: [supportDir.path, cacheDir.path]
            ),
            UninstallScannedItem(
                id: "app",
                title: "主应用程序、开机启动项与钥匙串凭据",
                detail: "移除 /Applications/WorkBuddyQQGateway.app、LaunchAgents 与钥匙串令牌。",
                bytes: appBytes,
                paths: [appBundleURL.path, prefsFile.path, runnerDir.path]
            ),
            UninstallScannedItem(
                id: "codebuddy",
                title: "CodeBuddy 独立 CLI 与登录态（可选）",
                detail: "若本机还要单独使用 CodeBuddy / WorkBuddy CLI，请勿勾选此项。",
                bytes: cbBytes,
                paths: [cbBin.path, cbHome.path]
            )
        ]

        let total = items.reduce(Int64(0)) { $0 + $1.bytes }
        return UninstallScanReport(items: items, totalBytes: total)
    }

    public func locateBundledUninstallScript() -> URL? {
        if let bundled = bundleResourceURL?.appendingPathComponent("uninstall.command"),
           fileManager.isExecutableFile(atPath: bundled.path) {
            return bundled
        }
        let repoFallback = URL(fileURLWithPath: fileManager.currentDirectoryPath)
            .appendingPathComponent("modules/macos-app/Scripts/uninstall.command")
        if fileManager.isExecutableFile(atPath: repoFallback.path) {
            return repoFallback
        }
        return nil
    }

    public static func buildScriptArguments(for options: UninstallOptions) -> [String] {
        var args = ["--yes", "--delay", "2"]
        switch options.vmMode {
        case .entireVM:
            args.append("--remove-vm")
        case .snowlumaOnly:
            args.append(contentsOf: ["--keep-vm", "--remove-snowluma-only"])
        case .keep:
            args.append(contentsOf: ["--keep-vm", "--keep-snowluma"])
        }
        args.append(options.removeAppData ? "--remove-app-data" : "--keep-app-data")
        args.append(options.removeAppAndPreferences ? "--remove-app" : "--keep-app")
        args.append(options.removeKeychain ? "--remove-keychain" : "--keep-keychain")
        args.append(options.removeCodeBuddyCLI ? "--remove-codebuddy" : "--keep-codebuddy")
        return args
    }

    @MainActor
    public func launchDetachedUninstall(options: UninstallOptions, appState: AppState) throws {
        guard let sourceScript = locateBundledUninstallScript() else {
            throw NSError(domain: "UninstallService", code: 1, userInfo: [
                NSLocalizedDescriptionKey: "未找到卸载脚本 uninstall.command，请从安装包 .dmg 根目录直接双击「卸载 WorkBuddy QQ Gateway.command」。"
            ])
        }

        let stamp = Int(Date().timeIntervalSince1970)
        let stagedScript = URL(fileURLWithPath: "/tmp/workbuddy-qq-uninstall-\(stamp).command")
        let wrapperScript = URL(fileURLWithPath: "/tmp/workbuddy-qq-run-uninstall-\(stamp).command")
        try? fileManager.removeItem(at: stagedScript)
        try? fileManager.removeItem(at: wrapperScript)
        try fileManager.copyItem(at: sourceScript, to: stagedScript)
        try fileManager.setAttributes([.posixPermissions: 0o700], ofItemAtPath: stagedScript.path)

        let args = Self.buildScriptArguments(for: options)

        let escapedArgs = args.joined(separator: " ")
        let wrapper = """
        #!/bin/zsh
        /bin/zsh "\(stagedScript.path)" \(escapedArgs)
        status=$?
        /bin/rm -f "\(stagedScript.path)" "\(wrapperScript.path)"
        echo ""
        if [ "$status" = "0" ]; then
          echo "按任意键或直接关闭此终端窗口…"
        fi
        """
        try wrapper.write(to: wrapperScript, atomically: true, encoding: .utf8)
        try fileManager.setAttributes([.posixPermissions: 0o700], ofItemAtPath: wrapperScript.path)

        NSWorkspace.shared.open(wrapperScript)

        appState.skipServiceShutdownOnNextQuit = false
        Task { @MainActor in
            await appState.performFullShutdown(stopQQRuntime: options.vmMode == .entireVM)
            NSApp.terminate(nil)
        }
    }

    public static func measureBytes(at url: URL, fileManager: FileManager = .default) -> Int64 {
        var isDir: ObjCBool = false
        guard fileManager.fileExists(atPath: url.path, isDirectory: &isDir) else {
            return 0
        }
        if !isDir.boolValue {
            let attrs = try? fileManager.attributesOfItem(atPath: url.path)
            return (attrs?[.size] as? NSNumber)?.int64Value ?? 0
        }
        guard let enumerator = fileManager.enumerator(
            at: url,
            includingPropertiesForKeys: [.isSymbolicLinkKey, .isRegularFileKey, .totalFileAllocatedSizeKey, .fileSizeKey],
            options: [.skipsHiddenFiles.intersection([])]
        ) else {
            return 0
        }
        var total: Int64 = 0
        for case let fileURL as URL in enumerator {
            guard let vals = try? fileURL.resourceValues(forKeys: [.isSymbolicLinkKey, .isRegularFileKey, .totalFileAllocatedSizeKey, .fileSizeKey]) else {
                continue
            }
            if vals.isSymbolicLink == true {
                enumerator.skipDescendants()
                continue
            }
            if vals.isRegularFile == true {
                total += Int64(vals.totalFileAllocatedSize ?? vals.fileSize ?? 0)
            }
        }
        return total
    }

    public static func formatByteCount(_ bytes: Int64) -> String {
        let formatter = ByteCountFormatter()
        formatter.allowedUnits = [.useKB, .useMB, .useGB]
        formatter.countStyle = .file
        return formatter.string(fromByteCount: max(0, bytes))
    }
}
