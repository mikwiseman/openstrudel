#if os(macOS)
import AppKit
import Combine
import Sparkle
import SwiftUI

@MainActor
final class AppUpdater: ObservableObject {
    static let shared = AppUpdater()
    @Published private(set) var canCheckForUpdates = false
    @Published private(set) var startupFailure: String?
    private let controller: SPUStandardUpdaterController
    private var observation: NSKeyValueObservation?

    private init() {
        controller = SPUStandardUpdaterController(startingUpdater: false, updaterDelegate: nil, userDriverDelegate: nil)
        let key = Bundle.main.object(forInfoDictionaryKey: "SUPublicEDKey") as? String
        let feed = (Bundle.main.object(forInfoDictionaryKey: "SUFeedURL") as? String).flatMap(URL.init(string:))
        guard let key, Data(base64Encoded: key)?.count == 32,
              let feed, feed.scheme == "https", feed.host != nil, feed.user == nil, feed.password == nil else {
            startupFailure = "В этой сборке не настроена проверка подписи обновлений."
            return
        }
        observation = controller.updater.observe(\.canCheckForUpdates, options: [.initial, .new]) { [weak self] updater, _ in
            MainActor.assumeIsolated { self?.canCheckForUpdates = updater.canCheckForUpdates }
        }
        // Disposable QA apps have their own preferences and only check on demand.
        if Bundle.main.bundleIdentifier != "is.openstrudel.mac" {
            controller.updater.automaticallyChecksForUpdates = false
        }
        do { try controller.updater.start() }
        catch { startupFailure = "Не удалось запустить проверку обновлений: " + error.localizedDescription }
    }

    var automaticChecksEnabled: Bool {
        get { controller.updater.automaticallyChecksForUpdates }
        set {
            guard newValue != controller.updater.automaticallyChecksForUpdates else { return }
            objectWillChange.send()
            controller.updater.automaticallyChecksForUpdates = newValue
        }
    }

    func checkForUpdates() {
        NSApplication.shared.activate()
        controller.updater.checkForUpdates()
    }
}

struct UpdateSettings: View {
    @ObservedObject private var updater = AppUpdater.shared

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Версия \(Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "") (\(Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? ""))")
                .font(.callout).foregroundStyle(AppTheme.secondaryText)
            Toggle("Проверять обновления автоматически", isOn: Binding(
                get: { updater.automaticChecksEnabled }, set: { updater.automaticChecksEnabled = $0 }
            ))
            Text("Сообщим о новой версии. Установка начнётся только после вашего подтверждения.")
                .font(.caption).foregroundStyle(AppTheme.secondaryText)
                .fixedSize(horizontal: false, vertical: true)
            if let failure = updater.startupFailure {
                Text(failure).font(.callout).foregroundStyle(AppTheme.warning)
            }
            Button("Проверить обновления…", action: updater.checkForUpdates)
                .buttonStyle(.bordered).disabled(!updater.canCheckForUpdates)
                .accessibilityIdentifier("checkForUpdates")
        }.settingsCard()
    }
}
#endif
