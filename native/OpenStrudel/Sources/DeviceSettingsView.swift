import SwiftUI
#if os(macOS)
import AppKit
#endif

struct SettingsView: View {
    enum Section: String, CaseIterable { case devices = "Устройства", accounts = "Аккаунты", backups = "Копии", application = "Приложение" }
    @EnvironmentObject private var library: DeviceLibrary
    @EnvironmentObject private var client: HomeClient
    @Environment(\.dismiss) private var dismiss
    @Environment(\.isPresented) private var isPresented
    @State private var section: Section = .devices
    @State private var selectedID = ""
    @State private var adding = false
    @State private var pairing: MacPairing?
    @State private var confirmingPairing: MacPairing?
    @State private var localStarting = false
    @State private var expandedDeviceID: String?
    @AppStorage("openstrudel.showMenuBar") private var showMenuBar = true
    private var selected: HomeClient { library.clients.first { $0.id == selectedID } ?? client }
    private let standalone: Bool

    init(initialSection: Section = .devices, standalone: Bool = false) {
        _section = State(initialValue: initialSection)
        self.standalone = standalone
    }

    var body: some View {
        Group {
            #if os(macOS)
            if standalone { settingsContent }
            else { settingsNavigation }
            #else
            settingsNavigation
            #endif
        }
        #if os(macOS)
        .frame(width: 620, height: 600)
        #endif
        .onAppear { selectedID = client.id }
        .sheet(isPresented: $adding, onDismiss: {
            if let pairing { confirmingPairing = pairing; self.pairing = nil }
        }) { ConnectionInvitationView { pairing = $0 } }
        .sheet(item: $confirmingPairing) { AddDeviceConfirmation(pairing: $0).environmentObject(library) }
    }

    private var settingsContent: some View {
            VStack(spacing: 0) {
                Picker("Настройки", selection: $section) {
                    ForEach(Section.allCases, id: \.self) { Text($0.rawValue) }
                }
                #if os(macOS)
                .pickerStyle(.segmented)
                #else
                .pickerStyle(.menu).font(.headline)
                #endif
                .labelsHidden().padding(24).padding(.bottom, -8)
                .accessibilityIdentifier("settingsSection")
                ScrollView {
                    VStack(alignment: .leading, spacing: 24) {
                        if section != .devices && section != .application && library.visibleClients.count > 1 {
                            Picker("Устройство", selection: $selectedID) {
                                ForEach(library.visibleClients) { Text($0.displayName).tag($0.id) }
                            }
                        }
                        switch section {
                        case .devices: deviceList
                        case .accounts:
                            DeviceAccountsView().environmentObject(selected).id(selected.id)
                            Divider()
                            TelegramSetupView().environmentObject(selected).id("telegram-" + selected.id)
                        case .backups:
                            Text("Резервная копия сотрудников").font(.title3.weight(.semibold))
                            AgentTransferSettings().environmentObject(selected).id(selected.id)
                        case .application:
                            if library.visibleClients.count > 1 {
                                Picker("Сотрудники на устройстве", selection: $selectedID) {
                                    ForEach(library.visibleClients) { Text($0.displayName).tag($0.id) }
                                }
                            }
                            ApprovalSettingsView().environmentObject(selected).id("approvals-" + selected.id)
                            Divider()
                            DictationSettings()
                            Divider()
                            #if os(macOS)
                            Toggle("Показывать в строке меню", isOn: $showMenuBar)
                            UpdateSettings()
                            HostingStoreSettings()
                            #endif
                            Link("Помощь", destination: URL(string: "https://waiwai.is/openstrudel#help")!)
                            Link("Конфиденциальность", destination: URL(string: "https://waiwai.is/openstrudel/privacy")!)
                            #if os(macOS)
                            LocalDataResetButton()
                            #endif
                        }
                    }.padding(24).frame(maxWidth: 640, alignment: .leading).frame(maxWidth: .infinity)
                }
            }.background(HomeBackground())
    }

    private var settingsNavigation: some View {
        NavigationStack {
            settingsContent
                .navigationTitle("Настройки")
                #if os(iOS)
                .navigationBarTitleDisplayMode(.inline)
                #endif
                .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Готово") {
                    #if os(macOS)
                    if isPresented { dismiss() } else { NSApp.keyWindow?.close() }
                    #else
                    dismiss()
                    #endif
                } } }
        }
    }

    private var deviceList: some View {
        VStack(alignment: .leading, spacing: 22) {
            Text("Сотрудники работают там, где вы их создали. Здесь можно подключить ещё один Mac или сервер.")
                .font(.callout).foregroundStyle(AppTheme.secondaryText).fixedSize(horizontal: false, vertical: true)
            ForEach(library.visibleClients) { device in
                DisclosureGroup(isExpanded: Binding(
                    get: { expandedDeviceID == device.id },
                    set: { expandedDeviceID = $0 ? device.id : nil }
                )) {
                    VStack(alignment: .leading, spacing: 12) {
                        MobilePairingSettings().environmentObject(device)
                    }.padding(.top, 12)
                } label: {
                    HStack(spacing: 12) {
                        Image(systemName: device.isLocalConnection ? "laptopcomputer" : "desktopcomputer").font(.title2)
                        VStack(alignment: .leading, spacing: 4) {
                            Text(device.displayName).font(.headline)
                            Text(device.homeUnreachable || device.health == nil ? "Нет связи · попробуем снова" : "На связи · сотрудников: \(device.profiles.count)")
                                .font(.caption).foregroundStyle(AppTheme.secondaryText)
                        }
                        Spacer()
                    }.padding(.vertical, 6)
                }.accessibilityIdentifier("deviceDetails")
                DeviceSignOutButton {}.environmentObject(device)
                if device.id != library.visibleClients.last?.id { Divider() }
            }
            Button("Подключить устройство…") { adding = true }.buttonStyle(.borderedProminent)
                .accessibilityIdentifier("addDevice")
            HiddenEmployeesButton()
            #if os(macOS)
            if !library.visibleClients.contains(where: \.isLocalConnection), LocalHome.isAvailable {
                Button(localStarting ? "Запускаем этот Mac…" : "Работать также на этом Mac") {
                    localStarting = true
                    Task { await library.openLocal(); localStarting = false }
                }.disabled(localStarting)
            }
            #endif
        }
    }
}

struct AddDeviceConfirmation: View {
    @EnvironmentObject private var library: DeviceLibrary
    @Environment(\.dismiss) private var dismiss
    let pairing: MacPairing
    @State private var candidate: HomeClient?
    @State private var busy = false
    @State private var error: String?
    @State private var connected = false

    var body: some View {
        NavigationStack {
            VStack(spacing: 20) {
                Image(systemName: connected ? "checkmark.circle.fill" : "desktopcomputer").font(.system(size: 48)).foregroundStyle(AppTheme.accent)
                Text(connected ? "Устройство подключено" : "Подключить «\(pairing.name)»?")
                    .font(.title2.weight(.semibold)).multilineTextAlignment(.center)
                Text(connected ? (candidate?.homeUnreachable == true ? "Подключение сохранено. Ждём ответа устройства — сотрудники появятся, когда оно выйдет на связь." : "Сотрудники этого устройства теперь доступны в списке чатов.") : "Вы сможете общаться с его сотрудниками и создавать новых. Они продолжат работать на «\(pairing.name)».")
                    .font(.callout).foregroundStyle(AppTheme.secondaryText).multilineTextAlignment(.center)
                if let error { Text(error).font(.callout).foregroundStyle(AppTheme.destructive).accessibilityIdentifier("pairingError") }
                Button {
                    if connected { if let candidate { library.select(candidate) }; dismiss(); return }
                    busy = true; error = nil
                    let target = candidate ?? library.connection(for: pairing); candidate = target
                    Task {
                        if await target.connectToMac(pairing) { library.add(target, select: false); connected = true }
                        else { error = target.pairingError }
                        busy = false
                    }
                } label: {
                    HStack { if busy { ProgressView().controlSize(.small) }; Text(connected ? "Открыть сотрудников" : busy ? "Проверяем подключение…" : "Подключить") }
                        .frame(minHeight: 32)
                }.buttonStyle(.borderedProminent).disabled(busy).keyboardShortcut(.defaultAction)
                .accessibilityIdentifier("confirmMacPairing")
            }.padding(32).frame(maxWidth: 460)
                .toolbar { ToolbarItem(placement: .cancellationAction) { Button(connected ? "Готово" : "Отмена") { dismiss() }.disabled(busy) } }
        }
        .interactiveDismissDisabled(busy)
        #if os(macOS)
        .frame(width: 500, height: 390)
        #endif
    }
}

struct DeviceAccountsView: View {
    @EnvironmentObject private var client: HomeClient
    @Environment(\.openURL) private var openURL
    @State private var deviceID = ""
    @State private var accounts: [ManagedCodexAccount] = []
    @State private var loading = true
    @State private var busy = false
    @State private var error: String?
    @State private var canManage = false
    @State private var login: OpenAILogin?
    @State private var loginAccount = ""
    @State private var logout: ManagedCodexAccount?
    private var query: String { deviceID.isEmpty ? "" : "?deviceId=" + deviceID }
    private func path(_ id: String, _ action: String) -> String { "/v1/accounts/" + id + "/" + action + query }

    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            Text("OpenAI на «\(client.displayName)»").font(.title3.weight(.semibold))
            if client.devices.count > 1 {
                Picker("Устройство сотрудника", selection: $deviceID) {
                    ForEach(client.devices) { Text($0.name).tag($0.id) }
                }
            }
            if loading { ProgressView(accounts.isEmpty ? "Загружаем аккаунты и лимиты…" : "Обновляем остатки…").controlSize(.small) }
            if let error { Text(error).font(.callout).foregroundStyle(AppTheme.destructive) }
            ForEach(Array(accounts.enumerated()), id: \.element.id) { index, account in
                VStack(alignment: .leading, spacing: 14) {
                    HStack(alignment: .top) {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(account.account.email ?? account.name).font(.headline).textSelection(.enabled)
                            Text(account.account.connected ? account.account.planLabel : account.account.isUnavailable ? "Не удалось проверить аккаунт" : "Нужен вход в OpenAI").font(.caption).foregroundStyle(AppTheme.secondaryText)
                        }
                        Spacer()
                        if canManage && account.account.connected {
                            Menu {
                                if index > 0 { Button("Использовать по умолчанию") { perform {
                                    let _: HomeActionResult = try await client.management(path(account.id, "priority"), method: "POST", payload: [:])
                                    await refresh()
                                } } }
                                Button("Выйти из аккаунта…", role: .destructive) { logout = account }
                                    .disabled(account.activeRuns > 0)
                            } label: { Image(systemName: "ellipsis") }.menuStyle(.borderlessButton).fixedSize()
                                .accessibilityLabel("Действия с аккаунтом")
                        }
                    }
                    if account.account.connected { UsageSummary(usage: account.usage) }
                    else if canManage && !account.account.isUnavailable {
                        Button { perform { try await signIn(account.id) } } label: { AdaptiveActionLabel(title: "Войти в OpenAI") }
                            .adaptiveActionStyle(.borderedProminent).disabled(login != nil || busy).accessibilityIdentifier("signInOpenAI")
                    }
                    if accounts.count > 1 && index == 0 { Text("По умолчанию для новых поручений").font(.caption).foregroundStyle(AppTheme.secondaryText) }
                }
                Divider()
            }
            if let login {
                Text("Завершите вход на сайте OpenAI").font(.headline)
                if let code = login.userCode { Text(code).font(.title2.monospaced()).textSelection(.enabled).accessibilityIdentifier("openAIDeviceCode") }
                if let url = login.url { Link("Открыть OpenAI", destination: url).buttonStyle(.borderedProminent) }
                Button("Отменить вход") { perform {
                    let _: OpenAILoginStatus = try await client.management(path(loginAccount, "login/" + login.loginId), method: "DELETE")
                    self.login = nil
                } }.accessibilityIdentifier("cancelOpenAILogin")
            } else if canManage && !accounts.isEmpty {
                Button("Добавить аккаунт OpenAI") { perform {
                    struct Added: Decodable { let id: String }
                    let result: Added = try await client.management("/v1/accounts" + query, method: "POST", payload: ["name": "OpenAI"])
                    try await signIn(result.id)
                } }.disabled(busy)
            }
            Button("Обновить остатки") { Task { await refresh(force: true) } }.disabled(loading)
            Text("Лимиты относятся к подписке. Кредиты — отдельный баланс аккаунта.")
                .font(.caption).foregroundStyle(AppTheme.secondaryText)
        }
        .task(id: deviceID) { await refresh() }
        .onAppear { deviceID = client.health?.nodeId ?? "" }
        .task(id: login?.loginId) {
            guard let current = login else { return }
            while !Task.isCancelled && login?.loginId == current.loginId {
                do {
                    try await Task.sleep(for: .seconds(2))
                    let status: OpenAILoginStatus = try await client.management(path(loginAccount, "login/" + current.loginId))
                    if status.status == "completed" { login = nil; await refresh(force: true); await client.refreshOpenAIAccount(force: true) }
                    if ["failed", "canceled"].contains(status.status) { login = nil; error = "Вход не завершён. Попробуйте ещё раз." }
                } catch is CancellationError { break }
                catch { self.error = "Не удалось проверить вход. Повторим, когда появится связь." }
            }
        }
        .confirmationDialog("Выйти из аккаунта OpenAI?", isPresented: Binding(get: { logout != nil }, set: { if !$0 { logout = nil } })) {
            if let account = logout { Button("Выйти", role: .destructive) { perform {
                let _: HomeActionResult = try await client.management(path(account.id, "logout"), method: "POST")
                logout = nil; await refresh()
            } } }
        } message: { Text("Сотрудники и переписка сохранятся. Для новых поручений понадобится вход.") }
    }
    private func refresh(force: Bool = false) async {
        let selected = deviceID
        loading = true; error = nil
        defer { if selected == deviceID { loading = false } }
        do {
            let result: ManagedCodexAccounts = try await client.management("/v1/accounts" + query + (query.isEmpty ? "?" : "&") + "refresh=" + String(force))
            guard selected == deviceID, !Task.isCancelled else { return }
            accounts = result.accounts; canManage = result.canManage
        } catch { if !Task.isCancelled { self.error = UserFacingError.text(error.localizedDescription) } }
    }
    private func signIn(_ id: String) async throws {
        loginAccount = id
        login = try await client.management(path(id, "login"), method: "POST")
        if let url = login?.url { openURL(url) }
    }
    private func perform(_ work: @escaping () async throws -> Void) {
        busy = true; error = nil
        Task { defer { busy = false }; do { try await work() } catch { self.error = error.localizedDescription } }
    }
}

struct UsageSummary: View {
    let usage: ManagedCodexAccount.Usage
    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            if usage.unavailable == true {
                Label("Не удалось получить остатки. Попробуйте обновить.", systemImage: "exclamationmark.circle").font(.callout).foregroundStyle(AppTheme.secondaryText)
            } else if usage.windows.isEmpty {
                Text("OpenAI не передал лимиты подписки.").font(.callout).foregroundStyle(AppTheme.secondaryText)
            }
            ForEach(usage.windows) { window in
                VStack(alignment: .leading, spacing: 5) {
                    HStack { Text(window.displayName); Spacer(); Text(window.remainingPercent.map { "\(Int($0.rounded()))% осталось" } ?? "Нет данных").monospacedDigit() }.font(.callout)
                    if let remaining = window.remainingPercent { ProgressView(value: max(0, min(100, remaining)), total: 100).accessibilityLabel(window.displayName).accessibilityValue("Осталось \(Int(remaining)) процентов") }
                    if let reset = window.resetsAt {
                        Text("Сброс \(Date(timeIntervalSince1970: reset).formatted(.dateTime.day().month(.abbreviated).hour().minute().locale(Locale(identifier: "ru_RU"))))")
                            .font(.caption).foregroundStyle(AppTheme.secondaryText)
                    }
                }
            }
            HStack {
                Text("Кредиты"); Spacer()
                Text(usage.credits.map { $0.unlimited ? "Без ограничений" : $0.balance ?? ($0.hasCredits ? "Доступны · баланс не передан" : "Нет кредитов") } ?? "Баланс не передан")
                    .monospacedDigit().foregroundStyle(AppTheme.secondaryText)
            }.font(.callout)
        }
    }
}
