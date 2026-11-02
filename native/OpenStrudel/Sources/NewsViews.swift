import SwiftUI

/// The News employee's stories, arranged for reading: the morning edition, the radar of events as they come,
/// and one story with its sources, history and a discussion. Every story is a message in the employee's chat.
/// Where the reader is: the open list, the story on top of it, and each list's place, kept across chat visits.
struct NewsPlace: Equatable {
    enum Mode: Hashable { case edition, radar, chat }
    var mode: Mode = .edition
    var story: String?
    var editionAnchor: String?
    var radarAnchor: String?
}

/// The edition's voice: a serif for headlines (the system's New York), the interface face for reading.
private enum NewsType {
    static func headline(_ mac: CGFloat, _ style: Font.TextStyle) -> Font {
        #if os(macOS)
        .system(size: mac, design: .serif)
        #else
        .system(style, design: .serif)
        #endif
    }
    static var kicker: Font {
        #if os(macOS)
        .system(size: 10.5, weight: .semibold)
        #else
        .caption2.weight(.semibold)
        #endif
    }
    static var lead: Font {
        #if os(macOS)
        .system(size: 17)
        #else
        .body
        #endif
    }
}

enum NewsLayout {
    /// The edition's reading column, wider than the chat's for headlines.
    static let column: CGFloat = 720
}

private extension String {
    var instant: Date? { (try? Date.ISO8601FormatStyle(includingFractionalSeconds: true).parse(self)) ?? (try? Date.ISO8601FormatStyle().parse(self)) }
}

/// "3 истории" with the plural the language needs.
func newsStoryCount(_ count: Int) -> String {
    let few = L10n.shared.language == .russian && (2...4).contains(count % 10) && !(12...14).contains(count % 100)
    let one = L10n.shared.language == .russian ? count % 10 == 1 && count % 100 != 11 : count == 1
    if one { return L("\(count) история") }
    return few ? L("\(count) истории") : L("\(count) историй")
}

private struct Kicker: View {
    let section: String
    let status: String?
    var body: some View {
        // Large text moves the status under the section rather than breaking the section's words.
        ViewThatFits(in: .horizontal) {
            HStack(spacing: 8) {
                label.fixedSize()
                if let status {
                    Text("•").foregroundStyle(AppTheme.secondaryText).accessibilityHidden(true)
                    pill(status)
                }
            }
            VStack(alignment: .leading, spacing: 6) {
                label
                if let status { pill(status) }
            }
        }
        .font(NewsType.kicker)
        .accessibilityElement(children: .combine)
    }

    private var label: some View { Text(section.uppercased()).tracking(1.4).foregroundStyle(AppTheme.secondaryText) }

    private func pill(_ status: String) -> some View {
        Text(status.uppercased()).tracking(1)
            .foregroundStyle(Color("NewsStatusText"))
            .padding(.horizontal, 6).padding(.vertical, 3)
            .background(Color("NewsStatusFill"), in: .rect(cornerRadius: 4, style: .continuous))
            .fixedSize()
    }
}

private struct ArrowLabel: View {
    let title: String
    var symbol = "arrow.right"
    var body: some View {
        HStack(spacing: 6) { Text(title); Image(systemName: symbol).imageScale(.small) }
            .font(AppTypography.interface.weight(.medium))
            .foregroundStyle(.primary)
    }
}

// MARK: - Lists

struct NewsSwitcher: View {
    @Binding var mode: NewsPlace.Mode
    var body: some View {
        // Large text keeps the three words on one line by dropping the symbols first.
        ViewThatFits(in: .horizontal) {
            tabs.labelStyle(.titleAndIcon)
            tabs.labelStyle(.titleOnly)
            ScrollView(.horizontal) { tabs.labelStyle(.titleOnly) }.scrollIndicators(.hidden)
        }
        .accessibilityElement(children: .contain)
    }

    private var tabs: some View {
        HStack(spacing: 24) {
            tab(L("Утренний выпуск"), symbol: "newspaper", .edition)
            tab(L("Радар"), symbol: "dot.radiowaves.left.and.right", .radar)
            tab(L("Чат"), symbol: "bubble.left", .chat)
        }
        .fixedSize()
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func tab(_ title: String, symbol: String, _ value: NewsPlace.Mode) -> some View {
        Button { mode = value } label: {
            Label(title, systemImage: symbol)
                .font(AppTypography.interface.weight(mode == value ? .semibold : .regular))
                .foregroundStyle(mode == value ? Color.primary : AppTheme.secondaryText)
                .padding(.vertical, 10)
                .overlay(alignment: .bottom) { Rectangle().fill(mode == value ? Color.primary : .clear).frame(height: 1.5) }
                .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(mode == value ? .isSelected : [])
        .accessibilityIdentifier("newsMode-" + String(describing: value))
    }
}

struct NewsDeskView: View {
    @Binding var place: NewsPlace
    /// The stories of this reader, with their questions and answers.
    let messages: [HomeMessage]
    /// Takes the open story to the chat as context.
    let discuss: (HomeMessage) -> Void

    var body: some View {
        let desk = NewsDesk(messages), open = desk.item(place.story)
        // Both lists stay alive under the story, so going back lands exactly where the reader left.
        ZStack {
            NewsEditionView(desk: desk, anchor: $place.editionAnchor, showRadar: { place.mode = .radar }) { place.story = $0 }
                .shown(open == nil && place.mode == .edition)
            NewsRadarView(items: desk.radarItems, anchor: $place.radarAnchor) { place.story = $0 }
                .shown(open == nil && place.mode == .radar)
            if let open {
                let list = place.mode == .radar ? desk.radarItems : desk.editionItems
                let next = list.firstIndex { $0.id == open.id }.flatMap { list.indices.contains($0 + 1) ? list[$0 + 1] : nil }
                NewsStoryReader(item: open, next: next, backTitle: place.mode == .radar ? L("К радару") : L("К выпуску"),
                                back: { place.story = nil }, open: { place.story = $0 }, discuss: { discuss(open.latest) })
                    .id(open.id)
            }
        }
    }
}

private extension View {
    func shown(_ visible: Bool) -> some View {
        opacity(visible ? 1 : 0).allowsHitTesting(visible).accessibilityHidden(!visible)
    }
}

private extension View {
    /// Under the Mac toolbar and the tabs, text scrolls behind a hard edge, as in the chat.
    func newsScrollEdge() -> some View {
        #if os(macOS)
        scrollEdgeEffectStyle(.hard, for: .top)
        #else
        self
        #endif
    }
}

private struct NewsPage<Content: View>: View {
    @Binding var anchor: String?
    @ViewBuilder let content: Content
    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) { content }
                .scrollTargetLayout()
                .frame(maxWidth: NewsLayout.column, alignment: .leading)
                .padding(.horizontal, Layout.edge)
                .padding(.top, Layout.belowToolbar)
                .padding(.bottom, 48)
                .frame(maxWidth: .infinity)
        }
        // Back from a story, the list opens where the reader left it.
        .scrollPosition(id: $anchor, anchor: .top)
        .scrollIndicators(.hidden)
        .newsScrollEdge()
    }
}

struct NewsEditionView: View {
    let desk: NewsDesk
    @Binding var anchor: String?
    let showRadar: () -> Void
    let open: (String) -> Void

    var body: some View {
        NewsPage(anchor: $anchor) {
            if let lead = desk.editionItems.first, let edition = desk.edition {
                header(edition: edition, published: desk.editionItems.compactMap { $0.versions.first { $0.story?.edition == edition }?.sentAt }.min())
                    .id("header")
                NewsLeadStory(item: lead) { open(lead.id) }.id(lead.id)
                if desk.editionItems.count > 1 {
                    Text(L("Ещё в выпуске").uppercased()).font(NewsType.kicker).tracking(2)
                        .padding(.top, 32).padding(.bottom, 8)
                        .accessibilityAddTraits(.isHeader)
                    ForEach(Array(desk.editionItems.dropFirst().enumerated()), id: \.element.id) { index, item in
                        NewsRow(number: index + 2, item: item) { open(item.id) }.id(item.id)
                    }
                }
            } else {
                ContentUnavailableView {
                    Label(L("Утренний выпуск выйдет в 07:00"), systemImage: "newspaper")
                } description: {
                    Text(L("Важное за день News показывает на радаре по мере появления."))
                } actions: {
                    Button(L("Открыть радар"), action: showRadar)
                }
                .padding(.top, 64)
            }
        }
    }

    private func header(edition: String, published: Date?) -> some View {
        let day = (edition + "T12:00:00Z").instant ?? .now
        let weekday = day.formatted(.dateTime.weekday(.wide).locale(L10n.locale))
        return VStack(alignment: .leading, spacing: 8) {
            Text((weekday + " · " + L("Утренний выпуск")).uppercased()).font(NewsType.kicker).tracking(2).foregroundStyle(AppTheme.secondaryText)
            ViewThatFits(in: .horizontal) {
                HStack(alignment: .lastTextBaseline) { title(day); Spacer(minLength: 24); stats(published, trailing: true) }
                VStack(alignment: .leading, spacing: 8) { title(day); stats(published, trailing: false) }
            }
            Rectangle().fill(Color.primary.opacity(0.75)).frame(height: 1.5).padding(.top, 16)
        }
        .padding(.bottom, 32)
    }

    private func title(_ day: Date) -> some View {
        Text(day.formatted(.dateTime.day().month(.wide).locale(L10n.locale)) + ".")
            .font(NewsType.headline(48, .largeTitle))
            .accessibilityAddTraits(.isHeader)
    }

    private func stats(_ published: Date?, trailing: Bool) -> some View {
        VStack(alignment: trailing ? .trailing : .leading, spacing: 4) {
            if let published { Text(ChatClock.time(published)).monospacedDigit() }
            Text(newsStoryCount(desk.editionItems.count))
        }
        .font(AppTypography.meta).foregroundStyle(AppTheme.secondaryText)
    }
}

private struct NewsLeadStory: View {
    let item: NewsDesk.Item
    let open: () -> Void
    var body: some View {
        Button(action: open) {
            VStack(alignment: .leading, spacing: 16) {
                Kicker(section: item.story.section, status: item.story.status)
                Text(item.story.title).font(NewsType.headline(36, .title)).lineSpacing(2)
                    .multilineTextAlignment(.leading).fixedSize(horizontal: false, vertical: true)
                Text(item.story.summary).font(NewsType.lead).foregroundStyle(AppTheme.secondaryText).lineSpacing(AppTypography.readingLineSpacing)
                    .multilineTextAlignment(.leading).fixedSize(horizontal: false, vertical: true)
                HStack(spacing: 24) {
                    ArrowLabel(title: L("Читать и обсудить"))
                    Text(L("Источники · \(item.story.sources.count)")).font(AppTypography.meta).foregroundStyle(AppTheme.secondaryText)
                }
                .padding(.top, 8)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.bottom, 32)
            .overlay(alignment: .bottom) { Hairline() }
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .combine)
        .accessibilityHint(L("Открыть историю"))
    }
}

private struct NewsRow: View {
    let number: Int
    let item: NewsDesk.Item
    let open: () -> Void
    var body: some View {
        Button(action: open) {
            HStack(alignment: .firstTextBaseline, spacing: 16) {
                Text(String(format: "%02d", number)).font(NewsType.headline(17, .body).italic()).foregroundStyle(AppTheme.secondaryText)
                    .monospacedDigit().frame(minWidth: 24, alignment: .leading)
                VStack(alignment: .leading, spacing: 8) {
                    Kicker(section: item.story.section, status: item.story.status)
                    Text(item.story.title).font(NewsType.headline(26, .title2))
                        .multilineTextAlignment(.leading).fixedSize(horizontal: false, vertical: true)
                    Text(item.story.summary).font(AppTypography.reading).foregroundStyle(AppTheme.secondaryText).lineSpacing(AppTypography.readingLineSpacing)
                        .multilineTextAlignment(.leading).fixedSize(horizontal: false, vertical: true)
                    ArrowLabel(title: L("Подробнее")).font(AppTypography.meta).padding(.top, 4)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.vertical, 24)
            .overlay(alignment: .bottom) { Hairline() }
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .combine)
        .accessibilityHint(L("Открыть историю"))
    }
}

struct NewsRadarView: View {
    let items: [NewsDesk.Item]
    @Binding var anchor: String?
    let open: (String) -> Void

    var body: some View {
        NewsPage(anchor: $anchor) {
            Text(L("Радар").uppercased()).font(NewsType.kicker).tracking(2).foregroundStyle(AppTheme.secondaryText)
            Text(L("Важное по мере появления")).font(NewsType.headline(34, .largeTitle)).padding(.top, 8).padding(.bottom, 16)
                .accessibilityAddTraits(.isHeader)
            if items.isEmpty {
                Text(L("Пока ничего существенного. News молчит, пока не появится новый факт.")).font(AppTypography.reading).foregroundStyle(AppTheme.secondaryText).padding(.top, 16)
            }
            ForEach(Array(items.enumerated()), id: \.element.id) { index, item in
                let moment = item.versions.last { $0.story?.edition == nil }?.sentAt ?? item.latest.sentAt ?? .now
                if index == 0 || !Calendar.current.isDate(moment, inSameDayAs: items[index - 1].versions.last { $0.story?.edition == nil }?.sentAt ?? .now) {
                    Text(ChatClock.day(moment)).font(AppTypography.meta.weight(.semibold)).foregroundStyle(AppTheme.secondaryText)
                        .padding(.top, 32).padding(.bottom, 4).accessibilityAddTraits(.isHeader)
                }
                Button { open(item.id) } label: {
                    HStack(alignment: .firstTextBaseline, spacing: 16) {
                        Text(ChatClock.time(moment)).font(AppTypography.meta).monospacedDigit().foregroundStyle(AppTheme.secondaryText).frame(minWidth: 40, alignment: .leading)
                        VStack(alignment: .leading, spacing: 8) {
                            Kicker(section: item.story.section, status: item.story.status)
                            Text(item.story.title).font(NewsType.headline(22, .title3))
                                .multilineTextAlignment(.leading).fixedSize(horizontal: false, vertical: true)
                            Text(item.story.summary).font(AppTypography.reading).foregroundStyle(AppTheme.secondaryText).lineSpacing(AppTypography.readingLineSpacing)
                                .multilineTextAlignment(.leading).fixedSize(horizontal: false, vertical: true)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.vertical, 20)
                    .overlay(alignment: .bottom) { Hairline() }
                    .contentShape(.rect)
                }
                .buttonStyle(.plain)
                .accessibilityElement(children: .combine)
                .accessibilityHint(L("Открыть историю"))
                .id(item.id)
            }
        }
    }
}

// MARK: - One story

struct NewsStoryReader: View {
    let item: NewsDesk.Item
    let next: NewsDesk.Item?
    let backTitle: String
    let back: () -> Void
    let open: (String) -> Void
    /// Takes this story to the chat as context; the discussion happens there, with everything else.
    let discuss: () -> Void
    @State private var showsSources = false

    private var story: NewsStory { item.story }

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    // Large text puts the date under the way back instead of squeezing both.
                    ViewThatFits(in: .horizontal) {
                        HStack(alignment: .firstTextBaseline) { backButton; Spacer(minLength: 16); checked }
                        VStack(alignment: .leading, spacing: 8) { backButton; checked }
                    }
                    .padding(.bottom, 32)

                    Kicker(section: story.section, status: story.status)
                    Text(story.title).font(NewsType.headline(42, .largeTitle)).lineSpacing(2).padding(.top, 16)
                        .fixedSize(horizontal: false, vertical: true).accessibilityAddTraits(.isHeader)
                    Text(story.summary).font(NewsType.lead).foregroundStyle(AppTheme.secondaryText).lineSpacing(5).padding(.top, 16)
                        .fixedSize(horizontal: false, vertical: true)
                    HStack(spacing: 24) {
                        Button { showsSources = true; withAnimation { proxy.scrollTo("sources", anchor: .top) } } label: {
                            ArrowLabel(title: L("Источники · \(story.sources.count)"), symbol: "arrow.down")
                        }
                        Button(action: discuss) { ArrowLabel(title: L("Обсудить в чате")) }
                            .accessibilityIdentifier("discussStory")
                    }
                    .buttonStyle(.plain).padding(.top, 24).padding(.bottom, 32)
                    Hairline()

                    if let change = story.change, item.versions.count > 1 { section(L("Что нового"), text: change) }
                    section(L("Что изменилось"), markdown: story.body)
                    if let view = story.view { opinion(view) }
                    if let check = story.check { section(L("Что стоит проверить"), text: check) }
                    Text(provenance).font(AppTypography.meta).foregroundStyle(AppTheme.secondaryText).lineSpacing(3).padding(.top, 24)
                        .fixedSize(horizontal: false, vertical: true).textSelection(.enabled)

                    sources.id("sources").padding(.top, 32)
                    if item.developments.count > 1 { history.padding(.top, 32) }
                    if !item.thread.isEmpty { discussion.padding(.top, 48) }
                    if let next {
                        Button { open(next.id) } label: {
                            HStack(alignment: .firstTextBaseline) {
                                Text(L("Дальше")).font(AppTypography.meta).foregroundStyle(AppTheme.secondaryText)
                                Spacer(minLength: 16)
                                ArrowLabel(title: next.story.title).multilineTextAlignment(.trailing)
                            }
                            .padding(.vertical, 24).overlay(alignment: .top) { Hairline() }.contentShape(.rect)
                        }
                        .buttonStyle(.plain).padding(.top, 32)
                    }
                }
                .frame(maxWidth: 640, alignment: .leading)
                .padding(.horizontal, Layout.edge)
                .padding(.top, Layout.belowToolbar)
                .padding(.bottom, 48)
                .frame(maxWidth: .infinity)
            }
            .scrollIndicators(.hidden)
            .newsScrollEdge()
        }
    }

    private var backButton: some View {
        Button(action: back) { Label(backTitle, systemImage: "arrow.left") }
            .buttonStyle(.plain).font(AppTypography.interface).foregroundStyle(AppTheme.secondaryText)
            .keyboardShortcut(.cancelAction).fixedSize()
    }

    @ViewBuilder private var checked: some View {
        if let checked = item.latest.sentAt {
            Text(L("Проверено \(checked.formatted(.dateTime.day().month(.wide).hour().minute().locale(L10n.locale)))"))
                .font(AppTypography.meta).foregroundStyle(AppTheme.secondaryText).fixedSize(horizontal: false, vertical: true)
        }
    }

    private var provenance: String {
        let event = story.eventAt?.instant.map { L("Событие: \(ChatClock.exact($0, hasTime: true)).") }
        return [event, story.verification].compactMap { $0 }.joined(separator: " ")
    }

    private func label(_ title: String) -> some View {
        Text(title.uppercased()).font(NewsType.kicker).tracking(1.6).foregroundStyle(Color("NewsStatusText"))
            .accessibilityAddTraits(.isHeader)
    }

    private func section(_ title: String, text: String? = nil, markdown: String? = nil) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            label(title)
            if let markdown { MessageContent(source: markdown).equatable() }
            if let text { Text(text).font(AppTypography.reading).lineSpacing(AppTypography.readingLineSpacing).textSelection(.enabled).fixedSize(horizontal: false, vertical: true) }
        }
        .padding(.top, 32)
    }

    private func opinion(_ text: String) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(L("Наш взгляд").uppercased()).font(NewsType.kicker).tracking(1.6).foregroundStyle(AppTheme.secondaryText)
            Text(text).font(NewsType.headline(21, .title3)).lineSpacing(4).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
        }
        .padding(.leading, 20)
        .overlay(alignment: .leading) { Rectangle().fill(Color("NewsStatusText").opacity(0.6)).frame(width: 2) }
        .padding(.top, 32)
        .accessibilityElement(children: .combine)
    }

    private var sources: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button { withAnimation(.snappy) { showsSources.toggle() } } label: {
                HStack {
                    Text(L("На чём основана история")).font(AppTypography.interface)
                    Spacer()
                    Image(systemName: "plus").rotationEffect(.degrees(showsSources ? 45 : 0)).foregroundStyle(AppTheme.secondaryText)
                }
                .padding(.vertical, 16).contentShape(.rect)
            }
            .buttonStyle(.plain)
            .accessibilityValue(showsSources ? L("Развёрнуто") : L("Свёрнуто"))
            if showsSources {
                VStack(alignment: .leading, spacing: 16) {
                    ForEach(Array(story.sources.enumerated()), id: \.offset) { _, source in
                        VStack(alignment: .leading, spacing: 4) {
                            if let url = URL(string: source.url), MessageContent.allowsLink(url) {
                                Link(destination: url) {
                                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                                        Text(source.title).underline().multilineTextAlignment(.leading)
                                        Image(systemName: "arrow.up.right").imageScale(.small)
                                    }
                                }
                                .font(AppTypography.interface.weight(.medium)).foregroundStyle(AppTheme.accentText)
                            }
                            Text([source.role, URL(string: source.url)?.host(), source.publishedAt?.instant.map { ChatClock.cluster($0, hasTime: true) }]
                                .compactMap { $0 }.joined(separator: " · "))
                                .font(AppTypography.meta).foregroundStyle(AppTheme.secondaryText)
                        }
                    }
                }
                .padding(.bottom, 16)
                .transition(.opacity)
            }
        }
        .overlay(alignment: .top) { Hairline() }
        .overlay(alignment: .bottom) { Hairline() }
    }

    private var history: some View {
        VStack(alignment: .leading, spacing: 12) {
            label(L("Развитие истории"))
            ForEach(item.developments) { version in
                HStack(alignment: .firstTextBaseline, spacing: 16) {
                    Text(version.sentAt.map { ChatClock.cluster($0, hasTime: true) } ?? "").font(AppTypography.meta).monospacedDigit()
                        .foregroundStyle(AppTheme.secondaryText).frame(minWidth: 120, alignment: .leading)
                    Text([version.story?.status, version.story?.change ?? (version.id == item.versions.first?.id ? L("Первое сообщение") : nil)].compactMap { $0 }.joined(separator: " — "))
                        .font(AppTypography.reading).fixedSize(horizontal: false, vertical: true)
                }
            }
        }
    }

    /// Questions asked about this story before the chat became the one place to ask, read as they were answered.
    private var discussion: some View {
        VStack(alignment: .leading, spacing: 20) {
            Text(L("Обсуждали раньше")).font(NewsType.headline(28, .title2)).accessibilityAddTraits(.isHeader)
            ForEach(item.thread) { message in
                if message.direction == "inbound" {
                    VStack(alignment: .leading, spacing: 6) {
                        Text(message.text).font(AppTypography.reading.weight(.medium)).textSelection(.enabled)
                        if message.status == "queued" || message.status == "running" {
                            Label(L("News отвечает…"), systemImage: "ellipsis").font(AppTypography.meta).foregroundStyle(AppTheme.secondaryText)
                        } else if message.status == "failed" {
                            Text(message.error ?? L("Ответ не получен.")).font(AppTypography.meta).foregroundStyle(AppTheme.warning)
                        }
                    }
                    .padding(.horizontal, 16).padding(.vertical, 12)
                    .background(AppTheme.userBubble, in: .rect(cornerRadius: Radius.card, style: .continuous))
                } else {
                    MessageContent(source: message.text).equatable()
                }
            }
        }
    }
}
