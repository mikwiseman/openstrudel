import SwiftUI
#if os(macOS)
import AppKit
#else
import UIKit
#endif

/// A presentation of legacy imported attachments. The stored message and the
/// employee's context stay verbatim; this never fetches a path from the import.
enum ImportedTranscript {
    enum Part: Equatable {
        case text(String)
        case file(name: String, text: String)
    }

    private static let files = try! NSRegularExpression(pattern: #"<file name="([^"\r\n]+)" mime="[^"\r\n]+">\s*([\s\S]*?)\s*</file>"#)
    private static let envelope = try! NSRegularExpression(pattern: #"^\s*<<<EXTERNAL_UNTRUSTED_CONTENT id="([a-zA-Z0-9_-]+)">>>\r?\nSource: External\r?\n---\r?\n([\s\S]*?)\r?\n<<<END_EXTERNAL_UNTRUSTED_CONTENT id="\1">>>\s*$"#)

    static func parts(_ source: String) -> [Part] {
        let range = NSRange(source.startIndex..., in: source)
        let matches = files.matches(in: source, range: range)
        guard !matches.isEmpty else { return [.text(source)] }
        var parts: [Part] = []
        var start = source.startIndex
        for match in matches {
            guard let whole = Range(match.range, in: source),
                  let name = Range(match.range(at: 1), in: source),
                  let content = Range(match.range(at: 2), in: source) else { continue }
            let prefix = String(source[start..<whole.lowerBound]).trimmingCharacters(in: .whitespacesAndNewlines)
            if !prefix.isEmpty { parts.append(.text(prefix)) }
            let raw = String(source[content])
            var text = raw
            if let wrapper = envelope.firstMatch(in: raw, range: NSRange(raw.startIndex..., in: raw)),
               let inner = Range(wrapper.range(at: 2), in: raw) { text = String(raw[inner]) }
            parts.append(.file(name: String(source[name]), text: text))
            start = whole.upperBound
        }
        let suffix = String(source[start...]).trimmingCharacters(in: .whitespacesAndNewlines)
        if !suffix.isEmpty { parts.append(.text(suffix)) }
        return parts
    }
}

/// Imported history: each passage on its bubble, each file as a chip.
struct ImportedMessageText: View {
    let source: String
    var fill: Color = AppTheme.surface
    /// The owner's history sits on the trailing edge like the rest of their messages.
    var alignment: HorizontalAlignment = .leading
    @State private var selected: Document?
    private struct Document: Identifiable {
        let id: Int
        let name: String
        let text: String
    }

    var body: some View {
        VStack(alignment: alignment, spacing: 8) {
            ForEach(Array(ImportedTranscript.parts(source).enumerated()), id: \.offset) { index, part in
                switch part {
                case .text(let text):
                    ChatBubble(text: text, fill: fill)
                case .file(let name, let text):
                    Button { selected = Document(id: index, name: name, text: text) } label: {
                        FileChip(icon: "doc.text", name: name, detail: L("Открыть текст из истории"))
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(L("Открыть текст файла «\(name)»"))
                }
            }
        }
        .sheet(item: $selected) { document in
            NavigationStack {
                ScrollView {
                    Text(document.text)
                        .font(AppTypography.reading).lineSpacing(AppTypography.readingLineSpacing)
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .paragraphDirection(of: document.text)
                        .padding(24)
                }
                .navigationTitle(document.name)
                #if os(iOS)
                .navigationBarTitleDisplayMode(.inline)
                #endif
                .toolbar { ToolbarItem(placement: .confirmationAction) {
                    Button(L("Готово")) { selected = nil }
                } }
            }
            #if os(macOS)
            .frame(width: 620, height: 540)
            #endif
        }
    }
}

/// A person's words in a bubble with one tight corner, the one that points at them: ink with the canvas's colour
/// for the owner, the quiet fill for other people in a shared conversation.
struct ChatBubble: View {
    @Environment(\.colorSchemeContrast) private var contrast
    let text: String
    var fill: Color = AppTheme.userBubble
    /// A bubble with its own context menu stays plain: selectable text answers a right-click with the system text menu.
    var selectable = true
    private var own: Bool { fill == AppTheme.userBubble }

    var body: some View {
        if selectable { bubble.textSelection(.enabled) } else { bubble }
    }

    private var bubble: some View {
        let shape = UnevenRoundedRectangle(topLeadingRadius: Radius.bubble, bottomLeadingRadius: own ? Radius.bubble : Radius.bubbleTail,
                                           bottomTrailingRadius: own ? Radius.bubbleTail : Radius.bubble, topTrailingRadius: Radius.bubble, style: .continuous)
        return Text(text)
            .font(AppTypography.reading)
            .lineSpacing(AppTypography.readingLineSpacing)
            .foregroundStyle(own ? AppTheme.canvas : Color.primary)
            .tint(own ? AppTheme.canvas : AppTheme.accentText)
            .fixedSize(horizontal: false, vertical: true)
            .frame(minHeight: 22)
            .paragraphDirection(of: text)
            .padding(.horizontal, 17)
            .padding(.vertical, 11)
            .background(fill, in: shape)
            .overlay { if contrast == .increased && !own { shape.strokeBorder(AppTheme.separator, lineWidth: 1) } }
    }
}

/// Each block reads in the direction of its first strong letter, so English stays
/// left-aligned in the Hebrew interface and Hebrew is right-aligned in English.
enum ParagraphDirection {
    static func of(_ text: String) -> LayoutDirection? {
        for scalar in text.unicodeScalars where scalar.properties.isAlphabetic {
            switch scalar.value {
            // Hebrew, Arabic, Syriac, Thaana, NKo and their presentation forms.
            case 0x0590...0x08FF, 0xFB1D...0xFDFF, 0xFE70...0xFEFF: return .rightToLeft
            default: return .leftToRight
            }
        }
        return nil
    }
}

private struct BlockDirection: ViewModifier {
    @Environment(\.layoutDirection) private var interface
    let direction: LayoutDirection?

    func body(content: Content) -> some View {
        content.environment(\.layoutDirection, direction ?? interface)
    }
}

private struct ChatSurface: ViewModifier {
    @Environment(\.colorSchemeContrast) private var contrast
    let fill: Color
    let radius: CGFloat

    func body(content: Content) -> some View {
        let shape = RoundedRectangle(cornerRadius: radius, style: .continuous)
        content
            .background(fill, in: shape)
            .overlay { if contrast == .increased { shape.strokeBorder(AppTheme.separator, lineWidth: 1) } }
    }
}

extension View {
    /// Lays a block out in its own reading direction; text without letters follows the interface.
    func paragraphDirection(of text: String) -> some View { modifier(BlockDirection(direction: ParagraphDirection.of(text))) }

    /// Lays a block out in a known reading direction; none follows the interface.
    func paragraphDirection(_ direction: LayoutDirection?) -> some View { modifier(BlockDirection(direction: direction)) }

    /// A transcript fill. Increased contrast adds a 1-pt separator edge, because a fill alone is too faint.
    func chatSurface(_ fill: Color, radius: CGFloat) -> some View { modifier(ChatSurface(fill: fill, radius: radius)) }

    /// A card in the transcript: a white tile with a soft shadow. A question, an approval, a notice, a file.
    func cardTile(radius: CGFloat = Radius.cardTile) -> some View { modifier(ChatSurface(fill: AppTheme.tile, radius: radius)).tileShadow(0.7) }
}

/// A one-pixel rule in the separator colour.
struct Hairline: View {
    @Environment(\.displayScale) private var scale
    var body: some View { Rectangle().fill(AppTheme.separator).frame(height: 1 / scale) }
}

/// Foundation handles Markdown syntax; SwiftUI lays out its native, selectable content.
struct MessageContent: View, Equatable {
    let source: String
    nonisolated static func == (lhs: Self, rhs: Self) -> Bool { lhs.source == rhs.source }

    struct Block: Identifiable {
        let id: Int
        var kind: String
        var content = AttributedString()
        var marker = ""
        var level = 0
        /// The outermost list this item belongs to, so two lists in a row keep paragraph spacing.
        var list: Int?
        var quoteDepth = 0
        var language: String?
        var table: MarkdownTable?
        var imageURL: URL?
    }

    /// Only web and mail links open. An AI reply can carry a file, app or script link
    /// from content it read, so every other scheme keeps its words and loses its target.
    static func allowsLink(_ url: URL) -> Bool { ["https", "http", "mailto"].contains(url.scheme?.lowercased() ?? "") }

    static func safeLinks(_ text: AttributedString) -> AttributedString {
        var result = text
        for run in text.runs { if let url = run.link, !allowsLink(url) { result[run.range].link = nil } }
        return result
    }

    var blocks: [Block] {
        guard let document = try? AttributedString(markdown: source, options: .init(interpretedSyntax: .full)) else {
            return [Block(id: 0, kind: "paragraph", content: AttributedString(source))]
        }
        var result: [Block] = []
        var seenListItems: Set<Int> = []
        for run in document.runs {
            let components = run.presentationIntent?.components ?? []
            var text = AttributedString(document[run.range])
            text.presentationIntent = nil
            text = Self.safeLinks(text)
            if let table = components.first(where: { if case .table = $0.kind { return true }; return false }),
               case .table(let columns) = table.kind,
               let cell = components.first(where: { if case .tableCell = $0.kind { return true }; return false }),
               case .tableCell(let column) = cell.kind {
                if result.last?.id != table.identity {
                    result.append(Block(id: table.identity, kind: "table", table: MarkdownTable(columns: columns)))
                }
                let row = components.compactMap { component -> Int? in
                    switch component.kind {
                    case .tableHeaderRow: return 0
                    case .tableRow(let index): return index
                    default: return nil
                    }
                }.first ?? 0
                result[result.count - 1].table?.append(text, row: row, column: column)
                continue
            }
            let identity = components.first?.identity ?? 0
            if let url = run.imageURL, ["https", "http"].contains(url.scheme?.lowercased() ?? ""),
               url.host != nil, url.user == nil, url.password == nil {
                result.append(Block(id: identity, kind: "image", content: text, imageURL: url))
                continue
            }
            if result.last?.id == identity && result.last?.kind != "image" {
                result[result.count - 1].content.append(text)
                continue
            }
            var block = Block(id: identity, kind: "paragraph", content: text)
            for component in components {
                switch component.kind {
                case .header(let level): block.kind = "heading"; block.level = level
                case .codeBlock(let language): block.kind = "code"; block.language = language
                case .thematicBreak: block.kind = "rule"
                case .blockQuote: block.quoteDepth += 1
                default: break
                }
            }
            if let itemIndex = components.firstIndex(where: { if case .listItem = $0.kind { return true }; return false }),
               case .listItem(let ordinal) = components[itemIndex].kind {
                let item = components[itemIndex]
                let lists = components.filter { $0.kind == .orderedList || $0.kind == .unorderedList }
                block.level = max(0, lists.count - 1)
                block.list = lists.last?.identity
                if seenListItems.insert(item.identity).inserted {
                    block.marker = components.dropFirst(itemIndex + 1).first?.kind == .orderedList ? "\(ordinal)." : "•"
                }
                if block.kind == "paragraph" { block.kind = "list" }
            } else if block.kind == "paragraph", block.quoteDepth > 0 {
                block.kind = "quote"
            }
            result.append(block)
        }
        return result
    }

    /// The reading rhythm: 12 between paragraphs, 6 between list items, 24 above and 8 below a heading.
    static func spacing(before block: Block, after previous: Block?) -> CGFloat {
        guard let previous else { return 0 }
        if block.kind == "heading" { return 24 }
        if previous.kind == "heading" { return 8 }
        if block.kind == "list" && previous.kind == "list" && block.list == previous.list { return 6 }
        return 12
    }

    var body: some View {
        let document = blocks
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(document.enumerated()), id: \.offset) { index, block in
                let previous = index == 0 ? nil : document[index - 1]
                blockContent(block, after: previous)
                    .padding(.top, Self.spacing(before: block, after: previous))
            }
        }
        .font(AppTypography.reading)
        .lineSpacing(AppTypography.readingLineSpacing)
        .textSelection(.enabled)
        .tint(AppTheme.accentText)
        .environment(\.openURL, OpenURLAction { Self.allowsLink($0) ? .systemAction : .discarded })
    }

    @ViewBuilder private func blockContent(_ block: Block, after previous: Block?) -> some View {
        let words = String(block.content.characters)
        switch block.kind {
        case "heading":
            Text(Self.styled(block.content))
                .font(block.level <= 2 ? AppTypography.title : AppTypography.reading.weight(.semibold))
                .accessibilityAddTraits(.isHeader)
                .frame(maxWidth: .infinity, alignment: .leading)
                .paragraphDirection(of: words)
        case "list":
            ListItem(marker: block.marker, level: block.level, content: Self.styled(block.content))
                .paragraphDirection(of: words)
        case "quote":
            Text(Self.styled(block.content))
                .foregroundStyle(AppTheme.secondaryText)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.leading, 2 + 12)
                .overlay(alignment: .leading) {
                    // Consecutive quote paragraphs share one unbroken rule.
                    Rectangle().fill(AppTheme.separator).frame(width: 2)
                        .padding(.top, previous?.kind == "quote" ? -Self.spacing(before: block, after: previous) : 0)
                }
                .paragraphDirection(of: words)
        case "code":
            CodeBlockView(code: words.trimmingCharacters(in: .newlines), language: block.language)
        case "table":
            if let table = block.table { MarkdownTableView(table: table) }
        case "image":
            if let url = block.imageURL {
                ChatImage(name: words, identity: url.absoluteString, autoload: false, origin: url.host) {
                    try await ChatMedia.download(url)
                }
            }
        case "rule":
            Hairline()
        default:
            Text(Self.styled(block.content))
                .frame(maxWidth: .infinity, alignment: .leading)
                .paragraphDirection(of: words)
        }
    }

    /// Links read as links at rest: ink with an underline in the secondary colour. Inline code is SF Mono on the surface.
    static func styled(_ source: AttributedString) -> AttributedString {
        var text = source
        for run in source.runs {
            if run.inlinePresentationIntent?.contains(.code) == true {
                text[run.range].font = AppTypography.code
                text[run.range].backgroundColor = AppTheme.surface
            }
            if run.link != nil {
                text[run.range].foregroundColor = AppTheme.accentText
                text[run.range].underlineStyle = Text.LineStyle(pattern: .solid, color: AppTheme.secondaryText)
            }
        }
        return text
    }
}

/// A list item with a fixed marker column: bullets and right-aligned tabular numbers end on one
/// edge, so every item's text starts on one line. Nested items start under their parent's text.
private struct ListItem: View {
    let marker: String
    let level: Int
    let content: AttributedString
    @Environment(\.layoutDirection) private var direction
    /// Wide enough for "10." at the reading size, so two-digit lists keep the same text edge.
    @ScaledMetric(relativeTo: .body) private var markerWidth: CGFloat = ListItem.marker
    private let gap: CGFloat = 8
    #if os(macOS)
    private static let marker: CGFloat = 24
    #else
    private static let marker: CGFloat = 28
    #endif

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: gap) {
            // A marker has no letters, so it would read in the window's direction: "1." turns
            // into ".1" beside English in the Hebrew interface. Isolate it in its item's direction.
            Text((direction == .rightToLeft ? "\u{2067}" : "\u{2066}") + marker + "\u{2069}")
                .foregroundStyle(AppTheme.secondaryText)
                .monospacedDigit()
                .fixedSize()
                .frame(width: markerWidth, alignment: .trailing)
            Text(content).frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.leading, CGFloat(level) * (markerWidth + gap))
        .accessibilityElement(children: .combine)
    }
}

/// A fenced block: SF Mono on the surface, scrolling sideways instead of wrapping.
/// Copy appears on hover on the Mac and stays visible on iOS.
struct CodeBlockView: View {
    let code: String
    let language: String?
    @State private var hovering = false
    @State private var buttonHovering = false
    @State private var copied = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if let language, !language.isEmpty {
                Text(language)
                    .font(AppTypography.meta)
                    .foregroundStyle(AppTheme.secondaryText)
                    .padding([.horizontal, .top], 12)
            }
            // Padding lives inside the scroll view so lines scroll to the block's edge
            // and the Mac scroller sits in the bottom padding, not over the last line.
            ScrollView(.horizontal) {
                Text(code)
                    .font(AppTypography.code)
                    .lineSpacing(AppTypography.codeLineSpacing)
                    .fixedSize()
                    // The Mac button only shows on hover, so VoiceOver gets the same action here.
                    .accessibilityAction(named: L("Скопировать код"), copy)
                    .padding(.horizontal, 12)
                    .padding(.top, language?.isEmpty == false ? 8 : 12)
                    .padding(.bottom, 12)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .chatSurface(AppTheme.surface, radius: Radius.card)
        .overlay(alignment: .topTrailing) { copyButton }
        .onHover { hovering = $0 }
        .environment(\.layoutDirection, .leftToRight)
        .accessibilityElement(children: .contain)
    }

    private var copyButton: some View {
        Button(action: copy) {
            Image(systemName: copied ? "checkmark" : "doc.on.doc")
                .font(.system(size: 12, weight: .medium))
                .contentTransition(.symbolEffect(.replace))
                .foregroundStyle(buttonHovering ? AnyShapeStyle(.primary) : AnyShapeStyle(AppTheme.secondaryText))
                // 4 from the block's corner, so 8 is concentric with its 12.
                .frame(width: 28, height: 28)
                .background(AppTheme.surface, in: RoundedRectangle(cornerRadius: Radius.control, style: .continuous))
                .padding(4)
                .frame(width: controlTarget + 4, height: controlTarget + 4, alignment: .topTrailing)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { buttonHovering = $0 }
        .help(copied ? L("Код скопирован") : L("Скопировать код"))
        .accessibilityLabel(copied ? L("Код скопирован") : L("Скопировать код"))
        #if os(macOS)
        .opacity(hovering || copied ? 1 : 0)
        .allowsHitTesting(hovering || copied)
        .animation(.easeOut(duration: 0.15), value: hovering)
        #endif
    }

    private func copy() {
        #if os(macOS)
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(code, forType: .string)
        #else
        UIPasteboard.general.string = code
        #endif
        copied = true
        Task {
            try? await Task.sleep(for: .seconds(1.5))
            copied = false
        }
    }
}

struct MarkdownTable {
    let columns: [PresentationIntent.TableColumn]
    var rows: [[AttributedString]] = []

    mutating func append(_ text: AttributedString, row: Int, column: Int) {
        while rows.count <= row { rows.append(Array(repeating: AttributedString(), count: columns.count)) }
        guard rows[row].indices.contains(column) else { return }
        rows[row][column].append(text)
    }

    private static let number = try! NSRegularExpression(pattern: #"^[-+−]?\p{Sc}?\s?\d[\d\s.,']*\s?%?\s?\p{Sc}?$"#)

    /// A column whose filled body cells are all numbers: counts, prices, percentages.
    func isNumeric(_ column: Int) -> Bool {
        let cells = rows.dropFirst().compactMap { row in
            row.indices.contains(column) ? String(row[column].characters).trimmingCharacters(in: .whitespaces) : nil
        }.filter { !$0.isEmpty }
        return !cells.isEmpty && cells.allSatisfy { Self.number.firstMatch(in: $0, range: NSRange($0.startIndex..., in: $0)) != nil }
    }

    /// Explicit centre and right alignment win; otherwise numbers sit on the trailing edge.
    /// Foundation reports `:---` and `---` alike as left, so left reads as no preference.
    func alignment(_ column: Int) -> HorizontalAlignment {
        switch columns[column].alignment {
        case .center: .center
        case .right: .trailing
        default: isNumeric(column) ? .trailing : .leading
        }
    }

    var words: String { rows.joined().map { String($0.characters) }.joined(separator: " ") }

    /// The column's longest word by letters, which a wrapped column should keep on one line.
    func longestWord(_ column: Int) -> (text: String, inHeader: Bool) {
        let words = rows.indices.flatMap { row in
            String(rows[row][column].characters).split(whereSeparator: \.isWhitespace).map { (text: String($0), inHeader: row == 0) }
        }
        return words.max { $0.text.count < $1.text.count } ?? (text: "", inHeader: false)
    }
}

private struct MarkdownTableView: View {
    let table: MarkdownTable
    @Environment(\.dynamicTypeSize) private var typeSize
    @Environment(\.colorSchemeContrast) private var contrast
    #if os(iOS)
    @Environment(\.horizontalSizeClass) private var sizeClass
    #endif
    /// Below this, a column's text would break into single words, so the table scrolls instead.
    private let minimumColumn: CGFloat = 120

    private var isCompact: Bool {
        #if os(iOS)
        sizeClass == .compact || typeSize.isAccessibilitySize
        #else
        false
        #endif
    }

    var body: some View {
        Group {
            if isCompact {
                compact
            } else {
                // A table that fits never scrolls: it wraps first, and scrolls only when its columns
                // could no longer keep their minimum width and their longest words.
                ViewThatFits(in: .horizontal) {
                    grid
                    ScrollView(.horizontal) { grid }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .paragraphDirection(of: table.words)
    }

    private var grid: some View {
        let shape = RoundedRectangle(cornerRadius: Radius.card, style: .continuous)
        return TableLayout(columns: table.columns.count, minimumColumn: minimumColumn) {
            ForEach(table.rows.indices, id: \.self) { row in
                ForEach(table.rows[row].indices, id: \.self) { column in
                    cell(row: row, column: column)
                }
            }
            ForEach(table.columns.indices, id: \.self) { column in
                let word = table.longestWord(column)
                Text(word.text)
                    .font(word.inHeader ? AppTypography.reading.weight(.semibold) : AppTypography.reading)
                    .monospacedDigit()
                    .padding(.horizontal, 12)
                    .hidden()
                    .accessibilityHidden(true)
            }
        }
        .clipShape(shape)
        .overlay { if contrast == .increased { shape.strokeBorder(AppTheme.separator, lineWidth: 1) } }
    }

    private func cell(row: Int, column: Int) -> some View {
        let alignment = table.alignment(column)
        return Text(MessageContent.styled(table.rows[row][column]))
            .font(row == 0 ? AppTypography.reading.weight(.semibold) : AppTypography.reading)
            .monospacedDigit()
            .lineSpacing(AppTypography.readingLineSpacing)
            .multilineTextAlignment(alignment == .trailing ? .trailing : alignment == .center ? .center : .leading)
            .fixedSize(horizontal: false, vertical: true)
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            // Every cell fills its column and row, so the header band and the rules run edge to edge.
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: Alignment(horizontal: alignment, vertical: .top))
            .background { if row == 0 { AppTheme.surface } }
            .overlay(alignment: .top) { if row > 1 { Hairline() } }
    }

    /// Narrow iPhones and accessibility sizes read a table as one card per row.
    private var compact: some View {
        VStack(alignment: .leading, spacing: 12) {
            ForEach(Array(table.rows.dropFirst().enumerated()), id: \.offset) { index, row in
                if index > 0 { Hairline() }
                VStack(alignment: .leading, spacing: 8) {
                    ForEach(row.indices, id: \.self) { column in
                        VStack(alignment: .leading, spacing: 4) {
                            if let header = table.rows.first?[column] {
                                Text(MessageContent.styled(header)).font(AppTypography.meta).foregroundStyle(AppTheme.secondaryText)
                            }
                            Text(MessageContent.styled(row[column]))
                                .font(column == 0 ? AppTypography.reading.weight(.semibold) : AppTypography.reading)
                                .monospacedDigit()
                        }
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .lineSpacing(AppTypography.readingLineSpacing)
    }
}

/// Table cells in rows, followed by one hidden longest word per column. A table that fits keeps every
/// column at its natural width. A narrower one keeps short columns whole and shares the rest by natural
/// width, never below `minimumColumn` or a column's longest word. Unconstrained, the table takes that
/// minimum, so it wraps before it scrolls. Sizing and placement measure rows at the same widths, so a
/// wrapped row is never clipped.
struct TableLayout: SwiftUI.Layout {
    let columns: Int
    let minimumColumn: CGFloat

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let widths = columnWidths(proposal.width, subviews)
        return CGSize(width: widths.reduce(0, +), height: rowHeights(widths, subviews).reduce(0, +))
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        let widths = columnWidths(proposal.width, subviews)
        var y = bounds.minY
        for (row, height) in rowHeights(widths, subviews).enumerated() {
            var x = bounds.minX
            for (column, width) in widths.enumerated() {
                subviews[row * columns + column].place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(width: width, height: height))
                x += width
            }
            y += height
        }
        for word in subviews.suffix(columns) { word.place(at: bounds.origin, proposal: .zero) }
    }

    private func columnWidths(_ width: CGFloat?, _ subviews: Subviews) -> [CGFloat] {
        guard columns > 0, subviews.count >= columns else { return [] }
        let cells = subviews.dropLast(columns).map { $0.sizeThatFits(.unspecified).width }
        let natural = (0..<columns).map { column in stride(from: column, to: cells.count, by: columns).map { cells[$0] }.max() ?? 0 }
        let words = subviews.suffix(columns).map { $0.sizeThatFits(.unspecified).width }
        return Self.columnWidths(natural: natural, words: words, width: width, minimum: minimumColumn)
    }

    static func columnWidths(natural: [CGFloat], words: [CGFloat], width: CGFloat?, minimum: CGFloat) -> [CGFloat] {
        let floors = natural.indices.map { min(natural[$0], max(minimum, words[$0])) }
        let width = width ?? floors.reduce(0, +)
        guard width < natural.reduce(0, +) else { return natural }
        guard width > floors.reduce(0, +) else { return floors }
        var widths = natural, open = Set(natural.indices), room = width
        while !open.isEmpty {
            let scale = room / open.reduce(0) { $0 + natural[$1] }
            let floored = open.filter { natural[$0] * scale < floors[$0] }
            if floored.isEmpty {
                for column in open { widths[column] = natural[column] * scale }
                break
            }
            for column in floored {
                widths[column] = floors[column]
                room -= floors[column]
                open.remove(column)
            }
        }
        return widths
    }

    private func rowHeights(_ widths: [CGFloat], _ subviews: Subviews) -> [CGFloat] {
        guard !widths.isEmpty else { return [] }
        return stride(from: 0, to: subviews.count - columns, by: columns).map { start in
            widths.indices.map { subviews[start + $0].sizeThatFits(ProposedViewSize(width: widths[$0], height: nil)).height }.max() ?? 0
        }
    }
}
