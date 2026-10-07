import SwiftUI
import UniformTypeIdentifiers
#if os(macOS)
import AppKit
#endif

extension UTType {
    static let openStrudelTeam = UTType(exportedAs: "is.openstrudel.team", conformingTo: .data)
}

struct AgentTeamDocument: FileDocument {
    static var readableContentTypes: [UTType] { [.openStrudelTeam] }
    var data: Data
    var filename: String? = nil
    init(data: Data, filename: String? = nil) { self.data = data; self.filename = filename }
    init(configuration: ReadConfiguration) throws {
        guard let data = configuration.file.regularFileContents, data.count <= AgentTransferFile.byteLimit else { throw AgentTransferFile.Failure.invalidFile }
        self.data = data
    }
    func fileWrapper(configuration: WriteConfiguration) throws -> FileWrapper {
        let file = FileWrapper(regularFileWithContents: data)
        if let filename, !filename.isEmpty { file.preferredFilename = filename }
        file.fileAttributes[FileAttributeKey.posixPermissions.rawValue] = 0o600
        return file
    }
}

struct AgentTransferSettings: View {
    var localBackupOnly = false
    @EnvironmentObject private var client: HomeClient
    @State private var document: AgentTeamDocument?
    @State private var showingExport = false
    @State private var showingImport = false
    @State private var pending: PendingAgentImport?
    @State private var busy: String?
    @State private var received: Int64 = 0
    @State private var total: Int64?
    @State private var operation: Task<Void, Never>?
    @State private var error: String?
    @State private var notice: String?
    @State private var savedURL: URL?
    @State private var deviceID = ""
    @State private var protected = false
    @State private var password = ""
    @State private var importData: Data?
    @State private var importPassword = ""
    @State private var askingPassword = false
    @State private var unlockedImport: PendingAgentImport?
    private var targetName: String { deviceID == client.health?.nodeId ? client.displayName : client.devices.first(where: { $0.id == deviceID })?.name ?? client.displayName }
    private var targetID: String? { deviceID.isEmpty ? nil : deviceID }
    private var working: Bool { busy != nil || showingExport || pending != nil }

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            if client.devices.count > 1 && !localBackupOnly {
                Picker("Сотрудники устройства", selection: $deviceID) {
                    ForEach(client.devices) { Text($0.name).tag($0.id) }
                }.disabled(working)
            }
            Text("Сотрудники «\(targetName)», их переписка, файлы и расписания — в одном файле.")
                .font(.callout).fixedSize(horizontal: false, vertical: true)
            Text("Вход в OpenAI и сервисы в копию не входит.")
                .font(.caption).foregroundStyle(AppTheme.secondaryText)
            if client.canTransferAgents {
                if client.health?.agentArchiveEncryption == true {
                    Toggle("Защитить копию паролем", isOn: $protected).disabled(working)
                    if protected {
                        SecureField("Пароль · не менее 12 символов", text: $password).textFieldStyle(.roundedBorder).disabled(working)
                        Text("Сохраните пароль: без него копию не открыть.").font(.caption).foregroundStyle(AppTheme.secondaryText)
                    } else { Text("Файл без пароля. Храните его в безопасном месте.").font(.caption).foregroundStyle(AppTheme.secondaryText) }
                } else { Text("Файл без пароля. Для защищённых копий обновите OpenStrudel на этом устройстве.").font(.caption).foregroundStyle(AppTheme.secondaryText) }
                HStack(spacing: 12) {
                    Button("Сохранить копию…", action: export).buttonStyle(.borderedProminent)
                        .disabled(working || protected && password.count < 12).accessibilityIdentifier("exportAgents")
                    if !localBackupOnly {
                        Button("Восстановить из копии…") { error = nil; notice = nil; showingImport = true }
                            .disabled(working).accessibilityIdentifier("importAgents")
                    }
                }
            } else {
                Text(client.health == nil || client.homeUnreachable ? "Для копии нужно подключение к устройству с сотрудниками." : "Копии доступны владельцу устройства. Проверьте доступ и версию OpenStrudel.")
                    .font(.callout).foregroundStyle(AppTheme.secondaryText)
            }
            if let busy {
                VStack(alignment: .leading, spacing: 10) {
                    if let total, total > 0 {
                        HStack {
                            Text("Получаем копию с «\(targetName)»")
                            Spacer()
                            Text("\(Int(min(1, Double(received) / Double(total)) * 100))%").monospacedDigit()
                        }.font(.callout)
                        ProgressView(value: Double(received), total: Double(total))
                        Text("\(ByteCountFormatter.string(fromByteCount: received, countStyle: .file)) из \(ByteCountFormatter.string(fromByteCount: total, countStyle: .file))")
                            .font(.caption).foregroundStyle(AppTheme.secondaryText)
                    } else { HStack(spacing: 10) { ProgressView().controlSize(.small); Text(busy).font(.callout) } }
                    Button("Отменить") { operation?.cancel() }
                }.padding(.vertical, 6)
            }
            if let error { Text(error).font(.callout).foregroundStyle(AppTheme.destructive).accessibilityIdentifier("agentTransferError") }
            if let notice { Text(notice).font(.callout).textSelection(.enabled).accessibilityIdentifier("agentTransferNotice") }
            #if os(macOS)
            if let savedURL { Button("Показать в Finder") { NSWorkspace.shared.activateFileViewerSelecting([savedURL]) } }
            #endif
        }
        .onAppear { deviceID = client.health?.nodeId ?? "" }
        .onDisappear { operation?.cancel(); password = ""; importPassword = "" }
        .fileExporter(isPresented: $showingExport, document: document, contentType: .openStrudelTeam,
                      defaultFilename: "OpenStrudel-" + targetName + "-" + Date().formatted(.iso8601.year().month().day().dateSeparator(.dash))) { result in
            document = nil
            switch result {
            case .success(let url): savedURL = url; notice = (protected ? "Защищённая копия сохранена: " : "Копия сохранена: ") + url.lastPathComponent + "\n" + url.deletingLastPathComponent().path
            case .failure(let value): report(value)
            }
        }
        .fileImporter(isPresented: $showingImport, allowedContentTypes: [.openStrudelTeam, .json], allowsMultipleSelection: false) { result in
            switch result {
            case .success(let urls):
                guard let url = urls.first else { return }
                operation = Task {
                    busy = "Читаем «\(url.lastPathComponent)»…"; error = nil; notice = nil; total = nil
                    defer { busy = nil; operation = nil }
                    do {
                        let data = try await AgentTransferFile.read(url)
                        if AgentTransferFile.isProtected(data) { importData = data; importPassword = ""; askingPassword = true }
                        else { pending = try await client.previewAgentImport(data, deviceID: targetID) }
                    } catch { report(error) }
                }
            case .failure(let value): report(value)
            }
        }
        .sheet(isPresented: $askingPassword, onDismiss: { importPassword = ""; importData = nil; pending = unlockedImport; unlockedImport = nil }) {
            NavigationStack {
                VStack(alignment: .leading, spacing: 20) {
                    Text("Введите пароль, заданный при сохранении копии.").font(.callout)
                    SecureField("Пароль копии", text: $importPassword).textFieldStyle(.roundedBorder)
                    if let error { Text(error).font(.callout).foregroundStyle(AppTheme.destructive) }
                    Button(busy == nil ? "Открыть копию" : "Проверяем…") {
                        operation = Task {
                            busy = "Открываем копию…"; error = nil
                            defer { busy = nil; operation = nil }
                            do {
                                guard let importData else { return }
                                let data = try AgentTransferFile.protectedUpload(importData, password: importPassword)
                                unlockedImport = try await client.previewAgentImport(data, deviceID: targetID)
                                askingPassword = false
                            } catch { report(error) }
                        }
                    }.buttonStyle(.borderedProminent).disabled(importPassword.isEmpty || busy != nil)
                }.padding(24).navigationTitle("Защищённая копия")
                    .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Отмена") { operation?.cancel(); askingPassword = false } } }
            }
            #if os(macOS)
            .frame(width: 440, height: 270)
            #endif
        }
        .sheet(item: $pending) { item in
            AgentImportReview(pending: item) { result in
                notice = result.preview.alreadyImported ? "Эта копия уже восстановлена. Дубликатов нет." : "Восстановлено сотрудников: \(result.profileIds.count). Они появились в списке чатов."
                pending = nil
            }.environmentObject(client)
        }
    }
    private func export() {
        operation = Task {
            busy = "Готовим копию сотрудников на «\(targetName)»…"; total = nil; received = 0; error = nil; notice = nil; savedURL = nil
            defer { busy = nil; operation = nil }
            do {
                let data = try await client.exportAgents(deviceID: targetID, password: protected ? password : nil) { received, total in
                    self.received = received; self.total = total
                }
                try Task.checkCancellation()
                document = AgentTeamDocument(data: data); password = ""; showingExport = true
            } catch { report(error) }
        }
    }
    private func report(_ value: Error) {
        guard !(value is CancellationError), !AttachmentImport.isCancellation(value), (value as? URLError)?.code != .cancelled else {
            notice = "Операция отменена."; return
        }
        error = UserFacingError.text(value.localizedDescription)
    }
}

private struct AgentImportReview: View {
    @EnvironmentObject private var client: HomeClient
    @Environment(\.dismiss) private var dismiss
    let pending: PendingAgentImport
    let completed: (AgentImportResult) -> Void
    @State private var importing = false
    @State private var error: String?
    @AccessibilityFocusState private var errorFocused: Bool

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    if pending.preview.alreadyImported {
                        Label("Эта команда уже добавлена", systemImage: "checkmark.circle")
                            .font(.title2.weight(.medium))
                        Text("Повторный импорт этого файла не создаст дубликаты.")
                    } else {
                        Text("Текущие сотрудники и их файлы сохранятся. Сотрудники из файла появятся рядом с ними.")
                        VStack(alignment: .leading, spacing: 8) {
                            ForEach(Array(pending.preview.employees.enumerated()), id: \.offset) { _, employee in
                                HStack(alignment: .top, spacing: 10) {
                                    Image(systemName: "person.crop.circle").accessibilityHidden(true)
                                    VStack(alignment: .leading, spacing: 3) {
                                        Text(employee.importedName).font(.body.weight(.medium))
                                        if employee.name != employee.importedName {
                                            Text("Имя изменено, чтобы не путать с существующим сотрудником.")
                                                .font(.caption).foregroundStyle(AppTheme.secondaryText)
                                        }
                                    }
                                }
                            }
                        }
                        Text("Чаты: \(pending.preview.counts.conversations) · Сообщения: \(pending.preview.counts.messages)\nФайлы: \(pending.preview.counts.files) · Расписания: \(pending.preview.counts.schedules)")
                            .font(.callout).foregroundStyle(AppTheme.secondaryText)
                        Text("Расписания будут на паузе, отправка в Telegram отключена. Проверьте их перед включением. Подключённые сервисы нужно будет авторизовать заново.")
                            .font(.callout).fixedSize(horizontal: false, vertical: true)
                        if let error { Text(error).foregroundStyle(AppTheme.destructive).accessibilityFocused($errorFocused) }
                        Button {
                            importing = true; error = nil
                            Task {
                                defer { importing = false }
                                do { completed(try await client.importAgents(pending)) }
                                catch {
                                    self.error = UserFacingError.text(error.localizedDescription)
                                    errorFocused = true
                                }
                            }
                        } label: {
                            HStack(spacing: 10) {
                                if importing { ProgressView().controlSize(.small) }
                                Text(importing ? "Добавляем сотрудников…" : "Добавить сотрудников: \(pending.preview.counts.employees)")
                            }.frame(maxWidth: .infinity, minHeight: 44)
                        }.buttonStyle(.borderedProminent).disabled(importing).accessibilityIdentifier("confirmAgentImport")
                    }
                }.padding(24).frame(maxWidth: 580, alignment: .leading).frame(maxWidth: .infinity)
            }
            .navigationTitle("Восстановление сотрудников")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar { ToolbarItem(placement: .cancellationAction) {
                Button(pending.preview.alreadyImported ? "Готово" : "Отмена") { dismiss() }.disabled(importing)
            } }
        }
        .interactiveDismissDisabled(importing)
        #if os(macOS)
        .frame(minWidth: 520, minHeight: 480)
        #endif
    }
}
