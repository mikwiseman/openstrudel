import SwiftUI

private extension HomeActivity.Insight {
    var displayTitle: String { needsAttention ? L("Needs attention") : title }
    var displayText: String { needsAttention ? L10n.serviceText(text) : text }
}

/// «Ждёт вас»: every card that waits for the owner, from every Home, each whole and with its buttons; then the recent
/// results of the chat's Home for reading. It opens from the home's lead. Reading never changes the main chat or its draft.
struct InsightsPage: View {
    @EnvironmentObject private var client: HomeClient
    @EnvironmentObject private var library: DeviceLibrary
    @EnvironmentObject private var needs: NeedsYouModel
    @EnvironmentObject private var failures: TeamFailures
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @ObservedObject var model: ActivityModel
    let scope: String
    let refresh: () async -> Void
    let openChat: () -> Void
    /// Carries out a card's button, with the words it was given when it takes words.
    let act: (NeedCard, NeedCard.Action, String?) -> Void
    private var activity: HomeActivity? { model.scope == scope ? model.activity : nil }

    var body: some View {
        let cards = needs.cards(library, failures: failures), decided = needs.recent(library), results = activity?.results ?? []
        ScrollViewReader { proxy in
            ActivityColumn {
                if cards.isEmpty {
                    if results.isEmpty, decided.isEmpty, activity != nil {
                        ActivityEmpty(title: L("Ничего не ждёт вас"), text: L("Scheduled results and things that need your attention will appear here."))
                    } else {
                        Text(L("Ничего не ждёт вас")).font(AppTypography.serif(22, .title2)).displayTracking(-0.3)
                            .accessibilityAddTraits(.isHeader).accessibilityIdentifier("needsCalm")
                    }
                } else {
                    VStack(alignment: .leading, spacing: 18) {
                        ForEach(cards) { card in
                            Group {
                                // A question with several parts, or one answered in words, is the chat's own card.
                                if case .question(let interaction) = card.origin, card.actions.first?.id == NeedsYou.open, let source = library.home(of: card) {
                                    InteractionCard(interaction: interaction).environmentObject(source)
                                } else {
                                    NeedCardView(card: card, act: act)
                                }
                            }
                            .id(card.id)
                            .transition(reduceMotion ? .opacity : .asymmetric(insertion: .opacity, removal: .scale(scale: 0.96).combined(with: .opacity)))
                        }
                    }
                    .animation(reduceMotion ? .easeInOut(duration: 0.2) : .spring(response: 0.35, dampingFraction: 0.8), value: cards.map(\.id))
                }
                // What was decided in the last day, on any Home, by whoever answered first: here or in Telegram.
                if !decided.isEmpty {
                    ActivitySection(title: L("Решено"), spacing: 16) {
                        ForEach(decided) { NeedRow(card: $0).accessibilityIdentifier("needDecided-" + $0.id) }
                    }
                }
                // The results are the chat's Home's own; a Home that cannot list them says so here.
                if model.failure != nil || cards.isEmpty { ActivityStatus(model: model, scope: scope, openChat: openChat) }
                if !results.isEmpty {
                    ActivitySection(title: L("Recent results"), spacing: 22) { ForEach(results) { insight($0) } }
                }
                if let activity { ActivityChecked(date: activity.checkedAt, home: client.displayName) }
            }
            // Opened at one card, the page brings that card into sight.
            .onChange(of: needs.focus, initial: true) { _, card in
                guard let card else { return }
                withAnimation(.smooth(duration: 0.3)) { proxy.scrollTo(card, anchor: .top) }
                needs.focus = nil
            }
        }
        .activityPage(L("Ждёт вас"))
        .toolbar { ToolbarItem(placement: .primaryAction) { ActivityRefresh(refreshing: model.refreshing, refresh: refresh) } }
        .refreshable { await refresh() }
        .sensoryFeedback(trigger: cards.count) { old, new in new < old ? .success : nil }
        .accessibilityIdentifier("insightsRoot")
    }

    /// Who and when in a quiet line, what it is called, then its first words as plain text.
    private func insight(_ item: HomeActivity.Insight) -> some View {
        NavigationLink(value: HomePlace.insight(item)) {
            VStack(alignment: .leading, spacing: 4) {
                Text(([item.employeeName] + (HomeActivity.date(item.occurredAt).map { [TeamWords().ago($0)] } ?? [])).joined(separator: " · "))
                    .foregroundStyle(AppTheme.secondaryText).font(ReaderLine.font).monospacedDigit()
                Text(item.displayTitle).font(AppTypography.interface.weight(.semibold)).multilineTextAlignment(.leading)
                Text(Team.plain(item.displayText)).font(.subheadline).foregroundStyle(AppTheme.secondaryText).lineSpacing(2)
                    .lineLimit(3).multilineTextAlignment(.leading)
            }
            .frame(maxWidth: .infinity, alignment: .leading).contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("insight-" + item.id)
    }
}

struct InsightDetail: View {
    @EnvironmentObject private var client: HomeClient
    let item: HomeActivity.Insight
    let discuss: (ChatContext) -> Void

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                VStack(alignment: .leading, spacing: 8) {
                    HStack(spacing: 5) {
                        if item.needsAttention {
                            Image(systemName: "exclamationmark.circle.fill").foregroundStyle(AppTheme.warning).accessibilityHidden(true)
                        }
                        Text(([item.needsAttention ? L("Needs attention") : L("Scheduled result"), item.employeeName]
                              + (HomeActivity.date(item.occurredAt).map { [TeamWords().ago($0)] } ?? [])).joined(separator: " · "))
                            .foregroundStyle(AppTheme.secondaryText)
                    }
                    .font(ReaderLine.font).monospacedDigit()
                    Text(item.displayTitle).font(AppTypography.display).displayTracking().textSelection(.enabled)
                        .fixedSize(horizontal: false, vertical: true)
                }
                MessageContent(source: item.displayText).textSelection(.enabled)
                NavigationLink(value: HomePlace.reader(ReaderRoute(connectionID: client.id, kind: .conversation(item.conversationId), title: item.employeeName))) {
                    Label(L("Open source conversation"), systemImage: "text.bubble")
                        .font(AppTypography.meta.weight(.medium)).foregroundStyle(.primary)
                        .padding(.horizontal, 14).frame(minHeight: 36)
                        .background(AppTheme.surface, in: Capsule())
                        .contentShape(Capsule())
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("insightSource")
            }
            .frame(maxWidth: Layout.column, alignment: .leading)
            .padding(.horizontal, Layout.edge).padding(.top, Layout.belowToolbar).padding(.bottom, 32)
            .frame(maxWidth: .infinity)
        }
        .scrollIndicators(.hidden)
        .background(AppTheme.canvas)
        .paperTop()
        .safeAreaBar(edge: .bottom, spacing: 0) {
            if let context = item.context {
                AskCapsule(title: L("Обсудить в чате")) { discuss(context) }.accessibilityIdentifier("discussInsight")
            }
        }
        .navigationTitle(item.employeeName)
        #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
        .containerBackground(AppTheme.canvas, for: .navigation)
        #endif
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("insightDetail")
    }
}

struct ProgressPage: View {
    @EnvironmentObject private var client: HomeClient
    @Environment(\.colorScheme) private var scheme
    @Environment(\.dynamicTypeSize) private var typeSize
    @ObservedObject var model: ActivityModel
    @ObservedObject var limits: ActivityLimitsModel
    let scope: String
    let refresh: () async -> Void
    let openChat: () -> Void
    private var activity: HomeActivity? { model.scope == scope ? model.activity : nil }

    var body: some View {
        ActivityColumn {
            ActivityStatus(model: model, scope: scope, openChat: openChat)
            if let activity {
                // The page opens as the home does, with tiles: what was done, the fullest limit, the days with work.
                DataShelf {
                    NumberTile(label: L("Сделано"), value: (activity.progress.completedRequests + activity.progress.completedRuns).formatted(), caption: L("за 7 дней"),
                               skin: .paper(AgentAppearance.tint(AgentAppearance(kind: "coil", tone: 1), dark: scheme == .dark)))
                    if limits.scope == scope, let limit = Shelf.limit(limits.accounts) { LimitTile(used: limit.used, weekly: limit.weekly) }
                    NumberTile(label: L("Active days"), value: activity.progress.activeDays.formatted(), caption: L("из 7"),
                               skin: .paper(AgentAppearance.tint(AgentAppearance(kind: "coil", tone: 3), dark: scheme == .dark)))
                }
                .padding(.bottom, -26)
                // The first steps are said until they are taken, not for ever after.
                let starting = activity.progress.milestones.filter(\.known).contains { !$0.reached }
                if starting { ProgressCharacter(progress: activity.progress) }
                ActivitySection(title: L("Last 7 days")) {
                    count(L("Answered requests"), activity.progress.completedRequests)
                    count(L("Automation results"), activity.progress.completedRuns)
                    Text(L("Replies and scheduled results from this Home.")).font(ReaderLine.font).foregroundStyle(AppTheme.secondaryText)
                }
                if starting { ActivitySection(title: L("Milestones")) {
                    ForEach(activity.progress.milestones.filter(\.known)) { milestone in
                        HStack(alignment: .firstTextBaseline, spacing: 10) {
                            Image(systemName: milestone.reached ? "checkmark.circle.fill" : "circle")
                                .foregroundStyle(milestone.reached ? AppTheme.signal : AppTheme.faint)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(milestoneTitle(milestone.id)).foregroundStyle(milestone.reached ? Color.primary : AppTheme.secondaryText)
                                if milestone.id == "three-active-days" { Text(L("Last 7 days")).font(ReaderLine.font).foregroundStyle(AppTheme.secondaryText) }
                            }
                        }
                        .font(AppTypography.interface)
                        .accessibilityElement(children: .combine)
                        .accessibilityValue(milestone.reached ? L("Reached") : L("Not yet"))
                        .accessibilityIdentifier("milestone-" + milestone.id)
                    }
                } }
                ActivitySection(title: L("Automation")) {
                    count(L("Active schedules"), activity.progress.activeSchedules)
                    count(L("Quiet runs · no new result"), activity.progress.quietRuns)
                    count(L("Failed runs"), activity.progress.failedRuns)
                }
            }
            ActivitySection(title: L("Limits and usage")) {
                if limits.scope != scope || limits.refreshing && limits.accounts.isEmpty {
                    ProgressView().accessibilityLabel(L("Обновить"))
                } else if limits.unavailable {
                    Text(L("Limits are unavailable. Refresh to check again.")).foregroundStyle(AppTheme.secondaryText)
                } else if limits.accounts.isEmpty {
                    Text(L("No subscription limits were reported by this Home.")).foregroundStyle(AppTheme.secondaryText)
                } else {
                    ForEach(limits.accounts) { account in
                        VStack(alignment: .leading, spacing: 14) {
                            Text(account.identityLabel).font(AppTypography.interface.weight(.semibold))
                            UsageSummary(usage: account.usage)
                            if let date = UsageSummary.checked(account.usage) { Text(UsageSummary.updated(date)).font(ReaderLine.font).foregroundStyle(AppTheme.secondaryText) }
                        }
                        .padding(18).frame(maxWidth: .infinity, alignment: .leading)
                        .cardTile()
                    }
                }
            }
            if let activity { ActivityChecked(date: activity.checkedAt, home: client.displayName) }
        }
        .activityPage(L("Progress"))
        .toolbar {
            ToolbarItem(placement: .primaryAction) { ActivityRefresh(refreshing: model.refreshing || limits.refreshing, refresh: refresh) }
        }
        .refreshable { await refresh() }
        .accessibilityIdentifier("progressRoot")
    }

    private func count(_ title: String, _ value: Int) -> some View {
        HStack(alignment: .firstTextBaseline) {
            Text(title)
            Spacer(minLength: 12)
            Text(value.formatted()).monospacedDigit().foregroundStyle(AppTheme.secondaryText)
        }
        .font(AppTypography.interface)
        .accessibilityElement(children: .combine)
    }
    private func milestoneTitle(_ id: String) -> String {
        switch id {
        case "first-request": L("First answered request")
        case "first-automation": L("First automation result")
        default: L("Three active days")
        }
    }
}

/// The existing Strudel character acknowledges recorded milestones; no idle animation or spending rewards.
private struct ProgressCharacter: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.dynamicTypeSize) private var typeSize
    let progress: HomeActivity.Progress
    private var started: Bool { progress.reached("first-request") }
    private var automated: Bool { progress.reached("first-automation") }
    var body: some View {
        let layout = typeSize.isAccessibilitySize ? AnyLayout(VStackLayout(alignment: .leading, spacing: 16)) : AnyLayout(HStackLayout(spacing: 18))
        layout {
            ToneAvatar(appearance: nil, size: 84)
                .rotationEffect(.degrees(automated ? -4 : 0))
                .overlay(alignment: .bottomTrailing) {
                    if started { Image(systemName: "checkmark.circle.fill").font(.title3).foregroundStyle(AppTheme.signal).background(AppTheme.canvas, in: Circle()) }
                }
                .animation(reduceMotion ? nil : .smooth(duration: 0.25), value: automated)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 6) {
                Text(automated ? L("A little work, taken care of") : started ? L("A useful start") : L("Start with one useful task"))
                    .font(AppTypography.title).displayTracking(-0.4)
                Text(automated ? L("Your first automation produced a result.") : started ? L("Your first assistant request is complete.") : L("Ask in Chat. Your assistants will take it from there."))
                    .font(.subheadline).foregroundStyle(AppTheme.secondaryText)
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("progressCharacter")
    }
}

struct ActivityStatus: View {
    @ObservedObject var model: ActivityModel
    let scope: String
    let openChat: () -> Void
    var body: some View {
        if model.scope != scope || model.activity == nil && model.failure == nil {
            ProgressView().frame(maxWidth: .infinity).accessibilityLabel(L("Loading activity"))
        } else if let failure = model.failure {
            VStack(alignment: .leading, spacing: 8) {
                Label(title(failure), systemImage: failure == .ownerOnly ? "person.badge.key" : failure == .unsupported ? "arrow.up.circle" : "wifi.slash")
                    .font(AppTypography.interface.weight(.semibold))
                Text(detail(failure)).font(.subheadline).foregroundStyle(AppTheme.secondaryText)
                Button(L("Open chat"), action: openChat)
                    .buttonStyle(.plain).font(AppTypography.meta.weight(.semibold))
                    .padding(.horizontal, 16).frame(minHeight: 36).background(AppTheme.surface, in: Capsule()).contentShape(Capsule())
                    .padding(.top, 6)
            }
            .padding(18).frame(maxWidth: .infinity, alignment: .leading)
            .cardTile()
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("activityState-" + String(describing: failure))
        }
    }
    private func title(_ failure: ActivityModel.Failure) -> String {
        switch failure {
        case .unsupported: L("This Home needs an update")
        case .ownerOnly: L("Activity is private to the owner")
        case .unavailable: L("Activity could not be refreshed")
        }
    }
    private func detail(_ failure: ActivityModel.Failure) -> String {
        switch failure {
        case .unsupported: L("Your chat still works. Update this Home to see Insights and Progress.")
        case .ownerOnly: L("Use an owner connection to read this Home’s activity.")
        case .unavailable: model.activity == nil ? L("Reconnect to this Home, then refresh.") : L("Showing the last checked activity from this Home.")
        }
    }
}

struct ActivityChecked: View {
    let date: String
    let home: String
    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(home)
            if let checked = HomeActivity.date(date) {
                Text(L("Last checked \(checked.formatted(.dateTime.day().month(.abbreviated).hour().minute().locale(L10n.locale)))"))
            }
        }.font(ReaderLine.font).foregroundStyle(AppTheme.faint)
    }
}

struct ActivityRefresh: View {
    let refreshing: Bool
    let refresh: () async -> Void
    var body: some View {
        Button { Task { await refresh() } } label: { Image(systemName: "arrow.clockwise") }
            .disabled(refreshing).accessibilityLabel(L("Обновить")).accessibilityIdentifier("refreshActivity")
    }
}

/// A page of the home (what waits, Progress, the polls): an open column on the paper, its groups under small sentence-case labels, no rules.
struct ActivityColumn<Content: View>: View {
    @ViewBuilder var content: Content
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 38) { content }
                .frame(maxWidth: Layout.column + 80, alignment: .leading)
                .padding(.horizontal, Layout.edge).padding(.top, Layout.belowToolbar).padding(.bottom, 48)
                .frame(maxWidth: .infinity)
        }
        .scrollIndicators(.hidden)
        .paperTop()
    }
}

struct ActivitySection<Content: View>: View {
    let title: String
    var spacing: CGFloat = 14
    @ViewBuilder var content: Content
    var body: some View {
        VStack(alignment: .leading, spacing: spacing) {
            Text(title).font(AppTypography.label).foregroundStyle(AppTheme.secondaryText).accessibilityAddTraits(.isHeader)
            content
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// Nothing yet: the bun, one sentence, and what will come.
struct ActivityEmpty: View {
    let title: String
    let text: String
    var body: some View {
        VStack(spacing: 10) {
            ToneAvatar(appearance: nil, size: 96).accessibilityHidden(true)
            Text(title).font(AppTypography.title).displayTracking(-0.4).padding(.top, 8)
            Text(text).font(.subheadline).foregroundStyle(AppTheme.secondaryText).multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity).padding(.vertical, 40)
        .accessibilityElement(children: .combine)
    }
}

extension View {
    func activityPage(_ title: String) -> some View {
        background(AppTheme.canvas)
            .navigationTitle(title)
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            .containerBackground(AppTheme.canvas, for: .navigation)
            #endif
    }
}
