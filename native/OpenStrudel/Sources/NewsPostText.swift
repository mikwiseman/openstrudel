import SwiftUI
import UniformTypeIdentifiers
#if os(macOS)
import AppKit
#else
import UIKit
#endif

/// A post draft as the owner reads it. The desk writes Markdown; the sheet shows its bold and links the way the post will
/// look, and gives the Home Markdown back. Leaving the app, the draft is rich text, with a plain version that has no marks.
enum NewsPostText {
    /// How a stretch of the draft looks.
    struct Look: Equatable {
        var bold = false, italic = false, struck = false, code = false
        var link: URL?
    }
    struct Piece: Equatable { var text: String; var look = Look() }

    // MARK: From the desk to the sheet

    /// The desk's Markdown as text to read and edit. Only what stands inside a line is read as formatting, so every line
    /// break and list mark of the post stays where the desk put it.
    static func rich(_ markdown: String) -> AttributedString {
        let options = AttributedString.MarkdownParsingOptions(interpretedSyntax: .inlineOnlyPreservingWhitespace, failurePolicy: .returnPartiallyParsedIfPossible)
        guard var text = try? AttributedString(markdown: markdown, options: options) else { return AttributedString(markdown) }
        for run in text.runs {
            let intent = run.inlinePresentationIntent ?? []
            var look = Look(bold: intent.contains(.stronglyEmphasized), italic: intent.contains(.emphasized), struck: intent.contains(.strikethrough), code: intent.contains(.code))
            look.link = run.link
            text[run.range].inlinePresentationIntent = nil
            dress(&text, run.range, look)
        }
        return text
    }

    /// The editor keeps a look as a font and a line, the same way it writes one when the owner presses Bold.
    private static func dress(_ text: inout AttributedString, _ range: Range<AttributedString.Index>, _ look: Look) {
        var font = look.code ? AppTypography.reading.monospaced() : AppTypography.reading
        if look.bold { font = font.bold() }
        if look.italic { font = font.italic() }
        if look.bold || look.italic || look.code { text[range].swiftUI.font = font }
        if look.struck { text[range].swiftUI.strikethroughStyle = .single }
        if look.link != nil { text[range].swiftUI.foregroundColor = AppTheme.signal; text[range].swiftUI.underlineStyle = .single }
    }

    // MARK: From the sheet

    /// The draft as stretches of one look each. Bold is read against the plain reading font, so the system's Bold Text
    /// setting, which makes every font heavier, does not turn a whole post bold.
    static func pieces(_ text: AttributedString, fonts: Font.Context) -> [Piece] {
        let plain = weight(AppTypography.reading.resolve(in: fonts))
        var result: [Piece] = []
        for run in text.runs {
            let intent = run.inlinePresentationIntent ?? [], font = run.swiftUI.font?.resolve(in: fonts)
            var look = Look(bold: intent.contains(.stronglyEmphasized) || font.map { weight($0) > plain + 0.1 } == true,
                            italic: intent.contains(.emphasized) || font?.isItalic == true,
                            struck: intent.contains(.strikethrough) || run.swiftUI.strikethroughStyle != nil,
                            code: intent.contains(.code) || font.map { CTFontGetSymbolicTraits($0.ctFont).contains(.traitMonoSpace) } == true)
            look.link = run.link
            let piece = Piece(text: String(text[run.range].characters), look: look)
            if let last = result.last, last.look == look { result[result.count - 1].text += piece.text } else { result.append(piece) }
        }
        return result
    }

    private static func weight(_ font: Font.Resolved) -> CGFloat {
        ((CTFontCopyTraits(font.ctFont) as NSDictionary)[kCTFontWeightTrait] as? CGFloat) ?? 0
    }

    /// Markdown for the Home. A mark never crosses a line break and never touches a space, or it would not be read back.
    static func markdown(_ pieces: [Piece]) -> String {
        pieces.map { piece in
            let look = piece.look
            guard look != Look() else { return escaped(piece.text) }
            return piece.text.split(separator: "\n", omittingEmptySubsequences: false).map { line -> String in
                let lead = String(line.prefix { $0 == " " || $0 == "\t" }), rest = line.dropFirst(lead.count)
                let tail = String(rest.reversed().prefix { $0 == " " || $0 == "\t" }.reversed()), core = String(rest.dropLast(tail.count))
                guard !core.isEmpty else { return String(line) }
                var inner = look.code ? "`" + core + "`" : escaped(core)
                if let link = look.link {
                    // An address shown as itself is written as itself.
                    let address = link.absoluteString
                    inner = core == address ? core : "[" + inner + "](" + (address.contains(where: { "() ".contains($0) }) ? "<" + address + ">" : address) + ")"
                }
                if look.struck { inner = "~~" + inner + "~~" }
                let stars = look.bold && look.italic ? "***" : look.bold ? "**" : look.italic ? "*" : ""
                return lead + stars + inner + stars + tail
            }.joined(separator: "\n")
        }.joined()
    }

    /// The characters Markdown would read as a mark, written so that they stay themselves. An underscore inside a word is
    /// never a mark, so names like snake_case keep their look in the text the desk reads; an address is left as it is.
    private static func escaped(_ text: String) -> String {
        var result = "", rest = Substring(text)
        while let address = rest.firstRange(of: #/https?://[^\s<>()\[\]]+/#) {
            result += marks(rest[..<address.lowerBound]) + rest[address]
            rest = rest[address.upperBound...]
        }
        return result + marks(rest)
    }

    private static func marks(_ text: Substring) -> String {
        let characters = Array(text)
        var result = ""
        for (index, character) in characters.enumerated() {
            let inWord = index > 0 && index < characters.count - 1 && characters[index - 1].isLetterOrNumber && characters[index + 1].isLetterOrNumber
            if "\\*`[]".contains(character) || (character == "_" && !inWord) || (character == "~" && index + 1 < characters.count && characters[index + 1] == "~") { result.append("\\") }
            result.append(character)
        }
        return result
    }

    /// The post with no marks at all: a link keeps its address in brackets after its words.
    static func plain(_ pieces: [Piece]) -> String {
        pieces.map { piece in
            guard let link = piece.look.link?.absoluteString, piece.text != link, !piece.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return piece.text }
            return piece.text + " (" + link + ")"
        }.joined()
    }

    /// The post as the HTML a browser's editor or a mail window takes: line breaks as they are, no paragraph margins to lose.
    static func html(_ pieces: [Piece]) -> String {
        let safe = { (text: String) in text.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "<", with: "&lt;").replacingOccurrences(of: ">", with: "&gt;") }
        return "<meta charset=\"utf-8\">" + pieces.map { piece in
            var inner = safe(piece.text).replacingOccurrences(of: "\n", with: "<br>")
            let look = piece.look
            if look.code { inner = "<code>" + inner + "</code>" }
            if look.struck { inner = "<s>" + inner + "</s>" }
            if look.italic { inner = "<em>" + inner + "</em>" }
            if look.bold { inner = "<strong>" + inner + "</strong>" }
            if let link = look.link { inner = "<a href=\"" + safe(link.absoluteString).replacingOccurrences(of: "\"", with: "&quot;") + "\">" + inner + "</a>" }
            return inner
        }.joined()
    }

    /// The post as rich text in a font every reader has, so bold is a bold and a link is a link wherever it is pasted.
    static func attributed(_ pieces: [Piece]) -> NSAttributedString {
        let result = NSMutableAttributedString()
        for piece in pieces {
            let look = piece.look
            let face = look.code ? (look.bold ? "Menlo-Bold" : "Menlo-Regular")
                : look.bold && look.italic ? "Helvetica-BoldOblique" : look.bold ? "Helvetica-Bold" : look.italic ? "Helvetica-Oblique" : "Helvetica"
            var attributes: [NSAttributedString.Key: Any] = [.font: CTFontCreateWithName(face as CFString, 14, nil)]
            if look.struck { attributes[.strikethroughStyle] = NSUnderlineStyle.single.rawValue }
            if let link = look.link { attributes[.link] = link }
            result.append(NSAttributedString(string: piece.text, attributes: attributes))
        }
        return result
    }

    static func rtf(_ pieces: [Piece]) -> Data? {
        let text = attributed(pieces)
        return try? text.data(from: NSRange(location: 0, length: text.length), documentAttributes: [.documentType: NSAttributedString.DocumentType.rtf])
    }

    // MARK: Leaving the app

    /// What goes on the clipboard, by type. Telegram for Mac pastes the plain version whenever there is one and drops every
    /// bold and link with it, so a Telegram post copied on a Mac carries only the rich versions. Everywhere else the plain
    /// version goes along for the fields that take nothing richer.
    static func clipboard(_ pieces: [Piece], channel: String, mac: Bool) -> [(type: UTType, data: Data)] {
        var items: [(UTType, Data)] = []
        if let rtf = rtf(pieces) { items.append((.rtf, rtf)) }
        items.append((.html, Data(html(pieces).utf8)))
        if !(mac && channel == "telegram") { items.append((.utf8PlainText, Data(plain(pieces).utf8))) }
        return items
    }

    static func copy(_ pieces: [Piece], channel: String) {
        #if os(macOS)
        let board = NSPasteboard.general
        board.clearContents()
        for item in clipboard(pieces, channel: channel, mac: true) { board.setData(item.data, forType: NSPasteboard.PasteboardType(item.type.identifier)) }
        #else
        let items = clipboard(pieces, channel: channel, mac: false)
        UIPasteboard.general.setItems([Dictionary(uniqueKeysWithValues: items.map { ($0.type.identifier, $0.type == .utf8PlainText ? String(decoding: $0.data, as: UTF8.self) as Any : $0.data as Any) })])
        #endif
    }
}

private extension Character {
    var isLetterOrNumber: Bool { isLetter || isNumber }
}

/// A draft handed to another app: the plain version first, for the many that take only words, then the rich ones.
struct NewsPostShare: Transferable {
    let pieces: [NewsPostText.Piece]

    static var transferRepresentation: some TransferRepresentation {
        ProxyRepresentation(exporting: { NewsPostText.plain($0.pieces) })
        DataRepresentation(exportedContentType: .rtf) { share in
            guard let data = NewsPostText.rtf(share.pieces) else { throw CocoaError(.fileWriteUnknown) }
            return data
        }
        DataRepresentation(exportedContentType: .html) { Data(NewsPostText.html($0.pieces).utf8) }
    }
}
