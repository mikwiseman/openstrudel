import SwiftUI

/// A full-width, wrapping action label; the system button style supplies the capsule and its states.
struct SetupActionLabel: View {
    @Environment(\.dynamicTypeSize) private var textSize
    @Environment(\.isEnabled) private var isEnabled
    @Environment(\.inkCapsule) private var inkCapsule
    let title: String
    var icon: String? = nil

    var body: some View {
        let layout = textSize.isAccessibilitySize
            ? AnyLayout(VStackLayout(spacing: 8))
            : AnyLayout(HStackLayout(spacing: 8))
        let label = layout {
            if let icon { Image(systemName: icon).accessibilityHidden(true) }
            Text(title).fixedSize(horizontal: false, vertical: true)
        }
        #if os(macOS)
        .font(AppTypography.interface)
        #else
        .font(AppTypography.interface.weight(.semibold))
        #endif
        .multilineTextAlignment(.center)
        .frame(maxWidth: .infinity)
        .contentShape(Rectangle())

        // On an enabled ink capsule the label takes the canvas colour; the disabled capsule and the
        // large-text style keep the colours the button style gives them.
        if inkCapsule && isEnabled && !textSize.isAccessibilitySize {
            label.foregroundStyle(AppTheme.canvas)
        } else {
            label
        }
    }
}

extension EnvironmentValues {
    /// Set by `primaryAction()` where the system leaves a white label on the ink (iOS).
    @Entry var inkCapsule = false
}

extension View {
    /// The one prominent action of a screen: a capsule in ink with a canvas-coloured label. On the
    /// Mac the system picks the label colour that reads on the ink and draws the inactive-window state,
    /// and Return presses it, as it presses a sheet's confirmation.
    func primaryAction() -> some View {
        adaptiveActionStyle(.glassProminent)
            .tint(AppTheme.accentText)
            .controlSize(.extraLarge)
            #if os(iOS)
            .environment(\.inkCapsule, true)
            #else
            .keyboardShortcut(.defaultAction)
            #endif
    }

    /// An action beside the primary one: plain ink text.
    func secondaryAction() -> some View {
        buttonStyle(TextActionStyle())
    }

    /// A sheet's toolbar colour. The Mac draws its default button filled in the system accent; iOS
    /// draws the confirmation action as tinted text, so there it takes the ink.
    func sheetTint() -> some View {
        #if os(iOS)
        tint(AppTheme.accentText)
        #else
        tint(nil)
        #endif
    }

    /// Gives a line of text a comfortable target. Layouts subtract `TextAction.inset` from the gaps
    /// around it, so the visible gaps between lines stay on the spacing scale.
    func textTarget() -> some View {
        #if os(macOS)
        // The pointer target grows; the layout keeps the line's own height.
        padding(.vertical, TextAction.reach).contentShape(Rectangle()).padding(.vertical, -TextAction.reach)
        #else
        frame(minHeight: TextAction.height).contentShape(Rectangle())
        #endif
    }
}

enum TextAction {
    #if os(macOS)
    /// Added above and below a line for the pointer, so the target reaches a control's 32 pt.
    static let reach: CGFloat = 8
    static let inset: CGFloat = 0
    #else
    /// The prominent capsule's height, so stacked targets are equal.
    static let height: CGFloat = 50
    /// The part of the target above and below a 22-pt line of body text.
    static let inset: CGFloat = 14
    #endif
}

/// Text that dims while pressed: ink, or the secondary colour for quiet help and footer actions.
struct TextActionStyle: ButtonStyle {
    @Environment(\.isEnabled) private var isEnabled
    var quiet = false

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .foregroundStyle(!isEnabled ? AnyShapeStyle(.tertiary)
                             : quiet ? AnyShapeStyle(AppTheme.secondaryText) : AnyShapeStyle(AppTheme.accentText))
            .opacity(configuration.isPressed ? 0.6 : 1)
            .textTarget()
    }
}

/// The top of a setup sheet: the character, a display title and its explanation on the form's edge.
struct SetupHeader: View {
    let title: String
    let paragraphs: [String]

    init(title: String, paragraphs: [String]) {
        self.title = title
        self.paragraphs = paragraphs.map(\.withoutWidow)
    }

    init(title: String, _ paragraphs: String...) { self.init(title: title, paragraphs: paragraphs) }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            AgentAvatar(appearance: nil, size: AvatarSize.hero)
            Text(title)
                .font(AppTypography.display).foregroundStyle(Color.primary)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityAddTraits(.isHeader)
                .padding(.top, 24)
            VStack(alignment: .leading, spacing: 12) {
                ForEach(paragraphs, id: \.self) { Text($0).fixedSize(horizontal: false, vertical: true) }
            }
            .font(AppTypography.interface).fontWeight(.regular)
            .foregroundStyle(AppTheme.secondaryText)
            .padding(.top, 12)
        }
        .textCase(nil)
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.bottom, 8)
    }
}

#if os(macOS)
/// Cloud setup keeps the provider's account and billing in the user's name. It is a page of the
/// Connect a device sheet, which owns Back and Cancel; `working` tells the sheet while setup runs.
struct ServerSetupView: View {
    @EnvironmentObject private var library: DeviceLibrary
    @StateObject private var cloud = DigitalOceanCloud.shared
    @State private var connecting = false
    @State private var connectionError: String?
    @State private var confirmingStartOver = false
    @Binding var working: Bool
    let onConnected: (HomeClient) -> Void

    private var isWorking: Bool {
        [.signingIn, .creating, .waitingForServer].contains(cloud.phase)
    }

    private var title: String {
        switch cloud.phase {
        case .idle: L("Сотрудники в облаке")
        case .signingIn: L("Войдите в DigitalOcean")
        case .billingRequired: L("Подключите оплату")
        case .readyToCreate: L("Всё готово к запуску")
        case .creating, .waitingForServer: L("Готовим вашу команду")
        case .connected: L("Всё готово")
        case .failed: L("Настройка не завершена")
        }
    }

    private var explanation: String {
        switch cloud.phase {
        case .idle:
            L("Сотрудники смогут работать, когда Mac выключен. Размещение предоставляет DigitalOcean. Для начала войдите в свой аккаунт или создайте его.")
        case .signingIn:
            L("Завершите вход в открывшемся окне. Пароль получает только DigitalOcean.")
        case .billingRequired:
            L("Добавьте способ оплаты на сайте DigitalOcean, затем вернитесь сюда. Данные карты остаются у провайдера.")
        case .readyToCreate:
            L("OpenStrudel установится на отдельном сервере в вашем аккаунте DigitalOcean. Проверьте стоимость перед запуском.")
        case .creating, .waitingForServer:
            L("Обычно настройка занимает несколько минут. Можно закрыть окно и вернуться позже. Прогресс сохранится.")
        case .connected:
            L("Открываем OpenStrudel. Дальше останется войти в свой аккаунт OpenAI.")
        case .failed:
            L("Ваш прогресс сохранён. Продолжите настройку, когда будете готовы.")
        }
    }

    private var notes: [String] {
        var notes: [String] = []
        if cloud.phase == .idle {
            notes.append(L("Понадобится аккаунт DigitalOcean и способ оплаты. Стоимость покажем до запуска."))
        }
        if cloud.phase == .readyToCreate, cloud.quote != nil {
            notes.append(L("Оплата напрямую DigitalOcean. Подписка ChatGPT оплачивается отдельно."))
            notes.append(L("Начисляется за время размещения, пока вы не удалите его в DigitalOcean. Налоги могут добавляться отдельно."))
        }
        if cloud.managementURL != nil, cloud.phase != .connected {
            notes.append(L("Размещение оплачивается, пока вы не удалите его в DigitalOcean."))
        }
        return notes
    }

    var body: some View {
        Form {
            Section {
                if cloud.phase == .readyToCreate, let quote = cloud.quote {
                    LabeledContent {
                        Text(quote.monthlyPrice.formatted(.currency(code: "USD")) + L(" / месяц")).monospacedDigit()
                    } label: { Text(verbatim: "DigitalOcean") }
                }
                if isWorking {
                    HStack(spacing: 8) {
                        ProgressView().controlSize(.small)
                        Text(cloud.phase == .signingIn ? L("Ожидаем входа") : L("Настраиваем OpenStrudel"))
                            .foregroundStyle(AppTheme.secondaryText)
                    }.accessibilityElement(children: .combine)
                }
                if let message = connectionError ?? cloud.message {
                    Text(message).foregroundStyle(AppTheme.secondaryText)
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityIdentifier("cloudSetupMessage")
                }
                if cloud.phase == .signingIn, let url = cloud.authorizationURL {
                    SetupLinkRow(title: L("Открыть вход в браузере"), url: url)
                }
                if cloud.phase == .billingRequired {
                    SetupLinkRow(title: L("Добавить способ оплаты"), url: URL(string: "https://cloud.digitalocean.com/account/billing")!)
                }
                if let url = cloud.managementURL, cloud.phase != .connected {
                    SetupLinkRow(title: L("Открыть в DigitalOcean"), url: url)
                }
                if cloud.canStartOver {
                    Button(L("Начать заново…")) { confirmingStartOver = true }
                        .accessibilityIdentifier("cloudStartOver")
                }
            } header: {
                SetupHeader(title: title, explanation)
            } footer: {
                if !notes.isEmpty {
                    VStack(alignment: .leading, spacing: 8) {
                        ForEach(notes, id: \.self) { Text($0.withoutWidow).fixedSize(horizontal: false, vertical: true) }
                    }
                }
            }
        }
        .formStyle(.grouped)
        .confirmationDialog(L("Начать установку заново?"), isPresented: $confirmingStartOver, titleVisibility: .visible) {
            Button(L("Сервер удалён")) { Task { await cloud.startOver() } }
            Button(L("Отмена"), role: .cancel) {}
        } message: {
            Text(L("Сначала удалите сервер в DigitalOcean. OpenStrudel проверит, что его там больше нет, и забудет эту установку. Новый сервер запустится только после того, как вы подтвердите стоимость."))
        }
        // Its header is the page's title in the content, so the bar keeps only Back.
        .sheetPageTitle(L("Get a server with DigitalOcean"))
        .toolbar {
            if hasPrimaryAction {
                ToolbarItem(placement: .confirmationAction) { primaryAction }
            }
        }
        .task {
            await cloud.resume()
            await finishConnection()
        }
        .onChange(of: cloud.connection?.url) { _, _ in
            Task { await finishConnection() }
        }
        .onChange(of: isWorking, initial: true) { _, value in working = value }
        // Back and Cancel both leave the page; setup that is under way continues and resumes here.
        .onDisappear { cloud.cancel(); working = false }
    }

    private var hasPrimaryAction: Bool {
        switch cloud.phase {
        case .signingIn, .creating, .waitingForServer: false
        case .connected: connectionError != nil
        case .idle, .billingRequired, .readyToCreate, .failed: true
        }
    }

    /// The one step that moves setup forward, in the sheet's confirmation place.
    @ViewBuilder private var primaryAction: some View {
        switch cloud.phase {
        case .idle:
            Button(L("Продолжить с DigitalOcean")) { Task { await cloud.signIn() } }
                .accessibilityIdentifier("cloudSignIn")
        case .billingRequired:
            Button(L("Продолжить")) { Task { await cloud.resume() } }
        case .readyToCreate:
            Button(L("Подтвердить и запустить")) { Task { await cloud.confirmCreate() } }
                .accessibilityIdentifier("cloudConfirmCost")
        case .failed:
            Button(L("Продолжить настройку")) { Task { await cloud.resume() } }
        case .connected:
            if connectionError != nil {
                Button(L("Открыть команду")) { Task { await finishConnection() } }.disabled(connecting)
            }
        case .signingIn, .creating, .waitingForServer:
            EmptyView()
        }
    }

    private func finishConnection() async {
        guard let connection = cloud.connection, !connecting else { return }
        connecting = true
        defer { connecting = false }
        let client = library.clients.first { $0.savedBaseURL == connection.url } ?? library.newConnection()
        if await client.connectToCloud(connection) {
            library.add(client, select: false)
            onConnected(client)
        } else {
            connectionError = client.pairingError ?? L("Не удалось сохранить подключение. Разблокируйте устройство и попробуйте ещё раз.")
        }
    }
}

/// A form row that opens a page in the browser.
private struct SetupLinkRow: View {
    let title: String
    let url: URL

    var body: some View {
        Link(destination: url) {
            Label {
                Text(title).underline(color: AppTheme.secondaryText)
            } icon: {
                Image(systemName: "arrow.up.forward")
            }
        }
        .foregroundStyle(AppTheme.accentText)
    }
}

/// Both server routes finish with the same account step and first assistant.
struct ServerAccountSetupView: View {
    @EnvironmentObject private var client: HomeClient
    @EnvironmentObject private var library: DeviceLibrary
    @Environment(\.openURL) private var openURL
    @Environment(\.openWindow) private var openWindow
    let onDone: () -> Void
    private var connected: Bool { client.openAIAccount?.connected == true && !client.homeUnreachable }
    /// Signing in is the next step: it takes the sheet's confirmation place. Once a sign-in is under
    /// way, the account card in the form carries the code and the browser link.
    private var readyToSignIn: Bool {
        !connected && !client.homeUnreachable && client.canManageOpenAI && client.openAILogin == nil
            && !client.openAILoginPending && client.openAIAccount?.isUnavailable != true
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    LabeledContent(L("Server"), value: client.displayName)
                    if connected, let provider = client.openAIAccount?.keyProviderName {
                        LabeledContent { Text(client.openAIAccount?.signsIn == true ? L("Подписка") : L("API-ключ")) } label: { Text(verbatim: provider) }
                    } else if connected, let account = client.openAIAccount {
                        LabeledContent {
                            VStack(alignment: .trailing, spacing: 2) {
                                Text(account.email ?? "ChatGPT").textSelection(.enabled)
                                let plan = [account.planLabel, account.categoryLabel].compactMap { $0 }.joined(separator: " · ")
                                if !plan.isEmpty { Text(plan).font(AppTypography.meta) }
                            }
                        } label: { Text(verbatim: "ChatGPT") }
                    }
                    if !connected && client.homeUnreachable {
                        Text(L("The server did not respond. Your installation is saved."))
                            .foregroundStyle(AppTheme.secondaryText)
                    }
                    if readyToSignIn, let error = client.openAIErrorMessage {
                        Text(UserFacingError.text(error)).foregroundStyle(AppTheme.secondaryText)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                } header: {
                    SetupHeader(title: connected ? L("Your server is ready") : L("Connect ChatGPT"),
                                connected ? L("Your assistants can now work here, even when your Mac is off.")
                                    : L("OpenStrudel is installed. Sign in to ChatGPT to let your assistants work on this server."))
                }
                if !connected && !client.homeUnreachable && !readyToSignIn {
                    Section { OpenAISettingsCard(showIdentity: false) }
                }
            }
            .formStyle(.grouped)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(connected ? L("Open server") : L("Продолжить позже")) { finish(createAssistant: false) }
                }
                if connected {
                    ToolbarItem(placement: .confirmationAction) {
                        Button(L("Create an assistant here")) {
                            finish(createAssistant: true)
                        }.accessibilityIdentifier("createFirstServerAssistant")
                    }
                } else if client.homeUnreachable {
                    ToolbarItem(placement: .confirmationAction) {
                        Button(L("Повторить")) { Task { await client.load(quiet: true) } }
                    }
                } else if readyToSignIn {
                    ToolbarItem(placement: .confirmationAction) {
                        Button(client.isStartingOpenAILogin ? L("Открываем OpenAI…") : L("Войти в OpenAI")) {
                            Task { await client.beginOpenAILogin() }
                        }
                        .disabled(client.isStartingOpenAILogin)
                        .accessibilityIdentifier("signInOpenAI")
                    }
                }
            }
        }
        .tint(nil)
        .onChange(of: client.openAILogin) { _, login in if let url = login?.url { openURL(url) } }
        .task(id: client.openAILogin?.loginId) {
            await client.refreshOpenAIAccount()
            while !Task.isCancelled && !connected && (client.openAILogin != nil || client.openAILoginPending) {
                if client.openAILogin != nil { await client.pollOpenAILogin() }
                else { await client.refreshOpenAIAccount() }
                do { try await Task.sleep(for: .seconds(2)) } catch { break }
            }
        }
    }

    private func finish(createAssistant: Bool) {
        onDone()
        // A new employee is asked for in the chat; the device just connected becomes the chat's Home only when it is the first.
        if !library.hasOtherDevices { library.select(client) }
        #if os(macOS)
        Task { @MainActor in
            await Task.yield()
            openWindow(id: "home")
        }
        #endif
    }
}

#endif

struct AIDataConsentView: View {
    @Environment(\.dynamicTypeSize) private var textSize
    let accept: () -> Void

    var body: some View {
        WelcomePage {
            WelcomeHeader(title: L("Ваши данные"))
            WelcomeText(L("Чаты хранятся на вашем Mac или сервере. Для ответов OpenAI или другой выбранный вами провайдер получает сообщения, нужную часть переписки и выбранные файлы."),
                        L("Другие сервисы получают данные только при обращении к ним."))
                .padding(.top, 12)
            InkLink(L("Подробнее о данных"), destination: URL(string: "https://waiwai.is/openstrudel/privacy")!)
                .font(AppTypography.interface)
                .padding(.top, 12 - TextAction.inset)
        } actions: {
            Button(action: accept) {
                SetupActionLabel(title: textSize.isAccessibilitySize ? L("Разрешить") : L("Разрешить и продолжить"))
            }
                .primaryAction()
                .accessibilityLabel(L("Разрешить и продолжить"))
                .accessibilityIdentifier("acceptAIDataSharing")
                .padding(.top, 32 - TextAction.inset)
        }
    }
}
