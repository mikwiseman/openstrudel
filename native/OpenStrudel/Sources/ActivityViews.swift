import SwiftUI

private extension HomeActivity.Insight {
    var displayTitle: String { needsAttention ? L("Needs attention") : title }
    var displayText: String { needsAttention ? L10n.serviceText(text) : text }
}

/// «Что важно»: results and exceptions, each with its source. It opens from its tile on the home. Reading never
/// changes the main chat or its draft.
struct InsightsPage: View {
    @EnvironmentObject private var client: HomeClient
    @ObservedObject var model: ActivityModel
    let scope: String
    let refresh: () async -> Void
    let openChat: () -> Void
    private var activity: HomeActivity? { model.scope == scope ? model.activity : nil }

    var body: some View {
        ActivityColumn {
            ActivityStatus(model: model, scope: scope, openChat: openChat)
            if let activity {
                if activity.insights.isEmpty {
                    ActivityEmpty(title: L("Nothing to read yet"), text: L("Scheduled results and things that need your attention will appear here."))
                }
                if !activity.attention.isEmpty {
                    ActivitySection(title: L("Needs attention"), spacing: 22) { ForEach(activity.attention) { insight($0) } }
                }
                if !activity.results.isEmpty {
                    ActivitySection(title: L("Recent results"), spacing: 22) { ForEach(activity.results) { insight($0) } }
                }
                ActivityChecked(date: activity.checkedAt, home: client.displayName)
            }
        }
        .activityPage(L("Что важно"))
        .toolbar { ToolbarItem(placement: .primaryAction) { ActivityRefresh(refreshing: model.refreshing, refresh: refresh) } }
        .refreshable { await refresh() }
        .accessibilityIdentifier("insightsRoot")
    }

    /// Who and when in a quiet line, what it is called, then its first words as plain text.
    private func insight(_ item: HomeActivity.Insight) -> some View {
        NavigationLink(value: HomePlace.insight(item)) {
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 5) {
                    if item.needsAttention {
                        Image(systemName: "exclamationmark.circle.fill").foregroundStyle(AppTheme.warning).accessibilityHidden(true)
                    }
                    Text(([item.employeeName] + (HomeActivity.date(item.occurredAt).map { [TeamWords().ago($0)] } ?? [])).joined(separator: " · "))
                        .foregroundStyle(AppTheme.secondaryText)
                }
                .font(ReaderLine.font).monospacedDigit()
                Text(item.displayTitle).font(AppTypography.interface.weight(.semibold)).foregroundStyle(item.needsAttention ? AppTheme.warning : Color.primary)
                    .multilineTextAlignment(.leading)
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
        .safeAreaBar(edge: .bottom, spacing: 0) {
            if let context = item.context {
                AskCapsule(title: L("Обсудить в чате")) { discuss(context) }.accessibilityIdentifier("discussInsight")
            }
        }
        .navigationTitle(L("Что важно"))
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
                ProgressCharacter(progress: activity.progress)
                ActivitySection(title: L("Last 7 days")) {
                    let layout = typeSize.isAccessibilitySize ? AnyLayout(VStackLayout(spacing: TileMetrics.gap)) : AnyLayout(HStackLayout(spacing: TileMetrics.gap))
                    layout {
                        figure(L("Answered requests"), activity.progress.completedRequests, tone: 3)
                        figure(L("Automation results"), activity.progress.completedRuns, tone: 6)
                        figure(L("Active days"), activity.progress.activeDays, tone: 1)
                    }
                    Text(L("Replies and scheduled results from this Home.")).font(ReaderLine.font).foregroundStyle(AppTheme.secondaryText)
                }
                if !activity.rituals.isEmpty {
                    ActivitySection(title: L("Check-ins")) { ForEach(activity.rituals) { CheckInCard(checkIn: $0) } }
                }
                ActivitySection(title: L("Milestones")) {
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
                }
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

    /// One number of the week as a small paper tile.
    private func figure(_ title: String, _ value: Int, tone: Int) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(value.formatted()).font(.system(size: 34, weight: .semibold)).tracking(-1.2).monospacedDigit()
                .contentTransition(.numericText(value: Double(value))).lineLimit(1).minimumScaleFactor(0.6)
            Text(title).font(AppTypography.label.weight(.regular)).opacity(0.66).lineLimit(2, reservesSpace: !typeSize.isAccessibilitySize)
                .minimumScaleFactor(0.8).multilineTextAlignment(.leading)
        }
        .padding(TileMetrics.padding)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(AgentAppearance.tint(AgentAppearance(kind: "coil", tone: tone), dark: scheme == .dark), in: RoundedRectangle(cornerRadius: 26, style: .continuous))
        .tileShadow(0.7)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(title).accessibilityValue(value.formatted())
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

/// Fourteen days of a Telegram poll: each person's own bars, their streak of answers and today's state. Opens the chat it lives in.
private struct CheckInCard: View {
    @EnvironmentObject private var client: HomeClient
    let checkIn: HomeActivity.CheckIn

    var body: some View {
        NavigationLink(value: HomePlace.reader(ReaderRoute(connectionID: client.id, kind: .conversation(checkIn.conversationId), title: checkIn.chat ?? checkIn.name))) {
            VStack(alignment: .leading, spacing: 14) {
                VStack(alignment: .leading, spacing: 3) {
                    Text(checkIn.question).font(.body.weight(.medium)).foregroundStyle(.primary)
                    if let chat = checkIn.chat { Text(chat).font(.caption).foregroundStyle(.secondary) }
                }
                ForEach(checkIn.participants) { person in
                    VStack(alignment: .leading, spacing: 6) {
                        HStack(alignment: .firstTextBaseline) {
                            Text(person.name).font(.subheadline.weight(.medium))
                            Spacer(minLength: 8)
                            if let latest = person.latest {
                                Text(latest.value.formatted()).font(.title3.weight(.semibold)).monospacedDigit()
                                    .accessibilityLabel(L("Latest answer \(latest.value.formatted())"))
                            }
                        }
                        CheckInBars(days: checkIn.days, participant: person.id, scale: checkIn.scale)
                        if !caption(person).isEmpty { Text(caption(person)).font(.caption).foregroundStyle(.secondary) }
                    }
                    .accessibilityElement(children: .combine)
                }
                Text(todayLine).font(.caption).foregroundStyle(.secondary)
            }
            .padding(18)
            .frame(maxWidth: .infinity, alignment: .leading)
            .cardTile()
        }
        .buttonStyle(TilePressStyle())
        .accessibilityIdentifier("checkIn-" + checkIn.id)
    }

    private func caption(_ person: HomeActivity.CheckIn.Participant) -> String {
        var parts: [String] = []
        if person.streak > 0 { parts.append(L("Streak: \(person.streak.formatted())")) }
        if let average = person.average { parts.append(L("Average \(average.formatted(.number.precision(.fractionLength(0...1))))")) }
        return parts.joined(separator: " · ")
    }

    private var todayLine: String {
        let answered = checkIn.participants.compactMap { person -> String? in
            guard let value = checkIn.value(of: person, on: checkIn.today) else { return nil }
            return person.name + " " + value.formatted()
        }
        return answered.isEmpty ? L("No answers yet today") : L("Today: \(answered.joined(separator: " · "))")
    }
}

/// One bar per local date, taller and darker with the answer; a day without an answer stays a faint base line.
private struct CheckInBars: View {
    let days: [HomeActivity.CheckIn.Day]
    let participant: String
    let scale: Int
    var body: some View {
        HStack(alignment: .bottom, spacing: 3) {
            ForEach(days, id: \.date) { day in
                let share = day.values[participant].map { Double($0) / Double(max(scale, 1)) }
                RoundedRectangle(cornerRadius: 2, style: .continuous)
                    .fill(share.map { Color.primary.opacity(0.3 + 0.7 * $0) } ?? Color.secondary.opacity(0.18))
                    .frame(height: share.map { max(6, 28 * $0) } ?? 4)
                    .frame(maxWidth: .infinity, alignment: .bottom)
            }
        }
        .frame(height: 28, alignment: .bottom)
        .accessibilityHidden(true)
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

private struct ActivityStatus: View {
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

private struct ActivityChecked: View {
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

private struct ActivityRefresh: View {
    let refreshing: Bool
    let refresh: () async -> Void
    var body: some View {
        Button { Task { await refresh() } } label: { Image(systemName: "arrow.clockwise") }
            .disabled(refreshing).accessibilityLabel(L("Обновить")).accessibilityIdentifier("refreshActivity")
    }
}

/// A page behind a tile: an open column on the paper, its groups under small sentence-case labels, no rules.
private struct ActivityColumn<Content: View>: View {
    @ViewBuilder var content: Content
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 38) { content }
                .frame(maxWidth: Layout.column + 80, alignment: .leading)
                .padding(.horizontal, Layout.edge).padding(.top, Layout.belowToolbar).padding(.bottom, 48)
                .frame(maxWidth: .infinity)
        }
        .scrollIndicators(.hidden)
    }
}

private struct ActivitySection<Content: View>: View {
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
private struct ActivityEmpty: View {
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

private extension View {
    func activityPage(_ title: String) -> some View {
        background(AppTheme.canvas)
            .navigationTitle(title)
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            .containerBackground(AppTheme.canvas, for: .navigation)
            #endif
    }
}
