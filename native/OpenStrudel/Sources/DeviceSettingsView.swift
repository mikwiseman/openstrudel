import SwiftUI
#if os(macOS)
import AppKit
#endif

@MainActor struct RenameTarget: Identifiable {
    nonisolated let id = UUID()
    let client: HomeClient
    var profile: EmployeeProfile? = nil
    var name: String { profile?.name ?? client.displayName }
    func save(_ name: String) async throws {
        if let profile { try await client.renameProfile(id: profile.id, name: name) }
        else { try await client.renameDevice(name) }
    }
}

struct NameEditor: View {
    let target: RenameTarget
    @Environment(\.dismiss) private var dismiss
    @State private var name: String
    @State private var saving = false
    @State private var error: String?
    @FocusState private var focused: Bool
    init(target: RenameTarget) { self.target = target; _name = State(initialValue: target.name) }
    private var cleanName: String { name.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var nameLimit: Int { target.profile == nil ? 120 : 80 }

    var body: some View {
        let title = target.profile == nil ? L("Название устройства") : L("Переименовать сотрудника")
        NavigationStack {
            Form {
                Section {
                    TextField(L("Имя"), text: $name)
                        .focused($focused).disabled(saving)
                        .accessibilityIdentifier("renameName")
                        .onSubmit { save() }
                    if let error { Text(error).foregroundStyle(AppTheme.destructive) }
                } header: {
                    #if os(macOS)
                    SheetTitle(title: title)
                    #endif
                }
            }
            .formStyle(.grouped)
            .fittedSheetPage(title)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button(L("Отмена")) { dismiss() }.disabled(saving) }
                ToolbarItem(placement: .confirmationAction) {
                    Button(L("Сохранить")) { save() }
                        .disabled(saving || cleanName.isEmpty || cleanName.count > nameLimit)
                        .accessibilityIdentifier("saveName")
                }
            }
        }
        #if os(macOS)
        .frame(width: 420)
        #endif
        .interactiveDismissDisabled(saving)
        .task { focused = true }
    }

    private func save() {
        guard !saving, !cleanName.isEmpty, cleanName.count <= nameLimit else { return }
        saving = true; error = nil
        Task {
            defer { saving = false }
            do { try await target.save(cleanName); dismiss() }
            catch { self.error = UserFacingError.text(error.localizedDescription) }
        }
    }
}

struct SavedConnectionUnlockButton: View {
    @ObservedObject var client: HomeClient
    var body: some View {
        HStack(spacing: 8) {
            Button(L("Unlock connection")) {
                Task { if await client.unlockSavedConnection() { await client.load(quiet: true) } }
            }
            .disabled(client.isUnlockingConnection)
            .accessibilityIdentifier("unlockSavedConnection")
            if client.isUnlockingConnection { ProgressView().controlSize(.small) }
        }
    }
}

/// The Settings window on the Mac (toolbar tabs) and the settings sheet on iOS (a section menu).
/// Every pane is a grouped Form made of the same rows on both platforms.
struct SettingsView: View {
    enum Section: String, CaseIterable {
        case devices, accounts, connections, backups, application
        /// The iOS section menu keeps these names.
        var title: String {
            switch self { case .devices: L("Устройства"); case .accounts: L("Аккаунты"); case .connections: L("Подключения"); case .backups: L("Копии"); case .application: L("Приложение") }
        }
        /// Mac tab names; the window title follows the selected tab.
        var tabTitle: String { self == .application ? L("Основные") : title }
        var symbol: String {
            switch self {
            case .devices: "laptopcomputer.and.iphone"
            case .accounts: "person.crop.circle"
            case .connections: "link"
            case .backups: "clock.arrow.circlepath"
            case .application: "gearshape"
            }
        }
    }
    /// Other screens open a pane by writing its raw value here and then calling `openSettings`.
    static let tabKey = "openstrudel.settingsTab"

    @EnvironmentObject private var library: DeviceLibrary
    @EnvironmentObject private var client: HomeClient
    @Environment(\.dismiss) private var dismiss
    @AppStorage(SettingsView.tabKey) private var tab: Section = .devices
    @State private var section: Section
    @State private var selectedID = ""
    private let initialSection: Section?
    private let standalone: Bool
    private var selected: HomeClient { library.clients.first { $0.id == selectedID } ?? client }

    init(initialSection: Section? = nil, standalone: Bool = false) {
        self.initialSection = initialSection
        self.standalone = standalone
        _section = State(initialValue: initialSection ?? .devices)
    }

    var body: some View {
        settings
            .modifier(InterfaceLanguage())
            .onAppear {
                selectedID = client.id
                if let initialSection { tab = initialSection }
            }
    }

    #if os(macOS)
    @ViewBuilder private var settings: some View {
        if standalone { tabs }
        else {
            // Presented as a sheet until every entry point opens the Settings window.
            tabs.toolbar { ToolbarItem(placement: .confirmationAction) { Button(L("Готово")) { dismiss() } } }
        }
    }

    private var tabs: some View {
        TabView(selection: $tab) {
            ForEach(Section.allCases, id: \.self) { section in
                Tab(section.tabTitle, systemImage: section.symbol, value: section) {
                    if section == .connections {
                        // The services list is a screen of its own that pushes the catalog, so it needs a stack, not a form row.
                        NavigationStack { ConnectionsView(embedded: true).environmentObject(client) }
                            .frame(width: 600, height: 640)
                    } else {
                        // Keep the device list compact; its sheets size themselves.
                        SettingsPane(minHeight: section == .devices ? 440 : 360) { pane(section) }
                    }
                }
            }
        }
    }
    #else
    private var settings: some View {
        NavigationStack {
            Form {
                SwiftUI.Section {
                    Picker(L("Настройки"), selection: $section) {
                        ForEach(Section.allCases, id: \.self) { Text($0.title) }
                    }
                    .pickerStyle(.menu).labelsHidden()
                    .accessibilityIdentifier("settingsSection")
                }
                pane(section)
            }
            .navigationTitle(L("Настройки"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button(L("Готово")) { dismiss() } } }
        }
    }
    #endif

    @ViewBuilder private func pane(_ section: Section) -> some View {
        switch section {
        case .devices:
            DevicesPane()
        case .accounts:
            DevicePickerSection(title: L("Устройство"), selection: $selectedID)
            DeviceAccountsView().environmentObject(selected).id(selected.id)
            TelegramSetupSection().environmentObject(selected).id("telegram-" + selected.id)
        case .connections:
            // The services the chat's Home uses in the main chat; each employee's own services stay in its details.
            SwiftUI.Section {
                NavigationLink(L("Сервисы и навыки")) { ConnectionsView(embedded: true).environmentObject(client) }
                    .accessibilityIdentifier("openChatConnections")
            } footer: { Text(L("Сервисы и навыки чата на устройстве «\(client.displayName)».")) }
        case .backups:
            DevicePickerSection(title: L("Устройство"), selection: $selectedID)
            SwiftUI.Section(L("Резервная копия сотрудников")) {
                AgentTransferSettings().environmentObject(selected)
            }.id("backup-" + selected.id)
        case .application:
            GeneralPane(selectedID: $selectedID, selected: selected)
        }
    }
}

#if os(macOS)
/// A Settings window pane: a grouped Form 600 wide whose height follows its rows up to 720,
/// so the window fits each tab and scrolls only when a pane is long.
private struct SettingsPane<Content: View>: View {
    /// A compact minimum; longer panes scroll after 720 points.
    var minHeight: CGFloat = 360
    @ViewBuilder let content: Content
    @State private var height: CGFloat = 360

    var body: some View {
        Form { content }
            .formStyle(.grouped)
            .tint(nil)
            // The content already holds the Form's top and bottom margins. The top inset is the
            // toolbar, which the window adds above the pane by itself.
            .onScrollGeometryChange(for: CGFloat.self) { $0.contentSize.height } action: { _, value in
                height = value
            }
            .frame(width: 600, height: min(max(height, minHeight), 720))
    }
}
#endif

/// The first section of a device-scoped pane when several devices are connected.
private struct DevicePickerSection: View {
    @EnvironmentObject private var library: DeviceLibrary
    let title: String
    @Binding var selection: String

    var body: some View {
        if library.visibleClients.count > 1 {
            Section {
                Picker(title, selection: $selection) {
                    ForEach(library.visibleClients) { Text($0.displayName).tag($0.id) }
                }
            }
        }
    }
}

private struct DevicesPane: View {
    @EnvironmentObject private var library: DeviceLibrary
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    #if os(macOS)
    @ObservedObject private var serverSetup = ServerSetupFlow.shared
    #endif
    private enum ConnectionRoute: String, Identifiable {
        case device, server
        var id: String { rawValue }
    }
    @State private var adding: ConnectionRoute?
    @State private var pairing: MacPairing?
    @State private var confirmingPairing: MacPairing?
    @State private var localStarting = false
    @State private var expandedDeviceID: String?
    @State private var removing: HomeClient?
    @State private var renaming: RenameTarget?
    @State private var diagnostics: HomeClient?
    @State private var speech: HomeClient?
    /// Why the chat stayed on its Home when another was chosen.
    @State private var primaryBlocked: String?

    private var actionLayout: AnyLayout {
        dynamicTypeSize.isAccessibilitySize
            ? AnyLayout(VStackLayout(alignment: .leading, spacing: 12))
            : AnyLayout(HStackLayout())
    }

    // A Form gives a modifier on several rows to each row, and duplicate presenters of one sheet
    // dismiss it and Settings with it. So each sheet hangs on exactly one row.
    var body: some View {
        #if os(macOS)
        if let pending = serverSetup.installation {
            Section {
                Button {
                    adding = .server
                } label: {
                    Label {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(pending.target.host)
                            Text(L("Continue server setup")).font(AppTypography.meta).foregroundStyle(AppTheme.secondaryText)
                        }
                    } icon: { Image(systemName: "server.rack") }
                }
                .accessibilityIdentifier("continuePendingServer")
                ForgetServerSetupButton(flow: serverSetup)
            }
        }
        #endif
        if library.visibleClients.count > 1 {
            // The chat is one Home's assistant; the others are read in Переписки. Moving it waits for the chat to be free.
            Section {
                Picker(L("Чат ведёт"), selection: Binding(get: { library.primary.id }, set: { id in
                    if let target = library.visibleClients.first(where: { $0.id == id }), !library.changePrimary(to: target) { primaryBlocked = library.primaryChangeBlocker }
                })) {
                    ForEach(library.visibleClients) { Text($0.displayName).tag($0.id) }
                }
                .accessibilityIdentifier("primaryHome")
            } footer: {
                Text(L("Чат — помощник этого устройства. Переписки остальных устройств читаются из чата."))
            }
            .alert(L("Чат занят"), isPresented: Binding(get: { primaryBlocked != nil }, set: { if !$0 { primaryBlocked = nil } })) {
                Button(L("Понятно"), role: .cancel) {}
            } message: { Text(primaryBlocked ?? "") }
        }
        Section(L("Подключённые устройства")) {
            ForEach(library.visibleClients) { device in
                DisclosureGroup(isExpanded: Binding(
                    get: { expandedDeviceID == device.id },
                    set: { expandedDeviceID = $0 ? device.id : nil }
                )) {
                    actionLayout {
                        Button(L("Проверить связь"), systemImage: "arrow.clockwise") { Task { await device.load() } }
                            .disabled(device.isLoading || !device.isConfigured)
                            .accessibilityIdentifier("reconnectDevice")
                        if !dynamicTypeSize.isAccessibilitySize { Spacer() }
                        Button(L("Диагностика…"), systemImage: "waveform.path.ecg") { diagnostics = device }
                            .accessibilityIdentifier("deviceDiagnostics")
                    }
                    .sheet(item: Binding(get: { diagnostics === device ? diagnostics : nil }, set: { diagnostics = $0 })) { DiagnosticsView(client: $0) }
                    if device.health?.speechVersion == 1 {
                        Button(L("Голос и распознавание…"), systemImage: "waveform") { speech = device }
                            .accessibilityIdentifier("deviceSpeechSettings")
                            .sheet(item: Binding(get: { speech === device ? speech : nil }, set: { speech = $0 })) { selected in
                                DeviceSpeechSettings(client: selected)
                            }
                    }
                    // An action that cannot run would look tappable in this list, so it appears only when it can.
                    if device.canRenameDevice {
                        HStack {
                            Button(L("Переименовать…"), systemImage: "pencil") { renaming = RenameTarget(client: device) }
                                .accessibilityIdentifier("renameDevice")
                            Spacer()
                        }
                    }
                    if device.health != nil, device.health?.deviceRenameVersion != 1, device.canManageOpenAI || device.canManageConnections {
                        Text(L("Обновите OpenStrudel на этом устройстве, чтобы переименовать его."))
                            .font(AppTypography.meta).foregroundStyle(AppTheme.secondaryText)
                    }
                    if device.connectionNeedsUnlock {
                        LabeledContent {
                            SavedConnectionUnlockButton(client: device)
                        } label: {
                            Text(L("Unlock the saved connection to continue. Your chats and drafts are safe."))
                        }
                    } else {
                        MobilePairingSettings().environmentObject(device)
                    }
                    HStack {
                        Button(L("Убрать подключение…"), role: .destructive) { removing = device }
                        .foregroundStyle(AppTheme.destructive)
                        .accessibilityIdentifier("signOutThisDevice")
                        .accessibilityLabel(L("Убрать подключение к «\(device.displayName)»"))
                        .sheet(item: Binding(get: { removing === device ? removing : nil }, set: { removing = $0 })) { device in
                            DeviceSignOutView { removing = nil }.environmentObject(device).environmentObject(library)
                        }
                        Spacer()
                    }
                } label: {
                    HStack(spacing: 12) {
                        Image(systemName: device.deviceSymbol)
                            .font(.system(size: 21, weight: .regular))
                            .foregroundStyle(AppTheme.secondaryText)
                            .frame(width: 36, height: 36)
                        VStack(alignment: .leading, spacing: 4) {
                            Text(device.displayName).fontWeight(.medium)
                            HStack(spacing: 5) {
                                Circle().fill(device.connectionState == .connected ? Color.green : device.homeUnreachable || device.connectionNeedsPairing ? Color.orange : Color.secondary)
                                    .frame(width: 6, height: 6).accessibilityHidden(true)
                                Text(status(device)).font(AppTypography.meta).foregroundStyle(AppTheme.secondaryText)
                            }
                        }
                        Spacer(minLength: 12)
                    }
                    .padding(.vertical, 5)
                    .accessibilityIdentifier("deviceDetails")
                    .sheet(item: Binding(get: { renaming?.client === device ? renaming : nil }, set: { renaming = $0 })) { NameEditor(target: $0) }
                }
                .disclosureGroupStyle(DeviceDisclosureStyle())
                .contextMenu {
                    Button(L("Переименовать…"), systemImage: "pencil") { renaming = RenameTarget(client: device) }
                        .disabled(!device.canRenameDevice)
                }
            }
        }
        Section {
            Button(L("Добавить Mac или сервер…"), systemImage: "plus.circle") { adding = .device }
                .buttonStyle(.plain)
                .accessibilityIdentifier("addDevice")
                .sheet(item: $adding, onDismiss: {
                    if let pairing { confirmingPairing = pairing; self.pairing = nil }
                }) { route in
                    #if os(macOS)
                    ConnectDeviceView(continueServerSetup: route == .server) { pairing = $0 }
                    #else
                    ConnectionInvitationView { pairing = $0 }
                    #endif
                }
                .sheet(item: $confirmingPairing) { AddDeviceConfirmation(pairing: $0).environmentObject(library) }
            HiddenEmployeesButton(prominent: true)
            #if os(macOS)
            if !library.visibleClients.contains(where: \.isLocalConnection), LocalHome.isAvailable {
                Button(localStarting ? L("Запускаем этот Mac…") : L("Работать также на этом Mac"), systemImage: "laptopcomputer") {
                    localStarting = true
                    Task { await library.openLocal(); localStarting = false }
                }.buttonStyle(.plain).disabled(localStarting)
            }
            #endif
        } footer: {
            Text(L("Сотрудники работают там, где вы их создали. Здесь можно подключить ещё один Mac или сервер."))
        }
    }

    private func status(_ device: HomeClient) -> String {
        let state = device.connectionNeedsUnlock ? L("Unlock connection")
            : device.connectionNeedsPairing ? L("Подключите устройство снова")
            : device.isConnecting ? L("Подключаемся…")
            : device.homeUnreachable || device.health == nil ? L("Нет связи · попробуем снова")
            : L("На связи · сотрудников: \(device.profiles.count)")
        return library.addressDetail(for: device).map { state + " · " + $0 } ?? state
    }
}

private struct DeviceDisclosureStyle: DisclosureGroupStyle {
    func makeBody(configuration: Configuration) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Button { configuration.isExpanded.toggle() } label: {
                HStack(spacing: 12) {
                    configuration.label
                    Image(systemName: configuration.isExpanded ? "chevron.down" : "chevron.right")
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(AppTheme.secondaryText)
                        .frame(width: 16, height: 16)
                        .accessibilityHidden(true)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityValue(configuration.isExpanded ? L("Развёрнуто") : L("Свёрнуто"))
            if configuration.isExpanded {
                #if os(iOS)
                // The whole device is one Form row, and iOS fires every default-style button
                // in a row on one tap. Borderless buttons answer only to their own tap.
                configuration.content.buttonStyle(.borderless)
                #else
                configuration.content
                #endif
            }
        }
    }
}

private struct DeviceSpeechSettings: View {
    let client: HomeClient
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        NavigationStack {
            Form { Section { SpeechSettingsView().environmentObject(client) } header: { Text(client.displayName) } }
                .formStyle(.grouped)
                .navigationTitle(L("Голос и распознавание"))
                .toolbar { ToolbarItem(placement: .confirmationAction) { Button(L("Готово")) { dismiss() } } }
        }
        #if os(macOS)
        .frame(width: 560, height: 480)
        #endif
    }
}

private struct GeneralPane: View {
    @Binding var selectedID: String
    let selected: HomeClient
    #if os(macOS)
    @AppStorage("openstrudel.showMenuBar") private var showMenuBar = true
    #endif
    @State private var relaunch = false
    @State private var cloudSpeech = false

    var body: some View {
        Section {
            Picker(L("Language"), selection: LanguageChoice.binding(relaunch: $relaunch)) {
                ForEach(AppLanguage.allCases) { Text($0.title).tag($0) }
            }
            .accessibilityIdentifier("interfaceLanguage")
            .modifier(LanguageChoice.RelaunchAlert(isPresented: $relaunch))
            #if os(macOS)
            Toggle(L("Показывать в строке меню"), isOn: $showMenuBar).settingsSwitch()
            #endif
        }
        DevicePickerSection(title: L("Сотрудники на устройстве"), selection: $selectedID)
        Section(L("Модель и скорость")) {
            ModelSettingsView().environmentObject(selected)
        }.id("models-" + selected.id)
        ApprovalSettingsView().environmentObject(selected).id("approvals-" + selected.id)
        if selected.health?.speechVersion == 1 {
            Section(L("Голос")) {
                SpeechSettingsView(onLoad: { cloudSpeech = $0.provider == "elevenlabs" },
                                   onProviderChange: { cloudSpeech = $0 == "elevenlabs" }).environmentObject(selected)
            }.id("speech-" + selected.id)
        }
        if !cloudSpeech { DictationSection() }
        #if os(macOS)
        UpdatesSection()
        HostingStoreSettings()
        #endif
        Section {
            InkLink(title: L("Помощь"), destination: URL(string: "https://waiwai.is/openstrudel#help")!)
            InkLink(title: L("Конфиденциальность"), destination: URL(string: "https://waiwai.is/openstrudel/privacy")!)
        }
        #if os(macOS)
        Section {
            LocalDataResetButton()
        } footer: {
            Text(L("Удалить местных сотрудников, переписку и настройки и начать заново."))
        }
        #endif
    }
}

private struct DictationSection: View {
    @ObservedObject private var assets = DictationAssets.shared

    var body: some View {
        Section {
            switch assets.state {
            case .checking:
                LabeledContent(L("Checking the local model…")) { ProgressView().controlSize(.small) }
            case .ready:
                Label {
                    Text(L("Ready for offline dictation"))
                } icon: {
                    Image(systemName: "checkmark.circle.fill").foregroundStyle(AppTheme.accentText)
                }
                .accessibilityIdentifier("dictationReady")
            case .downloading:
                if let progress = assets.progress {
                    ProgressView(value: progress) {
                        Text(progress < 1 ? L("Downloading the model…") : L("Checking the download…"))
                    } currentValueLabel: {
                        Text(progress, format: .percent.precision(.fractionLength(0))).monospacedDigit()
                    }
                } else {
                    ProgressView(L("Preparing the download…"))
                }
                Button(L("Cancel download")) { assets.cancel() }
                    .accessibilityIdentifier("cancelDictationDownload")
            case .available, .failed:
                if let error = assets.error { Text(L10n.serviceText(error)).foregroundStyle(AppTheme.warning) }
                LabeledContent {
                    Button(L("Download model")) { assets.download() }
                        .accessibilityIdentifier("downloadDictationModel")
                } label: {
                    Text(L("Download Parakeet once (740 MB). After that, dictation works offline."))
                }
            }
        } header: {
            Text(L("Dictation"))
        } footer: {
            Text(L("Speak naturally. Your language is recognized automatically, on this device.") + " "
                 + L("25 languages, including English, Russian, French and Spanish. Hebrew is not supported."))
        }
        .task { await assets.check() }
    }
}

#if os(macOS)
private struct UpdatesSection: View {
    @ObservedObject private var updater = AppUpdater.shared
    private var version: String {
        let info = Bundle.main.infoDictionary
        return L("Версия \(info?["CFBundleShortVersionString"] as? String ?? "") (\(info?["CFBundleVersion"] as? String ?? ""))")
    }

    var body: some View {
        Section {
            LabeledContent("OpenStrudel") { Text(version).monospacedDigit().foregroundStyle(AppTheme.secondaryText) }
            Toggle(isOn: Binding(get: { updater.automaticChecksEnabled }, set: { updater.automaticChecksEnabled = $0 })) {
                Text(L("Проверять обновления автоматически"))
                Text(L("Сообщим о новой версии. Установка начнётся только после вашего подтверждения."))
            }
            .settingsSwitch()
            if let failure = updater.startupFailure {
                Text(L10n.serviceText(failure)).foregroundStyle(AppTheme.warning)
            }
            Button(L("Проверить обновления…"), action: updater.checkForUpdates)
                .disabled(!updater.canCheckForUpdates)
                .accessibilityIdentifier("checkForUpdates")
        }
    }
}
#endif

struct AddDeviceConfirmation: View {
    @EnvironmentObject private var library: DeviceLibrary
    @Environment(\.dismiss) private var dismiss
    #if os(macOS)
    @Environment(\.openWindow) private var openWindow
    #endif
    let pairing: MacPairing
    @State private var candidate: HomeClient?
    @State private var busy = false
    @State private var error: String?
    @State private var connected = false

    var body: some View {
        NavigationStack {
            #if os(iOS)
            ScrollView {
                content.frame(maxWidth: .infinity)
            }
            .scrollBounceBehavior(.basedOnSize)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { cancelButton }
            }
            #else
            content
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) { cancelButton }
                    ToolbarItem(placement: .confirmationAction) { continueButton }
                }
            #endif
        }
        .interactiveDismissDisabled(busy)
        #if os(macOS)
        .presentationSizing(.fitted)
        #else
        .presentationSizing(.form)
        #endif
    }

    private var content: some View {
        VStack(spacing: 12) {
            Image(systemName: connected ? "checkmark.circle.fill" : "desktopcomputer")
                .font(.system(size: 48)).foregroundStyle(AppTheme.secondaryText)
                .padding(.bottom, 4)
                .accessibilityHidden(true)
            Text(connected ? L("Устройство подключено") : L("Подключить «\(pairing.name)»?"))
                .font(AppTypography.title)
            Text(connected ? (candidate?.homeUnreachable == true ? L("Подключение сохранено. Ждём ответа устройства — сотрудники появятся, когда оно выйдет на связь.") : L("Сотрудники этого устройства теперь доступны в списке чатов.")) : L("Вы сможете общаться с его сотрудниками и создавать новых. Они продолжат работать на «\(pairing.name)»."))
                .foregroundStyle(AppTheme.secondaryText)
            if busy { ProgressView(L("Проверяем подключение…")).controlSize(.small) }
            if let error {
                Text(L10n.serviceText(error)).foregroundStyle(AppTheme.warning).accessibilityIdentifier("pairingError")
            }
            #if os(iOS)
            continueButton.buttonStyle(.borderedProminent).controlSize(.large)
                .padding(.top, 12)
            #endif
        }
        .multilineTextAlignment(.center)
        .fixedSize(horizontal: false, vertical: true)
        .padding(24)
        #if os(macOS)
        .frame(width: 440)
        #else
        .frame(maxWidth: 440)
        #endif
    }

    private var cancelButton: some View {
        Button(connected ? L("Готово") : L("Отмена")) { dismiss() }.disabled(busy)
            .accessibilityIdentifier("cancelMacPairing")
    }

    private var continueButton: some View {
        Button {
            if connected {
                // The first device becomes the chat; another one joins the readers unless the chat is free to move.
                if let candidate { _ = library.select(candidate) }
                dismiss()
                #if os(macOS)
                openWindow(id: "home")
                #endif
                return
            }
            busy = true; error = nil
            let target = candidate ?? library.connection(for: pairing); candidate = target
            Task {
                if await target.connectToMac(pairing) { library.add(target, select: false); connected = true }
                else { error = target.pairingError }
                busy = false
            }
        } label: {
            Text(connected ? L("Открыть сотрудников") : L("Подключить"))
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
        }
        .disabled(busy)
        .accessibilityIdentifier(connected ? "openDeviceEmployees" : "confirmMacPairing")
    }
}

/// Every account on the selected device, its limits and credits. Emits Form sections.
struct DeviceAccountsView: View {
    @EnvironmentObject private var client: HomeClient
    @Environment(\.openURL) private var openURL
    @Environment(\.dynamicTypeSize) private var textSize
    @State private var deviceID = ""
    @State private var loadedDeviceID: String?
    @State private var accounts: [ManagedCodexAccount] = []
    @State private var loading = true
    @State private var refreshing = false
    @State private var busy = false
    @State private var error: String?
    @State private var canManage = false
    @State private var login: OpenAILogin?
    @State private var loginAccount = ""
    @State private var logout: ManagedCodexAccount?
    @State private var copiedCode = false
    @State private var renaming: ManagedCodexAccount?
    @State private var accountName = ""
    @State private var notice: String?
    @State private var keys: ProviderList?
    @State private var keyProvider: ProviderSummary?
    @State private var removingKey: ProviderSummary?
    /// The subscription being signed in; nil while `login` belongs to a ChatGPT account.
    @State private var loginProvider: ProviderSummary?
    @State private var signingOut: ProviderSummary?
    @State private var requestID = UUID()
    private var query: String { deviceID.isEmpty ? "" : "?deviceId=" + deviceID }
    private var selectedDevice: String? { deviceID.isEmpty ? nil : deviceID }
    private var deviceName: String { deviceID == client.health?.nodeId ? client.displayName : client.devices.first(where: { $0.id == deviceID })?.name ?? client.displayName }
    private func path(_ id: String, _ action: String) -> String { "/v1/accounts/" + id + "/" + action + query }

    var body: some View {
        Group {
            Section {
                if client.devices.count > 1 {
                    Picker(L("Устройство сотрудника"), selection: $deviceID) {
                        ForEach(client.devices) { Text($0.name).tag($0.id) }
                    }.disabled(login != nil || busy)
                }
                if loading && accounts.isEmpty {
                    LabeledContent(L("Загружаем аккаунты и лимиты…")) { ProgressView().controlSize(.small) }
                }
                if let error { Text(L10n.serviceText(error)).foregroundStyle(AppTheme.warning) }
                if let first = accounts.first { accountRows(first, index: 0) }
            } header: {
                Text(L("ChatGPT on \(deviceName)"))
            } footer: {
                if accounts.count > 1 { Text(L("По умолчанию для новых поручений")) }
            }
            ForEach(Array(accounts.enumerated()).dropFirst(), id: \.element.id) { index, account in
                Section { accountRows(account, index: index) }
            }
            // A new account is listed once its sign-in completes; until then the code has its own section.
            if let login, loginProvider == nil, !accounts.contains(where: { $0.id == loginAccount }) {
                Section { loginRows(login) } header: { Text(L("Завершите вход на сайте OpenAI")) }
            }
            let addsAccount = login == nil && canManage && !accounts.isEmpty
            // On the Mac an empty section, as during a sign-in, turns the next section's header into a row.
            if notice != nil || addsAccount || accounts.hasUsage {
                Section {
                    if let notice { Text(notice).foregroundStyle(AppTheme.secondaryText) }
                    if addsAccount {
                        Button(L("Добавить аккаунт OpenAI")) { perform {
                            notice = nil
                            struct Added: Decodable { let id: String }
                            let result: Added = try await client.management("/v1/accounts" + query, method: "POST", payload: ["name": "ChatGPT"])
                            try await signIn(result.id)
                        } }.disabled(busy)
                    }
                    if accounts.hasUsage {
                        HStack {
                            Button(L("Обновить остатки")) {
                                refreshing = true
                                Task { await refresh(force: true); refreshing = false }
                            }.disabled(loading)
                            Spacer()
                            if refreshing { ProgressView().controlSize(.small).accessibilityLabel(L("Обновляем остатки…")) }
                        }
                    }
                } footer: {
                    if accounts.hasUsage {
                        Text((accounts.compactMap({ UsageSummary.checked($0.usage) }).max().map { UsageSummary.updated($0) + "\n" } ?? "")
                             + L("Лимиты относятся к подписке. Кредиты — отдельный баланс аккаунта."))
                    }
                }
            }
            if let keys, keys.canManage {
                let subscriptions = keys.providers.filter(\.isSubscription)
                if client.health?.subscriptionsVersion == 1 && !subscriptions.isEmpty { subscriptionSection(subscriptions) }
                keySection(keys.providers)
            }
        }
        .task(id: deviceID) {
            if deviceID.isEmpty, let localDeviceID = client.health?.nodeId {
                deviceID = localDeviceID
            } else {
                while !Task.isCancelled {
                    if login == nil && !busy { await refresh() }
                    do { try await Task.sleep(for: .seconds(15)) } catch { break }
                }
            }
        }
        .task(id: login?.loginId) {
            copiedCode = false
            guard let current = login else { return }
            while !Task.isCancelled && login?.loginId == current.loginId {
                do {
                    try await Task.sleep(for: .seconds(2))
                    if let provider = loginProvider {
                        let status: OpenAILoginStatus = try await client.subscription(provider.id, "login/" + current.loginId, deviceID: selectedDevice)
                        if status.status == "completed" { await keysChanged(); login = nil; break }
                        // The Home names the reason, such as a plan without Grok Build.
                        if ["failed", "canceled"].contains(status.status) { login = nil; error = status.error ?? L("Вход не завершён. Попробуйте ещё раз.") }
                        continue
                    }
                    let status: OpenAILoginStatus = try await client.management(path(loginAccount, "login/" + current.loginId))
                    if status.status == "completed" {
                        // Clearing login cancels this .task. Finish both refreshes
                        // before changing its identity so their result is applied.
                        await refresh(force: true)
                        await client.refreshOpenAIAccount(force: true)
                        notice = status.alreadyConnected == true ? L("Already connected. Your account has been refreshed.") : L("Account connected.")
                        login = nil
                        break
                    }
                    if ["failed", "canceled"].contains(status.status) { login = nil; error = L("Вход не завершён. Попробуйте ещё раз.") }
                } catch is CancellationError { break }
                catch { self.error = L("Не удалось проверить вход. Повторим, когда появится связь.") }
            }
        }
        .confirmationDialog(L("Выйти из аккаунта OpenAI?"), isPresented: Binding(get: { logout != nil }, set: { if !$0 { logout = nil } })) {
            if let account = logout { Button(L("Выйти"), role: .destructive) { perform {
                let _: HomeActionResult = try await client.management(path(account.id, "logout"), method: "POST")
                logout = nil; await refresh()
            } } }
        } message: { Text(L("Сотрудники и переписка сохранятся. Для новых поручений понадобится вход.")) }
        .alert(L("Rename account"), isPresented: Binding(get: { renaming != nil }, set: { if !$0 { renaming = nil } })) {
            TextField(L("Название аккаунта"), text: $accountName)
                .autocorrectionDisabled()
            Button(L("Отмена"), role: .cancel) { renaming = nil }
            Button(L("Сохранить")) {
                guard let account = renaming else { return }
                let name = accountName.trimmingCharacters(in: .whitespacesAndNewlines)
                perform {
                    let _: HomeActionResult = try await client.management("/v1/accounts/" + account.id + query, method: "POST", payload: ["name": name])
                    renaming = nil
                    await refresh()
                }
            }.disabled(accountName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || accountName.count > 80)
        } message: { Text(L("Choose a name you recognise. Your OpenAI account stays the same.")) }
        .sheet(item: $keyProvider) { provider in
            ProviderKeySheet(provider: provider, deviceName: deviceName) { key in
                try await client.connectProvider(provider.id, key: key, deviceID: deviceID.isEmpty ? nil : deviceID)
                await keysChanged()
            }
        }
        .confirmationDialog(removingKey.map { L("Удалить ключ \($0.name)?") } ?? "", isPresented: Binding(get: { removingKey != nil }, set: { if !$0 { removingKey = nil } }),
                            titleVisibility: .visible, presenting: removingKey) { provider in
            Button(L("Удалить ключ"), role: .destructive) { perform {
                try await client.removeProvider(provider.id, deviceID: deviceID.isEmpty ? nil : deviceID)
                removingKey = nil; await keysChanged()
            } }
        } message: { provider in
            Text(provider.usedBy > 0 ? provider.removalWarning : L("Ключ будет удалён с «\(deviceName)»."))
        }
        .confirmationDialog(signingOut.map { L("Выйти из \($0.name)?") } ?? "", isPresented: Binding(get: { signingOut != nil }, set: { if !$0 { signingOut = nil } }),
                            titleVisibility: .visible, presenting: signingOut) { provider in
            Button(L("Выйти"), role: .destructive) { perform {
                let _: HomeActionResult = try await client.subscription(provider.id, "logout", method: "POST", deviceID: selectedDevice)
                signingOut = nil; await keysChanged()
            } }
        } message: { provider in
            Text(provider.usedBy > 0 ? provider.signOutWarning : L("Вход в \(provider.name) на «\(deviceName)» будет удалён."))
        }
    }

    /// Grok signs in with a device code inside its own agent on the device, which keeps the token.
    @ViewBuilder private func subscriptionSection(_ providers: [ProviderSummary]) -> some View {
        Section {
            ForEach(providers) { provider in
                let signingIn = login != nil && loginProvider?.id == provider.id
                LabeledContent {
                    if provider.connected {
                        Button(L("Выйти…")) { signingOut = provider }
                            .disabled(busy).accessibilityIdentifier("signOutSubscription-" + provider.id)
                    } else if !signingIn {
                        Button(L("Войти")) { perform { try await signIn(provider) } }
                            .disabled(login != nil || busy).accessibilityIdentifier("signInSubscription-" + provider.id)
                    }
                } label: {
                    Text(verbatim: provider.name)
                    if provider.connected { Text(L("Вход выполнен")) }
                }
                if signingIn, let login { loginRows(login, provider: provider) }
            }
        } header: {
            Text(L("Подписки"))
        }
    }

    /// API keys under the ChatGPT accounts: connected ones as rows, the others in Add key.
    @ViewBuilder private func keySection(_ providers: [ProviderSummary]) -> some View {
        let addable = providers.filter(\.canAddKey)
        Section {
            ForEach(providers.filter(\.connectedKey)) { provider in
                LabeledContent {
                    Menu {
                        Button(L("Заменить ключ…")) { keyProvider = provider }
                        Button(L("Удалить…"), role: .destructive) { removingKey = provider }
                    } label: {
                        Image(systemName: "ellipsis.circle")
                    }
                    .menuStyle(.button).buttonStyle(.plain).menuIndicator(.hidden).fixedSize()
                    .disabled(busy)
                    .accessibilityLabel(L("Действия: \(provider.name)"))
                    .accessibilityIdentifier("providerActions-" + provider.id)
                } label: {
                    Text(verbatim: provider.name)
                    Text(provider.keyHint.map { L("API-ключ \($0)") } ?? L("API-ключ"))
                }
            }
            if !addable.isEmpty {
                Menu(L("Добавить ключ…")) {
                    ForEach(addable) { provider in Button { keyProvider = provider } label: { Text(verbatim: provider.name) } }
                }
                .disabled(busy)
                .accessibilityIdentifier("addProviderKey")
            }
        } header: {
            Text(L("API-ключи"))
        } footer: {
            // Moonshot and Z.ai license these plans to one person's own interactive work.
            if client.health?.subscriptionsVersion == 1 {
                Text(L("Подписки Kimi Code и GLM Coding Plan — только для личного использования: расписания и ответы другим людям могут нарушать правила сервиса."))
            }
        }
    }

    @ViewBuilder private func accountRows(_ account: ManagedCodexAccount, index: Int) -> some View {
        LabeledContent {
            if canManage { accountMenu(account, index: index) }
        } label: {
            Text(account.title).textSelection(.enabled)
            let detail = accountDetail(account)
            if !detail.isEmpty { Text(detail).textSelection(.enabled) }
        }
        if account.account.connected {
            UsageSummary(usage: account.usage)
        } else if let login, loginAccount == account.id {
            loginRows(login)
        } else if canManage && !account.account.isUnavailable {
            Button(L("Войти в OpenAI")) { perform { try await signIn(account.id) } }
                .disabled(login != nil || busy)
                .accessibilityIdentifier("signInOpenAI")
        }
    }

    /// The code takes the place of Sign in, so it appears where the person tapped, even with the largest text.
    @ViewBuilder private func loginRows(_ login: OpenAILogin, provider: ProviderSummary? = nil) -> some View {
        if let code = login.userCode {
            // The largest text gives the code a line of its own; it never breaks.
            let layout = textSize.isAccessibilitySize ? AnyLayout(VStackLayout(alignment: .leading, spacing: 8)) : AnyLayout(HStackLayout())
            layout {
                Text(code).font(AppTypography.title.monospaced()).textSelection(.enabled)
                    .lineLimit(1).minimumScaleFactor(0.5)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .accessibilityIdentifier("openAIDeviceCode")
                Button(copiedCode ? L("Код скопирован") : L("Скопировать код")) { copy(code) }
                    .accessibilityIdentifier("copyOpenAICode")
            }
            Text(provider == nil ? L("Введите этот код на сайте OpenAI") : L("Введите этот код на странице входа")).foregroundStyle(AppTheme.secondaryText)
        }
        if let url = login.url {
            InkLink(title: provider == nil ? L("Открыть OpenAI") : L("Открыть страницу входа"), destination: url)
        }
        Button(L("Отменить вход")) { perform {
            if let provider {
                let _: HomeActionResult = try await client.subscription(provider.id, "login/" + login.loginId, method: "DELETE", deviceID: selectedDevice)
            } else {
                let _: OpenAILoginStatus = try await client.management(path(loginAccount, "login/" + login.loginId), method: "DELETE")
            }
            self.login = nil
        } }.accessibilityIdentifier("cancelOpenAILogin")
    }

    private func accountDetail(_ account: ManagedCodexAccount) -> String {
        var parts = [account.emailDetail].compactMap { $0 }
        if account.account.connected {
            parts += [account.account.planLabel, account.account.categoryLabel].compactMap { $0 }
        } else if account.account.isUnavailable {
            parts.append(L("Не удалось проверить аккаунт"))
        } else if !canManage {
            parts.append(L("Нужен вход в OpenAI"))
        }
        if accounts.filter({ $0.title == account.title && $0.account.planType == account.account.planType }).count > 1 {
            parts.append(L("Connection \(String(account.id.suffix(6)))"))
        }
        return parts.joined(separator: " · ")
    }

    private func accountMenu(_ account: ManagedCodexAccount, index: Int) -> some View {
        Menu {
            Button(L("Rename account…")) { accountName = account.title; renaming = account }
            if index > 0 && account.account.connected {
                Button(L("Использовать по умолчанию")) { perform {
                    let _: HomeActionResult = try await client.management(path(account.id, "priority"), method: "POST", payload: [:])
                    await refresh()
                } }
            }
            if account.account.connected {
                Button(L("Выйти из аккаунта…"), role: .destructive) { logout = account }
                    .disabled(account.activeRuns > 0)
            }
        } label: {
            Image(systemName: "ellipsis.circle")
        }
        // Plain, so the glyph ends on the values' trailing edge; borderless adds an inset.
        .menuStyle(.button).buttonStyle(.plain).menuIndicator(.hidden).fixedSize()
        .accessibilityLabel(L("Действия: \(account.title)"))
        .accessibilityIdentifier("accountActions-" + account.id)
    }

    private func copy(_ code: String) {
        #if os(macOS)
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(code, forType: .string)
        #else
        UIPasteboard.general.string = code
        #endif
        copiedCode = true
    }
    private func refresh(force: Bool = false) async {
        let selected = deviceID, token = UUID()
        requestID = token
        if loadedDeviceID != selected { accounts = []; canManage = false; keys = nil; loadedDeviceID = selected }
        loading = true; error = nil
        defer { if selected == deviceID && requestID == token { loading = false } }
        do {
            let result: ManagedCodexAccounts = try await client.management("/v1/accounts" + query + (query.isEmpty ? "?" : "&") + "refresh=" + String(force))
            guard selected == deviceID, requestID == token, !Task.isCancelled else { return }
            accounts = result.accounts; canManage = result.canManage
        } catch { if !Task.isCancelled && selected == deviceID && requestID == token { self.error = UserFacingError.text(error.localizedDescription) } }
        await loadKeys()
    }
    /// Older Homes have no API keys. A device that cannot answer shows no stale keys to add or replace,
    /// so a key goes only to a device that answers.
    private func loadKeys() async {
        let selected = deviceID
        guard client.health?.providers == 1 else { return }
        let list = try? await client.providers(deviceID: selected.isEmpty ? nil : selected)
        guard selected == deviceID, !Task.isCancelled else { return }
        keys = list
    }
    /// A key can change which provider an employee runs on, so the chat's gate is checked again.
    private func keysChanged() async {
        await loadKeys()
        await client.refreshOpenAIAccount(force: true)
    }
    private func signIn(_ id: String) async throws {
        loginAccount = id; loginProvider = nil
        login = try await client.management(path(id, "login"), method: "POST")
        if let url = login?.url { openURL(url) }
    }
    private func signIn(_ provider: ProviderSummary) async throws {
        let started: OpenAILogin = try await client.subscription(provider.id, "login", method: "POST", deviceID: selectedDevice)
        loginAccount = ""; loginProvider = provider; login = started
        if let url = started.url { openURL(url) }
    }
    private func perform(_ work: @escaping () async throws -> Void) {
        busy = true; error = nil
        Task { defer { busy = false }; do { try await work() } catch { self.error = error.localizedDescription } }
    }
}

/// An account's limits and credits as rows: in a Form each is a row, in the menu-bar popover they stack.
struct UsageSummary: View {
    let usage: ManagedCodexAccount.Usage

    var body: some View {
        if usage.unavailable == true {
            Label(L("Не удалось получить остатки. Попробуйте обновить."), systemImage: "exclamationmark.circle")
                .foregroundStyle(AppTheme.secondaryText)
        } else if usage.windows.isEmpty {
            Text(L("OpenAI не передал лимиты подписки.")).foregroundStyle(AppTheme.secondaryText)
        }
        ForEach(usage.windows) { UsageMeter(window: $0) }
        LabeledContent(L("Кредиты")) {
            Text(credits).monospacedDigit().foregroundStyle(AppTheme.secondaryText)
        }
        if let resets = usage.resetCredits {
            LabeledContent {
                Text(String(resets.availableCount)).monospacedDigit().foregroundStyle(AppTheme.secondaryText)
            } label: {
                Text(L("Extra limit resets"))
                if let expires = resets.nextExpiresAt {
                    Text(L("Next expiry: \(Date(timeIntervalSince1970: expires).formatted(.dateTime.day().month(.abbreviated).hour().minute().locale(L10n.locale)))"))
                        .font(AppTypography.meta).monospacedDigit().foregroundStyle(AppTheme.secondaryText)
                }
            }
        }
    }

    /// When OpenAI last reported these numbers.
    static func checked(_ usage: ManagedCodexAccount.Usage) -> Date? {
        ISO8601DateFormatter().date(from: usage.checkedAt) ?? DateFormatter.usageTimestamp.date(from: usage.checkedAt)
    }
    static func updated(_ date: Date) -> String {
        L("Updated \(date.formatted(.dateTime.hour().minute().locale(L10n.locale)))")
    }

    private var credits: String {
        usage.credits.map { $0.unlimited ? L("Без ограничений") : $0.balance ?? ($0.hasCredits ? L("Доступны · баланс не передан") : L("Нет кредитов")) } ?? L("Баланс не передан")
    }
}

/// One limit window: its name and what is left above a thin bar.
private struct UsageMeter: View {
    let window: ManagedCodexAccount.Usage.Window

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            LabeledContent(window.displayName) {
                Text(caption).monospacedDigit().foregroundStyle(AppTheme.secondaryText)
            }
            if let remaining = window.remainingPercent {
                UsageBar(fraction: max(0, min(100, remaining)) / 100)
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(window.displayName)
        .accessibilityValue(caption)
    }

    private var caption: String {
        guard let remaining = window.remainingPercent else { return L("Нет данных") }
        let percent = Int(remaining.rounded())
        guard let reset = window.resetsAt else { return L("\(percent)% осталось") }
        return L("\(percent)% осталось · сброс \(Self.resetTime(Date(timeIntervalSince1970: reset)))")
    }

    /// Today shows the time, this week the weekday and time, later the date.
    private static func resetTime(_ date: Date) -> String {
        let style: Date.FormatStyle = Calendar.current.isDateInToday(date) ? .dateTime.hour().minute()
            : date.timeIntervalSinceNow < 6 * 86_400 ? .dateTime.weekday(.abbreviated).hour().minute()
            : .dateTime.day().month(.abbreviated)
        return date.formatted(style.locale(L10n.locale))
    }
}

/// A 4-pt meter: what is left in the secondary colour on a hairline track, at least 4.5:1 in both appearances.
private struct UsageBar: View {
    let fraction: Double

    var body: some View {
        RoundedRectangle(cornerRadius: 2, style: .continuous)
            .fill(AppTheme.separator)
            .frame(height: 4)
            .overlay(alignment: .leading) {
                GeometryReader { proxy in
                    RoundedRectangle(cornerRadius: 2, style: .continuous)
                        .fill(AppTheme.secondaryText)
                        .frame(width: proxy.size.width * fraction)
                }
            }
            .accessibilityHidden(true)
    }
}

private extension DateFormatter {
    static var usageTimestamp: DateFormatter {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "yyyy-MM-dd'T'HH:mm:ss.SSSXXXXX"
        return formatter
    }
}
