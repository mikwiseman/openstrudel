#if os(macOS)
import SwiftUI
import AppKit

/// A view of the selected execution device; there is no invented global account.
struct HomeMenu: View {
    @EnvironmentObject private var client: HomeClient
    let openApplication: () -> Void
    let openPreferences: () -> Void
    @State private var devices: [HomeDevice] = []
    @State private var deviceID = ""
    @State private var accounts: [ManagedCodexAccount] = []
    @State private var canManage = false
    @State private var busy = false
    @State private var error: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack {
                Text("OpenStrudel").font(.headline)
                Spacer()
                if busy { ProgressView().controlSize(.small).accessibilityLabel("Обновляем состояние") }
            }
            Label(client.displayName, systemImage: "desktopcomputer").font(.callout)
            if devices.count > 1 {
                Picker("Устройство", selection: $deviceID) {
                    ForEach(devices) { Text($0.name).tag($0.id) }
                }.onChange(of: deviceID) { _, _ in Task { await reloadAccounts() } }
            }
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    ForEach(Array(accounts.enumerated()), id: \.element.id) { index, account in
                        VStack(alignment: .leading, spacing: 6) {
                            Text(account.account.email ?? account.name).font(.callout.weight(.medium)).textSelection(.enabled)
                            Text(account.account.connected ? (index == 0 ? "Первый для новых поручений" : "Резервный по приоритету") : "Нужен вход в OpenAI")
                                .font(.caption).foregroundStyle(.secondary)
                            UsageSummary(usage: account.usage)
                            if account.activeRuns > 0 { Text("В работе: \(account.activeRuns)").font(.caption) }
                            if canManage && index > 0 && account.account.connected {
                                Button("Использовать первым") { Task {
                                    do {
                                        let _: HomeActionResult = try await client.management("/v1/accounts/" + account.id + "/priority?deviceId=" + deviceID, method: "POST", payload: [:])
                                        await reloadAccounts()
                                    } catch { self.error = error.localizedDescription }
                                } }.disabled(busy)
                            }
                        }
                    }
                }.frame(maxWidth: .infinity, alignment: .leading)
            }.frame(maxHeight: 330)
            if let error { Text(error).font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true) }
            Divider()
            HStack {
                Button("Открыть", action: openApplication)
                Button("Настройки", action: openPreferences)
                Spacer()
                Button { Task { await refresh() } } label: { Image(systemName: "arrow.clockwise") }.accessibilityLabel("Обновить остатки").disabled(busy)
            }
        }.padding(18).frame(width: 350)
        .task { await refresh() }
    }
    private func refresh() async {
        do {
            let value: HomeDevices = try await client.management("/v1/devices")
            devices = value.devices
            if !devices.contains(where: { $0.id == deviceID }) { deviceID = client.health?.nodeId ?? value.devices.first?.id ?? "" }
            await reloadAccounts()
        } catch { self.error = "Устройство пока не отвечает. Данные появятся после восстановления связи." }
    }
    private func reloadAccounts() async {
        guard !deviceID.isEmpty else { return }
        let selected = deviceID
        busy = true
        defer { busy = false }
        do {
            let value: ManagedCodexAccounts = try await client.management("/v1/accounts?deviceId=" + selected)
            guard selected == deviceID else { return }
            accounts = value.accounts; canManage = value.canManage; error = nil
        } catch {
            guard selected == deviceID else { return }
            accounts = []; self.error = error.localizedDescription
        }
    }
}

/// An AppKit status item keeps menu lifetime separate from the SwiftUI scene
/// graph. A second Scene with the same observable Home can otherwise repeatedly
/// rebuild the main menu on macOS 26 while Home publishes connection changes.
@MainActor
final class HomeStatusItem: NSObject, NSPopoverDelegate {
    static let shared = HomeStatusItem()
    private var item: NSStatusItem?
    private let popover = NSPopover()
    private var client: HomeClient?
    private var openApplication: (() -> Void)?
    private var openPreferences: (() -> Void)?

    func configure(client: HomeClient, enabled: Bool, openApplication: @escaping () -> Void, openPreferences: @escaping () -> Void) {
        self.client = client
        self.openApplication = openApplication
        self.openPreferences = openPreferences
        setEnabled(enabled)
    }

    func setEnabled(_ enabled: Bool) {
        if !enabled {
            popover.close()
            if let item { NSStatusBar.system.removeStatusItem(item) }
            item = nil
            return
        }
        guard item == nil else { return }
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        item.button?.image = NSImage(named: "MenuStrudel")
        item.button?.setAccessibilityLabel("OpenStrudel: аккаунты и остатки")
        item.button?.toolTip = "OpenStrudel"
        item.button?.target = self
        item.button?.action = #selector(toggle)
        self.item = item
        popover.behavior = .transient
        popover.delegate = self
    }

    @objc private func toggle() {
        if popover.isShown { popover.close(); return }
        showAccounts()
    }

    func showAccounts() {
        guard let button = item?.button, let client else { openPreferences?(); return }
        let content = HomeMenu(openApplication: { [weak self] in
            self?.popover.close(); self?.openApplication?(); NSApp.activate(ignoringOtherApps: true)
        }, openPreferences: { [weak self] in
            self?.popover.close(); self?.openPreferences?(); NSApp.activate(ignoringOtherApps: true)
        }).environmentObject(client)
        popover.contentViewController = NSHostingController(rootView: content)
        popover.contentSize = NSSize(width: 350, height: 500)
        popover.show(relativeTo: button.bounds, of: button, preferredEdge: .minY)
        popover.contentViewController?.view.window?.makeKey()
    }

    func popoverDidClose(_ notification: Notification) { popover.contentViewController = nil }
}

struct HomeStatusItemAppearance: ViewModifier {
    @EnvironmentObject private var client: HomeClient
    @Environment(\.openWindow) private var openWindow
    @Environment(\.openSettings) private var openSettings
    @AppStorage("openstrudel.showMenuBar") private var enabled = true

    func body(content: Content) -> some View {
        content.onAppear {
            HomeStatusItem.shared.configure(client: client, enabled: enabled,
                openApplication: { openWindow(id: "home") }, openPreferences: { openSettings() })
        }.onChange(of: enabled) { _, value in HomeStatusItem.shared.setEnabled(value) }
    }
}
#endif
