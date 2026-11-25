import SwiftUI

@main
struct WorkBuddyQQGatewayApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @State private var appState = AppState()

    var body: some Scene {
        Window("WorkBuddy QQ Gateway", id: "main") {
            MainSplitView(appState: appState)
                .frame(minWidth: 980, idealWidth: 1240, minHeight: 660, idealHeight: 780)
                .task {
                    appDelegate.appState = appState
                    await appState.bootstrapOnLaunch()
                }
        }
        .commands {
            CommandGroup(replacing: .newItem) {}
        }

        Window("安装与登录向导", id: "onboarding") {
            OnboardingWindow(appState: appState)
                .frame(minWidth: 780, idealWidth: 840, minHeight: 620, idealHeight: 680)
        }
        .windowResizability(.contentSize)

        Settings {
            SettingsView(appState: appState)
                .frame(minWidth: 860, minHeight: 620)
        }

        MenuBarExtra {
            MenuBarStatusView(appState: appState)
        } label: {
            Image(systemName: appState.overallHealth.symbolName)
                .symbolRenderingMode(.palette)
                .foregroundStyle(appState.overallHealth.color)
        }
    }
}
