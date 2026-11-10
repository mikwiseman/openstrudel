# OpenStrudel design system

A warm, quiet workspace where small strudel helpers do the work, and the conversation is the hero.

This is the contract for the Mac app, the iPhone and iPad app, and the local web UI. Every value here is deliberate. If a screen needs a value that is not listed, add it here first.

## Principles

1. **Content first, chrome steps back.** The transcript is the main area. The sidebar, toolbar and composer are quiet controls around it. Liquid Glass is only for controls, never for messages or cards.
2. **Native before custom.** System sidebar, toolbar, Settings window, grouped forms, alerts, menus and buttons. Custom drawing only where the product is unique: the transcript and the characters.
3. **Monochrome. The characters are the only colour.** The primary action is ink: a fill in the primary text colour with a canvas-coloured label. Links are ink with an underline. Selection, focus, switches and checkboxes use the warm graphite accent. No brand hue anywhere in the interface; warmth comes from the cream and graphite neutrals and from the buns. Warning and destructive colours stay for meaning only.
4. **Hierarchy from weight and colour before size.** A screen uses at most four text sizes.
5. **Shared edges.** Text in a column starts on one vertical line. Control edges line up with the column edges.
6. **The characters carry the personality.** Everything around them stays plain.
7. **Generous space.** Start with too much space and remove it, never the other way round. Elements breathe; nothing touches its neighbour or the window edge. Density is allowed only where scanning many items needs it.

## Type

One superfamily: SF Pro for the interface and reading, SF Pro Rounded for display, SF Mono for code. They are designed together, share metrics, and cover Latin, Cyrillic and Greek; Hebrew falls back automatically to SF Hebrew and SF Hebrew Rounded. No custom fonts.

| Role | Mac | iOS (Dynamic Type) | Web |
|---|---|---|---|
| Display: welcome, onboarding, empty conversation name | SF Rounded Semibold 28 | `.system(.title, design: .rounded, weight: .semibold)` | `--font-display` 590, 28/34 |
| Title: sheet and pane titles inside content | SF Semibold 17 (`.title2.weight(.semibold)`) | `.title3.weight(.semibold)` | 17/22 590 |
| Reading: messages, composer, instructions editor | SF 15, `lineSpacing(3)` = 15/22 | `.body`, `lineSpacing(4)` = 17/24 | 15/22 |
| Interface: rows, labels, buttons, settings | SF 13 (`.body`) | `.body` | 13/16 rows, 13/20 multi-line |
| Meta: time clusters, status, file sizes, captions | SF 11 (`.subheadline`) | `.footnote` | 12/16 |
| Code (blocks and inline) | SF Mono 13, `lineSpacing(4)` = 13/20 | `.subheadline.monospaced()`, `lineSpacing(5)` | `--font-mono` 13/20 |

- Settings descriptions may use the system Form footer style (12 on Mac). No other size exists.
- The chat screen uses 15, 13 and 11, plus 17 only when a reply has headings.
- Weights: Regular, Medium, Semibold. No Light or Thin.
- Markdown headings stay small: H1 and H2 are 17 Semibold, H3 to H6 are 15 Semibold (iOS: `.title3.weight(.semibold)` and `.headline`). 24 above a heading, 8 below.
- Tabular figures (`.monospacedDigit()`, `tabular-nums`) for times, counts, percentages and prices. No manual letter-spacing.
- Web stacks, zero downloads:
  - `--font-sans: -apple-system, BlinkMacSystemFont, "Segoe UI Variable Text", "Segoe UI", Roboto, "Noto Sans", "Noto Sans Hebrew", "Helvetica Neue", Arial, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji"`
  - `--font-display: ui-rounded, -apple-system, BlinkMacSystemFont, "Segoe UI Variable Display", "Segoe UI", Roboto, sans-serif`
  - `--font-mono: ui-monospace, Menlo, Consolas, "DejaVu Sans Mono", monospace`
  - Weights 400 / 510 / 590 so a browser on a Mac renders the same SF instances as the app. Safari renders the native faces exactly; Chrome and Firefox on a Mac render SF for text, SF (not Rounded) for display and Menlo for code.

## Space and shape

- Layout gaps: **4, 8, 12, 16, 24, 32, 48, 64.** The Mac window edge is 20; iOS margins are 16. Line heights (16, 20, 22, 24) are not spacing.
- Default to the larger step. An icon and its label: 8. An avatar and its text: 12. Related controls: 12. Groups: 24. Sections and turns: 32. A new topic or time cluster: 48.
- Nothing sits closer than 16 to a window, sidebar or composer edge; content never runs under the bottom edge.
- Text-box paddings are optical and listed per component below.
- Radii (always `.continuous`): **8** dense controls; **12** code blocks, file chips, cards, tables, images, sidebar selection on the web; **20** message bubbles; **24** composer. Web only: **6** inline code. Nested shapes are concentric: inner radius = outer radius minus padding.
- Avatars: **24** (toolbar, the helper), **36** (sidebar), **64** (details header), **96** (empty conversation, welcome).

## Colour

Warm low-chroma neutrals, ink and graphite. Values are light / dark / light increased contrast / dark increased contrast. Every text token passes 4.5:1 on canvas, surface and user bubble in all four appearances (computed).

| Token | Values | Role |
|---|---|---|
| `CanvasColor` | `#F7F3EC` / `#1C1B1A` / `#FFFDF8` / `#121110` | main window background |
| `SurfaceColor` (new) | `#EEE9E1` / `#262422` / `#EFE9E1` / `#211F1D` | code blocks, file chips, cards, table header, multi-author messages |
| `UserBubbleColor` (new) | `#E6DFD5` / `#34302D` / `#E0D8CC` / `#3B3633` | the person's message bubble, a step darker than the surface |
| `SeparatorColor` (new) | `#DCD5CB` / `#3A3633` / `#8F887F` / `#77726D` | hairlines, table rules, quote rule, increased-contrast strokes. Never an input border |
| `AccentColor` | `#55504C` / `#7B7570` / `#2B2826` / `#7B7570` | the system accent: selection, focus, switches, checkboxes, default buttons. White on it: 8.0 / 4.5 / 14.6 / 4.5; against the sidebar 6.6 / 3.4 and grouped cards ≥ 3.0 in dark |
| `AccentText` (new) | `#262422` / `#EDEAE6` / `#14120F` / `#FFFFFF` | ink: links (underlined), the primary action's fill (label in `CanvasColor`: 14.0 / 14.3 / 20.7 / 18.9), the send button |
| `SecondaryText` | `#615B57` / `#ADA8A3` / `#45403C` / `#D2CEC9` | supporting text and meta |
| `WarningText` | `#865021` / `#DFB681` / `#6D3B12` / `#F6D3A3` | warnings and every error message: a failure to load, save or act |
| `DestructiveText` | `#A82029` / `#FF8A91` / `#850A12` / `#FFC7CB` | destructive text; destructive buttons use `role: .destructive` |

- `MetadataText` is removed; meta uses `SecondaryText` at the meta size.
- Primary text is the system `.primary`. Success is a word or a symbol, never a colour alone. Colour is never the only signal of state.
- Increased contrast: the user bubble, code blocks, file chips and tables add a 1-pt `SeparatorColor` stroke.
- The canvas is the main window only. Sheets, the Settings window, popovers, menus and grouped forms keep system backgrounds.
- Web only: `--control-border` `#86808C` / `#7C7781` / `#6F6A74` / `#8F8A94` for inputs (≥ 3:1).

## Characters

- The main assistant is the brand bun from the app icon without its tile (`Agent-main`), so every row in the sidebar is a character. The app icon tile stays for the Dock, About and the menu bar.
- **The helper.** One character sits at the "now" edge of every conversation: 24 pt at the leading text edge, 12 below the last transcript item. Idle, it is still. While the employee works, it proofs like rising dough (scale x 1.03, y 0.95, anchored at the bottom, ease-in-out 0.9 s, repeating) beside "{Name} is working…" in meta style. When a reply lands, it plops once (scale y 0.86 over 90 ms, then a spring back, response 0.35, damping 0.55); iOS adds a soft haptic. The loop pauses when the window is inactive. Reduce Motion: no scale, a 150 ms fade of the words only.
- **Offline.** When an employee's device is offline, its character renders desaturated at 60 % opacity in the sidebar, toolbar and helper, and its preview reads "Offline". It returns over 0.4 s with the character spring.

## Mac structure

- **Window:** a `NavigationSplitView` whose sidebar lists **Chat**, each **News** feed of the connected Homes (named after its employee, with the count of what is new today), and **Statistics**. ⌘1, ⌘2… follow the sidebar's order. `.windowToolbarStyle(.unified(showsTitle: false))`; no hidden title bar. The canvas is set with `.containerBackground(AppTheme.canvas, for: .window)`. Minimum window 760 × 560. One layout direction per window: AppKit's, fixed at launch from the chosen language (`AppleTextDirection`); choosing a language that reads the other way offers a relaunch. The language menu appears on the welcome screens only. There is no employee sidebar and no New employee command.
- **Chat:** the chosen Home's main assistant, the one composer in the app. The toolbar carries the history button (`clock.arrow.circlepath`, label «Переписки», ⌘F) that opens the readers list, and Settings. The transcript column is centred, max width **560**, at least 32 from the detail edges; 32 between the toolbar and the first item; 24 between the last item and the composer. Every unresolved send of the Home stays in this transcript with its destination («Для: …»), retry, «Убрать контекст и отправить» and «Удалить».
- **Readers:** a `NavigationStack(path:)` of `ReaderRoute` pushed over the chat: an employee's history or a Telegram group. A News feed has its own place in the sidebar. Readers scroll and search; they never compose. A message's or story's context menu «Обсудить в чате» attaches it to the chat's draft and pops back to the chat. The reader title opens the employee's details (also ⌘I), including its services and Telegram chats.
- **Bars:** connection banner and OpenAI recovery notice in `safeAreaBar(edge: .top)`; Telegram hint, new-messages button and composer in `safeAreaBar(edge: .bottom)`. No custom fades or bar backgrounds. The composer sits 24 above the window's bottom edge (20 on iOS above the safe area) and is never clipped. The draft's attached context is a chip above the field (`draftContext`, `removeDraftContext`).
- **Settings window (⌘,):** `TabView` with `Tab(_:systemImage:value:)` panes Devices, Accounts, Backups, Connections, General; the selected pane persists in `@AppStorage` so other screens can route to a pane and call `openSettings`. Devices holds the «Чат ведёт» picker: moving the chat to another Home is refused with the reason while a draft, a question, an answer in flight or an unconfirmed send is pending («Чат занят»). Each pane is a `Form` with `.formStyle(.grouped)`, width 600, as tall as its rows between 360 and 720; Devices is at least 560, so its Connect a device sheet stays inside the window. Row contract: one `Section` per group with an optional footer; switches as `.toggleStyle(.switch).controlSize(.mini)`; two to five exclusive options as `.pickerStyle(.radioGroup)`; read-only values as `LabeledContent` with the value in secondary; actions as their own rows; destructive actions last with `role: .destructive`; Help and Privacy as `Link` rows in one section. No cards, no hand-made dividers or headings.
- **Sheets:** multi-page sheets use `.presentationSizing(.form)` on the sheet's `NavigationStack` so pushes never resize them; single-page sheets use `.fitted`. Buttons go in `ToolbarItem(placement: .cancellationAction / .confirmationAction)`. Confirmations are `.alert` or `.confirmationDialog` with `role: .destructive`; a confirmation that needs more than an alert holds (Remove connection and Erase, which offer a backup first) is a sheet with its destructive button in `.destructiveAction`, so it is never the default button and Return does nothing.

## iOS structure

Four tabs in a bottom tab bar (`.tabBarMinimizeBehavior(.onScrollDown)`): Chat, Insights, Progress and Statistics. Insights opens with a row for each News feed: its name, «N новых» and its lead headline. Chat is the root of its `NavigationStack`; the readers list opens from the history button (`openChats`) as a sheet with sections for employees, feeds («Ленты») and Telegram chats, and a chosen reader pushes over the chat. Settings opens in its sheet with the existing identifiers; «Сервисы и навыки» (`openChatConnections`) lives there. The principal toolbar item is the chat's avatar + name. The composer sits in `safeAreaBar(edge: .bottom)`. All tokens apply through text styles so Dynamic Type works to AX5. Hit targets 44.

## Transcript

- **The person (one-to-one):** trailing bubble, `UserBubbleColor`, radius 20, padding 16 × 9 (one line is a 40-pt capsule), max width 75 % of the column (420).
- **The employee:** open text on the canvas, leading-aligned, full column width. No bubble, no avatar per message, no author label.
- **Multi-author conversations** (imported history, Telegram groups): other people's messages are leading-aligned on `SurfaceColor`, radius 20, with "Anna · 12:04" above in meta style.
- **Rhythm:** 32 between turns, 12 between consecutive messages from the same side, 12 between paragraphs, 6 between list items, 24 above and 8 below a heading, 48 above a time cluster header and 16 below it (none above the first).
- **Time:** a centred cluster header in meta style when a new day starts or after a gap of 30 minutes or more ("Today, 12:02"; day only when a message has no time). Exact time: `.help` on Mac and `accessibilityValue` everywhere. Schedule and notice lines keep their time. Queued, failed and error states stay visible under their message.
- **Markdown:** lists use a fixed marker column so bullets and right-aligned tabular numbers share one text edge. Quotes: 2-pt `SeparatorColor` rule, 12 gap, secondary text. Links: ink (`AccentText`), underlined at rest (underline in `SecondaryText`; on the web the underline turns solid ink on hover); only `https`, `http` and `mailto` stay links, natively and on the web. Inline code: SF Mono 13 on `SurfaceColor`. Code blocks: `SurfaceColor`, radius 12, padding 12, copy button on hover (Mac) or always (iOS). Tables: `SurfaceColor` header, hairline rules, a column whose cells are all numbers is trailing-aligned with tabular figures; horizontal scroll when wider than the column.
- **Files:** chips on `SurfaceColor`, radius 12, padding 12, icon 20, name 13 Medium, size in meta. Images radius 12, max 320 × 240. A web picture named in a reply loads only when the person asks, because its address can carry data out: natively a 240 × 180 surface with its host and "Download image", on the web a link. Attachments load on sight.
- **Right to left:** each block aligns by the direction of its first strong letter, so English in the Hebrew interface stays left-aligned and Hebrew in the English interface is right-aligned. The person's bubbles and the helper follow the direction of the employee's latest reply (the interface's when there is none), so the bubbles always sit opposite the employee's text edge: on the right beside English replies, on the left beside Hebrew ones. Directional symbols use `forward` and `backward` variants.

## Composer

Liquid Glass, radius 24, minimum height 48, growing to 8 lines and then scrolling. Its edges are the transcript column edges. Mac: 32-pt controls with 8 padding. iOS: 44-pt targets with 2 vertical padding. Leading `plus` menu; trailing microphone and send. The send button is the only filled element: an ink circle (`AccentText`) with a canvas-coloured arrow when there is content, the system disabled state otherwise; with an empty field while the employee answers it becomes Stop. With text while the employee answers, the steer / after-the-reply menu sits before the microphone. The queue tray and attachment chips sit inside the glass above the text. Text uses the reading style with the same line spacing as the transcript. Placeholder: "Message {Name}". Drop target: 2-pt ink stroke at the same radius. No glass inside the composer.

## Empty states and onboarding

The character, one sentence, at most one action. Empty conversation: character 96 at 40 % of the height, the name in display, the role in at most two lines of 13 secondary within 360; the composer is the action. On the Mac the keyboard stays on the chosen sidebar row, so arrows and Delete keep working; Tab reaches the composer after the search field. A new employee's draft focuses its composer. Welcome and onboarding: character 96, display title, body leading-aligned when it runs past two lines, one prominent capsule button in ink (canvas-coloured label); secondary actions are plain text buttons. Optically centred at 40 % from the top.

## Statistics

How the connected Homes were used, by day (thirty days) or by week (twelve, from Monday), in one column 640 wide (`StatisticsView.swift`). It reads every connected Home at once, not only the chat's, and «Все устройства» or one Home narrows it.

- **One number.** The chosen day's or week's requests in SF Semibold 64 (44 at accessibility sizes), proportional figures, `numericText` transition. Above it a meta kicker in capitals («Запросы сегодня»); below it the fair comparison in secondary: the unfinished day or week against the previous one up to the same moment («Вчера к этому часу: 253»), a finished one against the whole previous one. Then cost and tokens in primary when engines reported them («≈ $11,24 по ценам API · токены 4,1 млн»). The one size beyond the chat's four: a deliberate exception for this screen, like the News serif.
- **Bars.** One per period from the first request on, growing from one hairline baseline: at most 24 wide, 2 apart, 4 rounded at the top only, 148 high on the Mac and 132 on iOS. The shown bar is ink; the rest `SecondaryText` at 30 % (55 % under the pointer); a period with no requests is a 2-high `SeparatorColor` stub. One reference value top right on a faint hairline. Every bar is a button with its date and value; hovering on the Mac previews the number, a click or tap chooses the period for everything below. First and last date under the bars in meta.
- **Below**, 48 apart: each Home's share as a 4-high ink capsule on a `SeparatorColor` track (a row narrows the report to that Home); then «Где работали», «Расписания» and «Модели» as rows under capitalised meta headers with hairlines, the top five and «Показать все · N»; then where requests came from and how they ended as two meta lines of words beside numbers; then notes in meta (since when tokens are counted, a Home to update or offline in `WarningText`, the time checked).
- No colour carries meaning: Homes are named, never coloured. A state without numbers is a symbol, a display title, one line and at most one action (`statisticsState-<code>`): no devices, loading, needs an update, owner only, offline.

## News reader

The one deliberate exception to the chat's type and colour rules, approved by Mik on 30 October 2026 with the News prototype. An employee with stories is a feed, read as one page a day (`NewsViews.swift`; the arithmetic lives in `NewsDesk.swift`). There are no tabs and nothing to type: «Обсудить в чате» takes a story to the chat, and the feed keeps the story and the place the reader left.

- **The page**, top to bottom in a 720 column:
  - the date as a kicker («ВТОРНИК · 10 НОЯБРЯ») and one **status line** in meta beside the employee's character (24). The character proofs while a run is in progress, plops when stories join the page, and rests in grey while runs fail or the Home is out of reach;
  - **«Новое с 11:40 · 3»**, only when the radar reported something the reader has not had on screen since yesterday: the five newest as compact rows, then «Показать все · N». The time is shown only when every row came after the last visit;
  - **the morning edition** under an ink rule: the lead (kicker with status pill, headline, a dek of at most three lines, source sites), then numbered rows with a two-line dek. A row is its own button; there is no «read more». When today has no edition, the latest one stands in under «Выпуск за 8 ноября»;
  - **«Радар за день»**: compact rows, newest event first, without what «Новое» and the edition already show;
  - **«Раньше»**: every earlier day with its number of stories; a row opens that day's page.
- **Status line.** Exactly one of: «Выпуск 07:04 · 7 историй · радар проверил 14:35» · «News проверяет источники…» · «Радар не работает с 10:05: причина» (in `WarningText`; the time is the last check that worked) · «News на паузе с 8 ноября» · «Сегодняшнего выпуска нет. Ниже выпуск за 8 ноября.» A Home out of reach says so instead. A feed without a story in two weeks shows the character at 96, that sentence and nothing to press.
- **Compact row:** time (64), section (128, one line), headline in serif 17 on at most two lines. The time is the event's own when the story knows it, otherwise the report's; another day shows as its date. «↻» in `NewsStatusText` marks a development of a story reported earlier. Under 520 wide, and at accessibility sizes, the headline goes under the time and section.
- **Seen.** A story counts as seen once its row has rested on screen for 1.5 seconds with the page at rest in the active window, or when it is opened. Opening the page marks nothing. What was seen is kept on the device per Home and conversation; a device that meets a feed starts with everything before today seen. The sidebar and Insights count the «Новое» rows and the edition's stories not yet seen.
- **Arrivals.** Stories that arrive while a page is open wait behind a glass pill, «2 новых ↑» (centred over the column; at the trailing edge on a phone). Pressing it adds them and returns to the top. Curation and copy edits apply at once.
- **A story** pushes over its page in a 640 column: kicker, headline, summary; the latest development on top («↻ 10:40 — …») when the story has developed; source sites and «Обсудить в чате»; «Что произошло»; «Наш взгляд» in serif 21 behind a 2-pt rule; «Доказательства» (sources, open when there are three or fewer, then «Прочитано», «Не проверено» and «Событие» as name-and-text pairs); «Развитие» when there are two or more developments; the next story of the page. On the Mac the story takes the keyboard: Esc goes back, J and K or ← and → move through the page's stories, Space and the paging keys scroll.
- **Language.** Labels and dates follow the stories: Cyrillic stories read in Russian whatever the interface language; other stories keep the interface language, or English when that is Russian. An emptied feed remembers its language.
- Headlines use the system serif (New York, `design: .serif`): lead 36, numbered rows 22, compact rows 17, story 42, our view 21, the empty page's sentence 26 (iOS: Dynamic Type styles). Reading text stays SF at the reading size. Kickers: 10.5 Semibold, upper case, tracking 1.2–2.
- `NewsStatusFill` `#E3EADA` / `#26331F` / `#D6E1CA` / `#1E2A18` and `NewsStatusText` `#3B5636` / `#B5CFAA` / `#253D21` / `#D6EBCC` mark a story's factual status, section labels, «Новое» and «↻» (6.6–11.9:1). Always with words.
- Pages sit on `CanvasColor` on both platforms. Motion is the system's push and the layout curve below; Reduce Motion leaves fades.

## Motion

Layout: `.smooth(duration: 0.25)`, no bounce, under 300 ms. Characters only: springs with response 0.35 to 0.5 and damping 0.55 to 0.8. Press feedback on press. Reduce Motion: fades only.

## Web UI

Mirror the Mac layout and tokens at 1 pt = 1 px: CSS custom properties for every colour in light, dark and `prefers-contrast: more`; the same sidebar (56-px rows, 36 avatars, 12 gaps, 12-px inner margin), transcript, helper and composer with the same generous spacing; the page fits the viewport exactly (`100dvh`, no clipped composer or sidebar footer); the same type scale (meta raised to the 12 px floor). Markdown is rendered by a DOM-only renderer (never `innerHTML` for message content): raw HTML is text, only `https`, `http` and `mailto` links, images become links. Each message is one `<article>`. Follow the latest message only when the reader is near the bottom. SVG icons, no text glyphs. Form controls inherit the font. Logical properties and `dir="auto"` for right to left. `prefers-reduced-motion` and `prefers-reduced-transparency` respected. Modals: title, content, a bottom bar with Cancel first and one primary action last. Return in a modal's text field presses its primary action. The composer keeps the leading plus (files) and the steer / after-the-reply toggle but has no microphone: the browser has no speech engine here.

## File ownership (for parallel work)

`RootView.swift` (tabs and readers path), `ConversationView.swift` (the chat), `Transcript.swift`, `Composer.swift`, `ReaderViews.swift` and `ConversationReader.swift` (read-only readers), `StatisticsView.swift` and `StatisticsModel.swift` (Statistics), `EmployeePicker.swift` (the readers list), `EmployeeDetailsView.swift`, `Onboarding.swift` and `SharedViews.swift` replace `Views.swift` and the former `Sidebar.swift`, so each surface has one owner file. The Home side lives in `src/statistics.ts` and `src/usage.ts` (what each turn spent) and `src/message-context.ts` (what a message carries).
