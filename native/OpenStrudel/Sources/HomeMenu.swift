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
    @State private var accountContentHeight: CGFloat = 200
    @State private var canManage = false
    @State private var busy = false
    /// Why the chat stayed on its Home when another was chosen here.
    @State private var blocked: String?
    @State private var error: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(spacing: 8) {
                Label(client.displayName, systemImage: client.deviceSymbol)
                    .font(.body.weight(.semibold)).lineLimit(1)
                Spacer(minLength: 8)
                if let checked = accounts.compactMap({ UsageSummary.checked($0.usage) }).max() {
                    Text(UsageSummary.updated(checked)).font(AppTypography.meta).monospacedDigit()
                        .foregroundStyle(AppTheme.secondaryText).lineLimit(1)
                }
                Button { Task { await refresh() } } label: {
                    Image(systemName: "arrow.clockwise").symbolEffect(.rotate, isActive: busy)
                }
                .buttonStyle(.borderless).foregroundStyle(AppTheme.secondaryText)
                .disabled(busy)
                .help(L("Обновить остатки"))
                .accessibilityLabel(busy ? L("Обновляем состояние") : L("Обновить остатки"))
            }
            .frame(minHeight: 20)
            if library.visibleClients.count > 1 {
                Picker(L("Устройство"), selection: Binding(get: { client.id }, set: { id in
                    if let selected = library.visibleClients.first(where: { $0.id == id }), !library.select(selected) { blocked = library.primaryChangeBlocker }
                })) {
                    ForEach(library.visibleClients) { Text($0.displayName).tag($0.id) }
                }
                if let blocked {
                    Text(blocked).font(AppTypography.meta).foregroundStyle(AppTheme.secondaryText)
                        .accessibilityIdentifier("primaryHomeBlocked")
                }
            }
            if !accounts.isEmpty {
                ScrollView {
                    VStack(alignment: .leading, spacing: 24) {
                        ForEach(Array(accounts.enumerated()), id: \.element.id) { index, account in
                            accountView(account, index: index)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { accountContentHeight = $0 }
                }
                .scrollBounceBehavior(.basedOnSize)
                .frame(height: min(accountContentHeight, 440))
            } else if busy {
                Text(L("Загружаем аккаунты…")).foregroundStyle(AppTheme.secondaryText)
            } else if error == nil {
                Text(L("Подключите аккаунт OpenAI в настройках, чтобы видеть остатки.")).foregroundStyle(AppTheme.secondaryText)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if let error {
                Text(L10n.serviceText(error)).font(AppTypography.meta).foregroundStyle(AppTheme.secondaryText)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Divider()
            HStack(spacing: 8) {
                Button(L("Настройки"), action: openPreferences).tint(nil)
                Spacer(minLength: 0)
                Button(L("Open OpenStrudel"), action: openApplication).keyboardShortcut(.defaultAction)
            }
        }
        .labeledContentStyle(PopoverValueStyle())
        .padding(16).frame(width: 320)
        .task(id: connectionKey) {
            accounts = []; error = nil
            while !Task.isCancelled {
                await refresh()
                do { try await Task.sleep(for: .seconds(15)) } catch { break }
            }
        }
    }

    private func accountView(_ account: ManagedCodexAccount, index: Int) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(account.title).fontWeight(.medium).lineLimit(1).textSelection(.enabled)
                    Spacer(minLength: 0)
                    if let status = status(account, index: index) {
                        Text(status).font(AppTypography.meta).foregroundStyle(AppTheme.secondaryText).lineLimit(1)
                    }
                }
                let detail = [account.emailDetail, account.account.connected ? account.account.planLabel : nil].compactMap { $0 }.joined(separator: " · ")
                if !detail.isEmpty {
                    Text(detail).font(AppTypography.meta).foregroundStyle(AppTheme.secondaryText).lineLimit(1)
                }
            }
            if account.account.connected { UsageSummary(usage: account.usage) }
            if account.activeRuns > 0 {
                Text(L("В работе: \(account.activeRuns)")).font(AppTypography.meta).monospacedDigit().foregroundStyle(AppTheme.secondaryText)
            }
            if canManage && index > 0 && account.account.connected {
                Button(L("Использовать первым")) { Task {
                    do {
                        let _: HomeActionResult = try await client.management("/v1/accounts/" + account.id + "/priority?deviceId=" + deviceID, method: "POST", payload: [:])
                        await reloadAccounts()
                    } catch { self.error = error.localizedDescription }
                } }.tint(nil).disabled(busy)
            }
        }
    }

    /// Priority only matters with several accounts; problems always show.
    private func status(_ account: ManagedCodexAccount, index: Int) -> String? {
        if !account.account.connected { return account.account.isUnavailable ? L("Не удалось проверить аккаунт") : L("Нужен вход в OpenAI") }
        guard accounts.count > 1 else { return nil }
        return index == 0 ? L("Первый для новых поручений") : L("Резервный по приоритету")
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
            self.error = L("Не удалось обновить остатки. Повторим автоматически.")
        }
    }
    private func reloadAccounts() async { await refresh() }
}

/// Label and value on one line, the value in secondary, as LabeledContent reads in a grouped Form.
private struct PopoverValueStyle: LabeledContentStyle {
    func makeBody(configuration: Configuration) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            VStack(alignment: .leading, spacing: 2) { configuration.label }
            Spacer(minLength: 8)
            configuration.content.foregroundStyle(AppTheme.secondaryText)
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
        item.button?.setAccessibilityLabel(L("OpenStrudel: аккаунты и остатки"))
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
            .tint(AppTheme.accent)
            .modifier(InterfaceLanguage())
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
