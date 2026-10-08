import SwiftUI
import UniformTypeIdentifiers

/// Connection rows contain controls, not selectable records. A macOS Form
/// exposes each button to keyboard navigation and assistive technologies.
struct ServiceList<Content: View>: View {
    @ViewBuilder let content: () -> Content
    var body: some View {
        #if os(macOS)
        Form(content: content).formStyle(.grouped)
        #else
        List(content: content)
        #endif
    }
}

/// A navigation destination owns its state instead of retaining the presenting view.
struct ConnectionCatalogView: View {
    @EnvironmentObject private var client: HomeClient
    @Environment(\.openURL) private var openURL
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.dynamicTypeSize) private var textSize
    let scope: ExtensionContext
    @Binding var isPresented: Bool
    @State private var connections: [ServiceConnection] = []
    @State private var query = ""
    @State private var loading = true
    @State private var connecting: String?
    @State private var waiting: ServiceConnection?
    @State private var authorizationURL: URL?
    @State private var notice: String?
    @State private var error: String?

    private var results: [ServiceConnection] {
        connections.filter { $0.isAvailableToAdd && (query.isEmpty || $0.name.localizedCaseInsensitiveContains(query)) }
            .sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }
    }
    var body: some View {
        ServiceList {
            Section {
                Text(scope.isGroup ? "Для Telegram-группы «\(scope.title)»" : "Для разговора в приложении")
                    .foregroundStyle(AppTheme.secondaryText)
                if let shared = scope.sharedNotice { Text(shared).font(.caption).foregroundStyle(AppTheme.secondaryText) }
                if loading { ProgressView("Загружаем сервисы…") }
                if let error {
                    Text(UserFacingError.text(error)).foregroundStyle(AppTheme.warning)
                    Button("Повторить") { Task { await refresh() } }.disabled(loading)
                }
                if let waiting {
                    Text("Завершите вход в \(waiting.name) в браузере.")
                    if let authorizationURL { Link("Открыть ещё раз", destination: authorizationURL) }
                    Button("Проверить подключение") { Task { await refresh() } }.disabled(loading)
                }
            }
            if !results.isEmpty || !query.isEmpty {
                Section {
                    if connections.filter(\.isAvailableToAdd).count > 6 {
                        TextField("Найти сервис", text: $query).textFieldStyle(.roundedBorder)
                    }
                    ForEach(results) { connection in
                        // Dynamic Type keeps both the service name and action visible.
                        let layout = textSize.isAccessibilitySize ? AnyLayout(VStackLayout(alignment: .leading, spacing: 10)) : AnyLayout(HStackLayout(spacing: 12))
                        layout {
                            Text(connection.name).frame(maxWidth: .infinity, alignment: .leading)
                            Button(connecting == connection.id ? "Проверяем…" : waiting?.id == connection.id ? "Ожидаем входа" : connection.actionTitle) {
                                Task { await connect(connection) }
                            }.buttonStyle(.bordered).disabled(connecting != nil || waiting != nil)
                                .accessibilityLabel("\(connection.actionTitle) \(connection.name)")
                                .accessibilityIdentifier("connect-service-" + connection.id)
                        }.padding(.vertical, 6)
                            .accessibilityElement(children: .contain)
                    }
                    if results.isEmpty { Text("Ничего не найдено").foregroundStyle(AppTheme.secondaryText) }
                } header: { Text("Из аккаунта OpenAI") } footer: {
                    Text("«Добавить» разрешает сотруднику использовать сервис в этом чате.")
                }
            }
            Section("Другие способы") {
                NavigationLink { ExtensionSetupView(scope: scope, source: .mcp, isPresented: $isPresented) } label: {
                    Label("Сервис по адресу MCP", systemImage: "link")
                }.accessibilityIdentifier("addMCPService")
                NavigationLink { ExtensionSetupView(scope: scope, source: .package, isPresented: $isPresented) } label: {
                    Label("Навык или плагин из файла", systemImage: "folder.badge.plus")
                }.accessibilityIdentifier("addExtensionFile")
            }
            if let notice { Section { Text(notice).font(.caption).foregroundStyle(AppTheme.secondaryText) } }
        }
        .scrollContentBackground(.hidden).background(HomeBackground()).navigationTitle("Добавить")
        #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
        #endif
        .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Готово") { isPresented = false } } }
        .task { await refresh() }
        .task(id: waiting?.id) {
            guard waiting != nil else { return }
            for _ in 0..<30 {
                do { try await Task.sleep(for: .seconds(2)) } catch { return }
                if !loading { await refresh() }
                if waiting == nil { return }
            }
        }
        .onChange(of: scenePhase) { old, phase in
            if old != .active && phase == .active && !loading { Task { await refresh() } }
        }
    }
    private func refresh() async {
        loading = true; error = nil
        defer { loading = false }
        do {
            let result = try await client.serviceConnections(for: scope.id, refresh: true)
            connections = result.connections; notice = result.notice
            if let waiting, connections.contains(where: { $0.id == waiting.id && $0.connected }) {
                self.waiting = nil; authorizationURL = nil; isPresented = false
            }
        } catch is CancellationError { }
        catch { self.error = error.localizedDescription }
    }
    private func connect(_ connection: ServiceConnection) async {
        connecting = connection.id; error = nil
        defer { connecting = nil }
        do {
            if let url = try await client.connectService(connection.id, for: scope.id) {
                waiting = connection; authorizationURL = url
                openURL(url) { @Sendable accepted in
                    Task { @MainActor in
                        if !accepted { error = "Не удалось открыть браузер. Используйте ссылку «Открыть ещё раз»." }
                    }
                }
            } else {
                await refresh()
                if connections.contains(where: { $0.id == connection.id && $0.connected }) { isPresented = false }
                else { error = "Сервис ещё не подтвердил подключение. Попробуйте ещё раз." }
            }
        } catch is CancellationError { }
        catch { self.error = error.localizedDescription }
    }
}

struct ExtensionSetupView: View {
    enum Source { case mcp, package }
    enum Field: Hashable { case address, token, name }
    @EnvironmentObject private var client: HomeClient
    let scope: ExtensionContext
    var source: Source = .mcp
    @Binding var isPresented: Bool
    @State private var address = ""
    @State private var token = ""
    @State private var name = ""
    @State private var importing = false
    @State private var files: [ExtensionFile] = []
    @State private var preview: ExtensionPreview?
    @State private var busy = false
    @State private var error: String?
    @FocusState private var focusedField: Field?

    var body: some View {
        Form {
            Section {
                Text(scope.sharedNotice ?? (scope.isGroup ? "Для Telegram-группы «\(scope.title)»." : "Для разговора в приложении."))
                    .font(.callout).foregroundStyle(AppTheme.secondaryText)
            }
            if let preview {
                Section(preview.kind == "skill" ? "Навык" : "Плагин") {
                    Text(preview.name).font(.headline)
                    Text(preview.description).fixedSize(horizontal: false, vertical: true)
                    Text("Файлов: \(preview.files) · \(ByteCountFormatter.string(fromByteCount: Int64(preview.bytes), countStyle: .file))")
                        .font(.caption).foregroundStyle(AppTheme.secondaryText)
                    ForEach(preview.services, id: \.self) { Label($0, systemImage: "link") }
                    if preview.hasHooks { Text("В пакете есть автоматические действия (hooks). Проверьте, что доверяете его автору.").font(.callout) }
                    Button("Установить") { perform {
                        try await client.installExtension(files, digest: preview.digest, for: scope.id)
                        isPresented = false
                    } }.buttonStyle(.borderedProminent).disabled(busy)
                    Button("Выбрать другой пакет") { self.preview = nil; files = []; importing = true }.disabled(busy)
                }
            } else if source == .mcp {
                Section {
                    TextField("Адрес MCP", text: $address, prompt: Text("https://example.com/mcp"))
                        .focused($focusedField, equals: .address)
                        .textContentType(.URL).autocorrectionDisabled()
                        .accessibilityLabel("Адрес MCP").accessibilityIdentifier("mcpAddress")
                        #if os(iOS)
                        .textInputAutocapitalization(.never).keyboardType(.URL)
                        #endif
                    SecureField("Ключ, если сервис его требует", text: $token)
                        .focused($focusedField, equals: .token)
                    DisclosureGroup("Название подключения") {
                        TextField("Название латиницей", text: $name, prompt: Text(suggestedName)).autocorrectionDisabled()
                            .focused($focusedField, equals: .name)
                    }
                    Button("Добавить сервис") { perform {
                        try await client.addMCP(name: name.isEmpty ? suggestedName : name, url: address.trimmingCharacters(in: .whitespacesAndNewlines), token: token, for: scope.id)
                        token = ""; isPresented = false
                    } }.buttonStyle(.borderedProminent).disabled(busy || address.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                } header: { Text("Сервис по адресу") } footer: {
                    Text("Вставьте адрес MCP из настроек нужного сервиса. Если потребуется вход, продолжите его в браузере.")
                }
            } else {
                Section {
                    Button { importing = true } label: { Label("Выбрать навык или плагин…", systemImage: "folder.badge.plus") }.disabled(busy)
                } header: { Text("Из файла") } footer: {
                    Text("Выберите SKILL.md или папку пакета Codex. Сначала покажем, что будет добавлено.")
                }
            }
            if busy { HStack(spacing: 10) { ProgressView().controlSize(.small); Text(preview == nil ? "Проверяем…" : "Устанавливаем…") }.accessibilityElement(children: .combine) }
            if let error { Section { Text(UserFacingError.text(error)).foregroundStyle(AppTheme.warning).fixedSize(horizontal: false, vertical: true) } }
        }
        .formStyle(.grouped).scrollContentBackground(.hidden).background(HomeBackground())
        .navigationTitle(source == .mcp ? "Подключить сервис" : "Установить из файла")
        #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
        .scrollDismissesKeyboard(.interactively)
        .toolbar {
            ToolbarItemGroup(placement: .keyboard) {
                Spacer()
                Button { focusedField = nil } label: { Image(systemName: "keyboard.chevron.compact.down") }
                    .accessibilityLabel("Скрыть клавиатуру")
            }
        }
        #endif
        .fileImporter(isPresented: $importing, allowedContentTypes: [.folder, UTType(filenameExtension: "md") ?? .plainText]) { result in
            switch result {
            case .success(let url):
                perform {
                    let granted = url.startAccessingSecurityScopedResource()
                    defer { if granted { url.stopAccessingSecurityScopedResource() } }
                    let bundle = try await Task.detached { try ExtensionBundleReader.read(url) }.value
                    let checked = try await client.previewExtension(bundle, for: scope.id)
                    files = bundle; preview = checked
                }
            case .failure(let failure): error = failure.localizedDescription
            }
        }
    }
    private var suggestedName: String {
        let host = URL(string: address)?.host ?? "service"
        let cleaned = host.lowercased().map { $0.isASCII && ($0.isLetter || $0.isNumber) ? String($0) : "-" }.joined()
        return String(cleaned.prefix(64))
    }
    private func perform(_ action: @escaping @MainActor () async throws -> Void) {
        focusedField = nil; busy = true; error = nil
        Task { defer { busy = false }; do { try await action() } catch is CancellationError { } catch { self.error = error.localizedDescription } }
    }
}

enum ExtensionBundleReader {
    nonisolated static func read(_ url: URL) throws -> [ExtensionFile] {
        let manager = FileManager.default
        var files: [ExtensionFile] = [], bytes = 0, entries = 0
        func visit(_ item: URL, path: String) throws {
            entries += 1
            guard entries <= 1000, path.count <= 240 else { throw HomeClientError.server("Слишком много файлов или вложенных папок.") }
            let values = try item.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey, .isRegularFileKey, .fileSizeKey])
            guard values.isSymbolicLink != true else { throw HomeClientError.server("Выберите пакет с обычными файлами, без символических ссылок.") }
            if values.isDirectory == true {
                for child in try manager.contentsOfDirectory(at: item, includingPropertiesForKeys: nil) {
                    if [".git", ".DS_Store"].contains(child.lastPathComponent) { continue }
                    try visit(child, path: path.isEmpty ? child.lastPathComponent : path + "/" + child.lastPathComponent)
                }
            } else {
                bytes += values.fileSize ?? 0
                guard values.isRegularFile == true, bytes <= 10 * 1024 * 1024, files.count < 300 else {
                    throw HomeClientError.server("Пакет должен содержать не более 300 файлов и занимать до 10 МБ.")
                }
                let data = try Data(contentsOf: item)
                let mode = (try manager.attributesOfItem(atPath: item.path)[.posixPermissions] as? NSNumber)?.intValue ?? 0
                files.append(ExtensionFile(path: path, contentBase64: data.base64EncodedString(), executable: mode & 0o100 != 0))
            }
        }
        let directory = try url.resourceValues(forKeys: [.isDirectoryKey]).isDirectory == true
        try visit(url, path: directory ? "" : url.lastPathComponent)
        return files
    }
}
