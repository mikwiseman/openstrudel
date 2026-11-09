import SwiftUI

/// How the connected Homes were used, day by day or week by week: one number, its bars, and where it went.
/// Read-only. Requests are executed turns; tokens and cost are what the engines reported, at API prices.
struct StatisticsScreen: View {
    @EnvironmentObject private var library: DeviceLibrary
    @Environment(\.dynamicTypeSize) private var typeSize
    /// 64 on the Mac; on iOS it grows with the reader's text size and shrinks to keep one line.
    @ScaledMetric(relativeTo: .largeTitle) private var heroSize: CGFloat = 64
    @StateObject private var model = StatisticsModel()
    @AppStorage("openstrudel.statistics.period") private var period = UsagePeriod.day
    /// "all", or one connection's id.
    @AppStorage("openstrudel.statistics.home") private var scope = "all"
    /// The bar that was chosen, and the one under the pointer; neither means the current day or week.
    @State private var chosen: String?
    @State private var previewed: String?
    @State private var expanded: Set<String> = []

    private var clients: [HomeClient] { library.visibleClients }
    private var shownClients: [HomeClient] { scope == "all" ? clients : clients.filter { $0.id == scope } }
    private var homes: [(id: String, name: String, statistics: HomeStatistics)] {
        shownClients.compactMap { client in model.statistics(client.id).map { (client.id, client.displayName, $0) } }
    }
    /// Periods before the first request on any shown Home are left out rather than drawn as empty history.
    private var slices: [UsageSlice] {
        let all = StatisticsSummary.slices(homes, period: period)
        guard let first = homes.compactMap({ $0.statistics.firstDay }).min() else { return Array(all.suffix(1)) }
        let start = period == .day ? first : Self.monday(first)
        let kept = all.filter { $0.start >= start }
        return kept.isEmpty ? Array(all.suffix(1)) : kept
    }
    private var refreshKey: String { clients.map { $0.id + ":" + ($0.health?.homeId ?? "") }.joined(separator: ",") }

    var body: some View {
        Group {
            if homes.isEmpty { state } else { report }
        }
        .navigationTitle(L("Статистика"))
        #if os(iOS)
        .navigationBarTitleDisplayMode(.large)
        #endif
        .toolbar {
            ToolbarItem(placement: .principal) {
                Picker(L("Период"), selection: $period) { ForEach(UsagePeriod.allCases) { Text($0.title).tag($0) } }
                    .pickerStyle(.segmented).fixedSize()
                    .accessibilityIdentifier("statisticsPeriod")
            }
            ToolbarItem(placement: .primaryAction) {
                Button { Task { await refresh() } } label: { Image(systemName: "arrow.clockwise") }
                    .disabled(model.refreshing).accessibilityLabel(L("Обновить")).accessibilityIdentifier("refreshStatistics")
            }
        }
        .onChange(of: period) { _, _ in chosen = nil; previewed = nil }
        .onChange(of: scope) { _, _ in chosen = nil; previewed = nil }
        .task(id: refreshKey) { await refresh() }
        .accessibilityIdentifier("statisticsRoot")
    }

    private func refresh() async {
        if scope != "all", !clients.contains(where: { $0.id == scope }) { scope = "all" }
        // An offline Home keeps its last statistics, marked as such, instead of dropping out of the totals.
        await model.load(clients.map { client in (client.id, {
            guard client.health != nil else { throw URLError(.notConnectedToInternet) }
            return try await client.readStatistics()
        }) })
    }

    // MARK: Report

    private var report: some View {
        let all = slices
        let slice = all.first { $0.id == (previewed ?? chosen) } ?? all.last, current = all.first { $0.id == chosen } ?? all.last
        return ScrollView {
            if let slice, let current {
                VStack(alignment: .leading, spacing: 0) {
                    if clients.count > 1 { scopePicker }
                    hero(slice, in: all)
                    UsageBars(slices: all, period: period, highlighted: slice.id, chosen: $chosen, previewed: $previewed)
                        .padding(.top, 32)
                    if scope == "all" && current.homes.count > 1 { homeSplit(current).padding(.top, 48) }
                    rows(L("Где работали"), current.chats, key: "chats")
                    rows(L("Расписания"), current.schedules, key: "schedules", schedule: true)
                    if current.models.contains(where: { $0.id != "/" }) { rows(L("Модели"), current.models, key: "models", model: true) }
                    origin(current).padding(.top, 48)
                    notes(current).padding(.top, 24)
                }
                .frame(maxWidth: Layout.column + 80, alignment: .leading)
                .padding(.horizontal, Layout.edge)
                .padding(.top, Layout.belowToolbar)
                .padding(.bottom, 48)
                .frame(maxWidth: .infinity)
                .animation(.smooth(duration: 0.25), value: current.id)
            }
        }
        .scrollIndicators(.hidden)
        #if os(macOS)
        .scrollEdgeEffectStyle(.hard, for: .top)
        #else
        .refreshable { await refresh() }
        #endif
        .accessibilityIdentifier("statisticsReport")
    }

    /// A menu whose words start on the column's edge, like every other line of the report.
    private var scopePicker: some View {
        Menu {
            Picker(L("Устройства"), selection: $scope) {
                Text(L("Все устройства")).tag("all")
                ForEach(clients) { Text($0.displayName).tag($0.id) }
            }
            .pickerStyle(.inline)
        } label: {
            HStack(alignment: .firstTextBaseline, spacing: 4) {
                Text(scope == "all" ? L("Все устройства") : clients.first { $0.id == scope }?.displayName ?? L("Все устройства"))
                    .multilineTextAlignment(.leading)
                Image(systemName: "chevron.up.chevron.down").font(AppTypography.meta.weight(.semibold)).accessibilityHidden(true)
            }
            .font(AppTypography.interface.weight(.medium)).foregroundStyle(AppTheme.accentText)
            .frame(minHeight: controlTarget).contentShape(Rectangle())
        }
        .menuStyle(.button).buttonStyle(.plain).menuIndicator(.hidden).fixedSize(horizontal: false, vertical: true)
        .padding(.bottom, 8)
        .accessibilityIdentifier("statisticsScope")
    }

    private func hero(_ slice: UsageSlice, in all: [UsageSlice]) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(periodTitle(slice, in: all).uppercased())
                .font(AppTypography.meta.weight(.semibold)).foregroundStyle(AppTheme.secondaryText)
                .accessibilityAddTraits(.isHeader)
            Text(slice.requests.formatted(.number.locale(L10n.locale)))
                .font(.system(size: heroSize, weight: .semibold))
                .lineLimit(1).minimumScaleFactor(0.4)
                .contentTransition(.numericText(value: Double(slice.requests)))
                .accessibilityLabel(L("Запросы: \(slice.requests.formatted(.number.locale(L10n.locale)))"))
                .accessibilityIdentifier("statisticsRequests")
            if let comparison = comparison(slice, in: all) {
                Text(comparison).font(AppTypography.interface).foregroundStyle(AppTheme.secondaryText)
            }
            if let spend = spend(slice) {
                Text(spend).font(AppTypography.interface).foregroundStyle(.primary)
                    .accessibilityIdentifier("statisticsSpend")
            }
        }
        .animation(.smooth(duration: 0.25), value: slice.id)
    }

    /// The share of each Home; a row narrows the report to that Home.
    private func homeSplit(_ slice: UsageSlice) -> some View {
        let top = max(slice.homes.map(\.requests).max() ?? 1, 1)
        return VStack(alignment: .leading, spacing: 16) {
            ForEach(slice.homes) { home in
                Button { scope = home.id } label: {
                    VStack(alignment: .leading, spacing: 6) {
                        figures(home.name, requests: home.requests, cost: home.costUsd).foregroundStyle(.primary)
                        GeometryReader { proxy in
                            Capsule().fill(AppTheme.separator)
                                .overlay(alignment: .leading) {
                                    Capsule().fill(AppTheme.accentText).frame(width: home.requests == 0 ? 0 : max(4, proxy.size.width * CGFloat(home.requests) / CGFloat(top)))
                                }
                        }
                        .frame(height: 4)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityElement(children: .combine)
                .accessibilityHint(L("Показать только это устройство"))
                .accessibilityIdentifier("statisticsHome-" + home.id)
            }
        }
    }

    @ViewBuilder private func rows(_ title: String, _ items: [UsageSlice.Row], key: String, schedule: Bool = false, model: Bool = false) -> some View {
        if !items.isEmpty {
            let open = expanded.contains(key), visible = open ? items : Array(items.prefix(5))
            VStack(alignment: .leading, spacing: 0) {
                Text(title.uppercased())
                    .font(AppTypography.meta.weight(.semibold)).foregroundStyle(AppTheme.secondaryText)
                    .padding(.bottom, 8)
                    .accessibilityAddTraits(.isHeader)
                Hairline()
                ForEach(visible) { item in
                    VStack(alignment: .leading, spacing: 4) {
                        figures(item.title, requests: item.requests, cost: item.costUsd)
                        let detail = rowDetail(item, schedule: schedule, model: model)
                        if !detail.isEmpty { Text(detail).font(AppTypography.meta).foregroundStyle(AppTheme.secondaryText).lineLimit(2) }
                    }
                    .padding(.vertical, 12)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .overlay(alignment: .bottom) { Hairline() }
                    .accessibilityElement(children: .combine)
                    .accessibilityIdentifier("statisticsRow-" + key)
                }
                if items.count > 5 {
                    Button(open ? L("Свернуть") : L("Показать все · \(items.count)")) {
                        if open { expanded.remove(key) } else { expanded.insert(key) }
                    }
                    .buttonStyle(.plain).font(AppTypography.interface.weight(.medium)).foregroundStyle(AppTheme.accentText)
                    .frame(minHeight: controlTarget)
                    .accessibilityIdentifier("statisticsMore-" + key)
                }
            }
            .padding(.top, 48)
        }
    }

    /// A name with its requests and cost: on one line, or the numbers under the name at accessibility sizes.
    @ViewBuilder private func figures(_ title: String, requests: Int, cost: Double?) -> some View {
        let count = requests.formatted(.number.locale(L10n.locale))
        if typeSize.isAccessibilitySize {
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(AppTypography.interface.weight(.medium))
                Text(([count] + (cost.map { [Self.money($0)] } ?? [])).joined(separator: " · ")).font(AppTypography.interface).monospacedDigit()
            }
        } else {
            HStack(alignment: .firstTextBaseline, spacing: 12) {
                Text(title).font(AppTypography.interface.weight(.medium)).lineLimit(2)
                Spacer(minLength: 12)
                if let cost { Text(Self.money(cost)).font(AppTypography.meta).foregroundStyle(AppTheme.secondaryText).monospacedDigit() }
                Text(count).font(AppTypography.interface).monospacedDigit()
            }
        }
    }

    private func rowDetail(_ item: UsageSlice.Row, schedule: Bool, model: Bool) -> String {
        var parts = item.detail.isEmpty ? [] : [item.detail]
        if schedule && item.quiet > 0 { parts.append(L("без новостей \(item.quiet.formatted(.number.locale(L10n.locale)))")) }
        if item.failed > 0 { parts.append(L("сбои \(item.failed.formatted(.number.locale(L10n.locale)))")) }
        if model && item.tokens > 0 { parts.append(L("токены \(Self.compact(item.tokens))")) }
        return parts.joined(separator: " · ")
    }

    /// Where the requests came from and how they ended, in words beside each number.
    private func origin(_ slice: UsageSlice) -> some View {
        let n = { (value: Int) in value.formatted(.number.locale(L10n.locale)) }
        let sources = [(L("Приложение"), slice.sources.app), ("Telegram", slice.sources.telegram), (L("Расписания"), slice.sources.schedule), (L("События"), slice.sources.events)]
            .filter { $0.1 > 0 }.map { $0.0 + " " + n($0.1) }
        let outcomes = [(L("Ответы"), slice.outcomes.answered), (L("Без новостей"), slice.outcomes.quiet), (L("Сбои"), slice.outcomes.failed)]
            .filter { $0.1 > 0 }.map { $0.0 + " " + n($0.1) }
        return VStack(alignment: .leading, spacing: 6) {
            if !sources.isEmpty { Text(sources.joined(separator: " · ")) }
            if !outcomes.isEmpty { Text(outcomes.joined(separator: " · ")) }
        }
        .font(AppTypography.meta).foregroundStyle(AppTheme.secondaryText)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("statisticsOrigin")
    }

    private func notes(_ slice: UsageSlice) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            let since = homes.compactMap({ $0.statistics.usageSince }).min()
            if let since, since > slice.start { Text(L("Токены и стоимость считаются с \(Self.dayTitle(since)).")) }
            else if since == nil { Text(L("Токены и стоимость начнут считаться с первых ответов после обновления устройства.")) }
            if slice.unpriced > 0 { Text(L("У части моделей нет опубликованной цены, их стоимость не учтена.")) }
            ForEach(shownClients) { client in
                if let note = homeNote(client) { Text(note).foregroundStyle(AppTheme.warning) }
            }
            if let checked = homes.compactMap({ HomeActivity.date($0.statistics.checkedAt) }).min() {
                Text(L("Обновлено \(checked.formatted(.dateTime.hour().minute().locale(L10n.locale)))"))
            }
        }
        .font(AppTypography.meta).foregroundStyle(AppTheme.secondaryText)
        .fixedSize(horizontal: false, vertical: true)
    }

    private func homeNote(_ client: HomeClient) -> String? {
        switch model.states[client.id] {
        case .unsupported?: L("«\(client.displayName)»: обновите OpenStrudel на устройстве, чтобы увидеть его статистику.")
        case .ownerOnly?: L("«\(client.displayName)»: статистику видит владелец устройства.")
        case .unavailable(let last)?: last == nil ? L("«\(client.displayName)» не на связи.") : L("«\(client.displayName)» не на связи, показаны последние данные.")
        case nil where client.health == nil: L("«\(client.displayName)» не на связи.")
        default: nil
        }
    }

    // MARK: Words and numbers

    private func periodTitle(_ slice: UsageSlice, in all: [UsageSlice]) -> String {
        let last = all.last?.id == slice.id
        switch period {
        case .day: return last ? L("Запросы сегодня") : L("Запросы · \(Self.dayTitle(slice.start))")
        case .week: return last ? L("Запросы за эту неделю") : L("Запросы · \(Self.weekTitle(slice.start))")
        }
    }

    /// The unfinished day or week against the previous one up to the same moment; a finished one against the whole previous one.
    private func comparison(_ slice: UsageSlice, in all: [UsageSlice]) -> String? {
        let n = { (value: Int) in value.formatted(.number.locale(L10n.locale)) }
        if all.last?.id == slice.id, let previous = slice.previousToDate {
            return period == .day ? L("Вчера к этому часу: \(n(previous.requests))") : L("Неделю назад к этому часу: \(n(previous.requests))")
        }
        guard let index = all.firstIndex(where: { $0.id == slice.id }), index > 0 else { return nil }
        let previous = all[index - 1].requests
        return period == .day ? L("Днём раньше: \(n(previous))") : L("Неделей раньше: \(n(previous))")
    }

    private func spend(_ slice: UsageSlice) -> String? {
        var parts: [String] = []
        if let cost = slice.costUsd { parts.append(L("≈ \(Self.money(cost)) по ценам API")) }
        if slice.measured > 0 { parts.append(L("токены \(Self.compact(slice.totalTokens))")) }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    static func money(_ value: Double) -> String {
        if value > 0 && value < 0.01 { return "< " + 0.01.formatted(.currency(code: "USD").locale(L10n.locale)) }
        return value.formatted(.currency(code: "USD").precision(.fractionLength(2)).locale(L10n.locale))
    }
    static func compact(_ value: Int) -> String { value.formatted(.number.notation(.compactName).precision(.significantDigits(1...3)).locale(L10n.locale)) }
    static func date(_ value: String) -> Date? {
        var calendar = Calendar(identifier: .gregorian); calendar.timeZone = .gmt
        let parts = value.split(separator: "-").compactMap { Int($0) }
        guard parts.count == 3 else { return nil }
        return calendar.date(from: DateComponents(year: parts[0], month: parts[1], day: parts[2], hour: 12))
    }
    static func dayTitle(_ value: String) -> String {
        guard let date = date(value) else { return value }
        return date.formatted(Date.FormatStyle(timeZone: .gmt).day().month(.wide).locale(L10n.locale))
    }
    static func weekTitle(_ value: String) -> String {
        guard let start = date(value) else { return value }
        let end = start.addingTimeInterval(6 * 86_400)
        return start.formatted(Date.FormatStyle(timeZone: .gmt).day().month(.abbreviated).locale(L10n.locale)) + " – " + end.formatted(Date.FormatStyle(timeZone: .gmt).day().month(.abbreviated).locale(L10n.locale))
    }
    static func monday(_ value: String) -> String {
        guard let day = date(value) else { return value }
        var calendar = Calendar(identifier: .gregorian); calendar.timeZone = .gmt
        let weekday = (calendar.component(.weekday, from: day) + 5) % 7
        let start = day.addingTimeInterval(-Double(weekday) * 86_400)
        return start.formatted(.iso8601.year().month().day())
    }

    // MARK: States

    /// Nothing to show yet: each state in words, with the one action that helps.
    @ViewBuilder private var state: some View {
        let reachable = shownClients.filter { $0.health != nil }, states = reachable.map { model.states[$0.id] }
        if shownClients.isEmpty {
            message(L("Нет подключённых устройств"), text: L("Подключите Mac или сервер, и здесь появится его статистика."), symbol: "chart.bar", code: "empty")
        } else if reachable.isEmpty {
            message(L("Устройства не на связи"), text: L("Статистика появится, когда устройство подключится."), symbol: "wifi.slash", code: "offline", retry: true)
        } else if states.contains(where: { $0 == nil || $0 == .loading }) {
            ProgressView().controlSize(.large).frame(maxWidth: .infinity, maxHeight: .infinity).accessibilityIdentifier("statisticsState-loading")
        } else if states.allSatisfy({ $0 == .unsupported }) {
            message(L("Статистика появится после обновления"), text: L("Обновите OpenStrudel на устройстве. Чат работает как прежде."), symbol: "arrow.up.circle", code: "unsupported")
        } else if states.allSatisfy({ $0 == .ownerOnly }) {
            message(L("Статистику видит владелец устройства"), text: L("Подключитесь как владелец, чтобы видеть статистику."), symbol: "person.badge.key", code: "ownerOnly")
        } else {
            message(L("Устройства не на связи"), text: L("Статистика появится, когда устройство подключится."), symbol: "wifi.slash", code: "offline", retry: true)
        }
    }

    private func message(_ title: String, text: String, symbol: String, code: String, retry: Bool = false) -> some View {
        OpticalCentre {
            VStack(spacing: 16) {
                Image(systemName: symbol).font(.system(size: 40, weight: .light)).foregroundStyle(AppTheme.secondaryText)
                Text(title).font(AppTypography.display).multilineTextAlignment(.center)
                Text(text).font(AppTypography.interface).foregroundStyle(AppTheme.secondaryText).multilineTextAlignment(.center)
                if retry {
                    Button(L("Повторить")) { Task { await refresh() } }.buttonStyle(.glass).accessibilityIdentifier("retryStatistics")
                }
            }
            .frame(maxWidth: 360).padding(.horizontal, 24)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("statisticsState-" + code)
    }
}

/// One bar per day or week, growing from one baseline. The chosen or hovered one is ink, the rest graphite.
/// Every bar is a button with its date and value, so the chart reads without seeing it.
private struct UsageBars: View {
    let slices: [UsageSlice]
    let period: UsagePeriod
    let highlighted: String
    @Binding var chosen: String?
    @Binding var previewed: String?
    #if os(macOS)
    private let height: CGFloat = 148
    #else
    private let height: CGFloat = 132
    #endif

    var body: some View {
        let top = max(slices.map(\.requests).max() ?? 0, 1)
        VStack(alignment: .leading, spacing: 8) {
            GeometryReader { proxy in
                let slot = proxy.size.width / CGFloat(max(slices.count, 1))
                let width = max(2, min(24, slot - 2))
                HStack(alignment: .bottom, spacing: 0) {
                    ForEach(slices) { slice in
                        Button {
                            chosen = slice.id == slices.last?.id ? nil : slice.id
                        } label: {
                            VStack(spacing: 0) {
                                Spacer(minLength: 0)
                                UnevenRoundedRectangle(topLeadingRadius: slice.requests == 0 ? 0 : min(4, width / 2), topTrailingRadius: slice.requests == 0 ? 0 : min(4, width / 2), style: .continuous)
                                    .fill(fill(slice))
                                    .frame(width: width, height: slice.requests == 0 ? 2 : max(4, (height - 20) * CGFloat(slice.requests) / CGFloat(top)))
                            }
                            .frame(width: slot, height: height)
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        #if os(macOS)
                        .onHover { inside in
                            if inside { previewed = slice.id } else if previewed == slice.id { previewed = nil }
                        }
                        #endif
                        .accessibilityLabel(period == .day ? StatisticsScreen.dayTitle(slice.start) : StatisticsScreen.weekTitle(slice.start))
                        .accessibilityValue(slice.requests.formatted(.number.locale(L10n.locale)))
                        .accessibilityAddTraits(slice.id == highlighted ? .isSelected : [])
                        .accessibilityIdentifier("statisticsBar-" + slice.start)
                    }
                }
                .overlay(alignment: .topTrailing) {
                    // One reference value, so the heights have a scale.
                    // It sits in the band above the tallest bar, which no bar reaches.
                    Text(top.formatted(.number.locale(L10n.locale)))
                        .font(AppTypography.meta).monospacedDigit().foregroundStyle(AppTheme.secondaryText)
                        .frame(height: 18, alignment: .top)
                        .accessibilityHidden(true)
                }
                .overlay(alignment: .top) { Hairline().padding(.top, 20).opacity(0.6).accessibilityHidden(true) }
                .overlay(alignment: .bottom) { Hairline().accessibilityHidden(true) }
            }
            .frame(height: height)
            .animation(.smooth(duration: 0.25), value: highlighted)
            HStack {
                if let first = slices.first { Text(label(first)) }
                Spacer(minLength: 12)
                if let last = slices.last, slices.count > 1 { Text(label(last)) }
            }
            .font(AppTypography.meta).foregroundStyle(AppTheme.secondaryText)
            .accessibilityHidden(true)
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(period == .day ? L("Запросы по дням") : L("Запросы по неделям"))
        .accessibilityIdentifier("statisticsBars")
    }

    private func fill(_ slice: UsageSlice) -> Color {
        if slice.requests == 0 { return AppTheme.separator }
        if slice.id == highlighted { return AppTheme.accentText }
        return AppTheme.secondaryText.opacity(slice.id == previewed ? 0.55 : 0.3)
    }

    private func label(_ slice: UsageSlice) -> String {
        if slice.id == slices.last?.id { return period == .day ? L("Сегодня") : L("Эта неделя") }
        guard let date = StatisticsScreen.date(slice.start) else { return slice.start }
        return date.formatted(Date.FormatStyle(timeZone: .gmt).day().month(.abbreviated).locale(L10n.locale))
    }
}
