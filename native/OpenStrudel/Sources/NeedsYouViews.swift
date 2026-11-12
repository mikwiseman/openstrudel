import SwiftUI

/// What waits for the owner, as the home leads with it and as its page lists it. One card is one decision: who raised
/// it and when it is due, what is true, why now, the words that will leave when it has any, and the step itself.

extension DeviceLibrary {
    /// The Home a card is from.
    func home(of card: NeedCard) -> HomeClient? { teamHomes.first { $0.id == card.home } }

    /// The character of whoever raised a card; nil is a main assistant's bun.
    func appearance(of card: NeedCard) -> AgentAppearance? {
        guard let id = card.profileID else { return nil }
        return home(of: card)?.profiles.first { $0.id == id }?.resolvedAppearance
    }
}

struct NeedCardView: View {
    @EnvironmentObject private var library: DeviceLibrary
    @EnvironmentObject private var needs: NeedsYouModel
    @Environment(\.openURL) private var openURL
    let card: NeedCard
    /// On the home the card is short, and whatever needs reading or writing is done on its page.
    var lead = false
    /// Opens the card on its page.
    var read: (() -> Void)? = nil
    /// Carries out a button, with the words it was given when it takes words.
    let act: (NeedCard, NeedCard.Action, String?) -> Void
    /// The choice that is being answered in words, and the words.
    @State private var writing: NeedCard.Action?
    @State private var words = ""
    /// The words that will leave, once the person began changing them.
    @State private var edited: String?
    @FocusState private var typing: Bool

    private var busy: Bool { needs.busy.contains(card.id) }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            if let read { Button(action: read) { said }.buttonStyle(.plain) } else { said }
            if !lead {
                if let draft = card.draft { leaving(draft) } else if !card.details.isEmpty { facts }
            }
            if let people = card.waitsFor {
                // Someone else's to answer: said, with no button that would not work.
                Text(L("Отвечает \(people.formatted(.list(type: .and).locale(L10n.locale)))")).font(.subheadline).foregroundStyle(AppTheme.secondaryText)
            } else if !card.actions.isEmpty {
                HStack(spacing: 12) {
                    ViewThatFits(in: .horizontal) {
                        HStack(spacing: 8) { buttons }
                        VStack(alignment: .leading, spacing: 8) { buttons }
                    }
                    if busy { ProgressView().controlSize(.small) }
                }
                if let writing { answer(writing) }
            }
            if let error = needs.errors[card.id] {
                Text(UserFacingError.text(error)).font(AppTypography.meta).foregroundStyle(AppTheme.warning)
            }
        }
        .padding(18)
        .frame(maxWidth: .infinity, alignment: .leading)
        .cardTile()
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("need-" + card.id)
    }

    /// Who and when, what is true, why now.
    private var said: some View {
        VStack(alignment: .leading, spacing: 8) {
            NeedByline(card: card, appearance: library.appearance(of: card), home: homeWord)
            Text(card.title).font(AppTypography.serif(20, .title2)).displayTracking(-0.3).foregroundStyle(.primary)
                .lineLimit(lead ? 3 : nil).multilineTextAlignment(.leading).fixedSize(horizontal: false, vertical: true)
            if let text = card.text {
                Text(text).font(.subheadline).foregroundStyle(AppTheme.secondaryText).lineSpacing(2)
                    .lineLimit(lead ? 3 : nil).multilineTextAlignment(.leading).fixedSize(horizontal: false, vertical: true)
            }
            if let next = card.nextTry {
                Text(L("Следующая попытка \(TeamWords().moment(next))")).font(.subheadline).foregroundStyle(AppTheme.secondaryText)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }

    /// The Home's name, said only when there are several and the card is not from the chat's own.
    private var homeWord: String? {
        guard library.teamHomes.count > 1, let source = library.home(of: card), source !== library.primary else { return nil }
        return source.displayName
    }

    /// The words that will leave, whole: who receives them and through what, then the text as it will arrive. The
    /// person may change it before it goes.
    private func leaving(_ draft: NeedCard.Draft) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            let to = [draft.to, draft.via].compactMap { $0 }.joined(separator: " · ")
            let rows = [NeedCard.Detail(label: L("Кому"), value: to), NeedCard.Detail(label: L("Тема"), value: draft.subject ?? "")].filter { !$0.value.isEmpty } + card.details
            if !rows.isEmpty { grid(rows) }
            if edited != nil {
                TextField("", text: Binding(get: { edited ?? draft.text }, set: { edited = $0 }), axis: .vertical)
                    .textFieldStyle(.plain).font(AppTypography.reading).lineSpacing(AppTypography.readingLineSpacing).focused($typing)
                    .accessibilityLabel(L("Сообщение")).accessibilityIdentifier("needDraftEditor")
            } else {
                Text(draft.text).font(AppTypography.reading).lineSpacing(AppTypography.readingLineSpacing).textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(AppTheme.surface, in: RoundedRectangle(cornerRadius: Radius.cardTile - 12, style: .continuous))
        .accessibilityIdentifier("needDraft")
    }

    /// The other facts a card carries, each in full.
    private var facts: some View { grid(card.details) }

    private func grid(_ rows: [NeedCard.Detail]) -> some View {
        Grid(alignment: .leadingFirstTextBaseline, horizontalSpacing: 14, verticalSpacing: 4) {
            ForEach(rows) { row in
                GridRow {
                    Text(row.label).foregroundStyle(AppTheme.secondaryText).gridColumnAlignment(.leading)
                    Text(row.value).textSelection(.enabled).gridColumnAlignment(.leading)
                }
            }
        }
        .font(.subheadline)
    }

    @ViewBuilder private var buttons: some View {
        // The first choice is the step the card proposes; for an access that is missing it is the link.
        let main = card.actions.first
        ForEach(card.actions) { action in
            let prominent = action.id == main?.id
            if action.role == .link, let url = action.url {
                Button(action.label, systemImage: "arrow.up.forward") { openURL(url) }.buttonStyle(CardButtonStyle(prominent: prominent))
            } else if lead, let read, prominent && card.readsFirst {
                Button(L("Прочитать и отправить"), action: read).buttonStyle(CardButtonStyle(prominent: true)).accessibilityIdentifier("needRead")
            } else if action.needsText {
                // Words are written on the card's page, where there is room for them.
                Button(action.label) {
                    if lead, let read { read() } else { writing = writing == action ? nil : action; typing = writing != nil }
                }
                .buttonStyle(CardButtonStyle(prominent: prominent)).disabled(busy)
                .accessibilityIdentifier("needAction-" + action.id)
            } else {
                Button(action.label) { act(card, action, card.editable && action.id == NeedCard.send ? edited : nil) }
                    .buttonStyle(CardButtonStyle(prominent: prominent)).disabled(busy)
                    .accessibilityIdentifier("needAction-" + action.id)
            }
            // The words can be changed before they leave.
            if !lead, prominent, card.editable, edited == nil {
                Button(L("Изменить")) {
                    edited = card.draft?.text
                    // A Mac selects the whole field it focuses, and one key would then replace the draft.
                    #if os(iOS)
                    typing = true
                    #endif
                }
                .buttonStyle(CardButtonStyle(prominent: false)).disabled(busy)
                    .accessibilityIdentifier("needEdit")
            }
        }
    }

    /// A choice answered in words: one line to write them in, and the way to send them.
    private func answer(_ action: NeedCard.Action) -> some View {
        let ready = !words.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !busy
        let send = { guard ready else { return }; act(card, action, words) }
        return HStack(alignment: .bottom, spacing: 8) {
            TextField(action.label, text: $words, axis: .vertical).textFieldStyle(.plain).font(AppTypography.interface).lineLimit(1...4)
                .padding(.horizontal, 14).padding(.vertical, 9).frame(minHeight: 40)
                .background(AppTheme.surface, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
                .focused($typing).onSubmit(send)
                .accessibilityIdentifier("needWords")
            Button(action: send) {
                Image(systemName: "arrow.up").font(.system(size: 15, weight: .semibold)).foregroundStyle(AppTheme.canvas)
                    .frame(width: 36, height: 36).background(AppTheme.accentText.opacity(ready ? 1 : 0.3), in: Circle())
                    .frame(minWidth: 40, minHeight: 40).contentShape(Circle())
            }
            .buttonStyle(.plain).disabled(!ready)
            .accessibilityLabel(L("Отправить")).accessibilityIdentifier("needSendWords")
        }
        .transition(.opacity)
    }
}

/// Who raised a card, from which Home when that needs saying, and how near its day is. One run of text, so at large
/// sizes it takes a second line rather than losing its end.
private struct NeedByline: View {
    let card: NeedCard
    let appearance: AgentAppearance?
    let home: String?

    var body: some View {
        HStack(spacing: 8) {
            ToneAvatar(appearance: appearance, size: 28)
            TimelineView(.everyMinute) { timeline in
                let when = card.due.map { NeedsYou.until($0, now: timeline.date) } ?? card.at.map { TeamWords().ago($0, now: timeline.date) }
                (Text(card.employee).fontWeight(.semibold).foregroundStyle(.primary)
                 + Text(verbatim: home.map { " · " + $0 } ?? "").foregroundStyle(AppTheme.faint)
                 + Text(verbatim: when.map { " · " + $0 } ?? "").foregroundStyle(card.due != nil || card.kind == .failed ? AppTheme.warning : AppTheme.faint))
                    .font(.subheadline).multilineTextAlignment(.leading).fixedSize(horizontal: false, vertical: true)
            }
        }
    }
}

/// A card as one row: what is true, then who and when. Beside an open page it stands for a card that waits; on the
/// page it is a card already decided, with how.
struct NeedRow: View {
    @EnvironmentObject private var library: DeviceLibrary
    let card: NeedCard

    var body: some View {
        HStack(spacing: RowMetrics.gap) {
            ToneAvatar(appearance: library.appearance(of: card), size: AvatarSize.team)
            VStack(alignment: .leading, spacing: 2) {
                Text(card.title).font(RowMetrics.name).tracking(-0.3).foregroundStyle(.primary).lineLimit(1)
                TimelineView(.everyMinute) { timeline in
                    Text(second(now: timeline.date)).font(RowMetrics.preview).tracking(-0.15)
                        .foregroundStyle(card.decision == nil && (card.due != nil || card.kind == .failed) ? AppTheme.warning : AppTheme.secondaryText).lineLimit(1)
                }
            }
        }
        .frame(maxWidth: .infinity, minHeight: AvatarSize.team, alignment: .leading)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }

    private func second(now: Date) -> String {
        if let decision = card.decision {
            return ([decision.by, decision.words] + [decision.at.map { TeamWords().ago($0, now: now) }]).compactMap { $0 }.joined(separator: " · ")
        }
        let when = card.due.map { NeedsYou.until($0, now: now) } ?? card.at.map { TeamWords().ago($0, now: now) }
        return ([card.employee] + (when.map { [$0] } ?? [])).joined(separator: " · ")
    }
}

/// The home's lead. With something waiting: its count, and the first card on a phone or the first rows beside an open
/// page. With nothing: one calm sentence, and the latest decision or how much was done today.
struct HomeNeeds: View {
    let cards: [NeedCard]
    /// Beside an open place the cards are rows; alone on a phone the first is a whole card.
    let split: Bool
    let margin: CGFloat
    /// The latest card decided in the last day, said under the calm sentence.
    let last: NeedCard?
    /// Results of today on the chat's Home, said there when nothing was decided.
    let done: Int
    /// The page has something to read, so the calm sentence opens it.
    let readable: Bool
    let zoom: Namespace.ID
    /// Opens the page, at a card when one is given.
    let open: (NeedCard?) -> Void
    let act: (NeedCard, NeedCard.Action, String?) -> Void
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    private static let rows = 3

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if let first = cards.first {
                count
                if split { rows } else { card(first) }
            } else {
                calm
            }
        }
        .animation(reduceMotion ? .easeInOut(duration: 0.2) : .spring(response: 0.35, dampingFraction: 0.8), value: cards.map(\.id))
        // A card answered is felt as it leaves.
        .sensoryFeedback(trigger: cards.count) { old, new in new < old ? .success : nil }
    }

    /// «Ждёт вас · 3», in the one signal colour. It opens the whole list.
    private var count: some View {
        Button { open(nil) } label: {
            HStack(spacing: 6) {
                Circle().fill(AppTheme.signal).frame(width: 7, height: 7)
                Text(verbatim: L("Ждёт вас") + (cards.count > 1 ? " · " + cards.count.formatted() : "")).foregroundStyle(AppTheme.signalText)
                    .contentTransition(.numericText(value: Double(cards.count)))
            }
            .font(AppTypography.label)
            .frame(minHeight: split ? 28 : 32, alignment: .center).contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .padding(.horizontal, margin)
        .accessibilityIdentifier("needsCount")
        .accessibilityAddTraits(.isHeader)
    }

    /// The first card, whole, with the edges of the others under it.
    private func card(_ first: NeedCard) -> some View {
        NeedCardView(card: first, lead: true, read: { open(first) }, act: act)
            .background(alignment: .bottom) {
                // Two more cards at most are hinted; the count says how many there are.
                ForEach(1..<min(cards.count, 3), id: \.self) { depth in
                    RoundedRectangle(cornerRadius: Radius.cardTile, style: .continuous).fill(AppTheme.tile)
                        .opacity(depth == 1 ? 0.7 : 0.4).frame(height: 40)
                        .padding(.horizontal, CGFloat(depth) * 12).offset(y: CGFloat(depth) * 7)
                        .tileShadow(0.35)
                }
            }
            .zoomSource(AnyHashable("needs"), in: zoom)
            .id(first.id)
            .transition(reduceMotion ? .opacity : .asymmetric(insertion: .scale(scale: 0.96, anchor: .bottom).combined(with: .opacity),
                                                              removal: .offset(y: -18).combined(with: .opacity)))
            .padding(.horizontal, margin)
            .padding(.top, 4).padding(.bottom, cards.count > 1 ? 30 : 22)
    }

    /// Beside an open page: the first cards as rows, and how many more there are.
    private var rows: some View {
        VStack(alignment: .leading, spacing: 2) {
            ForEach(cards.prefix(Self.rows)) { card in
                Button { open(card) } label: {
                    NeedRow(card: card).padding(.horizontal, HomeMetrics.plate).padding(.vertical, 8)
                }
                .buttonStyle(.plain)
                .padding(.horizontal, margin - HomeMetrics.plate)
                .accessibilityIdentifier("needRow-" + card.id)
                .transition(.opacity)
            }
            if cards.count > Self.rows {
                Button { open(nil) } label: {
                    Text(L("Ещё \(cards.count - Self.rows)")).font(RowMetrics.preview).foregroundStyle(AppTheme.secondaryText)
                        .frame(maxWidth: .infinity, minHeight: 28, alignment: .leading).contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .padding(.horizontal, margin)
            }
        }
        .padding(.bottom, 14)
    }

    /// Nothing waits: said once, quietly, with the latest decision or what was done today. Nothing moves while it is
    /// calm. With something to read it opens the page.
    @ViewBuilder private var calm: some View {
        let words = VStack(alignment: .leading, spacing: 4) {
            Text(L("Ничего не ждёт вас")).font(split ? AppTypography.label : AppTypography.serif(20, .title2))
                .displayTracking(split ? 0 : -0.3).foregroundStyle(split ? AnyShapeStyle(AppTheme.secondaryText) : AnyShapeStyle(.primary))
            if let last, let decision = last.decision {
                // «Sent to Team · 5 мин», or the card and the button that closed it: what the last card came to.
                Text(((decision.whole ? [] : [last.title]) + [decision.words] + (decision.at.map { [TeamWords().ago($0)] } ?? [])).joined(separator: " · "))
                    .font(split ? RowMetrics.preview : .subheadline).foregroundStyle(AppTheme.secondaryText).lineLimit(1)
            } else if done > 0 {
                Text(L("Сегодня готово: \(done)")).font(split ? RowMetrics.preview : .subheadline).foregroundStyle(AppTheme.secondaryText)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading).contentShape(Rectangle())
        Group {
            if readable {
                Button { open(nil) } label: { words }.buttonStyle(.plain).zoomSource(AnyHashable("needs"), in: zoom).accessibilityIdentifier("needsCalm")
            } else {
                words.accessibilityElement(children: .combine).accessibilityIdentifier("needsCalmLine")
            }
        }
        .padding(.horizontal, margin)
        .padding(.top, split ? 2 : 6).padding(.bottom, split ? 14 : 24)
        .transition(.opacity)
    }
}
