import SwiftUI
import CoreImage.CIFilterBuiltins
#if os(iOS)
import VisionKit
import AVFoundation
#endif

struct MobilePairingSettings: View {
    @EnvironmentObject private var client: HomeClient
    @Environment(\.dynamicTypeSize) private var textSize
    @State private var showingCode = false
    @State private var creating = false
    @State private var revokeConfirmation = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
        if client.isLocalConnection || client.canManageConnections {
        VStack(alignment: .leading, spacing: 12) {
            Text("Чтобы открыть сотрудников этого устройства на другом, создайте ссылку подключения.")
                .font(.callout).foregroundStyle(AppTheme.secondaryText)
                .fixedSize(horizontal: false, vertical: true)
            let layout = textSize.isAccessibilitySize
                ? AnyLayout(VStackLayout(alignment: .leading, spacing: 12))
                : AnyLayout(HStackLayout(spacing: 8))
            layout {
                Button {
                    creating = true
                    Task {
                        await client.inviteMobile()
                        showingCode = client.mobileInvitation != nil
                        creating = false
                    }
                } label: {
                    AdaptiveActionLabel(title: creating ? "Готовим ссылку…" : "Получить ссылку подключения")
                }.adaptiveActionStyle(.glass).disabled(creating)
                if client.isLocalConnection && client.mobileConnections > 0 {
                    Button(role: .destructive) { revokeConfirmation = true } label: {
                        AdaptiveActionLabel(title: "Отключить")
                    }
                        .adaptiveActionStyle(.bordered)
                        .tint(AppTheme.destructive)
                }
            }
        }
        .settingsCard()
        }
        }
        .task { await client.refreshMobileStatus() }
        .confirmationDialog("Отключить другие устройства? Чаты и сотрудники сохранятся.", isPresented: $revokeConfirmation) {
            Button("Отключить", role: .destructive) { Task { await client.revokeMobile() } }
        }
        .sheet(isPresented: $showingCode, onDismiss: { Task { await client.cancelMobileInvitation() } }) {
            MobileQRCodeView().environmentObject(client)
        }
    }
}

private struct MobileQRCodeView: View {
    @EnvironmentObject private var client: HomeClient
    @Environment(\.dismiss) private var dismiss
    @State private var initialCount = 0
    @State private var refreshing = false

    var body: some View {
        NavigationStack {
        ScrollView {
        VStack(spacing: 20) {
            Text("Продолжите на другом устройстве").font(.title2.weight(.semibold)).multilineTextAlignment(.center)
            Text("Отсканируйте QR в OpenStrudel\nили откройте ссылку на другом устройстве.")
                .font(.body).foregroundStyle(AppTheme.secondaryText).multilineTextAlignment(.center)
            if let invitation = client.mobileInvitation {
                TimelineView(.periodic(from: .now, by: 1)) { context in
                    let remaining = invitation.remainingSeconds(at: context.date)
                    VStack(spacing: 16) {
                        if remaining > 0, let code = qr(invitation.url.absoluteString) {
                            Image(decorative: code, scale: 1).interpolation(.none).resizable()
                                .scaledToFit().frame(width: 236, height: 236)
                                .padding(16).background(.white, in: RoundedRectangle(cornerRadius: 22))
                                .accessibilityLabel("Одноразовая ссылка подключения OpenStrudel")
                            Text("Ссылка действует ещё \(remaining / 60):\(String(format: "%02d", remaining % 60))")
                                .font(.caption).monospacedDigit().foregroundStyle(AppTheme.secondaryText)
                            ShareLink(item: invitation.url) { AdaptiveActionLabel(title: "Поделиться ссылкой") }
                                .adaptiveActionStyle(.glass)
                        } else {
                            ContentUnavailableView("Срок ссылки истёк", systemImage: "qrcode",
                                description: Text("Получите новую, чтобы подключить устройство."))
                                .frame(height: 300)
                        }
                        Button {
                            refreshing = true
                            Task { await client.inviteMobile(); refreshing = false }
                        } label: {
                            Text(refreshing ? "Обновляем…" : "Новая ссылка")
                                .frame(minHeight: 44).contentShape(Rectangle())
                        }.buttonStyle(.plain).disabled(refreshing)
                    }
                }
            }
            Text("Ссылка открывает чаты и настройки сотрудников.\nИспользуйте её только на своих устройствах.")
                .font(.caption).foregroundStyle(AppTheme.secondaryText).multilineTextAlignment(.center)
        }
        .padding(30).frame(maxWidth: 420).frame(maxWidth: .infinity)
        }
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                Button("Готово") { dismiss() }.keyboardShortcut(.defaultAction)
                    .accessibilityIdentifier("closeMobileInvitation")
            }
        }
        }
        #if os(macOS)
        .frame(width: 420, height: 620)
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
    @Environment(\.dynamicTypeSize) private var textSize
    @State private var scanning = false
    @State private var enteringInvitation = false
    @State private var invitation: MacPairing?
    @State private var cameraError: String?
    @State private var showingHelp = false

    var body: some View {
        GeometryReader { geometry in
            ScrollView {
                VStack(spacing: 0) {
                    Spacer(minLength: 48)
                    OpenStrudelMark(size: 100)
                        .accessibilityHidden(true).padding(.bottom, 30)
                    Text(client.connectionNeedsPairing ? "Подключитесь снова." : client.isConfigured ? "Нет связи с OpenStrudel" : client.isSignedOut ? "Устройство отключено" : "Подключите устройство")
                        .font(.system(.largeTitle, design: .serif, weight: .medium))
                        .multilineTextAlignment(.center).fixedSize(horizontal: false, vertical: true)
                    Text(client.connectionNeedsPairing ? "Подключение отозвано. Получите новую ссылку на устройстве с сотрудниками." : client.isConfigured
                         ? "«\(client.connectionName)» пока не на связи. Подключимся автоматически."
                         : "Откройте сотрудников вашего Mac или сервера по ссылке подключения. Здесь будут те же чаты.")
                        .font(.body).foregroundStyle(AppTheme.secondaryText).multilineTextAlignment(.center)
                        .fixedSize(horizontal: false, vertical: true).padding(.top, 14)
                    if client.isConfigured && !client.connectionNeedsPairing {
                        ProgressView().controlSize(.small).padding(.top, 24)
                            .accessibilityLabel("Восстанавливаем связь")
                    }
                    Spacer(minLength: 48)
                    VStack(spacing: 14) {
                        if client.isConfigured && !client.connectionNeedsPairing {
                            Button { Task { await client.load(quiet: true) } } label: {
                                SetupActionLabel(title: "Проверить соединение", icon: "arrow.clockwise")
                            }.adaptiveActionStyle(.glassProminent).controlSize(.large)
                                .disabled(client.isLoading).accessibilityIdentifier("retryHomeConnection")
                        }
                        Button { Task { await openScanner() } } label: {
                            SetupActionLabel(title: textSize.isAccessibilitySize ? "QR-код" : "Сканировать QR", icon: "qrcode.viewfinder")
                                .foregroundStyle(.primary)
                        }
                        .adaptiveActionStyle(.glass).controlSize(.large)
                        .accessibilityLabel("Сканировать QR").accessibilityIdentifier("scanInvitation")
                        Button { enteringInvitation = true } label: {
                            SetupActionLabel(title: "Вставить ссылку", icon: "link")
                                .foregroundStyle(.primary)
                        }.adaptiveActionStyle(.glass).controlSize(.large)
                            .accessibilityLabel("Вставить ссылку подключения").accessibilityIdentifier("pasteInvitation")
                        if client.isConfigured { DeviceSignOutButton {} }
                        if let cameraError {
                            Text(cameraError).font(.footnote).foregroundStyle(AppTheme.secondaryText)
                                .multilineTextAlignment(.center).fixedSize(horizontal: false, vertical: true)
                        }
                        Button { showingHelp = true } label: {
                            Text("Где получить ссылку?")
                                .font(.callout).multilineTextAlignment(.center)
                                .fixedSize(horizontal: false, vertical: true)
                                .frame(maxWidth: .infinity, minHeight: 44)
                                .contentShape(Rectangle())
                        }.buttonStyle(.plain).foregroundStyle(AppTheme.secondaryText)
                            .accessibilityIdentifier("invitationHelp")
                    }.frame(maxWidth: 340)
                    Color.clear.frame(height: 32)
                }
                .padding(.horizontal, 28)
                .frame(maxWidth: 480).frame(maxWidth: .infinity, minHeight: geometry.size.height)
            }.scrollIndicators(.hidden)
        }
        .sheet(isPresented: $enteringInvitation, onDismiss: confirmInvitation) {
            ConnectionInvitationView { invitation = $0 }
        }
        .sheet(isPresented: $showingHelp) {
            MobileConnectionHelpView()
        }
        .fullScreenCover(isPresented: $scanning, onDismiss: confirmInvitation) {
            NavigationStack {
                QRScanner { value in
                    if let url = URL(string: value), let pairing = try? MacPairing(url: url) {
                        invitation = pairing; scanning = false
                    }
                } failed: {
                    cameraError = "Камера недоступна. Вставьте ссылку подключения."
                    scanning = false
                }
                .ignoresSafeArea(edges: .bottom)
                .navigationTitle("Сканируйте QR подключения")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Отмена") { scanning = false } } }
            }
        }
    }

    private func confirmInvitation() {
        guard let invitation else { return }
        client.pendingPairing = invitation
        client.pairingError = nil
        self.invitation = nil
    }

    private func openScanner() async {
        cameraError = nil
        guard DataScannerViewController.isSupported else {
            cameraError = "На этом устройстве вставьте ссылку подключения."
            return
        }
        let granted = await AVCaptureDevice.requestAccess(for: .video)
        guard granted, DataScannerViewController.isAvailable else {
            cameraError = "Разрешите доступ к камере в настройках устройства или вставьте ссылку."
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
                    VStack(alignment: .leading, spacing: 8) {
                        Text("Где получить ссылку").font(.title2.weight(.semibold)).foregroundStyle(Color.primary)
                        Text("На Mac с сотрудниками откройте OpenStrudel → Настройки → Устройства. Нажмите на устройство, затем «Получить ссылку подключения».")
                        Text("Для сервера откройте его веб-интерфейс → Настройки → Устройства.")
                    }
                    VStack(alignment: .leading, spacing: 8) {
                        Text("Как подключиться").font(.headline).foregroundStyle(Color.primary)
                        Text("Отсканируйте QR или вставьте ссылку в OpenStrudel на этом устройстве.")
                        Text("Ссылка одноразовая и действует пять минут. Если срок истёк, получите новую.")
                    }
                    VStack(alignment: .leading, spacing: 8) {
                        Text("Если нет связи").font(.headline).foregroundStyle(Color.primary)
                        Text("Устройство с сотрудниками должно быть включено и доступно по сети. Для подключения по локальной сети используйте один Wi-Fi.")
                        Text("Связь восстановится автоматически. Новая ссылка нужна, только если подключение отозвано.")
                    }
                }
                .font(.body).foregroundStyle(AppTheme.secondaryText)
                .fixedSize(horizontal: false, vertical: true)
                .padding(24).frame(maxWidth: 520, alignment: .leading)
                .frame(maxWidth: .infinity)
            }
            .background(Color(uiColor: .systemBackground))
            .navigationTitle("Подключение устройства")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Готово") { dismiss() }.accessibilityIdentifier("closeConnectionHelp")
                }
            }
        }
    }
}

private struct QRScanner: UIViewControllerRepresentable {
    let found: (String) -> Void
    let failed: () -> Void
    func makeCoordinator() -> Coordinator { Coordinator(found: found, failed: failed) }
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
        let failed: () -> Void
        private var used = false
        init(found: @escaping (String) -> Void, failed: @escaping () -> Void) { self.found = found; self.failed = failed }
        func dataScanner(_ dataScanner: DataScannerViewController, becameUnavailableWithError error: DataScannerViewController.ScanningUnavailable) { failed() }
        func dataScanner(_ dataScanner: DataScannerViewController, didAdd addedItems: [RecognizedItem], allItems: [RecognizedItem]) {
            guard !used else { return }
            for item in addedItems {
                if case .barcode(let barcode) = item, let value = barcode.payloadStringValue,
                   let url = URL(string: value), (try? MacPairing(url: url)) != nil {
                    used = true; dataScanner.stopScanning(); found(value); break
                }
            }
        }
    }
}
#endif

struct ConnectionInvitationView: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.dynamicTypeSize) private var textSize
    let onConfirm: (MacPairing) -> Void
    @State private var invitation = ""
    @State private var error: String?
    @FocusState private var focused: Bool

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    VStack(alignment: .leading, spacing: 12) {
                        Text("Подключить устройство")
                            .font(.system(textSize.isAccessibilitySize ? .title3 : .largeTitle, design: .serif, weight: .medium))
                            .fixedSize(horizontal: false, vertical: true)
                        Text("1. На другом Mac откройте OpenStrudel → Настройки → Устройства. Нажмите на устройство, затем «Получить ссылку подключения».\n\n2. Вставьте ссылку сюда. Для сервера получите её в его веб-интерфейсе: Настройки → Устройства.")
                            .font(.body).foregroundStyle(AppTheme.secondaryText)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    VStack(alignment: .leading, spacing: 12) {
                    SecureField("Ссылка подключения", text: $invitation)
                        .font(.body).textFieldStyle(.plain)
                        .padding(.horizontal, 18).frame(minHeight: 56)
                        .background(.primary.opacity(0.05), in: RoundedRectangle(cornerRadius: 18))
                        .overlay(RoundedRectangle(cornerRadius: 18).strokeBorder(.primary.opacity(0.12)))
                        .focused($focused).accessibilityIdentifier("connectionInvitation")
                        #if os(iOS)
                        .textInputAutocapitalization(.never).autocorrectionDisabled().submitLabel(.continue)
                        #endif
                        .onSubmit(confirm)
                    PasteButton(payloadType: String.self) { values in
                        if let value = values.first { invitation = value; error = nil }
                    }.labelStyle(.titleOnly).buttonStyle(.glass).controlSize(.large)
                    }
                    if let error {
                        Text(UserFacingError.text(error)).font(.callout).foregroundStyle(AppTheme.secondaryText)
                            .accessibilityIdentifier("invitationError")
                    }
                    Button(action: confirm) { SetupActionLabel(title: "Продолжить") }
                        .buttonStyle(.glassProminent).controlSize(.large)
                        .disabled(invitation.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                        .keyboardShortcut(.defaultAction)
                }.padding(32).frame(maxWidth: 480).frame(maxWidth: .infinity)
            }
            .defaultScrollAnchor(.center, for: .alignment)
            .navigationTitle("Новое устройство")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Отмена") { dismiss() } }
            }
        }
        #if os(macOS)
        .frame(width: 500, height: 530)
        #else
        .presentationDetents([.large])
        .presentationDragIndicator(.visible)
        #endif
        .onChange(of: invitation) { _, _ in error = nil }
    }

    private func confirm() {
        do {
            guard let url = URL(string: invitation.trimmingCharacters(in: .whitespacesAndNewlines)) else { throw HomeClientError.invalidURL }
            let pairing = try MacPairing(url: url)
            onConfirm(pairing); dismiss()
        } catch {
            self.error = "Это не ссылка подключения OpenStrudel. Скопируйте новую из настроек на устройстве с сотрудниками."
        }
    }
}
