import SwiftUI

#if os(iOS)
private extension HomeActivity.Insight {
    var displayTitle: String { needsAttention ? L("Needs attention") : title }
    var displayText: String { needsAttention ? L10n.serviceText(text) : text }
}

/// Results and exceptions have a source. Reading never changes the main chat or its draft.
struct InsightsTab: View {
    @EnvironmentObject private var library: DeviceLibrary
    @EnvironmentObject private var client: HomeClient
    @EnvironmentObject private var newsroom: Newsroom
    @ObservedObject var model: ActivityModel
    let scope: String
    let refresh: () async -> Void
    let openChat: () -> Void
    private var activity: HomeActivity? { model.scope == scope ? model.activity : nil }

    var body: some View {
        List {
            // What to read first: each News feed with its lead and how much of today is new.
            if !library.newsFeeds.isEmpty {
                Section {
                    ForEach(library.newsFeeds, id: \.route.id) { feed in
                        NavigationLink(value: feed.route) { NewsEntryRow(feed: newsroom.feed(feed.route, on: feed.source)) }
                            .accessibilityIdentifier("newsEntry-" + (feed.route.profileID ?? ""))
                    }
                }
            }
            ActivityStatus(model: model, scope: scope, openChat: openChat)
            if let activity {
                if activity.insights.isEmpty {
                    ContentUnavailableView(L("Nothing to read yet"), systemImage: "sparkle",
                        description: Text(L("Scheduled results and things that need your attention will appear here.")))
                        .listRowBackground(Color.clear)
                }
                if !activity.attention.isEmpty {
                    Section(L("Needs attention")) { ForEach(activity.attention) { insight($0) } }
                }
                if !activity.results.isEmpty {
                    Section(L("Recent results")) { ForEach(activity.results) { insight($0) } }
                }
                Section { ActivityChecked(date: activity.checkedAt, home: client.displayName) }
                    .listRowBackground(Color.clear)
            }
        }
        .listStyle(.insetGrouped)
        .navigationTitle(L("Insights"))
        .toolbar { ToolbarItem(placement: .topBarTrailing) { ActivityRefresh(refreshing: model.refreshing, refresh: refresh) } }
        .refreshable { await refresh() }
        .accessibilityIdentifier("insightsRoot")
    }

    private func insight(_ item: HomeActivity.Insight) -> some View {
        NavigationLink(value: item) {
            VStack(alignment: .leading, spacing: 6) {
                Text(item.displayTitle).font(.body.weight(.medium)).foregroundStyle(.primary)
                Text(item.displayText).font(.subheadline).foregroundStyle(.secondary).lineLimit(3)
                HStack {
                    Text(item.employeeName)
                    Spacer(minLength: 8)
                    if let date = HomeActivity.date(item.occurredAt) { Text(date, style: .date) }
                }
                .font(.caption).foregroundStyle(.secondary)
            }
            .padding(.vertical, 6)
            .frame(maxWidth: .infinity, alignment: .leading).contentShape(Rectangle())
        }
        .accessibilityIdentifier("insight-" + item.id)
    }
}

struct InsightDetail: View {
    @EnvironmentObject private var client: HomeClient
    let item: HomeActivity.Insight
    let discuss: (ChatContext) -> Void

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                Label(item.needsAttention ? L("Needs attention") : L("Scheduled result"), systemImage: item.needsAttention ? "exclamationmark.circle" : "checkmark.circle")
                    .font(.subheadline).foregroundStyle(.secondary)
                Text(item.displayTitle).font(.title2.weight(.semibold)).textSelection(.enabled)
                MessageContent(source: item.displayText).textSelection(.enabled)
                VStack(alignment: .leading, spacing: 6) {
                    Text(item.employeeName).font(.subheadline.weight(.medium))
                    if let date = HomeActivity.date(item.occurredAt) {
                        Text(date.formatted(.dateTime.day().month(.abbreviated).hour().minute().locale(L10n.locale))).font(.caption).foregroundStyle(.secondary)
                    }
                    NavigationLink(value: ReaderRoute(connectionID: client.id, kind: .conversation(item.conversationId), title: item.employeeName)) {
                        Label(L("Open source conversation"), systemImage: "text.bubble")
                    }
                    .accessibilityIdentifier("insightSource")
                }
                if let context = item.context {
                    Button(L("Обсудить в чате")) { discuss(context) }
                        .buttonStyle(.glassProminent).accessibilityIdentifier("discussInsight")
                }
            }
            .frame(maxWidth: Layout.column, alignment: .leading)
            .padding(24).frame(maxWidth: .infinity)
        }
        .navigationTitle(L("Insights"))
        .navigationBarTitleDisplayMode(.inline)
        .accessibilityIdentifier("insightDetail")
    }
}

struct ProgressTab: View {
    @EnvironmentObject private var client: HomeClient
    @ObservedObject var model: ActivityModel
    @ObservedObject var limits: ActivityLimitsModel
    let scope: String
    let refresh: () async -> Void
    let openChat: () -> Void
    private var activity: HomeActivity? { model.scope == scope ? model.activity : nil }

    var body: some View {
        List {
            ActivityStatus(model: model, scope: scope, openChat: openChat)
            if let activity {
                Section { ProgressCharacter(progress: activity.progress) }.listRowBackground(Color.clear)
                if !activity.rituals.isEmpty {
                    Section(L("Check-ins")) { ForEach(activity.rituals) { CheckInCard(checkIn: $0) } }
                }
                Section {
                    count(L("Answered requests"), activity.progress.completedRequests)
                    count(L("Automation results"), activity.progress.completedRuns)
                    count(L("Active days"), activity.progress.activeDays)
                } header: { Text(L("Last 7 days")) } footer: {
                    Text(L("Replies and scheduled results from this Home."))
                }
                Section(L("Milestones")) {
                    ForEach(activity.progress.milestones.filter(\.known)) { milestone in
                        Label {
                            VStack(alignment: .leading, spacing: 3) {
                                Text(milestoneTitle(milestone.id))
                                if milestone.id == "three-active-days" { Text(L("Last 7 days")).font(.caption).foregroundStyle(.secondary) }
                            }
                        } icon: {
                            Image(systemName: milestone.reached ? "checkmark.circle.fill" : "circle")
                                .foregroundStyle(milestone.reached ? Color.primary : Color.secondary)
                        }
                        .accessibilityElement(children: .combine)
                        .accessibilityValue(milestone.reached ? L("Reached") : L("Not yet"))
                        .accessibilityIdentifier("milestone-" + milestone.id)
                    }
                }
                Section {
                    count(L("Active schedules"), activity.progress.activeSchedules)
                    DisclosureGroup(L("Recent checks")) {
                        count(L("Quiet runs · no new result"), activity.progress.quietRuns)
                        count(L("Failed runs"), activity.progress.failedRuns)
                    }
                } header: { Text(L("Automation")) }
                Section { ActivityChecked(date: activity.checkedAt, home: client.displayName) }.listRowBackground(Color.clear)
            }
            Section(L("Limits and usage")) {
                if limits.scope != scope || limits.refreshing && limits.accounts.isEmpty {
                    ProgressView().accessibilityLabel(L("Обновить"))
                } else if limits.unavailable {
                    Text(L("Limits are unavailable. Refresh to check again.")).foregroundStyle(.secondary)
                } else if limits.accounts.isEmpty {
                    Text(L("No subscription limits were reported by this Home.")).foregroundStyle(.secondary)
                } else {
                    ForEach(limits.accounts) { account in
                        VStack(alignment: .leading, spacing: 14) {
                            Text(account.identityLabel).font(.headline)
                            UsageSummary(usage: account.usage)
                            if let date = UsageSummary.checked(account.usage) { Text(UsageSummary.updated(date)).font(.caption).foregroundStyle(.secondary) }
                        }.padding(.vertical, 6)
                    }
                }
            }
        }
        .listStyle(.insetGrouped)
        .navigationTitle(L("Progress"))
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) { ActivityRefresh(refreshing: model.refreshing || limits.refreshing, refresh: refresh) }
        }
        .refreshable { await refresh() }
        .accessibilityIdentifier("progressRoot")
    }

    private func count(_ title: String, _ value: Int) -> some View {
        LabeledContent(title) { Text(value.formatted()).monospacedDigit() }
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
        NavigationLink(value: ReaderRoute(connectionID: client.id, kind: .conversation(checkIn.conversationId), title: checkIn.chat ?? checkIn.name)) {
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
            .padding(.vertical, 8)
            .frame(maxWidth: .infinity, alignment: .leading).contentShape(Rectangle())
        }
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
        let layout = typeSize.isAccessibilitySize ? AnyLayout(VStackLayout(alignment: .leading, spacing: 16)) : AnyLayout(HStackLayout(spacing: 20))
        layout {
            AgentAvatar(appearance: nil, size: 76)
                .rotationEffect(.degrees(automated ? -4 : 0))
                .scaleEffect(automated ? 1.04 : 1)
                .overlay(alignment: .bottomTrailing) {
                    if started { Image(systemName: "checkmark.circle.fill").font(.title3).symbolRenderingMode(.hierarchical) }
                }
                .animation(reduceMotion ? nil : .smooth(duration: 0.25), value: automated)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 6) {
                Text(automated ? L("A little work, taken care of") : started ? L("A useful start") : L("Start with one useful task"))
                    .font(.title3.weight(.semibold))
                Text(automated ? L("Your first automation produced a result.") : started ? L("Your first assistant request is complete.") : L("Ask in Chat. Your assistants will take it from there."))
                    .font(.subheadline).foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 12)
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
            VStack(alignment: .leading, spacing: 10) {
                Label(title(failure), systemImage: failure == .ownerOnly ? "person.badge.key" : failure == .unsupported ? "arrow.up.circle" : "wifi.slash")
                    .font(.headline)
                Text(detail(failure)).font(.subheadline).foregroundStyle(.secondary)
                Button(L("Open chat"), action: openChat).buttonStyle(.borderless)
            }
            .padding(.vertical, 8).accessibilityIdentifier("activityState-" + String(describing: failure))
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
        }.font(.caption).foregroundStyle(.secondary)
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
#endif
