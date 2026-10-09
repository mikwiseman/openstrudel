import SwiftUI
import AVFoundation
import Speech
import CryptoKit

/// One bounded recording on the viewing device. Audio stays local; a draft is
/// retained if recognition fails or the user switches conversations.
@MainActor final class VoiceCapture: ObservableObject {
    enum Phase { case idle, preparing, recording, transcribing, saved }
    @Published private(set) var phase: Phase = .idle
    @Published private(set) var levels: [Double] = []
    @Published private(set) var seconds = 0
    @Published private(set) var detail = ""
    private var recorder: AVAudioRecorder?
    private var work: Task<Void, Never>?
    private var meter: Task<Void, Never>?
    private var generation = UUID()
    private var file: URL?
    private var context = ""
    private var deliver: ((String, Bool) -> Void)?
    private var transcriber: DictationTranscriber?
    static let maximumDuration: TimeInterval = 300
    static let maximumLevels = 64

    func attach(context: String, deliver: @escaping (String, Bool) -> Void) {
        detach()
        self.context = context
        self.deliver = deliver
        file = Self.draftURL(context: context)
        if let file, FileManager.default.fileExists(atPath: file.path) {
            phase = .saved
            detail = "Сохранена голосовая запись. Можно распознать ещё раз."
        }
    }

    func start(locale: String) {
        guard phase == .idle else { return }
        phase = .preparing; detail = "Разрешите доступ к микрофону…"
        let id = generation
        work = Task {
            do {
                guard await AVCaptureDevice.requestAccess(for: .audio) else {
                    throw VoiceFailure("Разрешите доступ к микрофону в настройках системы.")
                }
                try Task.checkCancellation()
                guard id == generation else { return }
                detail = "Подготавливаем распознавание…"
                let module = try await Self.prepare(locale: locale)
                try Task.checkCancellation()
                guard id == generation, let file else { return }
                #if os(iOS)
                try AVAudioSession.sharedInstance().setCategory(.record, mode: .default)
                try AVAudioSession.sharedInstance().setActive(true)
                #endif
                try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
                let recorder = try AVAudioRecorder(url: file, settings: [
                    AVFormatIDKey: kAudioFormatMPEG4AAC, AVSampleRateKey: 44100,
                    AVNumberOfChannelsKey: 1, AVEncoderBitRateKey: 64000
                ])
                recorder.isMeteringEnabled = true
                guard recorder.record(forDuration: Self.maximumDuration) else { throw VoiceFailure("Не удалось начать запись. Проверьте микрофон.") }
                self.recorder = recorder; self.transcriber = module
                phase = .recording; levels = []; seconds = 0; detail = ""
                meter = Task { [weak self] in
                    while !Task.isCancelled {
                        do { try await Task.sleep(for: .milliseconds(80)) } catch { return }
                        guard let self, id == self.generation, let recorder = self.recorder else { return }
                        guard recorder.isRecording else { self.finish(send: false, locale: locale); return }
                        recorder.updateMeters()
                        self.seconds = Int(recorder.currentTime)
                        self.levels.append(min(1, max(0, pow(10, Double(recorder.averagePower(forChannel: 0)) / 35))))
                        if self.levels.count > Self.maximumLevels { self.levels.removeFirst(self.levels.count - Self.maximumLevels) }
                    }
                }
            } catch {
                guard id == generation, !Task.isCancelled else { return }
                stopRecorder()
                phase = .idle; detail = (error as? VoiceFailure)?.message ?? "Не удалось подготовить голосовой ввод. Проверьте интернет для загрузки системной модели и попробуйте снова."
            }
        }
    }

    func finish(send: Bool, locale: String) {
        guard phase == .recording || phase == .saved, let file else { return }
        stopRecorder()
        phase = .transcribing; detail = "Распознаём на устройстве…"
        let id = generation
        work = Task {
            do {
                let module: DictationTranscriber
                if let transcriber { module = transcriber }
                else { module = try await Self.prepare(locale: locale) }
                let result = try await Self.transcribe(file: file, module: module)
                try Task.checkCancellation()
                guard id == generation else { return }
                guard !result.isEmpty else { throw VoiceFailure("Не удалось разобрать речь. Попробуйте ещё раз или запишите новое сообщение.") }
                // Deliver before deleting the recoverable audio draft.
                deliver?(result, send)
                try? FileManager.default.removeItem(at: file)
                transcriber = nil; phase = .idle; detail = ""; levels = []
            } catch {
                guard id == generation, !Task.isCancelled else { return }
                transcriber = nil; phase = .saved
                detail = (error as? VoiceFailure)?.message ?? "Не удалось распознать. Запись сохранена, можно повторить."
            }
        }
    }

    func cancel() {
        generation = UUID(); work?.cancel(); meter?.cancel(); stopRecorder()
        if let file { try? FileManager.default.removeItem(at: file) }
        transcriber = nil; phase = .idle; detail = ""; levels = []
    }

    func detach() {
        generation = UUID(); work?.cancel(); meter?.cancel(); stopRecorder()
        transcriber = nil; deliver = nil; phase = .idle; detail = ""; levels = []
    }

    private func stopRecorder() {
        meter?.cancel(); meter = nil
        recorder?.stop(); recorder = nil
        #if os(iOS)
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        #endif
    }

    static func draftURL(context: String) -> URL {
        let name = SHA256.hash(data: Data(context.utf8)).map { String(format: "%02x", $0) }.joined()
        return FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("OpenStrudel/VoiceDrafts", isDirectory: true).appendingPathComponent(name + ".m4a")
    }

    static func prepare(locale: String) async throws -> DictationTranscriber {
        let requested = Locale(identifier: locale == "system" ? Locale.current.identifier : locale)
        guard let supported = await DictationTranscriber.supportedLocale(equivalentTo: requested) else {
            throw VoiceFailure("Этот язык пока недоступен для распознавания. Выберите другой в настройках голосового ввода.")
        }
        let module = DictationTranscriber(locale: supported, preset: .longDictation)
        if let installation = try await AssetInventory.assetInstallationRequest(supporting: [module]) {
            try await installation.downloadAndInstall()
        }
        return module
    }

    static func transcribe(file: URL, module: DictationTranscriber) async throws -> String {
        let analyzer = SpeechAnalyzer(modules: [module], options: .init(priority: .userInitiated, modelRetention: .whileInUse))
        let results = Task {
            var parts: [String] = []
            for try await result in module.results where result.isFinal { parts.append(String(result.text.characters)) }
            return parts.joined(separator: " ").trimmingCharacters(in: .whitespacesAndNewlines)
        }
        return try await withTaskCancellationHandler {
            do {
                let audio = try AVAudioFile(forReading: file)
                if let end = try await analyzer.analyzeSequence(from: audio) { try await analyzer.finalizeAndFinish(through: end) }
                else { await analyzer.cancelAndFinishNow() }
                return try await results.value
            } catch { results.cancel(); await analyzer.cancelAndFinishNow(); throw error }
        } onCancel: { results.cancel(); Task { await analyzer.cancelAndFinishNow() } }
    }
}

private struct VoiceFailure: LocalizedError {
    let message: String
    init(_ message: String) { self.message = message }
    var errorDescription: String? { message }
}

struct VoiceRecordingRow: View {
    @ObservedObject var voice: VoiceCapture
    @Environment(\.dynamicTypeSize) private var textSize
    let locale: String
    let canSend: Bool
    var body: some View {
        let layout = textSize.isAccessibilitySize && voice.phase != .recording
            ? AnyLayout(VStackLayout(alignment: .leading, spacing: 12))
            : AnyLayout(HStackLayout(spacing: 12))
        layout {
            Button { voice.cancel() } label: { Image(systemName: "xmark").font(.system(size: 18)).frame(width: 44, height: 44).contentShape(Rectangle()) }
                .buttonStyle(.plain).accessibilityLabel("Отменить запись")
            if voice.phase == .recording {
                Canvas { context, size in
                    let count = min(VoiceCapture.maximumLevels, max(1, Int(size.width / 6)))
                    let samples = Array(voice.levels.suffix(count))
                    for index in 0..<count {
                        let sampleIndex = index - (count - samples.count)
                        let level = sampleIndex < 0 ? 0 : samples[sampleIndex]
                        let height = max(3, level * size.height)
                        let rect = CGRect(x: CGFloat(index) * size.width / CGFloat(count), y: (size.height - height) / 2, width: 3, height: height)
                        context.fill(Path(roundedRect: rect, cornerRadius: 2), with: .foreground)
                    }
                }.frame(height: 28).accessibilityHidden(true)
                Text(String(format: "%d:%02d", voice.seconds / 60, voice.seconds % 60)).font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                Button { voice.finish(send: false, locale: locale) } label: { Image(systemName: "stop.fill").font(.system(size: 18)).frame(width: 44, height: 44).contentShape(Rectangle()) }
                    .buttonStyle(.plain).accessibilityLabel("Остановить и проверить текст")
                Button { voice.finish(send: true, locale: locale) } label: { Image(systemName: "arrow.up").font(.system(size: 18)).frame(width: 44, height: 44).contentShape(Rectangle()) }
                    .buttonStyle(.glassProminent).buttonBorderShape(.circle).disabled(!canSend).accessibilityLabel("Распознать и отправить")
            } else {
                if voice.phase == .preparing || voice.phase == .transcribing { ProgressView().controlSize(.small) }
                Text(voice.detail).font(.callout).foregroundStyle(.secondary).frame(maxWidth: .infinity, alignment: .leading)
                if voice.phase == .saved {
                    Button { voice.finish(send: false, locale: locale) } label: { AdaptiveActionLabel(title: "Распознать") }
                        .adaptiveActionStyle(.glass)
                }
            }
        }.padding(.horizontal, 8).padding(.vertical, 6)
        .accessibilityElement(children: .contain).accessibilityLabel(voice.phase == .recording ? "Идёт запись" : "Голосовой ввод")
    }
}

struct DictationSettings: View {
    var showsTitle = true
    @AppStorage("openstrudel.dictation") private var provider = "ramble"
    @AppStorage("openstrudel.dictationLocale") private var locale = "ru-RU"
    #if os(macOS)
    private var rambleURL: URL? { NSWorkspace.shared.urlForApplication(withBundleIdentifier: "is.waiwai.dictation") }
    #endif
    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            if showsTitle { Text("Голосовой ввод").font(.headline) }
            #if os(macOS)
            Picker("Распознавание", selection: $provider) {
                Text("Open Ramble · рекомендуем").tag("ramble")
                Text("Встроенное Apple").tag("apple")
            }
            if provider == "ramble" {
                Text("Open Ramble превращает речь в текст на вашем Mac. Поставьте курсор в сообщение и используйте горячую клавишу из Open Ramble. Текст можно проверить перед отправкой.")
                    .font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                if let rambleURL {
                    Button("Открыть Open Ramble") { NSWorkspace.shared.openApplication(at: rambleURL, configuration: .init()) }
                } else { Link("Скачать Open Ramble", destination: URL(string: "https://waiwai.is/ramble")!) }
            } else { appleSettings }
            #else
            appleSettings
            #endif
        }
    }
    private var appleSettings: some View {
        VStack(alignment: .leading, spacing: 10) {
            Picker("Язык записи", selection: $locale) {
                Text("Русский").tag("ru-RU")
                Text("English").tag("en-US")
                Text("Язык системы").tag("system")
            }
            Text("Распознавание на этом устройстве. При первом использовании Apple загрузит языковую модель. Запись до 5 минут.")
                .font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
        }
    }
}

struct DictationSetupView: View {
    @Environment(\.dismiss) private var dismiss
    let record: () -> Void
    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    DictationSettings(showsTitle: false)
                    Button("Записать прямо здесь") {
                        UserDefaults.standard.set("apple", forKey: "openstrudel.dictation")
                        dismiss(); record()
                    }.buttonStyle(.glassProminent)
                }.padding(24)
            }
            .navigationTitle("Голосовой ввод")
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Готово") { dismiss() } } }
        }
        #if os(macOS)
        .frame(width: 480, height: 360)
        #endif
    }
}
