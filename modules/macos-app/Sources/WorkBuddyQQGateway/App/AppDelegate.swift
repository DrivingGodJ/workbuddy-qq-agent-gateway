import AppKit
import Foundation

@MainActor
public final class AppDelegate: NSObject, NSApplicationDelegate {
    public weak var appState: AppState?
    private var shutdownInFlight = false

    public func applicationDidFinishLaunching(_ notification: Notification) {
        // Warn gently if another instance of the exact same bundle is already active
        if let bundleID = Bundle.main.bundleIdentifier {
            let others = NSRunningApplication.runningApplications(withBundleIdentifier: bundleID)
                .filter { $0.processIdentifier != ProcessInfo.processInfo.processIdentifier }
            if let existing = others.first {
                existing.activate()
                appState?.skipServiceShutdownOnNextQuit = true
                NSApp.terminate(nil)
                return
            }
        }
    }

    public func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        // Keep MenuBarExtra alive even when the main window is closed
        false
    }

    public func applicationDidBecomeActive(_ notification: Notification) {
        Task { await appState?.refreshPermissions() }
    }

    public func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if !flag {
            if let openMain = appState?.openMainWindowAction {
                openMain()
            } else {
                for window in NSApp.windows where window.canBecomeMain {
                    window.makeKeyAndOrderFront(nil)
                    break
                }
            }
        }
        NSApp.activate(ignoringOtherApps: true)
        return true
    }

    public func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard let appState else {
            return .terminateNow
        }
        let shouldStopServices = appState.stopAllServicesOnQuit
            && !appState.skipServiceShutdownOnNextQuit
            && !appState.hasPerformedShutdown
        guard shouldStopServices else {
            appState.powerManager.stopKeepAwake()
            return .terminateNow
        }
        if shutdownInFlight {
            return .terminateLater
        }
        shutdownInFlight = true
        Task { @MainActor [weak appState] in
            await appState?.performFullShutdown(stopQQRuntime: true)
            self.shutdownInFlight = false
            NSApp.reply(toApplicationShouldTerminate: true)
        }
        return .terminateLater
    }

    public func applicationWillTerminate(_ notification: Notification) {
        appState?.powerManager.stopKeepAwake()
    }
}
