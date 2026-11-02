import SwiftUI

/// The owner's business clients, read from the company service connected to the chat's Home: a list, one client,
/// its files, and one action that takes the client to the chat as context. Nothing is written here.
struct ClientsTab: View {
    @EnvironmentObject private var library: DeviceLibrary
    @EnvironmentObject private var client: HomeClient
    #if os(macOS)
    @Environment(\.openSettings) private var openSettings
    #else
    @State private var showConnections = false
    #endif
    @StateObject private var model = ClientsModel()
    @State private var query = ""
    @State private var showArchive = false
    let discuss: (ChatContext) -> Void
    private var term: String { query.trimmingCharacters(in: .whitespacesAndNewlines) }

    var body: some View {
        Group {
            switch model.state {
            case .loading:
                ProgressView().controlSize(.large).frame(maxWidth: .infinity, maxHeight: .infinity)
                    .accessibilityIdentifier("clientsState-loading")
            case .ready(let source, let clients):
                list(clients, source: source)
            case .empty:
                state(L("Клиентов пока нет"), text: L("Как только в базе компании появятся клиенты, они будут здесь."), symbol: "person.2", code: "empty")
            case .offline:
                state(L("«\(client.displayName)» не на связи"), text: L("Клиенты появятся, когда устройство подключится."), symbol: "wifi.slash", code: "offline", retry: true)
            case .refused(let refusal):
                refused(refusal)
            }
        }
        .navigationTitle(L("Клиенты"))
        #if os(iOS)
        .navigationBarTitleDisplayMode(.large)
        #endif
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button { Task { await model.load(from: client, refresh: true) } } label: { Image(systemName: "arrow.clockwise") }
                    .disabled(model.refreshing || model.state == .loading)
                    .accessibilityLabel(L("Обновить"))
                    .accessibilityIdentifier("refreshClients")
            }
        }
        .task(id: client.id) { await model.load(from: client) }
        #if os(iOS)
        .sheet(isPresented: $showConnections) { SettingsView(initialSection: .connections) }
        #endif
    }

    private func list(_ clients: [BusinessClient], source: ClientSource) -> some View {
        let shown = clients.filter { term.isEmpty || $0.name.localizedCaseInsensitiveContains(term) || $0.company?.localizedCaseInsensitiveContains(term) == true || $0.aliases.contains { $0.localizedCaseInsensitiveContains(term) } }
        let active = shown.filter { !$0.archived }, archived = shown.filter(\.archived)
        return List {
            if shown.isEmpty {
                SearchEmptyState(query: query) { query = "" }
            }
            ForEach(active) { client in row(client, source: source) }
            if !archived.isEmpty {
                // Archived clients keep their files; they stay out of the way until asked for.
                Section(isExpanded: Binding(get: { showArchive || !term.isEmpty }, set: { showArchive = $0 })) {
                    ForEach(archived) { client in row(client, source: source) }
                } header: {
                    Text(L("Архив") + " · \(archived.count)")
                }
            }
        }
        #if os(macOS)
        .listStyle(.inset)
        #else
        .listStyle(.plain)
        #endif
        .searchable(text: $query, prompt: L("Найти клиента"))
        .navigationDestination(for: BusinessClient.self) { client in ClientDetail(client: client, source: source, discuss: discuss) }
        .accessibilityIdentifier("clientsState-ready")
    }

    private func row(_ client: BusinessClient, source: ClientSource) -> some View {
        NavigationLink(value: client) {
            VStack(alignment: .leading, spacing: 2) {
                Text(client.name).font(AppTypography.interface.weight(.medium)).lineLimit(1)
                if !client.detail.isEmpty {
                    Text(client.detail).font(AppTypography.interface).foregroundStyle(AppTheme.secondaryText).lineLimit(1)
                }
            }
            .padding(.vertical, 6)
        }
        .accessibilityIdentifier("client-" + client.id)
    }

    /// One state at a time, in words: empty data, no connection, a refusal. Colour never carries it alone.
    private func state(_ title: String, text: String, symbol: String, code: String, retry: Bool = false, connections: Bool = false) -> some View {
        OpticalCentre {
            VStack(spacing: 16) {
                Image(systemName: symbol).font(.system(size: 40, weight: .light)).foregroundStyle(AppTheme.secondaryText)
                Text(title).font(AppTypography.display).multilineTextAlignment(.center)
                Text(text).font(AppTypography.interface).foregroundStyle(AppTheme.secondaryText).multilineTextAlignment(.center)
                if retry {
                    Button(L("Повторить")) { Task { await model.load(from: client, refresh: true) } }
                        .buttonStyle(.glass).accessibilityIdentifier("retryClients")
                } else if connections {
                    Button(L("Открыть подключения")) { openConnections() }
                        .buttonStyle(.glass).accessibilityIdentifier("openConnectionsFromClients")
                }
            }
            .frame(maxWidth: 360)
            .padding(.horizontal, 24)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("clientsState-" + code)
    }

    @ViewBuilder private func refused(_ refusal: ClientsModel.Refusal) -> some View {
        let detail = refusal.detail.map { " · " + $0 } ?? ""
        switch refusal.code {
        case "no_connector":
            state(L("База клиентов не подключена"), text: L("Подключите сервис компании к чату, и клиенты появятся здесь.") + detail, symbol: "link", code: refusal.code, connections: true)
        case "ambiguous":
            // Nobody is chosen for the owner, and nothing here says to remove a connection: the settings show what is connected.
            state(L("Клиентов предлагают несколько подключений"), text: L("Проверьте подключения чата, чтобы понять, какое из них ведёт клиентов.") + detail, symbol: "link", code: refusal.code, connections: true)
        case "service_auth":
            state(L("Подключение к базе клиентов нужно обновить"), text: L("Сервис больше не принимает сохранённый вход. Войдите в него заново в подключениях.") + detail, symbol: "key", code: refusal.code, connections: true)
        case "service_denied":
            state(L("Доступ к клиентам закрыт для этого подключения"), text: L("Сервис отказал этому входу. Другое подключение или устройство его не заменит.") + detail, symbol: "hand.raised", code: refusal.code)
        case "owner_only":
            state(L("Клиентов видит владелец устройства"), text: L("На этом устройстве подключён не владелец, поэтому клиенты недоступны."), symbol: "person.badge.key", code: refusal.code)
        default:
            state(L("Сервис клиентов не ответил"), text: L10n.serviceText(refusal.message) + detail, symbol: "exclamationmark.triangle", code: refusal.code, retry: true)
        }
    }

    private func openConnections() {
        #if os(macOS)
        UserDefaults.standard.set(SettingsView.Section.connections.rawValue, forKey: SettingsView.tabKey)
        openSettings()
        #else
        showConnections = true
        #endif
    }
}

/// One client: who it is, its files as the service grades them, and the way to the chat.
private struct ClientDetail: View {
    @EnvironmentObject private var home: HomeClient
    @Environment(\.dynamicTypeSize) private var textSize
    @StateObject private var files: ClientFilesModel
    let client: BusinessClient
    let source: ClientSource
    let discuss: (ChatContext) -> Void

    init(client: BusinessClient, source: ClientSource, discuss: @escaping (ChatContext) -> Void) {
        self.client = client
        self.source = source
        self.discuss = discuss
        _files = StateObject(wrappedValue: ClientFilesModel(client: client, source: source))
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                Text(client.name).font(AppTypography.display).fixedSize(horizontal: false, vertical: true)
                    .accessibilityAddTraits(.isHeader)
                if !client.detail.isEmpty {
                    Text(client.detail).font(AppTypography.interface).foregroundStyle(AppTheme.secondaryText).padding(.top, 8)
                }
                if !client.aliases.isEmpty {
                    Text(client.aliases.joined(separator: ", ")).font(AppTypography.meta).foregroundStyle(AppTheme.secondaryText).padding(.top, 4)
                }
                if client.archived {
                    Label([L("В архиве"), client.archiveReason].compactMap { $0 }.joined(separator: " · "), systemImage: "archivebox")
                        .font(AppTypography.meta).foregroundStyle(AppTheme.secondaryText).padding(.top, 8)
                }
                Button { discuss(.client(client, source: source)) } label: {
                    Label(L("Обсудить в чате"), systemImage: "bubble.left.and.text.bubble.right")
                        .font(AppTypography.interface.weight(.medium))
                        .padding(.horizontal, 16).frame(minHeight: controlTarget)
                }
                .buttonStyle(.glassProminent)
                .padding(.top, 24)
                .accessibilityIdentifier("discussClient")

                Text(L("Файлы").uppercased() + (files.total > 0 ? " · \(files.total)" : ""))
                    .font(AppTypography.meta.weight(.semibold)).foregroundStyle(AppTheme.secondaryText)
                    .padding(.top, 48).padding(.bottom, 8)
                    .accessibilityAddTraits(.isHeader)
                Hairline()
                filesSection
            }
            .frame(maxWidth: Layout.column, alignment: .leading)
            .padding(.horizontal, Layout.edge)
            .padding(.top, Layout.belowToolbar)
            .padding(.bottom, 48)
            .frame(maxWidth: .infinity)
        }
        .scrollIndicators(.hidden)
        #if os(macOS)
        .scrollEdgeEffectStyle(.hard, for: .top)
        #endif
        .navigationTitle(client.name)
        #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
        #endif
        .task { await files.load(from: home) }
        .accessibilityIdentifier("clientDetail")
    }

    @ViewBuilder private var filesSection: some View {
        switch files.state {
        case .loading:
            ProgressView().controlSize(.small).padding(.vertical, 24)
        case .offline:
            Text(L("Файлы появятся, когда устройство подключится.")).font(AppTypography.interface).foregroundStyle(AppTheme.secondaryText).padding(.vertical, 16)
        case .refused(let refusal):
            Text(L10n.serviceText(refusal.message)).font(AppTypography.interface).foregroundStyle(AppTheme.warning).padding(.vertical, 16)
                .accessibilityIdentifier("clientFilesRefused-" + refusal.code)
        case .ready:
            if files.files.isEmpty {
                Text(L("У клиента пока нет файлов.")).font(AppTypography.interface).foregroundStyle(AppTheme.secondaryText).padding(.vertical, 16)
            }
            ForEach(files.files) { file in
                VStack(alignment: .leading, spacing: 4) {
                    Text(file.name).font(AppTypography.interface.weight(.medium)).lineLimit(2)
                    Text([file.category, file.sizeLabel, file.accessLabel].compactMap { $0 }.joined(separator: " · "))
                        .font(AppTypography.meta).foregroundStyle(AppTheme.secondaryText)
                }
                .padding(.vertical, 12)
                .overlay(alignment: .bottom) { Hairline() }
                .accessibilityElement(children: .combine)
                .accessibilityIdentifier("clientFile-" + file.id)
            }
            if files.nextOffset != nil {
                Button {
                    Task { await files.loadMore(from: home) }
                } label: {
                    HStack(spacing: 8) {
                        if files.loadingMore { ProgressView().controlSize(.mini) }
                        Text(L("Показать ещё"))
                    }
                    .font(AppTypography.interface.weight(.medium)).foregroundStyle(AppTheme.accentText)
                    .frame(minHeight: controlTarget)
                }
                .buttonStyle(.plain).disabled(files.loadingMore)
                .accessibilityIdentifier("moreClientFiles")
            }
        }
    }
}
