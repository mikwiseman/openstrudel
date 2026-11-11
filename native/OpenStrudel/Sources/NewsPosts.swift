import SwiftUI
#if os(macOS)
import AppKit
#else
import UIKit
#endif

/// A post for the owner's channel, written on the desk's Home from its stories. The sheet shows the draft as text to
/// edit, takes a change in words, makes a version for LinkedIn, and copies or shares the result. Nothing here
/// publishes: the owner posts it themselves.
struct NewsPostSheet: View {
    @ObservedObject var feed: NewsFeed
    @ObservedObject var posts: NewsPostShelf
    let request: NewsPostRequest
    let appearance: AgentAppearance?
    @Environment(\.dismiss) private var dismiss
    @Environment(\.newsWords) private var words
    @State private var stories: [String]
    @State private var channel = "telegram"
    /// The draft on screen for each channel.
    @State private var drafts: [String: String] = [:]
    @State private var text = ""
    /// The draft the text was last taken from, so a newer one replaces it and typing is never overwritten.
    @State private var shownVersion = ""
    @State private var instruction = ""
    @State private var failure: String?
    @State private var picking = false
    @State private var copied = false
    @State private var started = false
    /// A request to the Home is on its way: the sheet shows the desk writing, not a button to press again.
    @State private var asking = false
    @FocusState private var editing: Bool

    init(feed: NewsFeed, posts: NewsPostShelf, request: NewsPostRequest, appearance: AgentAppearance?) {
        self.feed = feed; self.posts = posts; self.request = request; self.appearance = appearance
        _stories = State(initialValue: request.stories)
    }

    private var post: NewsPost? { posts.post(drafts[channel]) }
    private var name: String { feed.route.title }
    private static var editorHeight: CGFloat {
        #if os(macOS)
        340
        #else
        220
        #endif
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    sources
                    Picker(words("Для чего пост"), selection: $channel) {
                        Text(verbatim: "Telegram").tag("telegram")
                        Text(verbatim: "LinkedIn").tag("linkedin")
                    }
                    .pickerStyle(.segmented).labelsHidden()
                    .accessibilityIdentifier("postChannel")
                    content
                }
                .padding(.horizontal, 20).padding(.top, 8).padding(.bottom, 24)
                .frame(maxWidth: 640)
                .frame(maxWidth: .infinity)
            }
            .scrollDismissesKeyboard(.interactively)
            .navigationTitle(words("Пост"))
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(words("Готово")) { Task { await keep(); dismiss() } }.accessibilityIdentifier("postDone")
                }
            }
            .safeAreaInset(edge: .bottom, spacing: 0) { if post?.status == "ready" { actions } }
        }
        #if os(macOS)
        .frame(minWidth: 560, idealWidth: 620, minHeight: 600, idealHeight: 700)
        #endif
        .task { await start() }
        .onChange(of: channel) { _, _ in Task { await keep(of: channel == "telegram" ? "linkedin" : "telegram"); adopt() } }
        .onChange(of: post?.updatedAt) { _, _ in show() }
        .onChange(of: post?.status) { _, _ in show() }
        .sheet(isPresented: $picking) { NewsStoryPicker(feed: feed, chosen: $stories).environment(\.newsWords, words) }
        .alert(words("Пост не получился"), isPresented: Binding(get: { failure != nil }, set: { if !$0 { failure = nil } })) {
            Button(L("Понятно"), role: .cancel) {}
        } message: { Text(failure ?? "") }
    }

    // MARK: What it is written from

    private var sources: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(words("Из историй")).font(NewsType.head).foregroundStyle(AppTheme.secondaryText)
            ForEach(stories, id: \.self) { id in
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(feed.desk.item(id)?.story.title ?? post?.titles.first ?? id).font(NewsType.headline(17, .headline)).fixedSize(horizontal: false, vertical: true)
                    Spacer(minLength: 0)
                }
            }
            Button { picking = true } label: { SourceCapsule(title: words("Добавить историю"), symbol: "plus") }
                .buttonStyle(NewsRowStyle()).disabled(post?.isWriting == true)
                .accessibilityIdentifier("postAddStory")
        }
    }

    // MARK: The draft

    @ViewBuilder private var content: some View {
        if let post {
            switch post.status {
            case "writing": writing
            case "failed":
                notice(post.error ?? words("Пост не получился. Попросите ещё раз."), warning: true)
                Button(words("Попросить ещё раз")) { ask { try await posts.revise(post, text: text, instruction: "") } }.buttonStyle(InkCapsuleStyle())
            default:
                editor
                if let note = post.note { notice(note) }
                if Set(post.storyIds) != Set(stories) {
                    Button(words("Переписать из выбранных историй")) { ask { try await posts.revise(postWith(stories), text: text, instruction: "") } }
                        .buttonStyle(InkCapsuleStyle()).accessibilityIdentifier("postRewrite")
                }
                change
            }
        } else if let refusal = posts.refusal, posts.posts.isEmpty {
            notice(words("Чтобы писать посты, обновите OpenStrudel на устройстве «\(feed.client.displayName)».") + "\n" + refusal, warning: true)
        } else if channel == "linkedin", let base = posts.post(drafts["telegram"]), base.status == "ready" {
            Text(words("\(name) перепишет этот пост для LinkedIn: тот же смысл, другой формат.")).font(AppTypography.reading).foregroundStyle(AppTheme.secondaryText)
                .fixedSize(horizontal: false, vertical: true)
            Button(words("Сделать версию для LinkedIn")) { ask { drafts["linkedin"] = try await posts.write(stories, channel: "linkedin", from: base).id } }
                .buttonStyle(InkCapsuleStyle()).accessibilityIdentifier("postLinkedIn")
        } else if started, !asking {
            Button(words("Написать пост")) { ask { drafts[channel] = try await posts.write(stories, channel: channel).id } }.buttonStyle(InkCapsuleStyle())
        } else { writing }
    }

    private var writing: some View {
        VStack(spacing: 14) {
            ToneAvatar(appearance: appearance, size: AvatarSize.hero, working: true)
            Text(words("\(name) пишет пост…")).font(NewsType.headline(21, .title3))
            Text(words("Обычно это около минуты. Окно можно закрыть: черновик останется в «Постах».")).font(AppTypography.interface).foregroundStyle(AppTheme.secondaryText)
                .multilineTextAlignment(.center).fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: 360).frame(maxWidth: .infinity).padding(.vertical, 40)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("postWriting")
    }

    private var editor: some View {
        TextEditor(text: $text)
            .font(AppTypography.reading).lineSpacing(AppTypography.readingLineSpacing)
            .scrollContentBackground(.hidden).scrollDisabled(true)
            .focused($editing)
            // On a phone the editor grows with the draft. On the Mac it keeps its height and scrolls inside, so it is
            // given room for a whole post.
            .frame(minHeight: Self.editorHeight)
            .padding(.horizontal, 12).padding(.vertical, 10)
            .background(AppTheme.tile, in: .rect(cornerRadius: 22, style: .continuous))
            .overlay { RoundedRectangle(cornerRadius: 22, style: .continuous).strokeBorder(AppTheme.separator, lineWidth: 1) }
            .accessibilityIdentifier("postText")
    }

    /// «Что изменить?»: the change in the owner's own words; the desk rewrites the draft as it stands now.
    private var change: some View {
        HStack(alignment: .bottom, spacing: 8) {
            TextField(words("Что изменить? Например: короче и без цифр"), text: $instruction, axis: .vertical).lineLimit(1...4)
                .textFieldStyle(.plain).font(AppTypography.reading)
                .padding(.horizontal, 16).padding(.vertical, 11)
                .background(AppTheme.surface, in: .rect(cornerRadius: 22, style: .continuous))
                .accessibilityIdentifier("postInstruction")
            Button {
                guard let post else { return }
                let said = instruction
                ask { try await posts.revise(post, text: text, instruction: said); instruction = "" }
            } label: {
                Image(systemName: "arrow.up").font(.system(size: 15, weight: .semibold)).foregroundStyle(AppTheme.canvas)
                    .frame(width: 36, height: 36).background(AppTheme.accentText, in: Circle())
                    .frame(minWidth: controlTarget, minHeight: controlTarget).contentShape(Circle())
            }
            .buttonStyle(.plain)
            .disabled(instruction.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            .opacity(instruction.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? 0.3 : 1)
            .accessibilityLabel(words("Переписать")).accessibilityIdentifier("postRevise")
        }
    }

    private func notice(_ message: String, warning: Bool = false) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Image(systemName: warning ? "exclamationmark.circle" : "info.circle").imageScale(.small)
            Text(message).fixedSize(horizontal: false, vertical: true)
        }
        .font(AppTypography.interface).foregroundStyle(warning ? AppTheme.warning : AppTheme.secondaryText)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("postNote")
    }

    // MARK: Taking it away

    private var actions: some View {
        HStack(spacing: 10) {
            Button { copy() } label: {
                HStack(spacing: 8) { Image(systemName: copied ? "checkmark" : "doc.on.doc"); Text(copied ? words("Скопировано") : words("Скопировать")) }
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(InkCapsuleStyle()).accessibilityIdentifier("postCopy")
            ShareLink(item: text) { Image(systemName: "square.and.arrow.up").font(.system(size: 17, weight: .medium)).frame(width: 48, height: 48).background(AppTheme.surface, in: Circle()) }
                .buttonStyle(.plain).foregroundStyle(.primary)
                .simultaneousGesture(TapGesture().onEnded { if let post { Task { await posts.save(post, text: text); await posts.used(post, "shared") } } })
                .accessibilityLabel(words("Поделиться")).accessibilityIdentifier("postShare")
            Button { if let post { ask { try await posts.revise(post, text: text, instruction: "") } } } label: {
                Image(systemName: "arrow.clockwise").font(.system(size: 17, weight: .medium)).frame(width: 48, height: 48).background(AppTheme.surface, in: Circle())
            }
            .buttonStyle(.plain).foregroundStyle(.primary)
            .accessibilityLabel(words("Ещё вариант")).accessibilityIdentifier("postAgain")
        }
        // A bar of controls grows only as far as a bar can: its words stay whole and on one line.
        .dynamicTypeSize(...DynamicTypeSize.accessibility1)
        .padding(.horizontal, 20).padding(.top, 10).padding(.bottom, 12)
        .frame(maxWidth: 640).frame(maxWidth: .infinity)
        .background(.bar)
    }

    private func copy() {
        guard let post else { return }
        NewsPostText.copy(text)
        withAnimation(.smooth(duration: 0.2)) { copied = true }
        Task {
            await posts.save(post, text: text); await posts.used(post, "copied")
            try? await Task.sleep(for: .seconds(1.6))
            withAnimation(.smooth(duration: 0.2)) { copied = false }
        }
    }

    // MARK: State

    private func postWith(_ stories: [String]) -> NewsPost { var next = post!; next.storyIds = stories; return next }

    /// A draft already made from these stories opens as it is; otherwise the desk is asked for one at once.
    private func start() async {
        await posts.load()
        if let id = request.post, let existing = posts.post(id) {
            channel = existing.channel; drafts[existing.channel] = id; stories = existing.storyIds
        } else if let existing = posts.post(for: stories, channel: "telegram") {
            drafts["telegram"] = existing.id
        } else if posts.refusal == nil {
            ask { drafts["telegram"] = try await posts.write(stories, channel: "telegram").id }
        }
        adopt()
        started = true
    }

    /// The other channel's draft of the same stories, when there is one.
    private func adopt() {
        if drafts[channel] == nil, let existing = posts.post(for: stories, channel: channel) { drafts[channel] = existing.id }
        shownVersion = ""
        show()
    }

    /// A newer draft from the Home replaces the text; the same one never overwrites what is being typed.
    private func show() {
        guard let post, post.status == "ready" else { return }
        let version = post.id + post.updatedAt
        if version != shownVersion { text = post.text; shownVersion = version }
    }

    private func keep(of channel: String? = nil) async {
        guard let post = posts.post(drafts[channel ?? self.channel]), post.status == "ready", shownVersion.hasPrefix(post.id) else { return }
        await posts.save(post, text: text)
    }

    private func ask(_ work: @escaping () async throws -> Void) {
        editing = false
        asking = true
        Task {
            do { try await work() }
            catch is CancellationError {}
            catch { failure = error.localizedDescription }
            asking = false
        }
    }
}

/// The primary action of a page or a sheet: an ink capsule with a canvas-coloured label.
struct InkCapsuleStyle: ButtonStyle {
    @Environment(\.isEnabled) private var enabled
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(AppTypography.reading.weight(.medium)).foregroundStyle(AppTheme.canvas)
            // An action's name is never broken across lines or hyphenated: it steps down a little, then ends in an ellipsis.
            .lineLimit(1).minimumScaleFactor(0.75)
            .padding(.horizontal, 22).frame(minHeight: 48)
            .background(AppTheme.accentText, in: Capsule())
            .opacity(enabled ? (configuration.isPressed ? 0.75 : 1) : 0.35)
            .contentShape(Capsule())
            .animation(.easeOut(duration: 0.1), value: configuration.isPressed)
    }
}

/// A draft leaves the app as the text it is.
enum NewsPostText {
    static func copy(_ text: String) {
        #if os(macOS)
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
        #else
        UIPasteboard.general.string = text
        #endif
    }
}

/// The stories a post can be written from: today's paper first, then the rest, each with a mark when chosen.
private struct NewsStoryPicker: View {
    @ObservedObject var feed: NewsFeed
    @Binding var chosen: [String]
    @Environment(\.dismiss) private var dismiss
    @Environment(\.newsWords) private var words

    var body: some View {
        let front = feed.desk.front(read: feed.read)
        let rest = feed.desk.items.filter { item in !front.stories.contains { $0.id == item.id } }.sorted { ($0.newest.sentAt ?? .distantPast) > ($1.newest.sentAt ?? .distantPast) }
        NavigationStack {
            List {
                ForEach(front.stories + rest.prefix(40)) { item in
                    Button { toggle(item.id) } label: {
                        HStack(alignment: .firstTextBaseline, spacing: 10) {
                            Image(systemName: chosen.contains(item.id) ? "checkmark.circle.fill" : "circle").foregroundStyle(chosen.contains(item.id) ? AppTheme.signal : AppTheme.faint)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(item.story.title).font(.body).foregroundStyle(.primary).multilineTextAlignment(.leading)
                                Text(newsLine(item.story, locale: words.language.locale)).font(.footnote).foregroundStyle(.secondary)
                            }
                        }
                    }
                    .buttonStyle(.plain)
                    .disabled(!chosen.contains(item.id) && chosen.count >= 5)
                    .accessibilityIdentifier("pickStory-" + item.id)
                }
            }
            .navigationTitle(words("Истории для поста"))
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button(words("Готово")) { dismiss() }.accessibilityIdentifier("pickDone") } }
        }
        #if os(macOS)
        .frame(minWidth: 480, minHeight: 520)
        #endif
    }

    /// At least one story stays chosen, and no more than five.
    private func toggle(_ id: String) {
        if let index = chosen.firstIndex(of: id) { if chosen.count > 1 { chosen.remove(at: index) } }
        else if chosen.count < 5 { chosen.append(id) }
    }
}

// MARK: - The drafts

/// One draft in a list: where it is meant for and when, its first lines, and what it was written from.
struct NewsPostRow: View {
    let post: NewsPost
    @Environment(\.newsWords) private var words
    @Environment(\.newsPost) private var open

    var body: some View {
        let when = Team.date(post.updatedAt).map { words.moment($0) }
        let state = post.status == "writing" ? words("пишется…") : post.status == "failed" ? words("не получился") : post.usedAt != nil ? words("взят в работу") : nil
        Button { open(NewsPostRequest(stories: post.storyIds, post: post.id)) } label: {
            VStack(alignment: .leading, spacing: 4) {
                QuietLine(text: [words.channel(post.channel), when, state].compactMap { $0 }.joined(separator: " · "))
                Text(post.text.isEmpty ? (post.titles.first ?? "") : Team.plain(post.text)).font(AppTypography.reading).lineSpacing(AppTypography.readingLineSpacing)
                    .lineLimit(3).multilineTextAlignment(.leading).fixedSize(horizontal: false, vertical: true)
                if !post.titles.isEmpty, !post.text.isEmpty {
                    Text(post.titles.joined(separator: " · ")).font(NewsType.quiet).foregroundStyle(AppTheme.secondaryText).lineLimit(1)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.vertical, 11).contentShape(.rect)
        }
        .buttonStyle(NewsRowStyle())
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("post-" + post.id)
    }
}

/// «Посты»: every draft the desk wrote for the owner, the newest first.
struct NewsPostsPage: View {
    @ObservedObject var feed: NewsFeed
    @ObservedObject var posts: NewsPostShelf
    let chrome: NewsChrome

    var body: some View {
        let words = feed.words
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                Text(words("Посты")).font(NewsType.dayTitle).displayTracking(-0.7).accessibilityAddTraits(.isHeader)
                Text(words("Черновики для вашего канала. Публикуете вы сами.")).font(NewsType.quiet).foregroundStyle(AppTheme.secondaryText).padding(.top, 5).padding(.bottom, 14)
                if posts.posts.isEmpty, posts.loaded {
                    VStack(spacing: 14) {
                        ToneAvatar(appearance: chrome.profile?.resolvedAppearance, size: AvatarSize.hero)
                        Text(posts.refusal == nil ? words("Постов пока нет") : words("Чтобы писать посты, обновите OpenStrudel на устройстве «\(feed.client.displayName)»."))
                            .font(NewsType.headline(22, .title2)).multilineTextAlignment(.center).fixedSize(horizontal: false, vertical: true)
                        if posts.refusal == nil {
                            Text(words("Откройте историю и нажмите «Сделать пост».")).font(AppTypography.interface).foregroundStyle(AppTheme.secondaryText).multilineTextAlignment(.center)
                        }
                    }
                    .frame(maxWidth: 380).frame(maxWidth: .infinity).padding(.top, 48)
                    .accessibilityElement(children: .combine).accessibilityIdentifier("postsEmpty")
                }
                ForEach(posts.posts) { post in
                    NewsPostRow(post: post)
                        .contextMenu { Button(words("Удалить"), systemImage: "trash", role: .destructive) { Task { await posts.delete(post) } } }
                }
            }
            .frame(maxWidth: NewsLayout.column, alignment: .leading)
            .padding(.horizontal, Layout.edge).padding(.top, 10).padding(.bottom, 32)
            .frame(maxWidth: .infinity)
        }
        .scrollIndicators(.hidden)
        .accessibilityIdentifier("newsPosts")
        .paperTop()
        .environment(\.newsWords, words)
        .newsToolbar(feed, chrome, title: words("Посты"))
        .onAppear { feed.appear() }
        .onDisappear { feed.disappear() }
        .task { await posts.load() }
    }
}
