import Testing
import SwiftUI

@MainActor
struct MessageContentTests {
    @Test func importedFileKeepsCaptionAndReadableText() {
        let text = "До\n<file name=\"Пример.pdf\" mime=\"application/pdf\">\n<<<EXTERNAL_UNTRUSTED_CONTENT id=\"abc\">>>\nSource: External\n---\nПервая строка\nВторая строка\n<<<END_EXTERNAL_UNTRUSTED_CONTENT id=\"abc\">>>\n</file>\nПосле"
        #expect(ImportedTranscript.parts(text) == [.text("До"), .file(name: "Пример.pdf", text: "Первая строка\nВторая строка"), .text("После")])
    }

    @Test func importedMultipleFilesStayInOrderAndDoNotFetchPaths() {
        let text = "<file name=\"/private/example.txt\" mime=\"text/plain\">Один</file>\nПодпись\n<file name=\"Второй.txt\" mime=\"text/plain\">Два</file>"
        #expect(ImportedTranscript.parts(text) == [.file(name: "/private/example.txt", text: "Один"), .text("Подпись"), .file(name: "Второй.txt", text: "Два")])
    }

    @Test func malformedImportAndOrdinaryTextAreNotLost() {
        for text in ["Обычный текст", "<file name=\"test\">незакрытый файл", "<<<EXTERNAL_UNTRUSTED_CONTENT>>> Текст"] {
            #expect(ImportedTranscript.parts(text) == [.text(text)])
        }
        let raw = "<<<EXTERNAL_UNTRUSTED_CONTENT id=\"a\">>>\nSource: External\n---\nТекст\n<<<END_EXTERNAL_UNTRUSTED_CONTENT id=\"b\">>>"
        #expect(ImportedTranscript.parts("<file name=\"test.txt\" mime=\"text/plain\">\(raw)</file>") == [.file(name: "test.txt", text: raw)])
    }

    @Test func imagesRemainVisibleBetweenText() {
        let blocks = MessageContent(source: "До ![Стул](https://example.com/chair.jpg) после").blocks
        #expect(blocks.map(\.kind) == ["paragraph", "image", "paragraph"])
        #expect(blocks.first(where: { $0.kind == "image" }).map { String($0.content.characters) } == "Стул")
    }

    @Test func consecutiveImagesRemainSeparate() {
        let blocks = MessageContent(source: "![Первый](https://example.com/a.jpg) ![Второй](https://example.com/b.jpg)").blocks
        #expect(blocks.filter { $0.kind == "image" }.count == 2)
    }

    @Test func imageMarkupInCodeDoesNotLoad() {
        let blocks = MessageContent(source: "`![Фото](https://example.com/a.jpg)`\n\n![Закрытый файл](file:///private/secret.jpg)").blocks
        #expect(!blocks.contains { $0.kind == "image" })
    }

    @Test func comparisonsAreTables() {
        let blocks = MessageContent(source: "| Модель | Ограничение |\n| --- | --- |\n| **LongCat** | Preview |\n| Exa | До трёх часов |").blocks
        #expect(blocks.count == 1)
        #expect(blocks.first?.kind == "table")
    }

    @Test func nestedPrioritiesKeepTheirHierarchy() {
        let blocks = MessageContent(source: "1. Исследование\n   - Проверить источники\n   - Оценить стоимость\n2. Разработка").blocks
        #expect(blocks.map(\.level) == [0, 1, 1, 0])
    }

    @Test func multilineQuotesStayTogether() {
        let blocks = MessageContent(source: "> Первая строка\n> продолжение мысли").blocks
        #expect(blocks.count == 1)
        #expect(blocks.first?.kind == "quote")
    }

    @Test func tildeFencesStayCode() {
        let blocks = MessageContent(source: "~~~swift\nlet value = \"**literal**\"\n~~~").blocks
        #expect(blocks.count == 1)
        #expect(blocks.first?.kind == "code")
    }

    @Test func emphasisAndCanonicalLinksSurvive() {
        let block = MessageContent(source: "**Важное** — [первоисточник](https://openai.com/index/proaction/), `код` и *оговорка*.").blocks[0]
        #expect(String(block.content.characters) == "Важное — первоисточник, код и оговорка.")
        #expect(block.content.runs.contains { $0.inlinePresentationIntent?.contains(.stronglyEmphasized) == true })
        #expect(block.content.runs.contains { $0.link?.absoluteString == "https://openai.com/index/proaction/" })
        #expect(block.content.runs.contains { $0.inlinePresentationIntent?.contains(.code) == true })
    }

    @Test func codeFencesPreserveLiteralMarkup() {
        let block = MessageContent(source: "````markdown\n# **Literal**\n```swift\nlet x = 1\n```\n````").blocks[0]
        #expect(block.kind == "code")
        #expect(String(block.content.characters).contains("```swift"))
        #expect(String(block.content.characters).contains("# **Literal**"))
    }

    @Test func listContinuationsDoNotInventExtraItems() {
        let blocks = MessageContent(source: "3. Первый абзац\n\n   Второй абзац того же пункта\n4. Следующий пункт").blocks
        #expect(blocks.map(\.marker) == ["3.", "", "4."])
    }

    @Test func tablesKeepCellsLinksAndAlignment() throws {
        let block = MessageContent(source: "| Модель | Источник |\n| :--- | ---: |\n| **Astra** | [OpenAI](https://openai.com) |").blocks[0]
        let table = try #require(block.table)
        #expect(table.rows.count == 2)
        #expect(table.rows[1].count == 2)
        #expect(String(table.rows[1][0].characters) == "Astra")
        #expect(table.rows[1][1].runs.first?.link?.host() == "openai.com")
        #expect(table.columns[1].alignment == .right)
    }

    @Test func horizontalRulesAndEscapedMarkupRemainDistinct() {
        let blocks = MessageContent(source: "\\*\\*Буквальные звёздочки\\*\\*\n\n---\n\n## Заголовок").blocks
        #expect(blocks.map(\.kind) == ["paragraph", "rule", "heading"])
        #expect(String(blocks[0].content.characters) == "**Буквальные звёздочки**")
    }
}
