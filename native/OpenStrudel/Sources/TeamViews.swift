import SwiftUI

/// The team as rows: a big character on a circle of its own tone, a name, the latest answer and when. The home
/// shows them on the phone and in the Mac sidebar; the arithmetic is in `Team.swift`.

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
    /// A News desk's stories not yet seen.
    var count = 0
    var nextRun: Date?
}

/// A character on a soft circle of its own tone. While its employee works, the existing proofing motion and a
/// signal ring say so; out of reach it rests in grey.
struct ToneAvatar: View {
    @Environment(\.colorScheme) private var scheme
    var appearance: AgentAppearance?
    let size: CGFloat
    var working = false
    var landings = 0
    var offline = false

    var body: some View {
        WorkingCharacter(appearance: appearance, size: size * 0.74, working: working, landings: landings, offline: offline)
            .frame(width: size, height: size)
            .background(AgentAppearance.tint(appearance, dark: scheme == .dark).opacity(offline ? 0.5 : 1), in: Circle())
            .overlay {
                if working { Circle().strokeBorder(AppTheme.signal.opacity(0.7), lineWidth: size > 44 ? 2.5 : 2).padding(size > 44 ? -5 : -4).transition(.opacity) }
            }
    }
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
    @State private var landings = 0

    /// The character spring: state changes use it, as a character returning from grey does.
    private static let spring = Animation.spring(response: 0.4, dampingFraction: 0.8)
    private var isNew: Bool { content.unread || content.count > 0 }

    private var line: String {
        switch content.state {
        case .offline: L("Нет связи")
        case .working: L("Работает…")
        case .failing: L("Не получилось")
        case .resting: content.preview
        }
    }

    var body: some View {
        HStack(spacing: RowMetrics.gap) {
            // Large text takes the whole row, as in every list of employees.
            if !textSize.isAccessibilitySize { character }
            if textSize.isAccessibilitySize {
                VStack(alignment: .leading, spacing: 4) {
                    name
                    second
                    HStack(spacing: 7) { mark; time }
                }
            } else {
                VStack(alignment: .leading, spacing: 2) { name; second }
                Spacer(minLength: 0)
                HStack(spacing: 7) { mark; time }
            }
        }
        .frame(maxWidth: .infinity, minHeight: AvatarSize.team, alignment: .leading)
        .contentShape(Rectangle())
        .animation(reduceMotion ? .easeInOut(duration: 0.15) : Self.spring, value: content.state)
        .animation(reduceMotion ? .easeInOut(duration: 0.15) : Self.spring, value: isNew)
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

    private var character: some View {
        // It proofs inside a signal ring while its employee works; out of reach, or while its runs fail, it rests in grey.
        ToneAvatar(appearance: content.appearance, size: AvatarSize.team, working: content.state == .working, landings: landings,
                   offline: content.state == .offline || content.state == .failing)
            .overlay(alignment: .bottomTrailing) {
                if content.state == .failing {
                    Image(systemName: "exclamationmark.circle.fill").font(.system(size: AvatarSize.team * 0.36))
                        .symbolRenderingMode(.palette).foregroundStyle(.white, AppTheme.warning)
                        .background(Circle().fill(AppTheme.canvas).padding(-1.5))
                        .offset(x: 2, y: 2).transition(.scale.combined(with: .opacity)).accessibilityHidden(true)
                }
            }
    }

    private var name: some View {
        Text(content.name).font(RowMetrics.name).tracking(-0.3).foregroundStyle(.primary)
            .lineLimit(textSize.isAccessibilitySize ? nil : 1)
            .fixedSize(horizontal: false, vertical: true)
    }

    @ViewBuilder private var time: some View {
        if let date = content.date, content.state != .offline {
            TeamTime(date: date).font(RowMetrics.time).foregroundStyle(AppTheme.faint).lineLimit(1).fixedSize()
        }
    }

    @ViewBuilder private var second: some View {
        if !line.isEmpty {
            Text(line).font(RowMetrics.preview).tracking(-0.15)
                .foregroundStyle(content.state == .working ? AnyShapeStyle(AppTheme.signal) : content.state == .failing ? AnyShapeStyle(AppTheme.warning) : AnyShapeStyle(AppTheme.secondaryText))
                .lineLimit(textSize.isAccessibilitySize ? 3 : 1)
                .id(content.state == .resting ? "preview" : String(describing: content.state))
                .transition(.opacity)
        }
    }

    @ViewBuilder private var mark: some View {
        if isNew {
            Circle().fill(AppTheme.signal).frame(width: RowMetrics.dot, height: RowMetrics.dot)
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

/// A row's measures: 54-point characters and reading-size names on a phone, the sidebar's on the Mac.
enum RowMetrics {
    #if os(macOS)
    static let gap: CGFloat = 11
    static let dot: CGFloat = 8
    static let name = Font.system(size: 14.5, weight: .semibold)
    static let preview = Font.system(size: 13)
    static let time = Font.system(size: 12)
    #else
    static let gap: CGFloat = 14
    static let dot: CGFloat = 9
    static let name = Font.body.weight(.semibold)
    static let preview = Font.subheadline
    static let time = Font.footnote
    #endif
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

/// An employee's row. A News desk leads with today's headline and marks its unseen stories.
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

/// The capsule every page wears at its top: whose page it is. It opens that employee's details.
struct TitleCapsule: View {
    var appearance: AgentAppearance?
    /// False for a Telegram chat or an archive, which has no character.
    var showsCharacter = true
    let name: String
    var offline = false
    var working = false
    let action: (() -> Void)?

    var body: some View {
        Button { action?() } label: {
            HStack(spacing: 8) {
                if showsCharacter { ToneAvatar(appearance: appearance, size: AvatarSize.capsule, working: false, offline: offline) }
                Text(name).font(.body.weight(.semibold)).tracking(-0.2).lineLimit(1)
            }
            .padding(.leading, showsCharacter ? 6 : 16).padding(.trailing, 16)
            .frame(minHeight: 42)
            .frame(maxWidth: 260)
            .contentShape(Capsule())
            #if os(iOS)
            .glassEffect(.regular.interactive(), in: .capsule)
            #endif
        }
        .buttonStyle(.plain)
        .disabled(action == nil)
    }
}

/// The way from a page that is only read to the one composer: a glass capsule shaped like it. It opens the chat
/// with what the page shows attached, and the chat grows out of it.
struct AskCapsule: View {
    @Environment(\.zoomNamespace) private var zoom
    let title: String
    let action: () -> Void

    var body: some View {
        let label = Button(action: action) {
            HStack(spacing: 12) {
                Image(systemName: "plus").font(.system(size: AskCapsule.height * 0.35, weight: .regular)).foregroundStyle(.primary)
                Text(title).font(AppTypography.reading).foregroundStyle(AppTheme.secondaryText).lineLimit(1)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 18).frame(minHeight: AskCapsule.height)
            .contentShape(Capsule())
            .dockGlass()
        }
        .buttonStyle(TilePressStyle())
        .dynamicTypeSize(...DynamicTypeSize.accessibility1)
        Group {
            if let zoom { label.zoomSource(AnyHashable("ask"), in: zoom) } else { label }
        }
        .frame(maxWidth: Layout.column)
        .padding(.horizontal, Layout.edge)
        .padding(.top, 8)
        .padding(.bottom, Layout.belowComposer)
        .frame(maxWidth: .infinity)
        .dockFade()
    }

    static var height: CGFloat {
        #if os(macOS)
        48
        #else
        54
        #endif
    }
}

#if os(iOS)
/// Liquid Glass drawn by UIKit, for a control that floats at the bottom of a page. Such a page comes back into sight
/// while the keyboard of the chat over it is still leaving, and SwiftUI's own glass effect has taken the app down
/// right there (iOS 27.0, in its material's layers); UIKit's glass does not.
private struct DockGlass: UIViewRepresentable {
    func makeUIView(context: Context) -> UIVisualEffectView {
        let view = UIVisualEffectView(effect: UIGlassEffect(style: .regular))
        view.cornerConfiguration = .capsule()
        view.isUserInteractionEnabled = false
        return view
    }
    func updateUIView(_ view: UIVisualEffectView, context: Context) {}
}
#endif

extension View {
    /// A capsule, or a circle, of glass under a floating control at the bottom of a page.
    @ViewBuilder func dockGlass() -> some View {
        #if os(iOS)
        background { DockGlass() }
        #else
        glassEffect(.regular.interactive(), in: .capsule)
        #endif
    }
}
