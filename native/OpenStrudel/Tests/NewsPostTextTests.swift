import Foundation
import SwiftUI
import Testing
import UniformTypeIdentifiers
#if os(macOS)
import AppKit
#endif

/// A post draft between the desk's Markdown, the text the owner edits and what leaves the app. Every post here is invented.
@MainActor struct NewsPostTextTests {
    private let fonts = EnvironmentValues().fontResolutionContext
    private let draft = "**Клён 3 вышел в открытый доступ**\n\nМодель стоит $2 за миллион токенов, вдвое дешевле прежней. Замеры [по ссылке](https://klen.example/bench)\n\nЯ бы попробовал её на рутине"

    private func pieces(_ markdown: String) -> [NewsPostText.Piece] { NewsPostText.pieces(NewsPostText.rich(markdown), fonts: fonts) }

    @Test func theDraftIsShownWithoutItsMarks() {
        let shown = NewsPostText.rich(draft)
        let text = String(shown.characters)
        #expect(!text.contains("*") && !text.contains("](") && !text.contains("["))
        #expect(text.hasPrefix("Клён 3 вышел в открытый доступ\n\nМодель стоит $2"))
        let found = pieces(draft)
        #expect(found.first == .init(text: "Клён 3 вышел в открытый доступ", look: .init(bold: true)))
        #expect(found.contains(.init(text: "по ссылке", look: .init(link: URL(string: "https://klen.example/bench")))))
        #expect(found.last?.look == .init())
    }

    @Test func anUntouchedDraftGoesBackToTheHomeAsItCame() {
        #expect(NewsPostText.markdown(pieces(draft)) == draft)
        let list = "Что нового:\n- **Скорость:** втрое выше\n- цена прежняя\n\n> цитата остаётся строкой\n1. первый шаг"
        #expect(NewsPostText.markdown(pieces(list)) == list)
    }

    @Test func whatTheOwnerMakesBoldIsWrittenAsBold() {
        var text = NewsPostText.rich("Старт продаж в пятницу")
        let range = text.range(of: "в пятницу")!
        text[range].swiftUI.font = AppTypography.reading.bold()
        #expect(NewsPostText.markdown(NewsPostText.pieces(text, fonts: fonts)) == "Старт продаж **в пятницу**")
        text[range].swiftUI.font = AppTypography.reading.italic()
        #expect(NewsPostText.markdown(NewsPostText.pieces(text, fonts: fonts)) == "Старт продаж *в пятницу*")
    }

    @Test func aMarkNeverCrossesALineOrTouchesASpace() {
        var text = AttributedString("Первая строка \nвторая")
        text.swiftUI.font = AppTypography.reading.bold()
        let written = NewsPostText.markdown(NewsPostText.pieces(text, fonts: fonts))
        #expect(written == "**Первая строка** \n**вторая**")
        #expect(String(NewsPostText.rich(written).characters) == "Первая строка \nвторая")
    }

    @Test func charactersThatLookLikeMarksStayThemselves() {
        let typed = AttributedString("5 * 3 = 15, файл snake_case.py, [не ссылка] и _так_")
        let written = NewsPostText.markdown(NewsPostText.pieces(typed, fonts: fonts))
        #expect(written.contains("snake_case.py"))
        #expect(String(NewsPostText.rich(written).characters) == String(typed.characters))
        #expect(pieces(written).allSatisfy { $0.look == .init() })
    }

    @Test func thePlainVersionHasNoMarksAndKeepsEveryAddress() {
        let plain = NewsPostText.plain(pieces(draft))
        #expect(!plain.contains("*") && !plain.contains("]("))
        #expect(plain.contains("Замеры по ссылке (https://klen.example/bench)"))
        #expect(NewsPostText.plain(pieces("Сайт: https://klen.example")) == "Сайт: https://klen.example")
    }

    @Test func theHTMLKeepsBoldLinksAndLineBreaks() {
        let html = NewsPostText.html(pieces(draft + "\n1 < 2 & 3"))
        #expect(html.contains("<strong>Клён 3 вышел в открытый доступ</strong><br><br>"))
        #expect(html.contains("<a href=\"https://klen.example/bench\">по ссылке</a>"))
        #expect(html.contains("1 &lt; 2 &amp; 3"))
        #expect(!html.contains("*"))
    }

    #if os(macOS)
    @Test func theRichTextReadsBackWithItsBoldAndItsLink() throws {
        let data = try #require(NewsPostText.rtf(pieces(draft)))
        let read = try NSAttributedString(data: data, options: [.documentType: NSAttributedString.DocumentType.rtf], documentAttributes: nil)
        #expect(read.string == String(NewsPostText.rich(draft).characters))
        let title = try #require(read.attribute(.font, at: 0, effectiveRange: nil) as? NSFont)
        #expect(title.fontDescriptor.symbolicTraits.contains(.bold))
        let body = try #require(read.attribute(.font, at: 40, effectiveRange: nil) as? NSFont)
        #expect(!body.fontDescriptor.symbolicTraits.contains(.bold))
        let at = (read.string as NSString).range(of: "по ссылке").location
        #expect((read.attribute(.link, at: at, effectiveRange: nil) as? URL)?.absoluteString == "https://klen.example/bench")
    }
    #endif

    @Test func aTelegramPostCopiedOnAMacCarriesNoPlainVersion() {
        let found = pieces(draft)
        // Telegram for Mac pastes the plain version whenever one is there, and the bold and the links are lost with it.
        #expect(NewsPostText.clipboard(found, channel: "telegram", mac: true).map(\.type) == [.rtf, .html])
        #expect(NewsPostText.clipboard(found, channel: "linkedin", mac: true).map(\.type) == [.rtf, .html, .utf8PlainText])
        let phone = NewsPostText.clipboard(found, channel: "telegram", mac: false)
        #expect(phone.map(\.type) == [.rtf, .html, .utf8PlainText])
        #expect(!String(decoding: phone[2].data, as: UTF8.self).contains("*"))
    }
}
