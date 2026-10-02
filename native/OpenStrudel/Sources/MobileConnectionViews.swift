import SwiftUI
import CoreImage.CIFilterBuiltins
#if os(iOS)
import VisionKit
import AVFoundation
#endif

struct MobilePairingSettings: View {
    @EnvironmentObject private var client: HomeClient
    @State private var showingCode = false
    @State private var creating = false
    @State private var revokeConfirmation = false

    var body: some View {
        Group {
        if client.isLocalConnection || client.canManageConnections {
        SectionTitle(title: "Другие устройства", subtitle: "Те же чаты на Mac, iPhone и iPad")
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .firstTextBaseline) {
                Text("Подключите приложение один раз — и продолжайте на другом устройстве.")
                    .font(.callout).foregroundStyle(AppTheme.secondaryText)
                Spacer()
            }
            HStack(spacing: 8) {
                Button(creating ? "Готовим приглашение…" : "Подключить устройство") {
                    creating = true
                    Task {
                        await client.inviteMobile()
                        showingCode = client.mobileInvitation != nil
                        creating = false
                    }
                }.buttonStyle(.glass).disabled(creating)
                if client.isLocalConnection && client.mobileConnections > 0 {
                    Button("Отключить", role: .destructive) { revokeConfirmation = true }
                        .buttonStyle(.bordered)
                        .tint(.red)
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
            Text("Отсканируйте QR в OpenStrudel\nили отправьте себе приглашение.")
                .font(.body).foregroundStyle(AppTheme.secondaryText).multilineTextAlignment(.center)
            if let invitation = client.mobileInvitation {
                TimelineView(.periodic(from: .now, by: 1)) { context in
                    let remaining = invitation.remainingSeconds(at: context.date)
                    VStack(spacing: 16) {
                        if remaining > 0, let code = qr(invitation.url.absoluteString) {
                            Image(decorative: code, scale: 1).interpolation(.none).resizable()
                                .scaledToFit().frame(width: 236, height: 236)
                                .padding(16).background(.white, in: RoundedRectangle(cornerRadius: 22))
                                .accessibilityLabel("Одноразовое приглашение OpenStrudel")
                            Text("Приглашение действует ещё \(remaining / 60):\(String(format: "%02d", remaining % 60))")
                                .font(.caption).monospacedDigit().foregroundStyle(AppTheme.secondaryText)
                            ShareLink(item: invitation.url) { Label("Поделиться приглашением", systemImage: "square.and.arrow.up") }
                                .buttonStyle(.glass)
                        } else {
                            ContentUnavailableView("Приглашение истекло", systemImage: "qrcode",
                                description: Text("Создайте новое, чтобы подключить устройство."))
                                .frame(height: 300)
                        }
                        Button {
                            refreshing = true
                            Task { await client.inviteMobile(); refreshing = false }
                        } label: {
                            Text(refreshing ? "Обновляем…" : "Новое приглашение")
                                .frame(minHeight: 44).contentShape(Rectangle())
                        }.buttonStyle(.plain).disabled(refreshing)
                    }
                }
            }
            Text("Приглашение открывает ваши чаты.\nИспользуйте его только на своих устройствах.")
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
    @Environment(\.dynamicTypeSize) private var textSize
    @EnvironmentObject private var client: HomeClient
    @State private var scanning = false
    @State private var enteringInvitation = false
    @State private var invitation: MacPairing?
    @State private var cameraError: String?
    @State private var showingSetup = false

    var body: some View {
        GeometryReader { geometry in
            ScrollView {
                VStack(spacing: 0) {
                    Spacer(minLength: 48)
                    Image("OpenStrudelMark").resizable().scaledToFit().frame(width: 100, height: 100)
                        .accessibilityHidden(true).padding(.bottom, 30)
                    Text(client.connectionNeedsPairing ? "Подключитесь снова." : client.isConfigured ? "Скоро на связи." : "Ваша команда.\nВсегда рядом.")
                        .font(.system(.largeTitle, design: .serif, weight: .medium))
                        .multilineTextAlignment(.center).fixedSize(horizontal: false, vertical: true)
                    Text(client.connectionNeedsPairing ? "Подключение отозвано. Создайте новое приглашение на своём Mac или сервере." : client.isConfigured
                         ? "«\(client.connectionName)» пока не на связи. Подключимся автоматически."
                         : "Начните в облаке или подключитесь\nк своему OpenStrudel.")
                        .font(.body).foregroundStyle(AppTheme.secondaryText).multilineTextAlignment(.center)
                        .fixedSize(horizontal: false, vertical: true).padding(.top, 14)
                    if client.isConfigured && !client.connectionNeedsPairing {
                        ProgressView().controlSize(.small).padding(.top, 24)
                            .accessibilityLabel("Восстанавливаем связь")
                    }
                    Spacer(minLength: 48)
                    VStack(spacing: 14) {
                        if let managementURL = DigitalOceanCloud.managementURL(for: client.normalizedBaseURL) {
                            Link(destination: managementURL) {
                                SetupActionLabel(title: "Управлять облаком", icon: "arrow.up.right.square")
                            }.buttonStyle(.glass).controlSize(.large)
                                .accessibilityIdentifier("manageCloudOffline")
                                .accessibilityHint("Открыть вашу установку в DigitalOcean")
                        }
                        if !client.isConfigured {
                            Button { showingSetup = true } label: {
                                SetupActionLabel(title: "Начать в облаке", icon: "cloud")
                            }.buttonStyle(.glassProminent).controlSize(.large)
                                .accessibilityIdentifier("setupCloud")
                        }
                        Button { Task { await openScanner() } } label: {
                            SetupActionLabel(title: textSize.isAccessibilitySize ? "QR-код" : "Сканировать QR", icon: "qrcode.viewfinder")
                                .foregroundStyle(.primary)
                        }
                        .buttonStyle(.glass).controlSize(.large)
                        .accessibilityLabel("Сканировать QR").accessibilityIdentifier("scanInvitation")
                        Button { enteringInvitation = true } label: {
                            SetupActionLabel(title: textSize.isAccessibilitySize ? "По ссылке" : "Вставить приглашение", icon: "link")
                                .foregroundStyle(.primary)
                        }.buttonStyle(.glass).controlSize(.large)
                            .accessibilityLabel("Вставить приглашение").accessibilityIdentifier("pasteInvitation")
                        if let cameraError {
                            Text(cameraError).font(.footnote).foregroundStyle(AppTheme.secondaryText)
                                .multilineTextAlignment(.center).fixedSize(horizontal: false, vertical: true)
                        }
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
        .sheet(isPresented: $showingSetup) {
            ServerSetupView().environmentObject(client)
        }
        .fullScreenCover(isPresented: $scanning, onDismiss: confirmInvitation) {
            NavigationStack {
                QRScanner { value in
                    if let url = URL(string: value), let pairing = try? MacPairing(url: url) {
                        invitation = pairing; scanning = false
                    }
                } failed: {
                    cameraError = "Камера недоступна. Можно подключиться по приглашению."
                    scanning = false
                }
                .ignoresSafeArea(edges: .bottom)
                .navigationTitle("Сканируйте приглашение")
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
            cameraError = "На этом устройстве используйте приглашение вместо камеры."
            return
        }
        let granted = await AVCaptureDevice.requestAccess(for: .video)
        guard granted, DataScannerViewController.isAvailable else {
            cameraError = "Разрешите доступ к камере в настройках iPhone или вставьте приглашение."
            return
        }
        scanning = true
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

struct ConfirmMacPairingView: View {
    @EnvironmentObject private var client: HomeClient
    @Environment(\.dismiss) private var dismiss
    let pairing: MacPairing

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 20) {
                    Image("OpenStrudelMark").resizable().scaledToFit().frame(width: 72, height: 72)
                        .accessibilityHidden(true).padding(.top, 18)
                    Text("Продолжить здесь.").font(.system(.title, design: .serif, weight: .medium))
                        .multilineTextAlignment(.center)
                    VStack(spacing: 6) {
                        Text(pairing.name).font(.headline)
                        Text(pairing.host).font(.footnote).foregroundStyle(AppTheme.secondaryText)
                    }.multilineTextAlignment(.center)
                    Text("Здесь появятся чаты и сотрудники с этого Mac или сервера.")
                        .font(.body).foregroundStyle(AppTheme.secondaryText).multilineTextAlignment(.center)
                    if client.isConfigured {
                        Text("Текущее подключение будет заменено. Данные на прежнем устройстве сохранятся.")
                            .font(.footnote).foregroundStyle(AppTheme.secondaryText).multilineTextAlignment(.center)
                    }
                    if let error = client.pairingError {
                        Text(error).font(.callout).foregroundStyle(AppTheme.secondaryText).multilineTextAlignment(.center)
                            .accessibilityIdentifier("pairingError")
                    }
                    Button {
                        Task { if await client.connectToMac(pairing) { dismiss() } }
                    } label: {
                        HStack(spacing: 10) {
                            if client.isPairing { ProgressView().controlSize(.small) }
                            Text(client.isPairing ? "Подключаем…" : "Подключить")
                        }.font(.body.weight(.semibold)).frame(maxWidth: .infinity, minHeight: 32).padding(.vertical, 6)
                    }
                    .buttonStyle(.glassProminent).controlSize(.large).disabled(client.isPairing)
                    .keyboardShortcut(.defaultAction).accessibilityIdentifier("confirmMacPairing")
                }.padding(32).frame(maxWidth: 480).frame(maxWidth: .infinity)
            }.defaultScrollAnchor(.center, for: .alignment)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Отмена") { dismiss() }.disabled(client.isPairing) } }
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
        }
        .interactiveDismissDisabled(client.isPairing)
        #if os(iOS)
        .presentationDetents([.large])
        .presentationDragIndicator(.visible)
        #else
        .frame(width: 440, height: 560)
        #endif
    }
}

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
                        Text("Ваши чаты.\nНа этом устройстве.")
                            .font(.system(textSize.isAccessibilitySize ? .title3 : .largeTitle, design: .serif, weight: .medium))
                            .fixedSize(horizontal: false, vertical: true)
                        Text("Вставьте приглашение из OpenStrudel на Mac или со страницы установки сервера.")
                            .font(.body).foregroundStyle(AppTheme.secondaryText)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    VStack(alignment: .leading, spacing: 12) {
                    SecureField("Ссылка-приглашение", text: $invitation)
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
                        Text(error).font(.callout).foregroundStyle(AppTheme.secondaryText)
                            .accessibilityIdentifier("invitationError")
                    }
                    Button(action: confirm) { SetupActionLabel(title: "Продолжить") }
                        .buttonStyle(.glassProminent).controlSize(.large)
                        .disabled(invitation.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                        .keyboardShortcut(.defaultAction)
                }.padding(32).frame(maxWidth: 480).frame(maxWidth: .infinity)
            }
            .defaultScrollAnchor(.center, for: .alignment)
            .navigationTitle("Приглашение")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Отмена") { dismiss() } }
            }
        }
        #if os(macOS)
        .frame(width: 480, height: 510)
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
            self.error = "Это не приглашение OpenStrudel. Скопируйте новую ссылку из настроек на компьютере."
        }
    }
}
