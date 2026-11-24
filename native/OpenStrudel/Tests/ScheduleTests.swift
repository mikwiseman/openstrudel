import Foundation
import Testing

struct ScheduleTests {
    private func schedule(_ extra: String = "") throws -> ChatSchedule {
        try JSONDecoder().decode(ChatSchedule.self, from: Data("""
        {"id":"once","conversationId":"c","name":"Follow up","prompt":"Remind me",
         "cron":"@once 2030-01-15T09:30:00+03:00","timezone":"Europe/Moscow",
         "enabled":false,"nextRunAt":"2030-01-15T06:30:00.000Z"\(extra)}
        """.utf8))
    }

    @Test func oneTimeReminderUsesItsOwnZoneAndNeverOffersCompletedWorkAsPaused() throws {
        let value = try schedule(",\"lastRunStatus\":\"completed\"")
        #expect(value.isOneTime)
        #expect(value.oneTimeResult == L("Выполнено"))
        #expect(value.timing.contains("9:30") || value.timing.contains("09:30"))
        #expect(!value.timing.contains("6:30"))
        #expect(value.timing.hasPrefix(L("Разово · ")))
    }

    @Test func onlyDailyAndWeeklySchedulesHaveARhythmInWords() throws {
        let recurring: (String) throws -> ChatSchedule = { cron in
            try JSONDecoder().decode(ChatSchedule.self, from: Data("""
            {"id":"r","conversationId":"c","name":"Radar","prompt":"Check","cron":"\(cron)","timezone":"Europe/Moscow",
             "enabled":false,"nextRunAt":"2026-10-26T09:00:00.000Z"}
            """.utf8))
        }
        // The time of day reads as the employee's page writes it in the interface's language, not as a fixed 24-hour clock.
        var calendar = Calendar(identifier: .gregorian); calendar.timeZone = .gmt
        let words = TeamWords(calendar: calendar)
        let time = { (hour: Int, minute: Int) in words.time(calendar.date(from: DateComponents(year: 2001, month: 1, day: 1, hour: hour, minute: minute))!) }
        #expect(try recurring("0 12 * * *").rhythm == L("Ежедневно в \(time(12, 0))") + " · " + L("Москва"))
        let saturday = try recurring("30 18 * * 6").rhythm
        #expect(saturday?.hasPrefix(L("По субботам")) == true)
        #expect(saturday?.contains(time(18, 30)) == true, "\(saturday ?? "")")
        // Any other cron is known only by its next run, which a switched-off schedule no longer has.
        let quarterly = try recurring("*/15 * * * *")
        #expect(quarterly.rhythm == nil)
        #expect(quarterly.timing.hasPrefix(L("Следующий выпуск · ")))
    }

    @Test func uncertainDeliveryStaysUncertainAndARealPauseHasNoCompletionClaim() throws {
        #expect(try schedule(",\"lastRunStatus\":\"uncertain\"").oneTimeResult == L("Проверьте результат"))
        #expect(try schedule().oneTimeResult == nil)
        #expect(try schedule(",\"lastRunStatus\":\"failed\"").oneTimeResult == L("Не выполнено"))
        #expect(try schedule(",\"lastRunStatus\":\"skipped\"").oneTimeResult == L("Пропущено"))
    }
}
