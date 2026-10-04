import Foundation
import Testing

@Suite("Readable operational errors")
struct UserFacingErrorTests {
    @Test func fullStorageDoesNotExposeInternalPathsOrPromiseSafeReplay() {
        for source in ["ENOSPC: no space left on device, open '/private/history.jsonl.tmp'",
                       "SQLITE_FULL: database or disk is full"] {
            let message = UserFacingError.text(source)
            #expect(message == UserFacingError.storageFull)
            #expect(!message.contains("/private"))
            #expect(message.contains("проверьте, успел ли"))
            #expect(HomeClientError.server(source).localizedDescription == message)
        }
    }

    @Test func preservesSpecificRecoveryInstructions() {
        let message = "Вход в OpenAI истёк. Войдите ещё раз."
        #expect(UserFacingError.text(message) == message)
    }

    @Test func previousReleaseErrorsRemainUnderstandableInSavedHistory() {
        let timeout = UserFacingError.text("Codex не ответил на thread/start")
        #expect(timeout.contains("Сотрудник не ответил вовремя"))
        #expect(timeout.contains("проверьте"))
        #expect(!timeout.contains("thread/start"))
        let lost = UserFacingError.text("Связь с Codex прервалась. Результат последнего действия нужно проверить.")
        #expect(lost.contains("результат последней задачи"))
        let expired = UserFacingError.text("workspace routing discovery unauthorized (401)")
        #expect(expired.contains("настройки OpenStrudel"))
        #expect(expired.contains("сохранены"))
        #expect(!expired.contains("401"))
    }
}
