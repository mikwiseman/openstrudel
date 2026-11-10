import SwiftUI

/// The team as a list of rows: the main assistant, then every employee with what it is doing now. The Mac sidebar and
/// the iPhone's «Команда» show the same rows; the arithmetic is in `Team.swift`.

/// What one row shows.
struct TeamRowContent: Equatable {
    var name: String
    /// Nil is the main assistant's bun.
    var appearance: AgentAppearance?
    /// The latest answer as one plain line.
    var preview: String
    var date: Date?
    var state = TeamRowState.resting
    /// A result this device has not had on screen.
    var unread = false
    /// A News desk's stories not yet seen; it replaces the dot.
    var count = 0
    var nextRun: Date?
}

/// A row's time ticks by itself: each minute only these few characters are drawn again, never the row.
private struct TeamTime: View {
    let date: Date

    var body: some View {
        TimelineView(.everyMinute) { timeline in
            let text = TeamWords().ago(date, now: timeline.date)
            Text(text).monospacedDigit().contentTransition(.numericText()).animation(.smooth(duration: 0.25), value: text)
        }
    }
}

struct TeamRow: View {
    let content: TeamRowContent
    /// The row is the chosen one: its character answers with one plop.
    var selected = false
    @Environment(\.dynamicTypeSize) private var textSize
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.backgroundProminence) private var prominence
    @State private var landings = 0

    /// The character spring: state changes use it, as a character returning from grey does.
    private static let spring = Animation.spring(response: 0.4, dampingFraction: 0.8)
    private var size: CGFloat {
        #if os(macOS)
        AvatarSize.sidebar
        #else
        AvatarSize.row
        #endif
    }
    /// On a selected row the system's own styles read against the selection; elsewhere the app's tokens do.
    private var secondary: AnyShapeStyle { prominence == .increased ? AnyShapeStyle(.secondary) : AnyShapeStyle(AppTheme.secondaryText) }
    private var ink: AnyShapeStyle { prominence == .increased ? AnyShapeStyle(.primary) : AnyShapeStyle(AppTheme.accentText) }
    private var warning: AnyShapeStyle { prominence == .increased ? AnyShapeStyle(.primary) : AnyShapeStyle(AppTheme.warning) }

    private var line: String {
        switch content.state {
        case .offline: L("Нет связи")
        case .working: L("Работает…")
        case .failing: L("Не получилось")
        case .resting: content.preview
        }
    }

    var body: some View {
        HStack(spacing: 12) {
            // Large text takes the whole row, as in every list of employees.
            if !textSize.isAccessibilitySize { character }
            if textSize.isAccessibilitySize {
                VStack(alignment: .leading, spacing: 4) {
                    name
                    second
                    HStack(spacing: 8) { time; mark }
                }
            } else {
                VStack(alignment: .leading, spacing: 2) {
                    HStack(alignment: .firstTextBaseline, spacing: 8) { name; Spacer(minLength: 0); time }
                    HStack(spacing: 8) { second; Spacer(minLength: 0); mark }
                }
            }
        }
        .frame(maxWidth: .infinity, minHeight: rowHeight, alignment: .leading)
        .contentShape(Rectangle())
        .animation(reduceMotion ? .easeInOut(duration: 0.15) : Self.spring, value: content.state)
        .animation(reduceMotion ? .easeInOut(duration: 0.15) : Self.spring, value: content.unread)
        .animation(reduceMotion ? .easeInOut(duration: 0.15) : Self.spring, value: content.count)
        // A result that lands while the list is in sight, and being chosen, each make the character plop once.
        .onChange(of: content.date) { old, new in if let old, let new, new > old { landings += 1 } }
        .onChange(of: selected) { _, now in if now { landings += 1 } }
        #if os(macOS)
        .help(content.nextRun.map { TeamWords().nextRun($0) } ?? "")
        #endif
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(content.name)
        .accessibilityValue(spoken)
    }

    private var rowHeight: CGFloat {
        #if os(macOS)
        40
        #else
        52
        #endif
    }

    private var character: some View {
        // It proofs while its employee works and rests in grey while it cannot be reached or its runs fail.
        WorkingCharacter(appearance: content.appearance, size: size, working: content.state == .working, landings: landings,
                         offline: content.state == .offline || content.state == .failing)
            .background {
                // Without motion, a still ring says the same.
                if content.state == .working && reduceMotion {
                    Circle().strokeBorder(AppTheme.accent, lineWidth: 2).padding(-4).transition(.opacity)
                }
            }
    }

    private var name: some View {
        Text(content.name).font(AppTypography.interface.weight(.medium)).foregroundStyle(.primary)
            .lineLimit(textSize.isAccessibilitySize ? nil : 1)
            .fixedSize(horizontal: false, vertical: true)
    }

    @ViewBuilder private var time: some View {
        if let date = content.date, content.state != .offline {
            TeamTime(date: date).font(AppTypography.meta).foregroundStyle(secondary).lineLimit(1).fixedSize()
        }
    }

    @ViewBuilder private var second: some View {
        if !line.isEmpty {
            HStack(spacing: 4) {
                if content.state == .failing {
                    Image(systemName: "exclamationmark.triangle.fill").imageScale(.small).foregroundStyle(warning).accessibilityHidden(true)
                }
                Text(line).font(AppTypography.interface)
                    // What has not been read yet reads a step stronger.
                    .foregroundStyle(content.state == .failing ? warning : content.unread && content.state == .resting ? AnyShapeStyle(.primary) : secondary)
                    .lineLimit(textSize.isAccessibilitySize ? 3 : 1)
                    .contentTransition(.opacity)
            }
            .id(content.state == .resting ? "preview" : String(describing: content.state))
            .transition(.opacity)
        }
    }

    @ViewBuilder private var mark: some View {
        if content.count > 0 {
            Text(String(content.count)).font(AppTypography.meta.weight(.semibold)).monospacedDigit()
                .contentTransition(.numericText(value: Double(content.count)))
                .foregroundStyle(prominence == .increased ? AnyShapeStyle(.primary) : AnyShapeStyle(AppTheme.canvas))
                .padding(.horizontal, 6).frame(minWidth: 18, minHeight: 18)
                .background(prominence == .increased ? AnyShapeStyle(.primary.opacity(0.22)) : ink, in: Capsule())
                .transition(.scale.combined(with: .opacity))
        } else if content.unread {
            Circle().fill(ink).frame(width: 8, height: 8)
                .transition(.scale.combined(with: .opacity))
        }
    }

    /// What VoiceOver reads after the name: the state or the latest answer, when, and what is new.
    private var spoken: String {
        var parts = [line]
        if let date = content.date, content.state != .offline { parts.append(TeamWords().ago(date)) }
        if content.count > 0 { parts.append(L("Новых: \(content.count)")) } else if content.unread { parts.append(L("Есть новое")) }
        return parts.filter { !$0.isEmpty }.joined(separator: ", ")
    }
}

/// The first row: the main assistant with its last answer in the chat.
struct TeamLeadRow: View {
    @EnvironmentObject private var client: HomeClient
    var selected = false

    var body: some View {
        let answer = client.messages.last { $0.direction == "outbound" && $0.kind != "notice" && $0.story == nil && !MessagePages.isOwnerReply($0) }
        let offline = client.isOffline(nil)
        TeamRow(content: TeamRowContent(name: client.activeAgentName, appearance: nil,
                                        preview: answer.map { Team.line($0.text) } ?? L("Напишите, что нужно"), date: answer?.sentAt,
                                        state: offline ? .offline : client.isWorking && client.interactions.isEmpty ? .working : .resting),
                selected: selected)
    }
}

/// An employee's row. A News desk counts its unseen stories and leads with today's headline.
struct TeamMemberRow: View {
    @EnvironmentObject private var marks: TeamReadMarks
    @EnvironmentObject private var newsroom: Newsroom
    let member: TeamMember
    let source: HomeClient
    var selected = false

    var body: some View {
        if member.isDesk {
            TeamDeskRow(member: member, source: source, feed: newsroom.feed(member.route, on: source), selected: selected)
        } else {
            let profile = member.profile
            TeamRow(content: TeamRowContent(name: profile.name, appearance: profile.resolvedAppearance,
                                            preview: profile.previewText.isEmpty ? profile.roleText : profile.previewText, date: Team.date(profile.previewAt),
                                            state: Team.state(profile, offline: source.isOffline(profile)), unread: marks.isUnread(profile, on: source),
                                            nextRun: Team.date(profile.nextRunAt)),
                    selected: selected)
        }
    }
}

private struct TeamDeskRow: View {
    let member: TeamMember
    let source: HomeClient
    @ObservedObject var feed: NewsFeed
    let selected: Bool

    var body: some View {
        let profile = member.profile, offline = source.isOffline(profile) || feed.unreachable
        // A Home that does not list its team's work yet still says what its desk's own runs are doing.
        let state: TeamRowState = offline ? .offline : profile.working ?? feed.status?.running == true ? .working
            : profile.failing ?? (feed.status?.failedAt != nil) ? .failing : .resting
        TeamRow(content: TeamRowContent(name: profile.name, appearance: profile.resolvedAppearance,
                                        preview: feed.headline ?? (profile.previewText.isEmpty ? profile.roleText : profile.previewText),
                                        date: Team.date(profile.previewAt), state: state, count: feed.unseen,
                                        nextRun: Team.date(profile.nextRunAt ?? feed.status?.nextRunAt)),
                selected: selected)
    }
}

/// What a row's menu offers, as every list of employees does: a new name, out of sight on this device, another device.
struct TeamMenu: ViewModifier {
    @EnvironmentObject private var library: DeviceLibrary
    let member: TeamMember
    let source: HomeClient
    @Binding var renaming: RenameTarget?
    @Binding var moving: EmployeeMoveRequest?

    func body(content: Content) -> some View {
        content.contextMenu {
            Button(L("Переименовать…"), systemImage: "pencil") { renaming = RenameTarget(client: source, profile: member.profile) }
                .disabled(source.isOffline(member.profile))
            Button(L("Скрыть у меня"), systemImage: "eye.slash") { Task { await library.setHidden(true, profile: member.profile, on: source) } }
            Button(L("Перенести на другое устройство…"), systemImage: "arrow.right.square") { moving = EmployeeMoveRequest(source: source, profile: member.profile) }
                .disabled(!source.ownsDevice)
        }
    }
}

/// A Home's name over its employees, with why it cannot be reached when it cannot.
struct TeamHomeTitle: View {
    let source: HomeClient

    var body: some View {
        HStack(spacing: 6) {
            Text(source.displayName)
            if source.connectionNeedsUnlock { Image(systemName: "lock") }
            else if source.homeUnreachable { Image(systemName: "wifi.slash") }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(source.connectionNeedsUnlock ? source.displayName + ", " + L("Unlock connection")
                            : source.homeUnreachable ? source.displayName + ", " + L("Нет связи") : source.displayName)
    }
}

#if os(iOS)
/// «Команда»: the same rows as the Mac sidebar, each opening its page. The first row is the chat itself.
struct TeamTab: View {
    @EnvironmentObject private var library: DeviceLibrary
    let openChat: () -> Void
    let open: (ReaderRoute) -> Void
    @State private var renaming: RenameTarget?
    @State private var moving: EmployeeMoveRequest?

    var body: some View {
        List {
            Group {
                Section {
                    Button(action: openChat) { TeamLeadRow() }.accessibilityIdentifier("teamLead")
                    ForEach(library.team(on: library.primary)) { row($0, on: library.primary) }
                }
                ForEach(Array(library.teamHomes.dropFirst())) { source in
                    let members = library.team(on: source)
                    if !members.isEmpty {
                        Section {
                            if !library.collapsedDeviceIDs.contains(source.id) { ForEach(members) { row($0, on: source) } }
                        } header: { header(source) }
                    }
                }
                Section { HiddenEmployeesButton() }.listRowSeparator(.hidden)
            }
            // The rows sit on the app's own paper, as the chat does.
            .listRowBackground(AppTheme.canvas)
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .background(AppTheme.canvas)
        .navigationTitle(L("Команда"))
        .sheet(item: $moving) { EmployeeMoveView(request: $0) }
        .sheet(item: $renaming) { NameEditor(target: $0) }
        .accessibilityIdentifier("teamRoot")
    }

    private func row(_ member: TeamMember, on source: HomeClient) -> some View {
        Button { open(member.route) } label: { TeamMemberRow(member: member, source: source) }
            .accessibilityIdentifier("teamMember-" + member.profile.id)
            .modifier(TeamMenu(member: member, source: source, renaming: $renaming, moving: $moving))
            .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                Button(L("Скрыть"), systemImage: "eye.slash") { Task { await library.setHidden(true, profile: member.profile, on: source) } }.tint(.gray)
            }
    }

    /// Another Home folds under its name, as in the list of conversations.
    private func header(_ source: HomeClient) -> some View {
        let collapsed = library.collapsedDeviceIDs.contains(source.id)
        return Button { withAnimation(.smooth(duration: 0.25)) { library.setCollapsed(!collapsed, client: source) } } label: {
            HStack(spacing: 8) {
                TeamHomeTitle(source: source)
                Spacer(minLength: 0)
                Image(systemName: "chevron.forward").font(.caption.weight(.semibold)).rotationEffect(.degrees(collapsed ? 0 : 90))
            }
            .font(.subheadline.weight(.semibold)).foregroundStyle(.primary)
            .frame(maxWidth: .infinity, minHeight: controlTarget, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityValue(collapsed ? L("Свёрнуто") : L("Развёрнуто"))
        .accessibilityIdentifier("teamHome-" + source.id)
    }
}
#endif
