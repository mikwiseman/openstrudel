import SwiftUI
import CoreImage.CIFilterBuiltins
#if os(iOS)
import VisionKit
import AVFoundation
#endif

/// Sharing starts in one place; the owner chooses their device or a colleague.
/// Existing connections and invitations follow the same action on both platforms.
struct MobilePairingSettings: View {
    @EnvironmentObject private var client: HomeClient
    @State private var showingCode = false
    @State private var creating = false
    @State private var revokeConfirmation = false
    @State private var invitationOwner = true
    @State private var choosingAccess = false

    var body: some View {
        #if os(macOS)
        HStack {
            linkButton
            Spacer()
        }
        #else
        linkButton
        #endif
        if client.supportsColleagueInvites {
            ForEach(client.mobileClients) { MobileClientRow(item: $0) }
            ForEach(client.waitingInvitations) { WaitingInvitationRow(item: $0) }
        } else if client.isLocalConnection && client.mobileConnections > 0 {
            LabeledContent {
                Button(L("Отключить"), role: .destructive) { revokeConfirmation = true }
                    .confirmationDialog(L("Отключить другие устройства? Чаты и сотрудники сохранятся."), isPresented: $revokeConfirmation) {
                        Button(L("Отключить"), role: .destructive) { Task { await client.revokeMobile() } }
                    }
            } label: {
                Text(L("Подключено других устройств: \(client.mobileConnections)")).monospacedDigit()
            }
        }
    }

    // Always present: this row also learns whether the device lets this app create links.
    private var linkButton: some View {
        Button(creating ? L("Готовим ссылку…") : L("Поделиться доступом…")) {
            choosingAccess = true
        }
        .accessibilityIdentifier("shareDeviceAccess")
        .disabled(creating || !(client.isLocalConnection || client.canManageConnections))
        .confirmationDialog(L("Кому дать доступ?"), isPresented: $choosingAccess, titleVisibility: .visible) {
            Button(L("Моему устройству")) { createInvitation(owner: true) }
            Button(L("Коллеге")) { createInvitation(owner: false) }
        } message: {
            Text(L("На своём устройстве вы сохраните все права. Коллега сможет работать с сотрудниками, но не управлять аккаунтами и доступом."))
        }
        .task { await client.refreshMobileStatus() }
        .sheet(isPresented: $showingCode, onDismiss: { Task { await client.cancelMobileInvitation(colleague: !invitationOwner) } }) {
            MobileQRCodeView(owner: invitationOwner).environmentObject(client).modifier(InterfaceLanguage())
        }
    }

    private func createInvitation(owner: Bool) {
        creating = true; invitationOwner = owner
        Task {
            await client.inviteMobile(owner: owner)
            showingCode = client.mobileInvitation != nil
            creating = false
        }
    }
}

/// One device paired with this Home. The owner disconnects any other device on its own, a lost
/// phone of their own included; the device asking keeps its access.
private struct MobileClientRow: View {
    @EnvironmentObject private var client: HomeClient
    let item: MobileClient
    @State private var confirming = false
    @State private var error: String?
    private var name: String { item.label ?? L("Устройство") }

    var body: some View {
        LabeledContent {
            if item.canDisconnect {
                Button(L("Отключить"), role: .destructive) { confirming = true }
                    .accessibilityIdentifier("disconnectClient-" + item.id)
                    .confirmationDialog(L("Отключить «\(name)»?"), isPresented: $confirming) {
                        Button(L("Отключить"), role: .destructive) {
                            Task {
                                do { try await client.revokeMobileClient(item.id); error = nil }
                                catch { self.error = error.localizedDescription }
                            }
                        }
                    } message: {
                        Text(item.isColleague ? L("Коллега больше не сможет открыть сотрудников этого устройства. Чаты и сотрудники сохранятся.")
                             : L("Устройство больше не сможет открыть сотрудников и управлять доступом. Чаты и сотрудники сохранятся."))
                    }
            }
        } label: {
            Text(name)
            Text(detail).monospacedDigit()
            if let error { Text(UserFacingError.text(error)).foregroundStyle(AppTheme.warning) }
        }
    }

    private var detail: String {
        [item.isColleague ? L("Коллега") : L("Владелец"),
         item.pairedDate.map { L("подключено \($0.formatted(.dateTime.day().month(.abbreviated).year().locale(L10n.locale)))") },
         item.current == true ? L("это устройство") : nil].compactMap { $0 }.joined(separator: " · ")
    }
}

/// A link nobody has used yet, the owner's own or a colleague's. Cancelling it ends the link at once.
private struct WaitingInvitationRow: View {
    @EnvironmentObject private var client: HomeClient
    let item: WaitingInvitation
    @State private var error: String?

    var body: some View {
        LabeledContent {
            Button(L("Отменить"), role: .destructive) {
                Task {
                    do { try await client.cancelInvitation(item.id); error = nil }
                    catch { self.error = error.localizedDescription }
                }
            }
            .accessibilityIdentifier("cancelInvitation-" + item.id)
        } label: {
            Text(item.isOwner ? L("Ссылка для своего устройства") : item.label ?? L("Ссылка для коллеги"))
            if let expiry = item.expiryDate {
                Text(L("действует до \(expiry.formatted(.dateTime.day().month(.abbreviated).hour().minute().locale(L10n.locale)))")).monospacedDigit()
            }
            if let error { Text(UserFacingError.text(error)).foregroundStyle(AppTheme.warning) }
        }
    }
}

/// A one-use link as a code and a share action. On the Mac the code sits beside its words so the
/// sheet fits inside the Settings window; on iOS they stack.
private struct MobileQRCodeView: View {
    let owner: Bool
    @EnvironmentObject private var client: HomeClient
    @Environment(\.dismiss) private var dismiss
    @State private var initialCount = 0
    @State private var refreshing = false

    var body: some View {
        let invitation = client.mobileInvitation
        let code = invitation.flatMap { qr($0.shareURL.absoluteString) }
        NavigationStack {
            TimelineView(.periodic(from: .now, by: 1)) { context in
                let remaining = invitation?.remainingSeconds(at: context.date) ?? 0
                #if os(macOS)
                VStack(alignment: .leading, spacing: 24) {
                    HStack(spacing: 24) {
                        codeView(remaining > 0 ? code : nil)
                        VStack(alignment: .leading, spacing: 12) {
                            title
                            Text(L("Наведите камеру телефона на QR-код или откройте ссылку на другом устройстве.").withoutWidow)
                            status(remaining)
                            HStack(spacing: 16) { actions(remaining > 0 ? invitation : nil) }.padding(.top, 12)
                        }
                        .fixedSize(horizontal: false, vertical: true)
                    }
                    Text(accessDescription.replacingOccurrences(of: "\n", with: " ").withoutWidow)
                        .font(AppTypography.meta).foregroundStyle(AppTheme.secondaryText)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .font(AppTypography.interface).foregroundStyle(AppTheme.secondaryText)
                .multilineTextAlignment(.leading)
                .padding(24)
                #else
                ScrollView {
                    VStack(spacing: 16) {
                        title
                        Text(L("Наведите камеру телефона на QR-код или откройте ссылку на другом устройстве."))
                        codeView(remaining > 0 ? code : nil).padding(.vertical, 8)
                        status(remaining)
                        actions(remaining > 0 ? invitation : nil)
                        Text(accessDescription)
                            .font(AppTypography.meta).padding(.top, 16)
                    }
                    .font(AppTypography.interface).foregroundStyle(AppTheme.secondaryText)
                    .multilineTextAlignment(.center)
                    .padding(24).frame(maxWidth: 420).frame(maxWidth: .infinity)
                }
                #endif
            }
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button(L("Готово")) { dismiss() }.keyboardShortcut(.defaultAction)
                        .accessibilityIdentifier("closeMobileInvitation")
                }
            }
        }
        .sheetTint()
        #if os(macOS)
        .frame(width: Sheet.width)
        .presentationSizing(.fitted)
        #endif
        .task {
            initialCount = client.mobileConnections
            while !Task.isCancelled {
                await client.refreshMobileStatus()
                if client.mobileConnections > initialCount { dismiss(); break }
                do { try await Task.sleep(for: .seconds(1)) } catch { break }
            }
        }
    }

    private var title: some View {
        Text(owner ? L("Продолжите на другом устройстве") : L("Пригласите коллегу")).font(AppTypography.title).foregroundStyle(Color.primary)
            .accessibilityAddTraits(.isHeader)
    }

    private var accessDescription: String {
        if owner { return L("Ссылка открывает чаты и настройки сотрудников.\nИспользуйте её только на своих устройствах.") }
        let access = L("Коллега получит доступ ко всем чатам, файлам и настройкам сотрудников этого устройства. Управление аккаунтами и доступом останется у вас. Приглашайте каждого по отдельной ссылке.")
        return client.mobileInvitation?.isLocalNetworkOnly == true ? access + "\n" + L("Ссылка работает только в той же сети Wi-Fi, что и это устройство.") : access
    }

    /// The code on white so any camera reads it; once the link expires, an empty tile of the same size.
    private func codeView(_ code: CGImage?) -> some View {
        let shape = RoundedRectangle(cornerRadius: Radius.card, style: .continuous)
        return Group {
            if let code {
                Image(decorative: code, scale: 1).interpolation(.none).resizable().scaledToFit()
                    .padding(16).background(.white, in: shape)
                    .accessibilityElement().accessibilityLabel(L("Одноразовая ссылка подключения OpenStrudel"))
            } else {
                Image(systemName: "qrcode").font(.system(size: 48)).foregroundStyle(.tertiary)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .background(AppTheme.surface, in: shape)
                    .accessibilityHidden(true)
            }
        }
        .frame(maxWidth: Self.codeSize, maxHeight: Self.codeSize)
        .aspectRatio(1, contentMode: .fit)
    }

    private static var textAlignment: HorizontalAlignment {
        #if os(macOS)
        .leading
        #else
        .center
        #endif
    }

    private static var codeSize: CGFloat {
        #if os(macOS)
        216
        #else
        268
        #endif
    }

    @ViewBuilder private func status(_ remaining: Int) -> some View {
        if remaining > 0 && client.keepsInvitation(owner: owner) {
            // The link outlives this sheet, so a countdown would only distract.
            Text(L("Ссылка действует сутки и подключает одно устройство.")).font(AppTypography.meta)
        } else if remaining > 0 {
            // One argument, so in Hebrew the minutes and seconds stay in reading order.
            let time = "\(remaining / 60):\(String(format: "%02d", remaining % 60))"
            Text(L("Link expires in \(time)"))
                .font(AppTypography.meta).monospacedDigit()
        } else {
            VStack(alignment: Self.textAlignment, spacing: 4) {
                Text(L("Срок ссылки истёк")).foregroundStyle(Color.primary)
                Text(L("Получите новую, чтобы подключить устройство."))
            }
        }
    }

    /// Share leads while the link is valid; afterwards a new link is the only step.
    @ViewBuilder private func actions(_ invitation: MobileInvitation?) -> some View {
        if let invitation {
            ShareLink(item: invitation.shareURL) {
                AdaptiveActionLabel(title: L("Поделиться ссылкой")).foregroundStyle(.primary)
            }
                .adaptiveActionStyle(.glass)
        }
        Button {
            refreshing = true
            Task { await client.inviteMobile(owner: owner); refreshing = false }
        } label: {
            Text(refreshing ? L("Обновляем…") : L("Новая ссылка"))
        }
        .secondaryAction().disabled(refreshing)
    }

    private func qr(_ value: String) -> CGImage? {
        let filter = CIFilter.qrCodeGenerator()
        filter.message = Data(value.utf8)
        filter.correctionLevel = "M"
        guard let output = filter.outputImage else { return nil }
        return CIContext().createCGImage(output, from: output.extent)
    }
}
#if os(iOS)
struct MobileWelcomeView: View {
    @EnvironmentObject private var client: HomeClient
    @State private var enteringInvitation = false
    @State private var invitation: MacPairing?
    @State private var cameraError: String?
    @State private var showingHelp = false
    private var reconnecting: Bool { client.isConfigured && !client.connectionNeedsPairing }

    var body: some View {
        WelcomePage {
            WelcomeHeader(title: client.connectionNeedsPairing ? L("Подключитесь снова.") : client.isConfigured ? L("Нет связи с OpenStrudel") : client.isSignedOut ? L("Устройство отключено") : L("Ваши AI-помощники"))
            WelcomeText(client.connectionNeedsPairing ? L("Подключение отозвано. Получите новую ссылку на устройстве с сотрудниками.") : client.isConfigured
                        ? L("«\(client.connectionName)» пока не на связи. Подключимся автоматически.")
                        : L("Пишите, планируйте и обсуждайте идеи. Подключите свой Mac или сервер с OpenStrudel, чтобы продолжить те же чаты здесь."))
                .padding(.top, 12)
            if reconnecting {
                ProgressView().padding(.top, 24).accessibilityLabel(L("Восстанавливаем связь"))
            }
        } actions: {
            Group {
                if reconnecting {
                    Button { Task { await client.load(quiet: true) } } label: {
                        SetupActionLabel(title: L("Проверить соединение"))
                    }.primaryAction()
                        .disabled(client.isLoading).accessibilityIdentifier("retryHomeConnection")
                } else {
                    // Scanning the code another device shows is the way in, so it leads unless a retry does.
                    scanButton.primaryAction()
                }
            }.padding(.top, 32)
            VStack(spacing: 0) {
                if reconnecting { scanButton.secondaryAction() }
                Button { enteringInvitation = true } label: {
                    SetupActionLabel(title: L("Вставить ссылку"), icon: "link")
                }.secondaryAction()
                    .accessibilityLabel(L("Вставить ссылку подключения")).accessibilityIdentifier("pasteInvitation")
                if let cameraError {
                    Text(L10n.serviceText(cameraError)).font(AppTypography.meta).foregroundStyle(AppTheme.secondaryText)
                        .multilineTextAlignment(.center).fixedSize(horizontal: false, vertical: true)
                }
            }
            // Text actions are as tall as the capsule; the gaps subtract that, so the words sit 16 below it.
            .padding(.top, 16 - TextAction.inset)
            VStack(spacing: 0) {
                if client.isConfigured { DeviceSignOutButton {}.frame(minHeight: controlTarget) }
                Button { showingHelp = true } label: {
                    Text(L("Как начать?"))
                        .multilineTextAlignment(.center)
                        .fixedSize(horizontal: false, vertical: true)
                        .frame(maxWidth: .infinity)
                }.buttonStyle(TextActionStyle(quiet: true))
                    .accessibilityIdentifier("invitationHelp")
            }
            .font(AppTypography.interface).padding(.top, 32 - 2 * TextAction.inset)
        }
        .sheet(isPresented: $enteringInvitation, onDismiss: confirmInvitation) {
            ConnectionInvitationView { invitation = $0 }
        }
        .sheet(isPresented: $showingHelp) {
            MobileConnectionHelpView()
        }
    }

    private var scanButton: some View {
        ScanInvitationButton(error: $cameraError) { invitation = $0; confirmInvitation() }
    }

    private func confirmInvitation() {
        guard let invitation else { return }
        client.pendingPairing = invitation
        client.pairingError = nil
        self.invitation = nil
    }

}

/// The same scanner is available during first setup and when adding another device.
private struct ScanInvitationButton: View {
    @Environment(\.dynamicTypeSize) private var textSize
    @Binding var error: String?
    let onScan: (MacPairing) -> Void
    @State private var scanning = false
    @State private var scanned: MacPairing?
    @State private var rejected = false

    var body: some View {
        Button { Task { await openScanner() } } label: {
            SetupActionLabel(title: textSize.isAccessibilitySize ? L("QR-код") : L("Сканировать QR"), icon: "qrcode.viewfinder")
        }
        .accessibilityLabel(L("Сканировать QR")).accessibilityIdentifier("scanInvitation")
        .fullScreenCover(isPresented: $scanning, onDismiss: {
            if let scanned { self.scanned = nil; onScan(scanned) }
        }) {
            NavigationStack {
                QRScanner { value in
                    if let url = URL(string: value), let pairing = try? MacPairing(url: url) {
                        scanned = pairing; scanning = false
                    }
                } rejected: {
                    rejected = true
                } failed: {
                    error = L("Камера недоступна. Вставьте ссылку подключения.")
                    scanning = false
                }
                .ignoresSafeArea(edges: .bottom)
                .overlay(alignment: .bottom) {
                    // Another code keeps the scanner open; say why nothing happens.
                    if rejected {
                        Text(L("Это не QR-код подключения OpenStrudel."))
                            .font(AppTypography.interface).multilineTextAlignment(.center)
                            .padding(.horizontal, 16).padding(.vertical, 10)
                            .background(.regularMaterial, in: Capsule())
                            .padding(.horizontal, 24).padding(.bottom, 32)
                            .accessibilityIdentifier("invalidInvitationCode")
                    }
                }
                .navigationTitle(L("Сканируйте QR подключения"))
                .navigationBarTitleDisplayMode(.inline)
                .toolbar { ToolbarItem(placement: .cancellationAction) { Button(L("Отмена")) { scanning = false } } }
            }
        }
    }

    private func openScanner() async {
        error = nil; rejected = false
        guard DataScannerViewController.isSupported else {
            error = L("На этом устройстве вставьте ссылку подключения.")
            return
        }
        let granted = await AVCaptureDevice.requestAccess(for: .video)
        guard granted, DataScannerViewController.isAvailable else {
            error = L("Разрешите доступ к камере в настройках устройства или вставьте ссылку.")
            return
        }
        scanning = true
    }
}

/// Connection help stays in the companion app and has no signup or payment route.
struct MobileConnectionHelpView: View {
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    topic(L("Начните на своём Mac"),
                          L("Установите бесплатный OpenStrudel с waiwai.is/openstrudel. Войдите в свой аккаунт OpenAI и создайте AI-помощника для личных или рабочих задач."),
                          L("Регистрация в OpenStrudel не нужна. Ссылку для своего iPhone или iPad вы создаёте сами."))
                    topic(L("Где получить ссылку"),
                          L("На Mac с сотрудниками откройте OpenStrudel → Настройки → Устройства. Выберите устройство → Поделиться доступом."),
                          L("Для сервера откройте его веб-интерфейс → Настройки → Устройства."))
                    topic(L("Как подключиться"),
                          L("Отсканируйте QR или вставьте ссылку в OpenStrudel на этом устройстве."),
                          L("Ссылка одноразовая и действует сутки. Если срок истёк, получите новую."))
                    topic(L("Если нет связи"),
                          L("Устройство с сотрудниками должно быть включено и доступно по сети. Для подключения по локальной сети используйте один Wi-Fi."),
                          L("Связь восстановится автоматически. Новая ссылка нужна, только если подключение отозвано."))
                }
                .padding(.horizontal, OnboardingLayout.margin).padding(.vertical, 24)
                .frame(maxWidth: OnboardingLayout.column, alignment: .leading)
                .frame(maxWidth: .infinity)
            }
            .navigationTitle(L("Подключение устройства"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button(L("Готово")) { dismiss() }.accessibilityIdentifier("closeConnectionHelp")
                }
            }
        }
        .sheetTint()
    }

    private func topic(_ title: String, _ paragraphs: String...) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title).font(.headline).foregroundStyle(Color.primary).accessibilityAddTraits(.isHeader)
            VStack(alignment: .leading, spacing: 12) {
                ForEach(paragraphs, id: \.self) { Text($0) }
            }
            .font(AppTypography.interface).foregroundStyle(AppTheme.secondaryText)
        }
        .fixedSize(horizontal: false, vertical: true)
    }
}

private struct QRScanner: UIViewControllerRepresentable {
    let found: (String) -> Void
    let rejected: () -> Void
    let failed: () -> Void
    func makeCoordinator() -> Coordinator { Coordinator(found: found, rejected: rejected, failed: failed) }
    func makeUIViewController(context: Context) -> DataScannerViewController {
        let scanner = DataScannerViewController(recognizedDataTypes: [.barcode(symbologies: [.qr])], qualityLevel: .balanced,
            recognizesMultipleItems: false, isHighFrameRateTrackingEnabled: false, isPinchToZoomEnabled: true, isGuidanceEnabled: true, isHighlightingEnabled: true)
        scanner.delegate = context.coordinator
        do { try scanner.startScanning() }
        catch { Task { @MainActor in failed() } }
        return scanner
    }
    func updateUIViewController(_ controller: DataScannerViewController, context: Context) {}
    static func dismantleUIViewController(_ controller: DataScannerViewController, coordinator: Coordinator) { controller.stopScanning() }
    final class Coordinator: NSObject, DataScannerViewControllerDelegate {
        let found: (String) -> Void
        let rejected: () -> Void
        let failed: () -> Void
        private var used = false
        init(found: @escaping (String) -> Void, rejected: @escaping () -> Void, failed: @escaping () -> Void) {
            self.found = found; self.rejected = rejected; self.failed = failed
        }
        func dataScanner(_ dataScanner: DataScannerViewController, becameUnavailableWithError error: DataScannerViewController.ScanningUnavailable) { failed() }
        func dataScanner(_ dataScanner: DataScannerViewController, didAdd addedItems: [RecognizedItem], allItems: [RecognizedItem]) {
            guard !used else { return }
            for item in addedItems {
                guard case .barcode(let barcode) = item, let value = barcode.payloadStringValue else { continue }
                if let url = URL(string: value), (try? MacPairing(url: url)) != nil {
                    used = true; dataScanner.stopScanning(); found(value); break
                }
                rejected()
            }
        }
    }
}

/// The same scanner and link entry for the first and every additional device.
struct ConnectionInvitationView: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL
    @Environment(\.dynamicTypeSize) private var textSize
    let onConfirm: (MacPairing) -> Void
    @State private var invitation = ""
    @State private var error: String?
    @State private var openingPage = false
    @FocusState private var focused: Bool

    private var connectionPage: URL? {
        guard let url = URL(string: invitation.trimmingCharacters(in: .whitespacesAndNewlines)),
              url.scheme?.lowercased() == "https", let host = url.host, !host.isEmpty,
              url.user == nil, url.password == nil, (try? MacPairing(url: url)) == nil else { return nil }
        return url
    }

    private var continueTitle: String {
        openingPage ? L("Открываем…") : connectionPage == nil ? L("Продолжить") : L("Открыть страницу")
    }

    private var canContinue: Bool {
        !openingPage && !invitation.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private var help: String {
        L("На устройстве с сотрудниками откройте Настройки → Устройства → Поделиться доступом. Отсканируйте QR-код или вставьте ссылку сюда.")
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    ScanInvitationButton(error: $error) { onConfirm($0); dismiss() }
                        .accessibilityIdentifier("scanAdditionalInvitation")
                    // The largest text gives the field the full width, with Paste below it.
                    let row = textSize.isAccessibilitySize ? AnyLayout(VStackLayout(alignment: .leading, spacing: 8)) : AnyLayout(HStackLayout(spacing: 8))
                    row {
                        SecureField(L("Ссылка подключения"), text: $invitation, prompt: Text(L("Ссылка подключения")))
                            .labelsHidden()
                            .focused($focused).accessibilityIdentifier("connectionInvitation")
                            .textInputAutocapitalization(.never).autocorrectionDisabled().submitLabel(.continue)
                            // The field is only as tall as its line; the rest of the 44-pt target focuses it too.
                            .frame(minHeight: controlTarget)
                            .background { Color.clear.contentShape(Rectangle()).onTapGesture { focused = true } }
                            .onSubmit(confirm)
                        PasteButton(payloadType: String.self) { values in
                            if let value = values.first { invitation = value; error = nil }
                        }.labelStyle(.titleOnly)
                    }
                } header: {
                    // The largest text keeps the field on the first screen: the explanation follows it.
                    SetupHeader(title: L("Добавить Mac или сервер"), paragraphs: textSize.isAccessibilitySize ? [] : [L("Откройте здесь его сотрудников и чаты.")])
                } footer: {
                    if let error {
                        Text(UserFacingError.text(error)).foregroundStyle(AppTheme.warning)
                            .fixedSize(horizontal: false, vertical: true)
                            .accessibilityIdentifier("invitationError")
                    } else if let page = connectionPage {
                        Text(L("Откроется \(page.host ?? L("страница подключения")) в браузере. На странице нажмите «Открыть OpenStrudel»."))
                            .fixedSize(horizontal: false, vertical: true)
                    } else {
                        Text(help).fixedSize(horizontal: false, vertical: true)
                    }
                }
                // Pinned, the action would cover the long text scrolling under it.
                if textSize.isAccessibilitySize {
                    Section { continueButton }.listRowInsets(EdgeInsets()).listRowBackground(Color.clear)
                }
            }
            .formStyle(.grouped)
            .safeAreaInset(edge: .bottom) {
                if !textSize.isAccessibilitySize {
                    continueButton.padding(.horizontal, OnboardingLayout.margin).padding(.bottom, 8)
                }
            }
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(L("Отмена")) { dismiss() }
                }
            }
        }
        .sheetTint()
        .presentationDetents([.large])
        .presentationDragIndicator(.visible)
        .onChange(of: invitation) { _, _ in error = nil }
    }

    private var continueButton: some View {
        Button(action: confirm) { SetupActionLabel(title: continueTitle) }
            .primaryAction()
            .disabled(!canContinue)
            .accessibilityIdentifier("continueConnection")
            .keyboardShortcut(.defaultAction)
    }

    private func confirm() {
        guard !openingPage else { return }
        focused = false
        if let page = connectionPage {
            openingPage = true
            openURL(page) { accepted in
                openingPage = false
                if accepted { dismiss() }
                else { error = L("Не удалось открыть браузер. Откройте ссылку в браузере на этом устройстве и нажмите «Открыть OpenStrudel».") }
            }
            return
        }
        do {
            guard let url = URL(string: invitation.trimmingCharacters(in: .whitespacesAndNewlines)) else { throw HomeClientError.invalidURL }
            let pairing = try MacPairing(url: url)
            onConfirm(pairing); dismiss()
        } catch {
            self.error = L("Это не ссылка подключения OpenStrudel. Скопируйте новую из настроек на устройстве с сотрудниками.")
        }
    }
}
#endif
