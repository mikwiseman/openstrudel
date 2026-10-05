import SwiftUI
import UniformTypeIdentifiers

extension UTType {
    static let openStrudelTeam = UTType(exportedAs: "is.openstrudel.team", conformingTo: .data)
}

struct AgentTeamDocument: FileDocument {
    static var readableContentTypes: [UTType] { [.openStrudelTeam] }
    var data: Data
    init(data: Data) { self.data = data }
    init(configuration: ReadConfiguration) throws {
        guard let data = configuration.file.regularFileContents, data.count <= AgentTransferFile.byteLimit else { throw AgentTransferFile.Failure.invalidFile }
        self.data = data
    }
    func fileWrapper(configuration: WriteConfiguration) throws -> FileWrapper {
        let file = FileWrapper(regularFileWithContents: data)
        file.fileAttributes[FileAttributeKey.posixPermissions.rawValue] = 0o600
        return file
    }
}

struct AgentTransferSettings: View {
    @EnvironmentObject private var client: HomeClient
    @Environment(\.dynamicTypeSize) private var textSize
    @State private var document: AgentTeamDocument?
    @State private var showingExport = false
    @State private var showingImport = false
    @State private var pending: PendingAgentImport?
    @State private var busy: String?
    @State private var error: String?
    @State private var notice: String?
    @AccessibilityFocusState private var errorFocused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Сохраните всех сотрудников вместе с инструкциями, перепиской, файлами и расписаниями. Из этого файла можно добавить команду на другой Mac или сервер.")
                .font(.callout).fixedSize(horizontal: false, vertical: true)
            Text("Текущие сотрудники при импорте сохранятся. Новые расписания будут на паузе. Доступ к OpenAI и подключённым сервисам в файл не входит.")
                .font(.caption).foregroundStyle(AppTheme.secondaryText).fixedSize(horizontal: false, vertical: true)
            if client.canTransferAgents {
                if textSize.isAccessibilitySize {
                    VStack(alignment: .leading, spacing: 8) { actions }
                } else {
                    ViewThatFits(in: .horizontal) {
                        HStack(spacing: 12) { actions }
                        VStack(alignment: .leading, spacing: 8) { actions }
                    }
                }
                if let busy { HStack(spacing: 10) { ProgressView().controlSize(.small); Text(busy).font(.callout) } }
            } else {
                Text(client.canManageOpenAI
                     ? "Для переноса обновите OpenStrudel на Mac или сервере, где работает команда."
                     : "Перенос доступен владельцу команды на основном Mac или устройстве, с которого настроили сервер.")
                    .font(.caption).foregroundStyle(AppTheme.secondaryText)
            }
            if let error {
                Text(error).font(.callout).foregroundStyle(AppTheme.destructive)
                    .accessibilityFocused($errorFocused).accessibilityIdentifier("agentTransferError")
            }
            if let notice { Text(notice).font(.callout).accessibilityIdentifier("agentTransferNotice") }
        }
        .padding(16).frame(maxWidth: .infinity, alignment: .leading)
        .background(.primary.opacity(0.07), in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        .fileExporter(isPresented: $showingExport, document: document, contentType: .openStrudelTeam,
                      defaultFilename: "OpenStrudel-" + Date().formatted(.iso8601.year().month().day().dateSeparator(.dash))) { result in
            document = nil
            switch result {
            case .success: notice = "Копия команды сохранена. В файле есть личная переписка и материалы."
            case .failure(let value): report(value)
            }
        }
        .fileImporter(isPresented: $showingImport, allowedContentTypes: [.openStrudelTeam, .json], allowsMultipleSelection: false) { result in
            switch result {
            case .success(let urls):
                guard let url = urls.first else { return }
                Task {
                    busy = "Проверяем файл…"; error = nil; notice = nil
                    defer { busy = nil }
                    do { pending = try await client.previewAgentImport(AgentTransferFile.read(url)) }
                    catch { report(error) }
                }
            case .failure(let value): report(value)
            }
        }
        .sheet(item: $pending) { item in
            AgentImportReview(pending: item) { result in
                notice = result.preview.alreadyImported ? "Этот файл уже импортирован. Дубликаты не добавлены." : "Добавлено сотрудников: \(result.profileIds.count). Они уже в списке команды."
                pending = nil
            }.environmentObject(client)
        }
    }

    @ViewBuilder private var actions: some View {
        Button {
            Task {
                busy = "Собираем копию команды…"; error = nil; notice = nil
                defer { busy = nil }
                do { document = AgentTeamDocument(data: try await client.exportAgents()); showingExport = true }
                catch { report(error) }
            }
        } label: { transferLabel("Сохранить копию", icon: "square.and.arrow.up") }
            .buttonStyle(.bordered).buttonBorderShape(textSize.isAccessibilitySize ? .roundedRectangle(radius: 14) : .capsule)
            .disabled(busy != nil || showingExport).accessibilityIdentifier("exportAgents")
        Button { error = nil; notice = nil; showingImport = true } label: {
            transferLabel("Добавить из файла", icon: "square.and.arrow.down")
        }.buttonStyle(.bordered).buttonBorderShape(textSize.isAccessibilitySize ? .roundedRectangle(radius: 14) : .capsule)
            .disabled(busy != nil || showingExport).accessibilityIdentifier("importAgents")
    }

    @ViewBuilder private func transferLabel(_ title: String, icon: String) -> some View {
        if textSize.isAccessibilitySize {
            VStack(alignment: .leading, spacing: 8) {
                Image(systemName: icon).accessibilityHidden(true)
                Text(title).fixedSize(horizontal: false, vertical: true)
            }.frame(maxWidth: .infinity, alignment: .leading).padding(.vertical, 8)
        } else { Label(title, systemImage: icon).frame(minHeight: 32) }
    }

    private func report(_ value: Error) {
        guard !AttachmentImport.isCancellation(value) else { return }
        error = UserFacingError.text(value.localizedDescription); errorFocused = true
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
            .navigationTitle("Импорт команды")
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
