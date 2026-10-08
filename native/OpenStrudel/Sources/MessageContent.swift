import SwiftUI

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

struct ImportedMessageText: View {
    let source: String
    @State private var selected: Document?
    private struct Document: Identifiable {
        let id: Int
        let name: String
        let text: String
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(Array(ImportedTranscript.parts(source).enumerated()), id: \.offset) { index, part in
                switch part {
                case .text(let text):
                    Text(text).font(ChatTypography.body).lineSpacing(4).textSelection(.enabled)
                case .file(let name, let text):
                    Button { selected = Document(id: index, name: name, text: text) } label: {
                        HStack(spacing: 12) {
                            Image(systemName: "doc.text").font(.title2).foregroundStyle(AppTheme.secondaryText)
                            VStack(alignment: .leading, spacing: 3) {
                                Text(name).font(.callout.weight(.medium)).lineLimit(2)
                                Text("Открыть текст из истории").font(.caption).foregroundStyle(AppTheme.secondaryText)
                            }
                            Spacer(minLength: 8)
                            Image(systemName: "chevron.right").font(.caption).foregroundStyle(AppTheme.secondaryText)
                        }.padding(12).contentShape(Rectangle())
                    }.buttonStyle(.plain)
                        .background(.primary.opacity(0.035), in: RoundedRectangle(cornerRadius: 11))
                        .accessibilityLabel("Открыть текст файла «\(name)»")
                }
            }
        }
        .sheet(item: $selected) { document in
            NavigationStack {
                ScrollView {
                    Text(document.text).font(ChatTypography.body).textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading).padding(24)
                }
                .navigationTitle(document.name)
                #if os(iOS)
                .navigationBarTitleDisplayMode(.inline)
                #endif
                .toolbar { ToolbarItem(placement: .confirmationAction) {
                    Button("Готово") { selected = nil }
                } }
            }
            #if os(macOS)
            .frame(width: 620, height: 540)
            #endif
        }
    }
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
        var quoteDepth = 0
        var language: String?
        var table: MarkdownTable?
        var imageURL: URL?
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
                block.level = max(0, components.filter { $0.kind == .orderedList || $0.kind == .unorderedList }.count - 1)
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

    var body: some View {
        let document = blocks
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(document.enumerated()), id: \.offset) { index, block in
                blockContent(block, first: index == 0)
                    .padding(.leading, CGFloat(block.level) * (block.kind == "list" ? 18 : 0))
                    // List items read as one group; other blocks keep paragraph spacing.
                    .padding(.top, index == 0 ? 0 : (block.kind == "list" && document[index - 1].kind == "list" ? 6 : 14))
            }
        }
        .font(ChatTypography.body)
        .lineSpacing(4)
        .textSelection(.enabled)
        .tint(AppTheme.accent)
    }

    @ViewBuilder private func blockContent(_ block: Block, first: Bool) -> some View {
        switch block.kind {
        case "heading":
            Text(styled(block.content))
                .font(block.level <= 2 ? .system(block.level == 1 ? .title2 : .title3, design: .default, weight: .semibold) : ChatTypography.body.weight(.semibold))
                .padding(.top, first ? 0 : 5)
                .accessibilityAddTraits(.isHeader)
        case "list":
            HStack(alignment: .firstTextBaseline, spacing: 9) {
                Text(block.marker).foregroundStyle(AppTheme.secondaryText).monospacedDigit().frame(minWidth: 14, alignment: .trailing)
                Text(styled(block.content)).frame(maxWidth: .infinity, alignment: .leading)
            }
        case "quote":
            Text(styled(block.content))
                .foregroundStyle(AppTheme.secondaryText)
                .padding(.leading, 14)
                .overlay(alignment: .leading) {
                    RoundedRectangle(cornerRadius: 2).fill(.secondary.opacity(0.4)).frame(width: 3)
                }
        case "code":
            VStack(alignment: .leading, spacing: 8) {
                if let language = block.language, !language.isEmpty {
                    Text(language).font(.caption).foregroundStyle(AppTheme.secondaryText)
                }
                ScrollView(.horizontal) {
                    Text(String(block.content.characters).trimmingCharacters(in: .newlines))
                        .font(ChatTypography.code).fixedSize()
                }
            }
            .padding(12)
            .background(.primary.opacity(0.04), in: RoundedRectangle(cornerRadius: 10))
        case "table":
            if let table = block.table { MarkdownTableView(table: table) }
        case "image":
            if let url = block.imageURL {
                ChatImage(name: String(block.content.characters), identity: url.absoluteString) {
                    try await ChatMedia.download(url)
                }
            }
        case "rule": Divider().padding(.vertical, 4)
        default: Text(styled(block.content))
        }
    }

    private func styled(_ source: AttributedString) -> AttributedString {
        var text = source
        for run in source.runs where run.inlinePresentationIntent?.contains(.code) == true {
            text[run.range].font = ChatTypography.code
            text[run.range].backgroundColor = .primary.opacity(0.06)
        }
        return text
    }
}

enum ChatTypography {
    static var body: Font { AppTypography.chat }
    static var code: Font { body.monospaced() }
}

struct MarkdownTable {
    let columns: [PresentationIntent.TableColumn]
    var rows: [[AttributedString]] = []

    mutating func append(_ text: AttributedString, row: Int, column: Int) {
        while rows.count <= row { rows.append(Array(repeating: AttributedString(), count: columns.count)) }
        guard rows[row].indices.contains(column) else { return }
        rows[row][column].append(text)
    }
}

private struct MarkdownTableView: View {
    let table: MarkdownTable
    @Environment(\.dynamicTypeSize) private var typeSize
    #if os(iOS)
    @Environment(\.horizontalSizeClass) private var sizeClass
    #endif
    @State private var availableWidth: CGFloat = 600

    private var isCompact: Bool {
        #if os(iOS)
        sizeClass == .compact || typeSize.isAccessibilitySize
        #else
        false
        #endif
    }
    private var columnWidth: CGFloat { max(132, availableWidth / CGFloat(max(1, table.columns.count)) - 24) }

    var body: some View {
        Group {
            if isCompact {
                VStack(alignment: .leading, spacing: 16) {
                    ForEach(Array(table.rows.dropFirst().enumerated()), id: \.offset) { rowIndex, row in
                        if rowIndex > 0 { Divider() }
                        VStack(alignment: .leading, spacing: 10) {
                            ForEach(row.indices, id: \.self) { column in
                                VStack(alignment: .leading, spacing: 3) {
                                    if let header = table.rows.first?[column] {
                                        Text(header).font(.caption).foregroundStyle(AppTheme.secondaryText)
                                    }
                                    Text(row[column]).font(column == 0 ? ChatTypography.body.weight(.semibold) : ChatTypography.body)
                                }
                            }
                        }.frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
            } else {
                ScrollView(.horizontal) {
                    Grid(alignment: .topLeading, horizontalSpacing: 0, verticalSpacing: 0) {
                        ForEach(table.rows.indices, id: \.self) { row in
                            GridRow {
                                ForEach(table.rows[row].indices, id: \.self) { column in
                                    Text(table.rows[row][column])
                                        .font(row == 0 ? ChatTypography.body.weight(.semibold) : ChatTypography.body)
                                        .frame(width: columnWidth, alignment: alignment(column))
                                        .padding(12)
                                }
                            }
                            if row == 0 { Divider().gridCellUnsizedAxes(.horizontal) }
                        }
                    }
                }
                .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { availableWidth = $0 }
                .clipShape(RoundedRectangle(cornerRadius: 10))
                .overlay { RoundedRectangle(cornerRadius: 10).stroke(.primary.opacity(0.1)) }
            }
        }
        .lineSpacing(3)
    }

    private func alignment(_ column: Int) -> Alignment {
        switch table.columns[column].alignment {
        case .right: .trailing
        case .center: .center
        default: .leading
        }
    }
}
