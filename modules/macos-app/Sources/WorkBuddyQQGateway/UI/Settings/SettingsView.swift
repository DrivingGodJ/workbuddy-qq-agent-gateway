import SwiftUI

enum SettingsTabKind: String, CaseIterable, Identifiable, Hashable {
    case general = "general"
    case accounts = "accounts"
    case persona = "persona"
    case lan = "lan"
    case permissions = "permissions"
    case maintenance = "maintenance"

    var id: String { rawValue }

    var title: String {
        switch self {
        case .general: return "服务与启动"
        case .accounts: return "账号与登录"
        case .persona: return "人格与模型"
        case .lan: return "局域网面板"
        case .permissions: return "智能家居与权限"
        case .maintenance: return "存储、日志与卸载"
        }
    }

    var systemImage: String {
        switch self {
        case .general: return "power"
        case .accounts: return "person.crop.circle.badge.checkmark"
        case .persona: return "theatermasks"
        case .lan: return "wifi.router"
        case .permissions: return "lock.shield"
        case .maintenance: return "internaldrive"
        }
    }
}

struct SettingsView: View {
    @Bindable var appState: AppState
    @State private var selectedTab: SettingsTabKind = .general

    var body: some View {
        NavigationSplitView {
            List(selection: $selectedTab) {
                Section("基础运行") {
                    tabRow(.general)
                    tabRow(.accounts)
                }
                Section("智能与联动") {
                    tabRow(.persona)
                    tabRow(.lan)
                    tabRow(.permissions)
                }
                Section("存储与维护") {
                    tabRow(.maintenance)
                }
            }
            .listStyle(.sidebar)
            .navigationSplitViewColumnWidth(min: 185, ideal: 205, max: 230)
        } detail: {
            detailView
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .onAppear { applyRequestedTab() }
        .onChange(of: appState.settingsRequestedTab) { _, _ in applyRequestedTab() }
    }

    @ViewBuilder
    private func tabRow(_ tab: SettingsTabKind) -> some View {
        Label(tab.title, systemImage: tab.systemImage)
            .tag(tab)
    }

    @ViewBuilder
    private var detailView: some View {
        switch selectedTab {
        case .general:
            GeneralServiceTab(appState: appState)
        case .accounts:
            AccountsLoginTab(appState: appState)
        case .persona:
            PersonaGlobalTab(appState: appState)
        case .lan:
            LanControlTab(appState: appState)
        case .permissions:
            PermissionsHATab(appState: appState)
        case .maintenance:
            MaintenanceDataTab(appState: appState)
        }
    }

    private func applyRequestedTab() {
        if let requested = appState.settingsRequestedTab,
           let tab = SettingsTabKind(rawValue: requested) {
            selectedTab = tab
            appState.settingsRequestedTab = nil
        }
    }
}
