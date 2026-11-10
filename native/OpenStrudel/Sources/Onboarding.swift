import SwiftUI

/// First-run screens share one composition: the character, a display title, a short body and the
/// actions, in a 480-pt column whose centre sits at 40 % of the height (docs/design-system.md).
struct WelcomePage<Content: View>: View {
    /// Off where the same layout serves another window, such as Servers.
    var languageMenu = true
    @ViewBuilder var content: Content

    var body: some View {
        GeometryReader { proxy in
            ScrollView {
                OpticalCentre(height: proxy.size.height) {
                    VStack(spacing: 0) { content }
                        .frame(maxWidth: OnboardingLayout.column)
                        .padding(.horizontal, OnboardingLayout.margin)
                        // Even bands keep the content's own centre at 40 %; the top one stays clear of the
                        // language menu when the content fills the height.
                        .padding(.vertical, 64)
                }
            }
            .scrollBounceBehavior(.basedOnSize)
        }
        // The language menu belongs to the welcome screens only, never to the workspace.
        .overlay(alignment: .topTrailing) { if languageMenu { LanguagePicker().padding(OnboardingLayout.margin) } }
        // Actions choose their own ink; glass inside shared cards stays clear.
        .tint(nil)
    }
}

enum OnboardingLayout {
    static let column: CGFloat = 480
    /// The window edge on the Mac, the screen margin on iOS.
    static var margin: CGFloat {
        #if os(macOS)
        20
        #else
        22
        #endif
    }
}

/// Wraps text to the narrowest width that keeps its number of lines, so centred lines come out even
/// and no word is left alone on the last one. Leading-aligned text keeps the full column.
struct BalancedLines: SwiftUI.Layout {
    var centred = true

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        guard let text = subviews.first else { return .zero }
        let size = text.sizeThatFits(.init(width: proposal.width, height: nil))
        return CGSize(width: proposal.width ?? size.width, height: size.height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        guard let text = subviews.first else { return }
        let width = centred ? Self.balancedWidth(text, within: bounds.width) : bounds.width
        text.place(at: CGPoint(x: centred ? bounds.midX : bounds.minX, y: bounds.minY),
                   anchor: centred ? .top : .topLeading, proposal: .init(width: width, height: nil))
    }

    private static func balancedWidth(_ text: LayoutSubview, within available: CGFloat) -> CGFloat {
        let height = text.sizeThatFits(.init(width: available, height: nil)).height
        var narrow: CGFloat = 0, wide = available
        while wide - narrow > 0.5 {
            let width = (narrow + wide) / 2
            if text.sizeThatFits(.init(width: width, height: nil)).height > height + 0.5 { narrow = width } else { wide = width }
        }
        return wide
    }
}

extension String {
    /// Joins the last two words with a no-break space, so wrapped text never ends on a lone word.
    var withoutWidow: String {
        guard let space = lastIndex(of: " ") else { return self }
        return replacingCharacters(in: space...space, with: "\u{00A0}")
    }
}

/// The first-run language menu: the globe and the current language in the quiet colour. It follows
/// the interface direction, so in Hebrew it sits at the window's left.
struct LanguagePicker: View {
    @State private var relaunch = false

    var body: some View {
        let language = L10n.shared.language
        Menu {
            Picker(L("Language"), selection: LanguageChoice.binding(relaunch: $relaunch)) {
                ForEach(AppLanguage.allCases) { Text($0.title).tag($0) }
            }
            .pickerStyle(.inline)
            .labelsHidden()
        } label: {
            Label(language.title, systemImage: "globe")
                .labelStyle(.titleAndIcon)
                .font(AppTypography.interface)
                .foregroundStyle(AppTheme.secondaryText)
                .textTarget()
        }
        .menuStyle(.button)
        .buttonStyle(.plain)
        .menuIndicator(.hidden)
        .fixedSize()
        .accessibilityLabel(L("Language"))
        .accessibilityValue(language.title)
        .accessibilityIdentifier("interfaceLanguage")
        .modifier(LanguageChoice.RelaunchAlert(isPresented: $relaunch))
    }
}

/// Choosing the interface language. Text follows at once. A Mac window mirrors only when the app opens,
/// so a language that reads the other way offers a relaunch instead of half-mirroring the window.
enum LanguageChoice {
    static func binding(relaunch: Binding<Bool>) -> Binding<AppLanguage> {
        Binding {
            L10n.shared.language
        } set: { language in
            L10n.shared.language = language
            #if os(macOS)
            if language.isRightToLeft != (NSApp.userInterfaceLayoutDirection == .rightToLeft) { relaunch.wrappedValue = true }
            #endif
        }
    }

    struct RelaunchAlert: ViewModifier {
        @Binding var isPresented: Bool

        func body(content: Content) -> some View {
            #if os(macOS)
            content.alert(L("Перезапустить OpenStrudel?"), isPresented: $isPresented) {
                Button(L("Позже"), role: .cancel) {}
                Button(L("Перезапустить")) { relaunch() }.keyboardShortcut(.defaultAction)
            } message: {
                Text(L("Направление интерфейса сменится после перезапуска."))
            }
            #else
            content
            #endif
        }
    }

    #if os(macOS)
    /// Opens a fresh copy once this one has quit, so two copies never run side by side.
    private static func relaunch() {
        let reopen = Process()
        reopen.executableURL = URL(fileURLWithPath: "/bin/sh")
        reopen.arguments = ["-c", "while /bin/kill -0 \"$1\" 2>/dev/null; do /bin/sleep 0.2; done; /usr/bin/open \"$2\"",
                            "relaunch", String(ProcessInfo.processInfo.processIdentifier), Bundle.main.bundlePath]
        guard (try? reopen.run()) != nil else { return }
        NSApp.terminate(nil)
    }
    #endif
}

/// The main character and the display title.
struct WelcomeHeader: View {
    let title: String

    var body: some View {
        VStack(spacing: 24) {
            ToneAvatar(appearance: nil, size: AvatarSize.hero + 16)
            BalancedLines {
                Text(title)
                    .font(AppTypography.display).displayTracking()
                    .multilineTextAlignment(.center)
                    .accessibilityAddTraits(.isHeader)
            }
        }
    }
}

/// Body copy: centred and balanced while the whole body fits on two lines, leading-aligned once it
/// runs longer, counting the lines of every paragraph together.
struct WelcomeText: View {
    let paragraphs: [String]
    @State private var lines: [Int: Int] = [:]
    private var centred: Bool { lines.values.reduce(0, +) <= 2 }

    init(_ paragraphs: String...) { self.paragraphs = paragraphs.map(\.withoutWidow) }

    var body: some View {
        VStack(spacing: 12) {
            ForEach(paragraphs.indices, id: \.self) { index in
                BalancedLines(centred: centred) {
                    Text(paragraphs[index]).multilineTextAlignment(centred ? .center : .leading)
                }
                .background {
                    // The paragraph's height over the height of its first line alone. Balancing keeps the
                    // number of lines, so the count does not depend on the alignment it chooses.
                    GeometryReader { full in
                        Text(paragraphs[index]).lineLimit(1).hidden()
                            .onGeometryChange(for: Int.self) { line in
                                line.size.height > 0 ? Int((full.size.height / line.size.height).rounded()) : 0
                            } action: { lines[index] = $0 }
                    }
                }
            }
        }
        .font(AppTypography.interface)
        .foregroundStyle(AppTheme.secondaryText)
    }
}

struct HomeConnectingView: View {
    @EnvironmentObject private var client: HomeClient
    var body: some View {
        WelcomePage {
            WelcomeHeader(title: client.isStartingLocalHome ? L("Запускаем OpenStrudel") : L("Подключаемся к вашей команде"))
            ProgressView().padding(.top, 32).accessibilityLabel(L("Подключение"))
        }
        .accessibilityIdentifier("homeConnecting")
    }
}

#if os(macOS)
/// Home runs beside the app. It is found again automatically once it starts.
struct HomeUnavailableView: View {
    @EnvironmentObject private var client: HomeClient
    @State private var showingInvitation = false
    @State private var invitation: MacPairing?
    @State private var starting = false
    private var reconnecting: Bool { client.shouldRestoreConnection && client.connectionState == .unavailable }
    private var remote: Bool { client.isConfigured && !client.isLocalConnection }
    /// Connecting another device leads only when there is nothing to retry or start here.
    private var connectingLeads: Bool { !remote && !LocalHome.isAvailable }

    var body: some View {
        WelcomePage {
            WelcomeHeader(title: reconnecting ? L("Нет связи с OpenStrudel") : client.isSignedOut ? L("Вы вышли на этом устройстве") : L("Помощники для ваших задач"))
            WelcomeText(reconnecting
                        ? L("Пока не удаётся подключиться к вашей команде. Ваши чаты сохранены. Подключимся автоматически.")
                        : client.isSignedOut ? L("Сотрудники сохранены на своих устройствах. Подключитесь снова, чтобы продолжить.") : L("Начните на этом Mac. Создайте сотрудников или восстановите их из копии. Другие устройства можно подключить позже."))
                .padding(.top, 12)
            VStack(spacing: 8) {
                if remote {
                    Button { Task { await client.load() } } label: {
                        SetupActionLabel(title: L("Попробовать ещё раз"))
                    }.primaryAction()
                } else if LocalHome.isAvailable {
                    Button {
                        starting = true
                        Task { await client.startLocalHome(); starting = false }
                    } label: {
                        SetupActionLabel(title: starting ? L("Готовим ваш Mac…") : L("Начать на этом Mac"))
                    }.primaryAction()
                        .disabled(starting).accessibilityIdentifier("setupThisMac")
                    // Only a first start needs to say where the work will live.
                    if !reconnecting {
                        Text(L("Сотрудники и их файлы будут храниться здесь."))
                            .font(AppTypography.meta).foregroundStyle(AppTheme.secondaryText)
                            .multilineTextAlignment(.center).fixedSize(horizontal: false, vertical: true)
                    }
                } else {
                    connectButton.primaryAction()
                }
            }.padding(.top, 32)
            if !connectingLeads {
                VStack(spacing: 16) {
                    if remote, let managementURL = DigitalOceanCloud.managementURL(for: client.normalizedBaseURL) {
                        Link(destination: managementURL) {
                            Label(L("Управлять облаком"), systemImage: "arrow.up.forward")
                        }.secondaryAction()
                            .accessibilityIdentifier("manageCloudOffline")
                            .accessibilityHint(L("Открыть вашу установку в DigitalOcean"))
                    }
                    connectButton.secondaryAction()
                }
                .font(AppTypography.interface).padding(.top, 16)
            }
            HStack(spacing: 24) {
                if client.isConfigured { DeviceSignOutButton {} }
                InkLink(L("Конфиденциальность"), destination: URL(string: "https://waiwai.is/openstrudel/privacy")!)
            }
            .font(AppTypography.interface).padding(.top, 24)
        }
        .sheet(isPresented: $showingInvitation, onDismiss: {
            if let invitation { client.pendingPairing = invitation; client.pairingError = nil; self.invitation = nil }
        }) {
            ConnectDeviceView { invitation = $0 }
        }
    }

    private var connectButton: some View {
        Button { showingInvitation = true } label: {
            if connectingLeads { SetupActionLabel(title: L("Подключить другое устройство")) }
            else { Text(L("Подключить другое устройство")) }
        }
        .disabled(starting).accessibilityIdentifier("setupExisting")
    }
}
#endif

struct OpenAIWelcomeView: View {
    @EnvironmentObject private var client: HomeClient
    @Environment(\.openURL) private var openURL
    @State private var keyProviders: [ProviderSummary] = []
    @State private var keyProvider: ProviderSummary?
    var body: some View {
        WelcomePage {
            WelcomeHeader(title: client.openAIAccount?.isUnavailable == true ? L("Нет связи с OpenAI")
                          : !client.canManageOpenAI ? L("Нужен вход владельца")
                          : client.openAIAccount?.needsSignInAgain == true ? L("Войдите в OpenAI снова")
                          : L("Подключите OpenAI"))
            WelcomeText(client.openAIAccount?.isUnavailable == true
                        ? L("Проверьте подключение к интернету и попробуйте ещё раз. Ваши чаты и сотрудники сохранены.")
                        : !client.canManageOpenAI ? client.openAIRecoveryMessage
                        : client.openAIAccount?.needsSignInAgain == true
                        ? L("Сохранённый вход больше не действует. Войдите снова для сотрудников этого устройства.")
                        : L("Войдите на сайте OpenAI. Этот аккаунт будут использовать сотрудники на «\(client.displayName)»."))
                .padding(.top, 12)
            Group {
                if client.openAILogin != nil || client.openAILoginPending {
                    // The code, the browser link and cancelling live in the shared account card.
                    OpenAISettingsCard(showIdentity: false)
                } else if client.openAIAccount?.isUnavailable == true {
                    VStack(spacing: 12) {
                        error
                        Button { Task { await client.refreshOpenAIAccount(force: true) } } label: {
                            SetupActionLabel(title: L("Проверить ещё раз"))
                        }.primaryAction()
                            .accessibilityIdentifier("retryOpenAIAccount")
                    }
                } else if client.canManageOpenAI {
                    VStack(spacing: 12) {
                        error
                        Button { Task { await client.beginOpenAILogin() } } label: {
                            SetupActionLabel(title: client.isStartingOpenAILogin ? L("Открываем OpenAI…") : L("Войти в OpenAI"), icon: "arrow.up.forward")
                        }.primaryAction()
                            .disabled(client.isStartingOpenAILogin)
                            .accessibilityIdentifier("signInOpenAI")
                        if !keyProviders.isEmpty {
                            Menu {
                                ForEach(keyProviders) { provider in Button { keyProvider = provider } label: { Text(verbatim: provider.name) } }
                            } label: {
                                Text(L("У меня есть API-ключ"))
                            }
                            .menuStyle(.button).secondaryAction().menuIndicator(.hidden).fixedSize()
                            .font(AppTypography.interface).padding(.top, 4)
                            .accessibilityIdentifier("connectWithAPIKey")
                        }
                    }
                }
            }.padding(.top, 32)
        }
        // The key powers the device, so the account check goes straight to the chat.
        .sheet(item: $keyProvider) { provider in
            ProviderKeySheet(provider: provider, deviceName: client.displayName) { key in
                try await client.connectFirstProvider(provider.id, key: key)
            }
        }
        .task(id: client.health?.providers == 1 && client.canManageOpenAI) {
            guard client.health?.providers == 1, client.canManageOpenAI, let list = try? await client.providers(), list.canManage else { return }
            keyProviders = list.providers.filter(\.canAddKey)
        }
        .onChange(of: client.openAILogin) { _, login in if let url = login?.url { openURL(url) } }
        .task(id: client.openAILogin?.loginId) {
            guard client.openAILogin != nil else { return }
            while !Task.isCancelled && client.openAILogin != nil {
                try? await Task.sleep(for: .seconds(1))
                await client.pollOpenAILogin()
            }
        }
    }

    @ViewBuilder private var error: some View {
        if let error = client.openAIErrorMessage {
            Text(UserFacingError.text(error))
                .font(AppTypography.interface).foregroundStyle(AppTheme.secondaryText)
                .multilineTextAlignment(.center).fixedSize(horizontal: false, vertical: true)
        }
    }
}
