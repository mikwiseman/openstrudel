import SwiftUI
import Charts

/// The daily polls of a chat as a place: the day's answers with the people side by side, what stands out, each
/// measure over the weeks, and this week against the last. It opens from its tile on the home. A finger on any chart
/// moves the whole page to that day and lets go back to the latest.
struct CheckInsPage: View {
    @EnvironmentObject private var client: HomeClient
    @ObservedObject var model: ActivityModel
    let scope: String
    let refresh: () async -> Void
    let openChat: () -> Void
    private var activity: HomeActivity? { model.scope == scope ? model.activity : nil }

    var body: some View {
        // A board nobody has answered yet has nothing to draw: the page says so instead.
        let boards = CheckInBoard.boards(activity?.rituals ?? []).filter { $0.latestDay != nil }
        ActivityColumn {
            ActivityStatus(model: model, scope: scope, openChat: openChat)
            if let activity {
                if boards.isEmpty {
                    ActivityEmpty(title: L("Пока нет ответов"), text: L("Когда в чате появится ежедневный опрос, ответы соберутся здесь."))
                }
                ForEach(boards) { CheckInBoardView(board: $0, named: boards.count > 1) }
                ActivityChecked(date: activity.checkedAt, home: client.displayName)
            }
        }
        .activityPage(boards.count == 1 ? boards[0].title : L("Check-ins"))
        .toolbar { ToolbarItem(placement: .primaryAction) { ActivityRefresh(refreshing: model.refreshing, refresh: refresh) } }
        .refreshable { await refresh() }
        .accessibilityIdentifier("checkInsRoot")
    }
}

private struct CheckInBoardView: View {
    @EnvironmentObject private var client: HomeClient
    @Environment(\.dynamicTypeSize) private var typeSize
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let board: CheckInBoard
    /// More than one chat has polls: each board says whose it is.
    let named: Bool
    /// The day under the finger, while a chart is touched.
    @State private var scrubbed: String?

    private var latest: String { board.latestDay ?? board.today }
    private var shown: String { scrubbed ?? latest }
    private var words: CheckInWords { CheckInWords() }

    var body: some View {
        let standouts = board.standouts(on: latest)
        VStack(alignment: .leading, spacing: 38) {
            VStack(alignment: .leading, spacing: 18) {
                VStack(alignment: .leading, spacing: 4) {
                    if named { Text(board.title).font(AppTypography.label).foregroundStyle(AppTheme.secondaryText) }
                    Text(words.day(shown, today: board.today)).font(AppTypography.display).displayTracking()
                        .contentTransition(.opacity).accessibilityAddTraits(.isHeader).accessibilityIdentifier("checkInDay")
                }
                people
            }
            if !standouts.isEmpty {
                ActivitySection(title: L("Что заметно"), spacing: 16) {
                    ForEach(standouts) { standout in
                        VStack(alignment: .leading, spacing: 2) {
                            Text(words.title(standout)).font(AppTypography.interface.weight(.semibold))
                            Text(words.text(standout)).font(rowDetail).foregroundStyle(AppTheme.secondaryText).monospacedDigit()
                        }
                        .accessibilityElement(children: .combine)
                        .accessibilityIdentifier("checkInStandout-" + standout.id)
                    }
                }
            }
            ActivitySection(title: L("По дням"), spacing: 22) {
                ForEach(board.measures) { MeasureChart(board: board, measure: $0, shown: shown, scrubbed: $scrubbed) }
                if let first = board.charted.first, let last = board.charted.last, first != last {
                    HStack {
                        Text(words.shortDay(first, today: board.today))
                        Spacer(minLength: 8)
                        Text(words.shortDay(last, today: board.today))
                    }
                    .font(AppTypography.meta).foregroundStyle(AppTheme.faint).padding(.top, -12).accessibilityHidden(true)
                }
            }
            if board.dates.count > 7 { ActivitySection(title: L("Неделя к прошлой"), spacing: 12) { weeks } }
            NavigationLink(value: HomePlace.reader(ReaderRoute(connectionID: client.id, kind: .conversation(board.id), title: board.chat ?? board.title))) {
                Label(L("Open source conversation"), systemImage: "text.bubble")
                    .font(AppTypography.meta.weight(.medium)).foregroundStyle(.primary)
                    .padding(.horizontal, 14).frame(minHeight: max(36, controlTarget))
                    .background(AppTheme.surface, in: Capsule()).contentShape(Capsule())
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("checkInSource")
        }
        .animation(reduceMotion ? nil : .smooth(duration: 0.18), value: shown)
        // One soft tick for each day the finger crosses.
        .sensoryFeedback(trigger: scrubbed) { _, day in day == nil ? nil : .selection }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("checkInBoard-" + board.id)
    }

    /// The people side by side; one under another when the reader's type is very large, sideways past three.
    @ViewBuilder private var people: some View {
        let cards = ForEach(Array(board.people.enumerated()), id: \.element.id) { index, person in
            PersonCard(board: board, person: person, index: index, day: shown, latest: latest)
        }
        if typeSize.isAccessibilitySize {
            VStack(spacing: TileMetrics.gap) { cards }
        } else if board.people.count <= 3 {
            HStack(alignment: .top, spacing: TileMetrics.gap) { cards }.fixedSize(horizontal: false, vertical: true)
        } else {
            ScrollView(.horizontal) {
                HStack(alignment: .top, spacing: TileMetrics.gap) { cards.frame(width: TileMetrics.side + 20) }
                    .fixedSize(horizontal: false, vertical: true).padding(.bottom, 26)
            }
            .scrollIndicators(.hidden).scrollClipDisabled().padding(.bottom, -26)
        }
    }

    /// Each measure's mean over the last seven days and how far it moved from the seven before.
    private var weeks: some View {
        Grid(alignment: .leadingFirstTextBaseline, horizontalSpacing: 20, verticalSpacing: 12) {
            GridRow {
                Color.clear.gridCellUnsizedAxes([.horizontal, .vertical])
                ForEach(Array(board.people.enumerated()), id: \.element.id) { index, person in
                    HStack(spacing: 5) { PersonMark(index: index); Text(CheckInBoard.short(person.name)).lineLimit(1) }
                        .font(AppTypography.meta).foregroundStyle(AppTheme.secondaryText).gridColumnAlignment(.trailing)
                }
            }
            .accessibilityHidden(true)
            ForEach(board.measures) { measure in
                GridRow {
                    Text(measure.label).frame(maxWidth: .infinity, alignment: .leading)
                    ForEach(board.people) { person in
                        let now = board.mean(measure, person, over: board.thisWeek), before = board.mean(measure, person, over: board.lastWeek)
                        HStack(alignment: .firstTextBaseline, spacing: 6) {
                            if let now, let before, let change = words.change(now.value - before.value) {
                                Text(change).font(AppTypography.meta).foregroundStyle(AppTheme.secondaryText)
                            }
                            Text(now.map { words.number($0.value) } ?? "–").foregroundStyle(now == nil ? AnyShapeStyle(AppTheme.faint) : AnyShapeStyle(.primary))
                        }
                        .monospacedDigit()
                        .accessibilityElement(children: .ignore)
                        .accessibilityLabel(person.name)
                        .accessibilityValue(spoken(now?.value, before?.value))
                    }
                }
                .font(AppTypography.interface)
                .accessibilityElement(children: .combine)
            }
        }
        .accessibilityIdentifier("checkInWeeks")
    }

    private func spoken(_ now: Double?, _ before: Double?) -> String {
        guard let now else { return L("Нет ответа") }
        guard let before else { return words.number(now) }
        return L("За неделю \(words.number(now)), неделей раньше \(words.number(before))")
    }
}

/// The quiet words of a row: the interface size on the Mac, where a subheadline would be 11 points.
private var rowDetail: Font {
    #if os(macOS)
    .system(size: 12.5)
    #else
    .subheadline
    #endif
}

/// Who is who without a colour: the first person is filled, the second is a ring, anyone after them is quiet.
private struct PersonMark: View {
    let index: Int
    var size: CGFloat = 7
    /// The mark grows with the name beside it.
    @ScaledMetric(relativeTo: .caption) private var scale: CGFloat = 1
    var body: some View {
        Group {
            switch index {
            case 0: Circle().fill(AppTheme.accentText)
            case 1: Circle().fill(AppTheme.tile).overlay { Circle().strokeBorder(AppTheme.accentText, lineWidth: 1.5) }
            default: Circle().fill(AppTheme.faint)
            }
        }
        .frame(width: size * min(scale, 2), height: size * min(scale, 2))
        .accessibilityHidden(true)
    }
}

/// One person's answers of the shown day: a white tile that is as tall as its words need.
private struct PersonCard: View {
    @Environment(\.colorSchemeContrast) private var contrast
    let board: CheckInBoard
    let person: CheckInBoard.Person
    let index: Int
    let day: String
    let latest: String

    private var answered: Bool { board.measures.contains { board.value($0, person, on: day) != nil } }
    private var footer: String {
        if !answered { return day == board.today ? L("Пока без ответа") : L("Нет ответа") }
        return day == latest && person.streak > 1 ? L("Streak: \(person.streak.formatted())") : ""
    }

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: TileMetrics.radius, style: .continuous)
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 6) {
                PersonMark(index: index)
                Text(CheckInBoard.short(person.name)).lineLimit(1).opacity(0.72)
            }
            .font(AppTypography.label)
            VStack(spacing: 6) {
                ForEach(board.measures) { measure in
                    let value = board.value(measure, person, on: day)
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text(measure.label).font(rowDetail).foregroundStyle(AppTheme.secondaryText).lineLimit(1).minimumScaleFactor(0.8)
                        Spacer(minLength: 0)
                        Text(value.map { $0.formatted() } ?? "–").font(.title3.weight(.semibold)).monospacedDigit()
                            .foregroundStyle(value == nil ? AnyShapeStyle(AppTheme.faint) : AnyShapeStyle(.primary))
                            .contentTransition(.numericText(value: Double(value ?? 0)))
                    }
                }
            }
            .padding(.top, 14)
            Text(footer.isEmpty ? " " : footer).font(AppTypography.label.weight(.regular)).foregroundStyle(AppTheme.secondaryText).lineLimit(1)
                .padding(.top, 12).opacity(footer.isEmpty ? 0 : 1)
        }
        .padding(TileMetrics.padding)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(AppTheme.tile, in: shape)
        .overlay { shape.strokeBorder(contrast == .increased ? AnyShapeStyle(AppTheme.separator) : AnyShapeStyle(.white.opacity(0.18)), lineWidth: 1) }
        .tileShadow()
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(person.name)
        .accessibilityValue(spoken)
        .accessibilityIdentifier("checkInPerson-" + person.id)
    }

    private var spoken: String {
        let answers = board.measures.compactMap { measure in board.value(measure, person, on: day).map { measure.label + " " + $0.formatted() } }
        return ([CheckInWords().day(day, today: board.today)] + (answers.isEmpty ? [footer] : answers + [footer]).filter { !$0.isEmpty }).joined(separator: ", ")
    }
}

/// One measure over the weeks: each person a line through the days they answered. The first person's line is ink
/// with filled points, the second's is quiet with rings. A day without an answer has no point.
private struct MeasureChart: View {
    let board: CheckInBoard
    let measure: CheckInBoard.Measure
    /// The day whose answers the head shows and the rule stands on.
    let shown: String
    @Binding var scrubbed: String?
    @State private var selection: Double?

    private struct Point: Identifiable { let id: String; let person: Int; let name: String; let day: Int; let value: Int }
    private var dates: [String] { board.charted }

    private var points: [Point] {
        board.people.enumerated().flatMap { index, person in
            dates.enumerated().compactMap { day, date in
                board.value(measure, person, on: date).map { Point(id: person.id + ":" + date, person: index, name: person.name, day: day, value: $0) }
            }
        }
    }

    var body: some View {
        let dates = dates, shownIndex = dates.firstIndex(of: shown)
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline, spacing: 14) {
                Text(measure.label).font(AppTypography.interface.weight(.semibold))
                if scrubbed != nil {
                    Text(CheckInWords().shortDay(shown, today: board.today)).font(AppTypography.meta).foregroundStyle(AppTheme.secondaryText).transition(.opacity)
                }
                Spacer(minLength: 8)
                ForEach(Array(board.people.enumerated()), id: \.element.id) { index, person in
                    let value = board.value(measure, person, on: shown)
                    HStack(spacing: 5) {
                        PersonMark(index: index)
                        Text(value.map { $0.formatted() } ?? "–").monospacedDigit().contentTransition(.numericText(value: Double(value ?? 0)))
                            .foregroundStyle(value == nil ? AnyShapeStyle(AppTheme.faint) : AnyShapeStyle(.primary))
                    }
                }
                .font(AppTypography.interface.weight(.medium))
            }
            .accessibilityHidden(true)
            Chart {
                // Where the last seven days begin.
                if dates.count > 7 {
                    RuleMark(x: .value("Week", Double(dates.count - 7) - 0.5))
                        .foregroundStyle(AppTheme.separator).lineStyle(StrokeStyle(lineWidth: 1, dash: [2, 3])).accessibilityHidden(true)
                }
                if scrubbed != nil, let shownIndex {
                    RuleMark(x: .value("Day", Double(shownIndex))).foregroundStyle(AppTheme.secondaryText.opacity(0.45)).lineStyle(StrokeStyle(lineWidth: 1))
                        .accessibilityHidden(true)
                }
                ForEach(points) { point in
                    LineMark(x: .value("Day", Double(point.day)), y: .value(measure.label, point.value), series: .value("Person", point.name))
                        .lineStyle(StrokeStyle(lineWidth: point.person == 0 ? 2 : 1.5, lineCap: .round, lineJoin: .round))
                        .foregroundStyle(point.person == 0 ? AnyShapeStyle(AppTheme.accentText) : AnyShapeStyle(AppTheme.secondaryText.opacity(0.6)))
                        .accessibilityHidden(true)
                }
                ForEach(points) { point in
                    PointMark(x: .value("Day", Double(point.day)), y: .value(measure.label, point.value))
                        .symbol { PersonMark(index: point.person, size: point.day == shownIndex && scrubbed != nil ? 10 : 6) }
                        .accessibilityLabel(point.name + ", " + CheckInWords().day(dates[point.day], today: board.today))
                        .accessibilityValue(point.value.formatted())
                }
            }
            .chartXScale(domain: -0.5...Double(max(dates.count - 1, 1)) + 0.5)
            .chartYScale(domain: 0.4...Double(measure.scale) + 0.6)
            .chartXAxis(.hidden)
            .chartYAxis {
                AxisMarks(position: .trailing, values: [1, measure.scale]) { _ in
                    AxisGridLine(stroke: StrokeStyle(lineWidth: 1)).foregroundStyle(AppTheme.separator.opacity(0.7))
                    AxisValueLabel().font(.caption2).foregroundStyle(AppTheme.faint)
                }
            }
            .chartLegend(.hidden)
            .chartXSelection(value: $selection)
            .frame(height: 96)
            .onChange(of: selection) { _, value in
                scrubbed = value.flatMap { dates.isEmpty ? nil : dates[min(max(Int($0.rounded()), 0), dates.count - 1)] }
            }
            .accessibilityLabel(measure.label)
            .accessibilityHint(measure.question)
            .accessibilityIdentifier("checkInChart-" + measure.id)
        }
    }
}

/// The board on the home's shelf: the latest day's answers as levels, each measure a pair of bars. The first person's
/// bars are filled, the second's are outlined.
struct CheckInTile: View {
    let board: CheckInBoard

    private var day: String { board.latestDay ?? board.today }

    var body: some View {
        let people = Array(board.people.prefix(3)), words = CheckInWords()
        Tile(label: board.title, skin: .plain) {
            Spacer(minLength: 6)
            HStack(alignment: .bottom, spacing: 0) {
                ForEach(Array(board.measures.prefix(5).enumerated()), id: \.element.id) { index, measure in
                    if index > 0 { Spacer(minLength: 4) }
                    VStack(spacing: 5) {
                        HStack(alignment: .bottom, spacing: 3) {
                            ForEach(Array(people.enumerated()), id: \.element.id) { person, who in
                                Level(share: board.value(measure, who, on: day).map { Double($0) / Double(measure.scale) }, person: person)
                            }
                        }
                        Text(measure.label.prefix(1).uppercased()).font(.system(size: 10, weight: .semibold)).foregroundStyle(AppTheme.secondaryText)
                    }
                }
            }
            .frame(maxWidth: .infinity)
            Text(words.shortDay(day, today: board.today)).font(AppTypography.label.weight(.regular)).opacity(0.62).lineLimit(1).padding(.top, 8)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(board.title)
        .accessibilityValue(spoken)
    }

    private var spoken: String {
        let lines = board.people.compactMap { person -> String? in
            let answers = board.measures.compactMap { measure in board.value(measure, person, on: day).map { measure.label + " " + $0.formatted() } }
            return answers.isEmpty ? nil : person.name + ": " + answers.joined(separator: ", ")
        }
        return ([CheckInWords().day(day, today: board.today)] + lines).joined(separator: ". ")
    }

    /// One answer as a level in its own track; no answer leaves the track empty.
    private struct Level: View {
        let share: Double?
        let person: Int
        private static let height: CGFloat = TileMetrics.side * 0.34

        var body: some View {
            let width: CGFloat = TileMetrics.side > 140 ? 9 : 8
            ZStack(alignment: .bottom) {
                Capsule().fill(AppTheme.surface)
                if let share {
                    let level = Capsule().frame(height: max(width, Self.height * min(1, max(0, share))))
                    if person == 0 { level.foregroundStyle(AppTheme.accentText) }
                    else { level.foregroundStyle(AppTheme.tile).overlay { Capsule().strokeBorder(person == 1 ? AppTheme.accentText : AppTheme.faint, lineWidth: 1.5) } }
                }
            }
            .frame(width: width, height: Self.height)
        }
    }
}
