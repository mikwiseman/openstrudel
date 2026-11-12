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

    /// Rows only: the caller wraps them in a Form section.
    var body: some View {
        Group {
            if client.devices.count > 1 && !localBackupOnly {
                Picker(L("Сотрудники устройства"), selection: $deviceID) {
                    ForEach(client.devices) { Text($0.name).tag($0.id) }
                }.disabled(working)
            }
            VStack(alignment: .leading, spacing: 4) {
                Text(L("Сотрудники «\(targetName)», их переписка, файлы и расписания — в одном файле."))
                Text(L("Вход в OpenAI и сервисы в копию не входит."))
                    .font(AppTypography.meta).foregroundStyle(AppTheme.secondaryText)
            }
            .fixedSize(horizontal: false, vertical: true)
            if client.canTransferAgents {
                if client.health?.agentArchiveEncryption == true {
                    Toggle(isOn: $protected) {
                        Text(L("Защитить копию паролем"))
                        Text(protected ? L("Сохраните пароль: без него копию не открыть.") : L("Файл без пароля. Храните его в безопасном месте."))
                    }
                    .settingsSwitch().disabled(working)
                    if protected {
                        SecureField(text: $password, prompt: Text(L("Пароль · не менее 12 символов"))) { Text(L("Пароль копии")) }
                            .disabled(working)
                    }
                } else {
                    Text(L("Файл без пароля. Для защищённых копий обновите OpenStrudel на этом устройстве."))
                        .font(AppTypography.meta).foregroundStyle(AppTheme.secondaryText)
                }
                Button(L("Сохранить копию…"), action: export)
                    .disabled(working || protected && password.count < 12).accessibilityIdentifier("exportAgents")
                if !localBackupOnly {
                    Button(L("Восстановить из копии…")) { error = nil; notice = nil; showingImport = true }
                        .disabled(working).accessibilityIdentifier("importAgents")
                }
            } else {
                Text(client.health == nil || client.homeUnreachable ? L("Для копии нужно подключение к устройству с сотрудниками.") : L("Копии доступны владельцу устройства. Проверьте доступ и версию OpenStrudel."))
                    .foregroundStyle(AppTheme.secondaryText)
            }
            if let busy {
                HStack(spacing: 12) {
                    if let total, total > 0 {
                        VStack(alignment: .leading, spacing: 4) {
                            LabeledContent(L("Получаем копию с «\(targetName)»")) {
                                Text("\(Int(min(1, Double(received) / Double(total)) * 100))%").monospacedDigit().foregroundStyle(AppTheme.secondaryText)
                            }
                            ProgressView(value: Double(received), total: Double(total))
                            Text(L("\(ByteCountFormatter.string(fromByteCount: received, countStyle: .file)) из \(ByteCountFormatter.string(fromByteCount: total, countStyle: .file))"))
                                .font(AppTypography.meta).monospacedDigit().foregroundStyle(AppTheme.secondaryText)
                        }
                    } else {
                        ProgressView().controlSize(.small)
                        Text(busy)
                        Spacer(minLength: 0)
                    }
                    Button(L("Отменить")) { operation?.cancel() }
                }
            }
            if let error { Text(L10n.serviceText(error)).foregroundStyle(AppTheme.warning).accessibilityIdentifier("agentTransferError") }
            if let notice {
                HStack(spacing: 12) {
                    Text(L10n.serviceText(notice)).textSelection(.enabled).accessibilityIdentifier("agentTransferNotice")
                    #if os(macOS)
                    if let savedURL {
                        Spacer(minLength: 0)
                        Button(L("Показать в Finder")) { NSWorkspace.shared.activateFileViewerSelecting([savedURL]) }
                    }
                    #endif
                }
            }
        }
        .onAppear { deviceID = client.health?.nodeId ?? "" }
        .onDisappear { operation?.cancel(); password = ""; importPassword = "" }
        .fileExporter(isPresented: $showingExport, document: document, contentType: .openStrudelTeam,
                      defaultFilename: "OpenStrudel-" + targetName + "-" + Date().formatted(.iso8601.year().month().day().dateSeparator(.dash))) { result in
            document = nil
            switch result {
            case .success(let url): savedURL = url; notice = (protected ? L("Защищённая копия сохранена: ") : L("Копия сохранена: ")) + url.lastPathComponent + "\n" + url.deletingLastPathComponent().path
            case .failure(let value): report(value)
            }
        }
        .fileImporter(isPresented: $showingImport, allowedContentTypes: [.openStrudelTeam, .json], allowsMultipleSelection: false) { result in
            switch result {
            case .success(let urls):
                guard let url = urls.first else { return }
                operation = Task {
                    busy = L("Читаем «\(url.lastPathComponent)»…"); error = nil; notice = nil; total = nil
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
                Form {
                    Section {
                        SecureField(text: $importPassword, prompt: Text(L("Пароль копии"))) { Text(L("Пароль копии")) }
                    } footer: {
                        Text(L("Введите пароль, заданный при сохранении копии."))
                    }
                    if let error {
                        Section { Text(L10n.serviceText(error)).foregroundStyle(AppTheme.warning) }
                    }
                }
                .formStyle(.grouped)
                .navigationTitle(L("Защищённая копия"))
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) { Button(L("Отмена")) { operation?.cancel(); askingPassword = false } }
                    ToolbarItem(placement: .confirmationAction) {
                        Button(busy == nil ? L("Открыть копию") : L("Проверяем…")) {
                            operation = Task {
                                busy = L("Открываем копию…"); error = nil
                                defer { busy = nil; operation = nil }
                                do {
                                    guard let importData else { return }
                                    let data = try AgentTransferFile.protectedUpload(importData, password: importPassword)
                                    unlockedImport = try await client.previewAgentImport(data, deviceID: targetID)
                                    askingPassword = false
                                } catch { report(error) }
                            }
                        }.disabled(importPassword.isEmpty || busy != nil)
                    }
                }
            }
            #if os(macOS)
            .frame(width: 440)
            #endif
            .presentationSizing(.fitted)
        }
        .sheet(item: $pending) { item in
            AgentImportReview(pending: item) { result in
                notice = result.preview.alreadyImported ? L("Эта копия уже восстановлена. Дубликатов нет.") : L("Восстановлено сотрудников: \(result.profileIds.count). Они появились в команде.")
                pending = nil
            }.environmentObject(client)
        }
    }
    private func export() {
        operation = Task {
            busy = L("Готовим копию сотрудников на «\(targetName)»…"); total = nil; received = 0; error = nil; notice = nil; savedURL = nil
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
            notice = L("Операция отменена."); return
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
            Form {
                if pending.preview.alreadyImported {
                    Section {
                        Label {
                            Text(L("Эта команда уже добавлена"))
                        } icon: {
                            Image(systemName: "checkmark.circle.fill").foregroundStyle(AppTheme.accentText)
                        }
                    } footer: {
                        Text(L("Повторный импорт этого файла не создаст дубликаты."))
                    }
                } else {
                    Section {
                        ForEach(Array(pending.preview.employees.enumerated()), id: \.offset) { _, employee in
                            Label {
                                Text(employee.importedName)
                                if employee.name != employee.importedName {
                                    Text(L("Имя изменено, чтобы не путать с существующим сотрудником."))
                                        .font(AppTypography.meta).foregroundStyle(AppTheme.secondaryText)
                                }
                            } icon: {
                                Image(systemName: "person.crop.circle").foregroundStyle(AppTheme.secondaryText)
                            }
                        }
                    } footer: {
                        Text(L("Текущие сотрудники и их файлы сохранятся. Сотрудники из файла появятся рядом с ними."))
                    }
                    Section {
                        Text(L("Чаты: \(pending.preview.counts.conversations) · Сообщения: \(pending.preview.counts.messages)\nФайлы: \(pending.preview.counts.files) · Расписания: \(pending.preview.counts.schedules)"))
                            .monospacedDigit().foregroundStyle(AppTheme.secondaryText)
                    } footer: {
                        Text(L("Расписания будут на паузе, отправка в Telegram отключена. Проверьте их перед включением. Подключённые сервисы нужно будет авторизовать заново."))
                    }
                    if let error {
                        Section { Text(L10n.serviceText(error)).foregroundStyle(AppTheme.warning).accessibilityFocused($errorFocused) }
                    }
                }
            }
            .formStyle(.grouped)
            .navigationTitle(L("Восстановление сотрудников"))
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                if pending.preview.alreadyImported {
                    ToolbarItem(placement: .confirmationAction) { Button(L("Готово")) { dismiss() } }
                } else {
                    ToolbarItem(placement: .cancellationAction) { Button(L("Отмена")) { dismiss() }.disabled(importing) }
                    ToolbarItem(placement: .confirmationAction) {
                        Button(importing ? L("Добавляем сотрудников…") : L("Добавить сотрудников: \(pending.preview.counts.employees)")) {
                            importing = true; error = nil
                            Task {
                                defer { importing = false }
                                do { completed(try await client.importAgents(pending)) }
                                catch {
                                    self.error = UserFacingError.text(error.localizedDescription)
                                    errorFocused = true
                                }
                            }
                        }
                        .disabled(importing).accessibilityIdentifier("confirmAgentImport")
                    }
                }
            }
        }
        .interactiveDismissDisabled(importing)
        #if os(macOS)
        .frame(width: 520).frame(minHeight: 320, idealHeight: 480, maxHeight: 640)
        #endif
        .presentationSizing(.fitted)
    }
}
