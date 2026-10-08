import SwiftUI
import UniformTypeIdentifiers

struct ExtensionSetupView: View {
    @EnvironmentObject private var client: HomeClient
    let scope: ExtensionContext
    @Binding var isPresented: Bool
    @State private var address = ""
    @State private var token = ""
    @State private var name = ""
    @State private var importing = false
    @State private var files: [ExtensionFile] = []
    @State private var preview: ExtensionPreview?
    @State private var busy = false
    @State private var error: String?

    var body: some View {
        Form {
            Section {
                Text(scope.sharedNotice ?? (scope.isGroup ? "Будет доступно участникам «\(scope.title)»." : "Будет доступно в личном чате этого сотрудника."))
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
            } else {
                Section {
                    TextField("Адрес MCP", text: $address, prompt: Text("https://example.com/mcp"))
                        .textContentType(.URL).autocorrectionDisabled()
                        .accessibilityLabel("Адрес MCP").accessibilityIdentifier("mcpAddress")
                        #if os(iOS)
                        .textInputAutocapitalization(.never).keyboardType(.URL)
                        #endif
                    SecureField("Ключ, если сервис его требует", text: $token)
                    DisclosureGroup("Название подключения") {
                        TextField("Название латиницей", text: $name, prompt: Text(suggestedName)).autocorrectionDisabled()
                    }
                    Button("Добавить сервис") { perform {
                        try await client.addMCP(name: name.isEmpty ? suggestedName : name, url: address.trimmingCharacters(in: .whitespacesAndNewlines), token: token, for: scope.id)
                        token = ""; isPresented = false
                    } }.buttonStyle(.borderedProminent).disabled(busy || address.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                } header: { Text("Сервис по адресу") } footer: {
                    Text("Вставьте адрес MCP из настроек нужного сервиса. Если потребуется вход, продолжите его в браузере.")
                }
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
        .navigationTitle("Добавить возможность")
        #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
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
        busy = true; error = nil
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
