#if os(macOS)
import SwiftUI
import AppKit

/// A view of the selected execution device; there is no invented global account.
struct HomeMenu: View {
    @EnvironmentObject private var library: DeviceLibrary
    private var client: HomeClient { library.active }
    let openApplication: () -> Void
    let openPreferences: () -> Void
    @State private var deviceID = ""
    @State private var requestID = UUID()
    private var connectionKey: String { client.id + "|" + client.normalizedBaseURL + "|" + String(describing: client.connectionState) }
    @State private var accounts: [ManagedCodexAccount] = []
    @State private var accountContentHeight: CGFloat = 180
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
            if library.visibleClients.count > 1 {
                Picker("Устройство", selection: Binding(get: { client.id }, set: { id in
                    if let selected = library.visibleClients.first(where: { $0.id == id }) { library.select(selected) }
                })) {
                    ForEach(library.visibleClients) { Text($0.displayName).tag($0.id) }
                }
            }
            if !accounts.isEmpty {
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
                    .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { accountContentHeight = $0 }
            }.frame(height: min(accountContentHeight, 330))
            } else if busy {
                Text("Загружаем аккаунты…").font(.callout).foregroundStyle(.secondary)
            } else if error == nil {
                Text("Подключите аккаунт OpenAI в настройках, чтобы видеть остатки.").font(.callout).foregroundStyle(.secondary)
            }
            if let error { Text(error).font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true) }
            Divider()
            HStack {
                Button("Открыть", action: openApplication)
                Button("Настройки", action: openPreferences)
                Spacer()
                Button { Task { await refresh() } } label: { Image(systemName: "arrow.clockwise") }.accessibilityLabel("Обновить остатки").disabled(busy)
            }
        }.padding(18).frame(width: 350)
        .task(id: connectionKey) {
            accounts = []; error = nil
            while !Task.isCancelled {
                await refresh()
                do { try await Task.sleep(for: .seconds(15)) } catch { break }
            }
        }
    }
    private func refresh() async {
        let source = client, key = connectionKey, token = UUID()
        requestID = token; busy = true
        defer { if requestID == token { busy = false } }
        do {
            let value: HomeDevices = try await source.management("/v1/devices")
            guard !Task.isCancelled, key == connectionKey, requestID == token else { return }
            deviceID = source.health?.nodeId ?? value.devices.first?.id ?? ""
            let query = deviceID.isEmpty ? "" : "?deviceId=" + deviceID
            let result: ManagedCodexAccounts = try await source.management("/v1/accounts" + query)
            guard !Task.isCancelled, key == connectionKey, requestID == token else { return }
            accounts = result.accounts; canManage = result.canManage; error = nil
        } catch {
            guard !Task.isCancelled, key == connectionKey, requestID == token else { return }
            self.error = "Не удалось обновить остатки. Повторим автоматически."
        }
    }
    private func reloadAccounts() async { await refresh() }
}

/// An AppKit status item keeps menu lifetime separate from the SwiftUI scene
/// graph. A second Scene with the same observable Home can otherwise repeatedly
/// rebuild the main menu on macOS 26 while Home publishes connection changes.
@MainActor
final class HomeStatusItem: NSObject, NSPopoverDelegate {
    static let shared = HomeStatusItem()
    private var item: NSStatusItem?
    private let popover = NSPopover()
    private var library: DeviceLibrary?
    private var openApplication: (() -> Void)?
    private var openPreferences: (() -> Void)?

    func configure(library: DeviceLibrary, enabled: Bool, openApplication: @escaping () -> Void, openPreferences: @escaping () -> Void) {
        self.library = library
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
        guard let button = item?.button, let library else { openPreferences?(); return }
        let content = HomeMenu(openApplication: { [weak self] in
            self?.popover.close(); self?.openApplication?(); NSApp.activate(ignoringOtherApps: true)
        }, openPreferences: { [weak self] in
            self?.popover.close(); self?.openPreferences?(); NSApp.activate(ignoringOtherApps: true)
        }).environmentObject(library)
        let controller = NSHostingController(rootView: content)
        controller.sizingOptions = [.preferredContentSize]
        popover.contentViewController = controller
        popover.contentSize = controller.view.fittingSize
        popover.show(relativeTo: button.bounds, of: button, preferredEdge: .minY)
        popover.contentViewController?.view.window?.makeKey()
    }

    func popoverDidClose(_ notification: Notification) { popover.contentViewController = nil }
}

struct HomeStatusItemAppearance: ViewModifier {
    @EnvironmentObject private var library: DeviceLibrary
    private var client: HomeClient { library.active }
    @Environment(\.openWindow) private var openWindow
    @Environment(\.openSettings) private var openSettings
    @AppStorage("openstrudel.showMenuBar") private var enabled = true

    func body(content: Content) -> some View {
        content.onAppear {
            HomeStatusItem.shared.configure(library: library, enabled: enabled,
                openApplication: { openWindow(id: "home") }, openPreferences: { openSettings() })
        }.onChange(of: enabled) { _, value in HomeStatusItem.shared.setEnabled(value) }
    }
}
#endif
