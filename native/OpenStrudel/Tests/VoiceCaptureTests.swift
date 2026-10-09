import Foundation
import Testing

@Suite("Voice drafts")
@MainActor struct VoiceCaptureTests {
    @Test func switchingConversationsRetainsOnlyThatConversationsRecording() throws {
        let first = "voice-test-" + UUID().uuidString, second = "voice-test-" + UUID().uuidString
        let file = VoiceCapture.draftURL(context: first)
        defer { try? FileManager.default.removeItem(at: file) }
        try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data("test-only recording".utf8).write(to: file)
        let voice = VoiceCapture()
        voice.attach(context: first) { _, _ in Issue.record("A saved recording must not send itself") }
        #expect(voice.phase == .saved)
        voice.attach(context: second) { _, _ in Issue.record("Audio cannot move to another conversation") }
        #expect(voice.phase == .idle)
        #expect(FileManager.default.fileExists(atPath: file.path))
        voice.attach(context: first) { _, _ in Issue.record("No automatic replay") }
        #expect(voice.phase == .saved)
        voice.cancel()
        #expect(voice.phase == .idle)
        #expect(!FileManager.default.fileExists(atPath: file.path))
    }

    @Test(.enabled(if: ProcessInfo.processInfo.environment["OPENSTRUDEL_VOICE_FIXTURE"] != nil))
    func recognizesAnActualRussianRecordingLocally() async throws {
        let path = try #require(ProcessInfo.processInfo.environment["OPENSTRUDEL_VOICE_FIXTURE"])
        let module = try await VoiceCapture.prepare(locale: "ru-RU")
        let text = try await VoiceCapture.transcribe(file: URL(fileURLWithPath: path), module: module)
        #expect(text.localizedCaseInsensitiveContains("проверка"))
        #expect(text.localizedCaseInsensitiveContains("встреча"))
        #expect(text.contains("12") || text.localizedCaseInsensitiveContains("двенадцать"))
    }
}
