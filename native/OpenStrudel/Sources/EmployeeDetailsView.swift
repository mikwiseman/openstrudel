import SwiftUI

/// One size for every page of a multi-page sheet. It fits the smallest window.
enum Sheet {
    #if os(macOS)
    static let width: CGFloat? = 560
    static let height: CGFloat? = 480
    #else
    static let width: CGFloat? = nil
    static let height: CGFloat? = nil
    #endif
}

/// A multi-page sheet. On Mac its bar belongs to the sheet, so every page keeps the bar and pushing a page
/// never resizes the sheet. On iOS the bar items sit on the first page, where the navigation bar shows them.
/// The bar holds only the sheet's way out, in the cancellation place: a sheet-wide confirmation would hide
/// a page's own, such as Add, and a page with no bar items would shrink the sheet.
struct SheetStack<Root: View, Bar: ToolbarContent>: View {
    @ViewBuilder let root: () -> Root
    @ToolbarContentBuilder let bar: () -> Bar

    var body: some View {
        #if os(macOS)
        NavigationStack { root() }
            .toolbar(content: bar)
            // The window's graphite tint would draw bordered labels in grey; sheets keep the system's colours.
            .tint(nil)
            .frame(width: Sheet.width, height: Sheet.height)
            .presentationSizing(.form)
            .modifier(InterfaceLanguage())
        #else
        NavigationStack { root().toolbar(content: bar) }
            .presentationSizing(.form)
            .modifier(InterfaceLanguage())
        #endif
    }
}

/// A sheet page's title, in its content on the Mac: 17 pt on the rows' text edge, where every page of a sheet
/// shows it, so pushing a page never moves or resizes the title. The bar keeps only Back and the buttons.
struct SheetTitle: View {
    let title: String
    var body: some View {
        Text(title).font(AppTypography.title).foregroundStyle(Color.primary)
            .textCase(nil).accessibilityAddTraits(.isHeader)
    }
}

/// The title as a page's first section, for a page whose first rows vary. The form puts the next
/// section's header right under it, so `beforeHeader` keeps 16 between the two, as in Hidden assistants.
struct SheetTitleSection: View {
    let title: String
    var beforeHeader = false
    var body: some View {
        #if os(macOS)
        Section {} header: { SheetTitle(title: title).padding(.bottom, beforeHeader ? 8 : 0) }
        #endif
    }
}

extension View {
    /// Names a sheet page. On the Mac its title is drawn in the content, so the bar keeps only Back.
    func sheetPageTitle(_ title: String) -> some View {
        #if os(macOS)
        // A pushed page shows its navigation title beside Back even with `toolbar(removing: .title)`,
        // so the bar's title stays empty; the content's title carries the header trait.
        navigationTitle("")
        #else
        navigationTitle(title).navigationBarTitleDisplayMode(.inline)
        #endif
    }

    /// Names a single-page form sheet that stays as tall as its rows when a row such as an error comes or goes.
    /// On the Mac the title is in the content, so the bar keeps no empty title band, and the form stops
    /// scrolling, so the sheet follows its height. Its sizing stays automatic: a `.fitted` sheet keeps its first
    /// height and pushes a new row's neighbours out. An iPhone sheet cannot fit its content: half height, and
    /// the form scrolls when large text needs more.
    func fittedSheetPage(_ title: String) -> some View {
        #if os(macOS)
        navigationTitle(title).toolbar(removing: .title)
            .scrollDisabled(true).fixedSize(horizontal: false, vertical: true)
        #else
        navigationTitle(title).navigationBarTitleDisplayMode(.inline).presentationDetents([.medium])
        #endif
    }
}

/// Pages a details sheet pushes. The sheet's stack owns them, so a push never resizes the sheet.
enum DetailsPage: Hashable { case services, telegram, project }

/// The character, the name and the role at the top of a details sheet.
struct DetailsHeader<Name: View>: View {
    @Environment(\.layoutDirection) private var layoutDirection
    let appearance: AgentAppearance?
    let role: String
    @ViewBuilder let name: () -> Name

    var body: some View {
        HStack(spacing: 12) {
            AgentAvatar(appearance: appearance, size: AvatarSize.header)
            VStack(alignment: .leading, spacing: 2) {
                // An editable name keeps to the interface edge like the role, whatever script it is in.
                // A Mac text field reads "leading" by its text's own direction, so right to left
                // names the physical right edge instead.
                name().font(AppTypography.title)
                    .multilineTextAlignment(layoutDirection == .rightToLeft ? .trailing : .leading)
                    .environment(\.layoutDirection, .leftToRight)
                if !role.isEmpty {
                    Text(role).font(AppTypography.interface).foregroundStyle(AppTheme.secondaryText)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
        .padding(.vertical, 4)
    }
}

#if os(macOS)
/// Takes a sheet's first focus, so the name reads calmly instead of opening with its text selected.
/// A click or Tab still edits every field.
private struct RestingFocus: NSViewRepresentable {
    final class Sink: NSView {
        override var acceptsFirstResponder: Bool { true }
        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            guard let window else { return }
            window.initialFirstResponder = self
            DispatchQueue.main.async { [weak self] in
                guard let self, let window = self.window else { return }
                window.makeFirstResponder(self)
            }
        }
    }
    func makeNSView(context: Context) -> Sink { Sink() }
    func updateNSView(_ view: Sink, context: Context) {}
}
#endif

/// A navigation row: a symbol on the shared icon column, the title on one edge and an optional value.
struct DetailsRow: View {
    let title: String
    let symbol: String
    var value: String = ""

    var body: some View {
        LabeledContent {
            if !value.isEmpty { Text(value).foregroundStyle(AppTheme.secondaryText).lineLimit(1) }
        } label: {
            Label { Text(title) } icon: { Image(systemName: symbol).frame(width: 20) }
        }
    }
}

struct BotDetailsView: View {
    @EnvironmentObject private var client: HomeClient
    @Environment(\.dismiss) private var dismiss
    let profile: EmployeeProfile
    @State private var name: String
    @State private var instructions: String
    @State private var appearance: AgentAppearance
    @State private var isSaving = false
    @State private var confirmDiscard = false
    @State private var confirmDeletion = false
    @State private var saveError: String?
    /// Nil until the model settings answer; an employee on an API key has no OpenAI account to choose.
    @State private var runsOnChatGPT: Bool?
    private var hasChanges: Bool { name != profile.name || instructions != profile.instructions || appearance != profile.resolvedAppearance }
    private var telegramChats: String {
        (client.telegram?.chats ?? []).filter { $0.profileId == profile.id }.map(\.title).joined(separator: ", ")
    }
    private var deviceName: String {
        profile.deviceId == client.health?.nodeId ? client.displayName
            : client.devices.first(where: { $0.id == profile.deviceId })?.name ?? client.displayName
    }

    /// Opened from a reader, the employee's own conversation scopes its services and schedules; the chat is elsewhere.
    private let conversationID: String?

    init(profile: EmployeeProfile, conversationID: String? = nil) {
        self.profile = profile
        self.conversationID = conversationID
        _name = State(initialValue: profile.name)
        _instructions = State(initialValue: profile.instructions)
        _appearance = State(initialValue: profile.resolvedAppearance)
    }

    var body: some View {
        SheetStack {
            Form {
                Section {
                    DetailsHeader(appearance: appearance, role: profile.roleText) {
                        TextField(L("Имя сотрудника"), text: $name).textFieldStyle(.plain).labelsHidden()
                    }
                    #if os(macOS)
                    .background(RestingFocus())
                    #endif
                    if let saveError {
                        Text(L10n.serviceText(saveError)).foregroundStyle(AppTheme.warning)
                            .accessibilityIdentifier("employeeSaveError")
                    }
                }
                Section {
                    TextEditor(text: $instructions)
                        .font(AppTypography.reading).lineSpacing(AppTypography.readingLineSpacing)
                        .scrollContentBackground(.hidden)
                        // The text view insets its glyphs by 5; this puts them on the column's text edge.
                        .padding(.horizontal, -5)
                        // An empty editor says what belongs in it, where its first line will start.
                        .overlay(alignment: .topLeading) {
                            if instructions.isEmpty {
                                Text(L("Опишите задачи и правила, которым он должен следовать."))
                                    .font(AppTypography.reading).lineSpacing(AppTypography.readingLineSpacing)
                                    .foregroundStyle(AppTheme.secondaryText)
                                    #if os(iOS)
                                    .padding(.top, 8)
                                    #endif
                                    .allowsHitTesting(false).accessibilityHidden(true)
                            }
                        }
                        .frame(minHeight: 132)
                        .accessibilityLabel(L("Описание сотрудника"))
                        .accessibilityHint(L("Опишите задачи и правила, которым он должен следовать."))
                } header: {
                    Text(L("Чем занимается сотрудник"))
                }
                if client.health?.agentAppearanceVersion == 1 {
                    Section {
                        AgentAppearancePicker(selection: $appearance)
                    } header: {
                        HStack {
                            Text(L("Образ"))
                            Spacer()
                            AgentAppearanceShuffle(selection: $appearance)
                        }
                    }
                }
                Section {
                    NavigationLink(value: DetailsPage.services) { DetailsRow(title: L("Сервисы и навыки"), symbol: "link") }
                    NavigationLink(value: DetailsPage.telegram) { DetailsRow(title: "Telegram", symbol: "paperplane", value: telegramChats) }
                }
                Section(L("Модель и скорость")) { ModelSettingsView(agentID: profile.id) { runsOnChatGPT = $0.runsOnChatGPT } }
                if client.health?.homeProtocol == 1 && (client.health?.providers != 1 || runsOnChatGPT == true) { AgentAccountPreference(profile: profile) }
                if client.canManageOpenAI {
                    Section(L("Advanced")) {
                        NavigationLink(value: DetailsPage.project) { DetailsRow(title: L("Project"), symbol: "folder") }
                            .disabled(isSaving).accessibilityIdentifier("employeeProject")
                    }
                }
                if !client.schedules.isEmpty || client.scheduleRuns.contains(where: { $0.error != nil }) {
                    Section(L("Расписание")) { schedules }
                }
                Section {
                    // A move carries the saved employee, so it waits until the edits are saved or dropped.
                    EmployeeMoveButton(profile: profile, disabled: hasChanges || isSaving).labelStyle(.titleOnly)
                }
                if client.canManageOpenAI {
                    Section {
                        Button(L("Удалить сотрудника…"), role: .destructive) { confirmDeletion = true }
                            .foregroundStyle(AppTheme.destructive)
                            .disabled(isSaving || client.homeUnreachable)
                            .accessibilityIdentifier("deleteEmployee")
                    }
                }
            }
            .formStyle(.grouped)
            .navigationTitle(L("Сотрудник"))
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #else
            // On the Mac the header is the page's title, on the content edge; pushed pages show Back and theirs.
            .toolbar(removing: .title)
            #endif
            .toolbar { saveItem }
            .interactiveDismissDisabled(hasChanges || isSaving)
            .alert(L("Не сохранять изменения?"), isPresented: $confirmDiscard) {
                Button(L("Не сохранять"), role: .destructive) { dismiss() }
                Button(L("Продолжить редактирование"), role: .cancel) {}
            } message: { Text(L("Имя, образ и описание сотрудника останутся прежними.")) }
            .alert(L("Удалить «\(profile.name)»?"), isPresented: $confirmDeletion) {
                Button(L("Отмена"), role: .cancel) {}
                Button(L("Удалить"), role: .destructive, action: delete)
            } message: {
                Text(L("Сотрудник, переписка и расписания будут удалены с устройства «\(deviceName)». Отменить удаление нельзя."))
            }
            .navigationDestination(for: DetailsPage.self) { page in
                Group {
                    switch page {
                    case .services: ConnectionsView(embedded: true, conversationID: conversationID)
                    case .telegram: TelegramChatsView(profile: profile, embedded: true)
                    case .project: ProjectSettingsView(employeeID: profile.id)
                    }
                }
                #if os(macOS)
                // These pages apply their changes at once, so the sheet still closes from them.
                .toolbar { saveItem }
                #endif
            }
            .task { await client.loadChatSettings(conversationID: conversationID, profileID: conversationID == nil ? nil : profile.id) }
        } bar: {
            // Cancel belongs to the sheet: it stays on every page and closes the whole sheet.
            ToolbarItem(placement: .cancellationAction) {
                Button(L("Отмена")) { if hasChanges { confirmDiscard = true } else { dismiss() } }
                    .disabled(isSaving).keyboardShortcut(.cancelAction)
                    .accessibilityIdentifier("cancelEmployeeChanges")
            }
        }
    }

    private var saveItem: some ToolbarContent {
        ToolbarItem(placement: .confirmationAction) {
            Button(isSaving ? L("Сохраняем…") : hasChanges ? L("Сохранить") : L("Готово"), action: save)
                .disabled(isSaving || name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                .keyboardShortcut(.defaultAction).accessibilityIdentifier("saveEmployeeChanges")
        }
    }

    @ViewBuilder private var schedules: some View {
        ForEach(client.schedules.filter(\.enabled)) { schedule in
            Toggle(isOn: Binding(get: { schedule.enabled }, set: { value in Task { await client.setSchedule(schedule, enabled: value) } })) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(schedule.name)
                    Text(schedule.timing + source(schedule)).font(AppTypography.meta).foregroundStyle(AppTheme.secondaryText)
                }
            }
        }
        if client.schedules.contains(where: { !$0.enabled && $0.oneTimeResult == nil }) {
            DisclosureGroup(L("Приостановленные")) {
                ForEach(client.schedules.filter { !$0.enabled && $0.oneTimeResult == nil }) { schedule in
                    Toggle(schedule.name + source(schedule), isOn: Binding(get: { schedule.enabled }, set: { value in Task { await client.setSchedule(schedule, enabled: value) } }))
                }
            }
        }
        if client.schedules.contains(where: { $0.oneTimeResult != nil }) {
            DisclosureGroup(L("Результаты напоминаний")) {
                ForEach(client.schedules.filter { $0.oneTimeResult != nil }) { schedule in
                    VStack(alignment: .leading, spacing: 2) {
                        Text(schedule.name + source(schedule))
                        Text((schedule.oneTimeResult ?? "") + " · " + schedule.timing)
                            .font(AppTypography.meta).foregroundStyle(AppTheme.secondaryText)
                    }
                }
            }
        }
        if let error = client.scheduleRuns.lazy.compactMap(\.error).first {
            Text(UserFacingError.text(error)).font(AppTypography.meta).foregroundStyle(AppTheme.warning)
        }
    }

    /// A schedule made in a Telegram chat names that chat.
    private func source(_ schedule: ChatSchedule) -> String {
        client.employeeTelegramChats.first { $0.conversationId == schedule.conversationId }.map { " · Telegram · " + $0.title } ?? ""
    }

    private func save() {
        guard hasChanges else { dismiss(); return }
        isSaving = true
        saveError = nil
        Task {
            let saved = await client.updateProfile(id: profile.id, name: name, instructions: instructions, appearance: appearance != profile.resolvedAppearance ? appearance : nil)
            isSaving = false
            if saved { dismiss() }
            else { saveError = client.errorMessage ?? L("Не удалось сохранить изменения. Попробуйте ещё раз."); client.errorMessage = nil }
        }
    }

    /// The sheet closes first: once the employee is gone the conversation moves to the main assistant.
    private func delete() {
        let client = client, id = profile.id
        dismiss()
        Task {
            do { try await client.deleteProfile(id) }
            catch { client.errorMessage = error.localizedDescription }
        }
    }
}

/// The main assistant's sheet: the same header and rows, without the employee-only sections.
struct MainAssistantDetailsView: View {
    @EnvironmentObject private var client: HomeClient
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        SheetStack {
            Form {
                Section {
                    DetailsHeader(appearance: nil, role: L("Помощник для ваших задач")) { Text(verbatim: "OpenStrudel") }
                }
                Section {
                    NavigationLink(value: DetailsPage.services) { DetailsRow(title: L("Сервисы и навыки"), symbol: "link") }
                }
                Section(L("Модель и скорость")) { ModelSettingsView(agentID: "main") }
            }
            .formStyle(.grouped)
            .navigationTitle("OpenStrudel")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #else
            .toolbar(removing: .title)
            .toolbar { doneItem }
            #endif
            .navigationDestination(for: DetailsPage.self) { _ in
                ConnectionsView(embedded: true)
                    #if os(macOS)
                    .toolbar { doneItem }
                    #endif
            }
        } bar: {
            #if os(macOS)
            // The same bar as an employee's sheet: Cancel on every page, Done (Return) on the pages
            // without an action of their own, so a pushed page's Add service stays the default button.
            ToolbarItem(placement: .cancellationAction) { Button(L("Отмена")) { dismiss() }.keyboardShortcut(.cancelAction) }
            #else
            ToolbarItem(placement: .confirmationAction) { Button(L("Готово")) { dismiss() } }
            #endif
        }
    }

    private var doneItem: some ToolbarContent {
        ToolbarItem(placement: .confirmationAction) {
            Button(L("Готово")) { dismiss() }.keyboardShortcut(.defaultAction)
        }
    }
}

struct TelegramChatsView: View {
    @EnvironmentObject private var client: HomeClient
    @Environment(\.dismiss) private var dismiss
    @Environment(\.dynamicTypeSize) private var textSize
    var profile: EmployeeProfile? = nil
    var embedded = false
    @State private var busyGroup: String?
    @State private var error: String?
    @State private var showAccounts = false
    private var groups: [TelegramChat] { (client.telegram?.chats ?? []).filter(\.isGroup) }

    var body: some View {
        if embedded { content }
        else {
            SheetStack { content } bar: {
                ToolbarItem(placement: .confirmationAction) { Button(L("Готово")) { dismiss() } }
            }
        }
    }

    private var content: some View {
        Form {
            SheetTitleSection(title: title, beforeHeader: true)
            if let group = client.activeTelegramGroup {
                Section {
                    LabeledContent {
                        groupAction(group)
                    } label: {
                        Label { groupText(group) } icon: { Image(systemName: "person.2").frame(width: 20) }
                    }
                    NavigationLink { ConnectionsView(embedded: true) } label: { DetailsRow(title: L("Сервисы и навыки"), symbol: "link") }
                        .accessibilityIdentifier("telegramGroupServices")
                } header: { Text(L("Группа в Telegram")) }
            } else {
                TelegramSetupSection()
            }
            if client.telegram?.configured == true && client.openAIAccount?.connected == false {
                Section {
                    Text(client.openAIAccount?.isUnavailable == true
                         ? L("Не удалось проверить OpenAI. Подключение Telegram сохранено.")
                         : client.openAIAccount?.keyProviderName.map { L("Подключите \($0), чтобы помощник мог отвечать.") }
                         ?? L("Войдите в OpenAI, чтобы помощник мог отвечать."))
                    Button(L("Аккаунты")) { showAccounts = true }
                        .accessibilityIdentifier("telegramOpenAIAccounts")
                }
            }
            if client.activeTelegramGroup == nil && !groups.isEmpty {
                Section(L("Группы")) {
                    ForEach(groups) { chat in
                        if textSize.isAccessibilitySize {
                            VStack(alignment: .leading, spacing: 8) {
                                groupLabel(chat)
                                groupAction(chat)
                            }
                        } else {
                            LabeledContent { groupAction(chat) } label: { groupLabel(chat) }
                        }
                    }
                }
            }
            if let error { Section { Text(L10n.serviceText(error)).foregroundStyle(AppTheme.warning) } }
        }
        .formStyle(.grouped)
        .sheetPageTitle(title)
        .navigationDestination(isPresented: $showAccounts) {
            Form {
                SheetTitleSection(title: L("Аккаунты"), beforeHeader: true)
                DeviceAccountsView()
            }
            .formStyle(.grouped).sheetPageTitle(L("Аккаунты"))
        }
    }

    private var title: String { client.activeTelegramGroup?.title ?? "Telegram" }

    private func groupLabel(_ chat: TelegramChat) -> some View {
        Label {
            VStack(alignment: .leading, spacing: 2) {
                Text(chat.title)
                groupText(chat, secondary: true)
            }
        } icon: { Image(systemName: "person.2").frame(width: 20) }
    }

    private func groupText(_ chat: TelegramChat, secondary: Bool = false) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(groupDescription(chat)).foregroundStyle(secondary ? AppTheme.secondaryText : Color.primary)
            if chat.enabled != false {
                Text(chat.replies == "mentions" ? L("Отвечает на @упоминание и ответы боту") : L("Отвечает по правилам сотрудника"))
                    .font(AppTypography.meta).foregroundStyle(AppTheme.secondaryText)
            }
        }
    }

    @ViewBuilder private func groupAction(_ chat: TelegramChat) -> some View {
        if busyGroup == chat.chatId { ProgressView().controlSize(.small) }
        else {
            Button(chat.enabled == false ? L("Продолжить") : L("Приостановить")) { toggle(chat) }
                .disabled(busyGroup != nil)
                .accessibilityLabel((chat.enabled == false ? L("Продолжить в группе «") : L("Приостановить в группе «")) + chat.title + "»")
                .accessibilityIdentifier("toggleTelegramGroup-" + chat.chatId)
        }
    }

    private func groupDescription(_ chat: TelegramChat) -> String {
        if chat.enabled == false { return L("На паузе · переписка сохранена") }
        if let name = client.profiles.first(where: { $0.id == chat.profileId })?.name { return L("Отвечает «\(name)»") }
        return L("Помощник сам подбирает сотрудника по задаче")
    }

    private func toggle(_ chat: TelegramChat) {
        busyGroup = chat.chatId; error = nil
        Task {
            defer { busyGroup = nil }
            do { try await client.setTelegramGroupEnabled(chat.chatId, enabled: chat.enabled == false) }
            catch { self.error = UserFacingError.text(error.localizedDescription) }
        }
    }
}

struct ConnectionsView: View {
    @EnvironmentObject private var client: HomeClient
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.dynamicTypeSize) private var textSize
    var embedded = false
    /// The conversation whose services these are when it is not the open chat: a reader's employee.
    var conversationID: String? = nil
    @State private var query = ""
    @State private var loading = true
    @State private var error: String?
    @State private var connecting: String?
    @State private var connectTask: Task<Void, Never>?
    @State private var browserSignIn = false
    @State private var waiting: ServiceConnection?
    @State private var authorizationURL: URL?
    @State private var notice: String?
    @State private var availableConnections: [ServiceConnection] = []
    @State private var extensions: [EmployeeExtension] = []
    @State private var contexts: [ExtensionContext] = []
    @State private var scopeID = ""
    @State private var showAdd = false
    @State private var extensionNotice: String?
    @State private var changing = false
    @State private var pendingRemoval: EmployeeExtension?
    @State private var pendingMCPRemoval: ServiceConnection?
    @State private var refreshID = UUID()
    private var scope: ExtensionContext? { contexts.first { $0.id == scopeID } }
    private var results: [ServiceConnection] {
        availableConnections.filter { $0.id != "mcp:cua_repl" && !$0.isAvailableToAdd && (query.isEmpty || $0.name.localizedCaseInsensitiveContains(query)) }
            .sorted { $0.connected != $1.connected ? $0.connected : $0.name.localizedStandardCompare($1.name) == .orderedAscending }
    }
    var body: some View {
        if embedded { content }
        else {
            SheetStack { content } bar: {
                ToolbarItem(placement: .confirmationAction) { Button(L("Готово")) { dismiss() } }
            }
        }
    }

    private var canManage: Bool { client.canManageConnections || client.canManageOpenAI }
    private var scopeTitle: String { scope?.isGroup == true ? "Telegram · " + (scope?.title ?? L("Группа")) : L("В приложении") }

    private var servicesList: some View {
        ServiceList {
            SheetTitleSection(title: L("Сервисы и навыки"))
            scopeSection
            if availableConnections.filter({ $0.id != "mcp:cua_repl" && !$0.isAvailableToAdd }).count > 6 {
                Section {
                    TextField(L("Найти подключение"), text: $query, prompt: Text(L("Найти подключение")))
                        .labelsHidden().accessibilityLabel(L("Найти подключение"))
                }
            }
            if !scopeID.isEmpty {
                Section { ComputerUseSettingsView(conversationID: scopeID, isGroup: scope?.isGroup == true).id(scopeID) }
            }
            extensionRows
            connectionRows
        }
        .sheetPageTitle(L("Сервисы и навыки"))
    }

    private var content: some View {
        servicesList
        .navigationDestination(isPresented: $showAdd) {
            if let scope { ConnectionCatalogView(scope: scope, isPresented: $showAdd) }
        }
        .onChange(of: showAdd) { wasPresented, isPresented in
            if wasPresented && !isPresented { Task { await refresh() } }
        }
        .confirmationDialog(L("Удалить расширение?"), isPresented: Binding(get: { pendingRemoval != nil || pendingMCPRemoval != nil }, set: { if !$0 { pendingRemoval = nil; pendingMCPRemoval = nil } }), titleVisibility: .visible) {
            if let item = pendingRemoval { Button(L("Удалить «\(item.name)»"), role: .destructive) { updateExtension(item); pendingRemoval = nil } }
            if let item = pendingMCPRemoval { Button(L("Удалить «\(item.name)»"), role: .destructive) { removeMCP(item); pendingMCPRemoval = nil } }
            Button(L("Отмена"), role: .cancel) { pendingRemoval = nil; pendingMCPRemoval = nil }
        } message: { Text(L("Переписка и файлы сотрудника сохранятся.")) }
        .task { await loadContexts() }
        .task(id: scopeID) { await loadScope() }
        .task(id: waiting?.id) { await pollAuthorization() }
        .onDisappear { connectTask?.cancel() }
        .onChange(of: scenePhase) { old, phase in
            if old != .active && phase == .active && !loading { Task { await refresh() } }
        }
    }

    private func loadContexts() async {
        do { contexts = try await client.extensionContexts(conversationID: conversationID); scopeID = conversationID ?? client.conversationID ?? "" }
        catch { self.error = L("Не удалось определить чат. Вернитесь к переписке и откройте сервисы снова."); loading = false }
    }

    private func loadScope() async {
        guard !scopeID.isEmpty else { return }
        availableConnections = []; extensions = []; waiting = nil; authorizationURL = nil; notice = nil
        await refresh(force: false)
    }

    private func pollAuthorization() async {
        guard waiting != nil && !browserSignIn else { return }
        for _ in 0..<30 {
            do { try await Task.sleep(for: .seconds(2)) } catch { return }
            if !loading { await refresh() }
            if waiting == nil { return }
        }
    }

    @ViewBuilder private var extensionRows: some View {
        let shown = extensions.filter { query.isEmpty || $0.name.localizedCaseInsensitiveContains(query) }
        if !shown.isEmpty {
            Section(L("Навыки и плагины")) {
                ForEach(shown) { item in
                    Group {
                        if item.removable && canManage {
                            Toggle(isOn: Binding(get: { item.enabled }, set: { enabled in updateExtension(item, enabled: enabled) })) {
                                extensionLabel(item, removable: true)
                            }.disabled(changing || loading)
                        } else {
                            LabeledContent {
                                Image(systemName: item.enabled ? "checkmark" : "pause.circle")
                                    .foregroundStyle(item.enabled ? Color.primary : AppTheme.secondaryText)
                            } label: { extensionLabel(item) }
                        }
                    }
                    .accessibilityElement(children: .contain)
                }
            }
        }
    }

    /// The name, what it does and, when it can go, the quiet way to remove it, all on the text edge.
    private func extensionLabel(_ item: EmployeeExtension, removable: Bool = false) -> some View {
        Label {
            VStack(alignment: .leading, spacing: 2) {
                Text(item.name)
                if !item.description.isEmpty {
                    Text(item.description).font(AppTypography.meta).foregroundStyle(AppTheme.secondaryText).lineLimit(3)
                }
                if removable {
                    Button(L("Удалить…"), role: .destructive) { pendingRemoval = item }
                        .buttonStyle(.borderless).font(AppTypography.meta).disabled(changing)
                }
            }
        } icon: { Image(systemName: item.kind == "plugin" ? "puzzlepiece.extension" : "sparkles").frame(width: 20) }
    }

    @ViewBuilder private var connectionRows: some View {
        if !results.isEmpty {
            Section {
                ForEach(results) { connection in
                    serviceRow(connection)
                        .contextMenu {
                            if connection.removable == true && canManage {
                                Button(L("Удалить подключение…"), role: .destructive) { pendingMCPRemoval = connection }
                            }
                        }
                }
            }
        } else if !query.isEmpty {
            Section { SearchEmptyState(query: query) { query = "" } }
        }
    }

    /// Where the services apply, the one action that adds more, and the state of the last check.
    private var scopeSection: some View {
        Section {
            LabeledContent {
                HStack(spacing: 12) {
                    Button { Task { await refresh() } } label: { Image(systemName: "arrow.clockwise") }
                        .buttonStyle(.borderless).foregroundStyle(AppTheme.secondaryText)
                        .disabled(loading).accessibilityLabel(L("Обновить сервисы"))
                        #if os(macOS)
                        .help(L("Обновить сервисы"))
                        #endif
                    if canManage {
                        Button { query = ""; showAdd = true } label: { Text(L("Добавить…")) }
                            #if os(iOS)
                            .buttonStyle(.borderless)
                            #endif
                            .disabled(scope == nil || changing).accessibilityIdentifier("addEmployeeExtension")
                    }
                }
            } label: {
                Label {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(scopeTitle)
                        Text(L("Для «\(client.activeAgentName)» · \(client.executionDeviceName)"))
                            .font(AppTypography.meta).foregroundStyle(AppTheme.secondaryText)
                    }
                } icon: { Image(systemName: scope?.isGroup == true ? "paperplane" : "bubble.left").frame(width: 20) }
            }
            if loading {
                Label { Text(L("Проверяем доступ к сервисам…")).foregroundStyle(AppTheme.secondaryText) } icon: {
                    ProgressView().controlSize(.small).frame(width: 20)
                }
            }
            if let waiting {
                Text(L("Завершите подключение \(waiting.name) в браузере. Здесь появится подтверждение."))
                    .fixedSize(horizontal: false, vertical: true)
                ViewThatFits(in: .horizontal) {
                    HStack { authorizationActions }.fixedSize(horizontal: true, vertical: false)
                    VStack(alignment: .leading, spacing: 12) { authorizationActions }
                }
            }
            if let notice {
                Label { Text(notice) } icon: { Image(systemName: "checkmark").frame(width: 20) }
            }
            if let error {
                Text(UserFacingError.text(error)).foregroundStyle(AppTheme.warning).fixedSize(horizontal: false, vertical: true)
                Button(L("Повторить")) { Task { await refresh() } }.disabled(loading)
            }
            // Every notice says something failed to load, the OpenAI catalog included, so it reads as one.
            if let extensionNotice {
                Text(L10n.serviceText(extensionNotice)).foregroundStyle(AppTheme.warning).fixedSize(horizontal: false, vertical: true)
            }
        } footer: {
            let notes = scopeNotes
            if !notes.isEmpty { Text(notes.joined(separator: "\n")) }
        }
    }

    /// Plain explanations live in the footer, never in a box that looks like a field.
    private var scopeNotes: [String] {
        var notes: [String] = []
        if scope?.isGroup == true { notes.append(L("Подключения для этой группы.")) }
        if let shared = scope?.sharedNotice { notes.append(shared) }
        // "No connections yet" is a claim; after a failed load the warning above says what is known.
        if results.isEmpty && query.isEmpty && !loading && error == nil && extensionNotice == nil {
            notes.append(extensions.isEmpty && !availableConnections.contains(where: { $0.id == "mcp:cua_repl" })
                ? L("Пока без подключений. Нажмите «Добавить», чтобы сотрудник мог работать с вашими сервисами.")
                : L("Другие сервисы можно подключить через «Добавить»."))
        }
        return notes
    }

    @ViewBuilder private var authorizationActions: some View {
        if let authorizationURL { Link(L("Открыть ещё раз"), destination: authorizationURL) }
        if browserSignIn { Button(L("Отменить вход")) { connectTask?.cancel() } }
        Button(L("Проверить подключение")) { Task { await refresh() } }.disabled(loading)
    }

    @ViewBuilder private func serviceRow(_ connection: ServiceConnection) -> some View {
        Group {
            if textSize.isAccessibilitySize {
                VStack(alignment: .leading, spacing: 12) {
                    connectionDetails(connection)
                    connectionAction(connection).adaptiveActionStyle(.bordered)
                }
            } else {
                LabeledContent { connectionAction(connection) } label: { connectionDetails(connection) }
            }
        }
        .accessibilityElement(children: .contain)
    }

    private func connectionDetails(_ connection: ServiceConnection) -> some View {
        Label {
            VStack(alignment: .leading, spacing: 2) {
                Text(connection.name)
                Group {
                    if let detail = connection.detail { Text(L10n.serviceText(detail)) }
                    if let count = connection.toolCount, connection.connected { Text(L("Инструментов: \(count)")) }
                    if connection.status == "unavailable" { Text(L("Нет связи с сервисом")) }
                    if connection.status == "unknown" { Text(L("Не удалось проверить подключение")) }
                }
                .font(AppTypography.meta).foregroundStyle(AppTheme.secondaryText)
                if connection.removable == true && canManage {
                    Button(L("Удалить…"), role: .destructive) { pendingMCPRemoval = connection }
                        .buttonStyle(.borderless).font(AppTypography.meta).disabled(changing)
                }
            }
            .fixedSize(horizontal: false, vertical: true)
        } icon: { Image(systemName: connection.icon).frame(width: 20) }
    }

    @ViewBuilder private func connectionAction(_ connection: ServiceConnection) -> some View {
        if connection.connected {
            Label { Text(L("Подключён")).foregroundStyle(AppTheme.secondaryText) } icon: { Image(systemName: "checkmark") }
                .fixedSize()
        } else {
            Button {
                connectTask = Task { await connect(connection) }
            } label: {
                AdaptiveActionLabel(title: connecting == connection.id ? L("Проверяем…") : waiting?.id == connection.id ? L("Ожидаем входа") : connection.actionTitle)
            }.adaptiveActionStyle(.bordered).disabled(connectTask != nil || waiting?.id == connection.id)
                .fixedSize()
                .accessibilityLabel("\(connection.actionTitle) \(connection.name)")
                .accessibilityIdentifier("connect-service-" + connection.id)
        }
    }

    private func connect(_ connection: ServiceConnection) async {
        connecting = connection.id; error = nil; notice = nil
        defer {
            connecting = nil; connectTask = nil
            if browserSignIn { browserSignIn = false; waiting = nil; authorizationURL = nil }
        }
        do {
            if let url = try await client.connectService(connection.id, for: scopeID, onAuthorization: { url in
                browserSignIn = true; connecting = nil; waiting = connection; authorizationURL = url
            }) {
                waiting = connection; authorizationURL = url
                openURL(url) { @Sendable accepted in
                    Task { @MainActor in
                        if !accepted { error = L("Не удалось открыть браузер. Используйте ссылку «Открыть ещё раз».") }
                    }
                }
            } else {
                await refresh()
                if availableConnections.contains(where: { $0.id == connection.id && $0.connected }) { notice = L("Connected: \(connection.name)") }
                else { error = L("Сервис ещё не подтвердил подключение. Нажмите «Обновить сервисы».") }
            }
        } catch is CancellationError { }
        catch { self.error = error.localizedDescription }
    }
    private func refresh(force: Bool = true) async {
        guard !scopeID.isEmpty else { return }
        let requestID = UUID(), scope = scopeID
        refreshID = requestID
        loading = true; error = nil
        defer { if refreshID == requestID { loading = false } }
        do {
            async let services = client.serviceConnections(for: scope, refresh: force)
            async let installed = try? client.loadExtensions(for: scope)
            let (result, packages) = try await (services, installed)
            guard refreshID == requestID, scope == scopeID else { return }
            availableConnections = result.connections; extensions = packages?.items ?? []
            extensionNotice = packages?.notice ?? result.notice ?? (packages == nil ? L("Не удалось загрузить навыки. Проверьте, что OpenStrudel на устройстве сотрудника обновлён.") : nil)
            if let waiting, availableConnections.contains(where: { $0.id == waiting.id && $0.connected }) {
                notice = L("Connected: \(waiting.name)"); self.waiting = nil; authorizationURL = nil
            }
        } catch is CancellationError { }
        catch { if refreshID == requestID { self.error = error.localizedDescription } }
    }
    private func updateExtension(_ item: EmployeeExtension, enabled: Bool? = nil) {
        changing = true; error = nil
        Task {
            defer { changing = false }
            do { try await client.changeExtension(item.id, enabled: enabled, for: scopeID); await refresh() }
            catch { self.error = error.localizedDescription }
        }
    }
    private func removeMCP(_ item: ServiceConnection) {
        changing = true; error = nil
        Task {
            defer { changing = false }
            do { try await client.removeMCP(item.id, for: scopeID); await refresh() }
            catch { self.error = error.localizedDescription }
        }
    }
}
