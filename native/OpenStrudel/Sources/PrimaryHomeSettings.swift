import SwiftUI
import UniformTypeIdentifiers

struct HomeControlDocument: FileDocument {
    static var readableContentTypes: [UTType] { [.data, .json] }
    var data: Data
    init(_ data: Data) { self.data = data }
    init(configuration: ReadConfiguration) throws {
        guard let data = configuration.file.regularFileContents, data.count < 300 * 1024 * 1024 else { throw HomeClientError.invalidResponse }
        self.data = data
    }
    func fileWrapper(configuration: WriteConfiguration) throws -> FileWrapper {
        let file = FileWrapper(regularFileWithContents: data)
        file.fileAttributes[FileAttributeKey.posixPermissions.rawValue] = 0o600
        return file
    }
}

struct PrimaryHomeSettings: View {
    @EnvironmentObject private var client: HomeClient
    @State private var showing = false
    var body: some View {
        Button { showing = true } label: {
            HStack(alignment: .top, spacing: 12) {
                Image(systemName: "desktopcomputer.and.macbook").font(.title2)
                VStack(alignment: .leading, spacing: 5) {
                    Text("Устройства и аккаунты").font(.headline)
                    Text("Где работает команда, какой аккаунт использовать и как перенести управление.")
                        .font(.callout).foregroundStyle(AppTheme.secondaryText).fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 0); Image(systemName: "chevron.right")
            }.padding(16).frame(maxWidth: .infinity, alignment: .leading)
                .background(.primary.opacity(0.07), in: RoundedRectangle(cornerRadius: 18))
        }.buttonStyle(.plain)
            .sheet(isPresented: $showing) { HomeManagementView().environmentObject(client) }
    }
}

struct AgentAccountPreference: View {
    @EnvironmentObject private var client: HomeClient
    let profile: EmployeeProfile
    @State private var accounts: [ManagedCodexAccount] = []
    @State private var selection = ""
    @State private var original = ""
    @State private var error: String?
    @State private var busy = false
    @State private var showingMove = false
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Divider()
            Text("Аккаунт Codex").font(.subheadline.weight(.medium))
            if let device = client.devices.first(where: { $0.id == profile.deviceId }) {
                Text("Работает на «\(device.name)»").font(.caption).foregroundStyle(AppTheme.secondaryText)
            }
            Picker("Использовать", selection: $selection) {
                Text("Порядок аккаунтов устройства").tag("")
                ForEach(accounts) { Text($0.account.email ?? $0.name).tag($0.id) }
            }.disabled(!client.canManageOpenAI || busy)
            if selection != original {
                Button("Сохранить выбор аккаунта") {
                    busy = true
                    Task { defer { busy = false }; do {
                        let _: HomeActionResult = try await client.management("/v1/agents/" + profile.id + "/accounts", method: "POST", payload: ["accountIds": selection.isEmpty ? NSNull() : [selection] as Any])
                        original = selection
                    } catch { self.error = error.localizedDescription } }
                }.disabled(busy)
            }
            Text("Выбор изменит следующие поручения. Начатая работа продолжится с прежним аккаунтом.").font(.caption).foregroundStyle(AppTheme.secondaryText)
            if client.canManageOpenAI {
                Button("Переместить на другое устройство…") { showingMove = true }
            }
            if let error { Text(error).font(.caption).foregroundStyle(AppTheme.destructive) }
        }.sheet(isPresented: $showingMove) { AgentMoveView(agentId: profile.id, name: profile.name, sourceId: profile.deviceId).environmentObject(client) }.task {
            do {
                struct Policy: Decodable { let accountIds: [String]? }
                let result: ManagedCodexAccounts = try await client.management("/v1/accounts" + (profile.deviceId.map { "?deviceId=" + $0 } ?? ""))
                accounts = result.accounts
                let policy: Policy = try await client.management("/v1/agents/" + profile.id + "/accounts")
                if let ids = policy.accountIds, ids.count == 1 { selection = ids[0] }
                else if (policy.accountIds?.count ?? 0) > 1 { error = "Для этого агента задан отдельный порядок через CLI. Выбор здесь заменит его." }
                original = selection
            } catch { self.error = error.localizedDescription }
        }
    }
}

private struct AgentMoveView: View {
    @EnvironmentObject private var client: HomeClient
    @Environment(\.dismiss) private var dismiss
    let agentId: String
    let name: String
    let sourceId: String?
    @State private var devices: [HomeDevice] = []
    @State private var target = ""
    @State private var operation: HomeTransferOperation?
    @State private var error: String?
    @State private var sending = false
    @State private var operationId = UUID().uuidString.lowercased()
    var body: some View {
        NavigationStack {
            Form {
                Text("Перенесём «\(name)» вместе с перепиской, файлами и расписаниями. На прежнем устройстве агент перестанет работать. Выбор главного устройства не изменится.")
                Text("Вход в OpenAI, разрешения Mac и доступ к сервисам проверяются на новом устройстве. Расписания с неподключёнными сервисами останутся на паузе.").foregroundStyle(AppTheme.secondaryText)
                if let operation {
                    Label(operation.phaseDescription, systemImage: operation.phase == "completed" ? "checkmark.circle" : "arrow.right.circle")
                    if let issue = operation.error { Text(issue).foregroundStyle(AppTheme.destructive) }
                    ForEach(operation.warnings ?? [], id: \.self) { Text($0) }
                    if !operation.isFinished { Button("Проверить состояние") { Task { await check() } } }
                    if operation.phase == "attention" {
                        Button("Продолжить перенос") { Task {
                            do { self.operation = try await client.management("/v1/home/operations/" + operation.id + "/retry", method: "POST", payload: [:]) }
                            catch { self.error = error.localizedDescription }
                        } }
                    }
                } else {
                    Picker("Новое устройство", selection: $target) {
                        Text("Выберите устройство").tag("")
                        ForEach(devices.filter { $0.online && $0.id != sourceId }) { Text($0.name).tag($0.id) }
                    }
                    Button("Переместить агента") {
                        sending = true
                        Task {
                            defer { sending = false }
                            do { operation = try await client.management("/v1/agents/" + agentId + "/move", method: "POST", payload: ["deviceId": target, "operationId": operationId]) }
                            catch {
                                self.error = error.localizedDescription + " Проверяем, был ли перенос принят."
                                self.operation = try? await client.management("/v1/home/operations/" + operationId)
                            }
                        }
                    }.disabled(target.isEmpty || sending)
                }
                if sending { ProgressView("Начинаем перенос…") }
                if let error { Text(error).foregroundStyle(AppTheme.destructive) }
                Text("Можно закрыть окно. Перенос продолжится на главном устройстве.").font(.caption)
            }.formStyle(.grouped)
                .navigationTitle("Переместить агента")
                .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Готово") { dismiss() } } }
        }
        #if os(macOS)
        .frame(minWidth: 520, minHeight: 420)
        #endif
        .task { do { let value: HomeDevices = try await client.management("/v1/devices"); devices = value.devices } catch { self.error = error.localizedDescription } }
        .task(id: operation?.id) {
            while let operation, !operation.isFinished && !Task.isCancelled {
                try? await Task.sleep(for: .seconds(1)); if !Task.isCancelled { await check() }
            }
        }
    }
    private func check() async {
        guard let id = operation?.id else { return }
        do { operation = try await client.management("/v1/home/operations/" + id); if operation?.phase == "completed" { await client.load(quiet: true) } }
        catch { self.error = error.localizedDescription }
    }
}

private struct HomeManagementView: View {
    @EnvironmentObject private var client: HomeClient
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL
    @State private var devices: [HomeDevice] = []
    @State private var accounts: [ManagedCodexAccount] = []
    @State private var section = "Устройства"
    @State private var selectedDevice = ""
    @State private var canManage = false
    @State private var busy = false
    @State private var error: String?
    @State private var notice: String?
    @State private var invitation: String?
    @State private var joinText = ""
    @State private var showJoin = false
    @State private var password = ""
    @State private var restoreText: String?
    @State private var isolated = false
    @State private var showingImport = false
    @State private var document: HomeControlDocument?
    @State private var showingExport = false
    @State private var exportName = "OpenStrudel-control.homebackup"
    @State private var transferTarget: HomeDevice?
    @State private var login: OpenAILogin?
    @State private var loginAccount = ""
    @State private var accountName = ""
    @State private var logoutAccount: ManagedCodexAccount?
    @State private var operations: [HomeTransferOperation] = []
    @State private var mainNodeId: String?
    @State private var showingMainMove = false
    @AppStorage("openstrudel.pendingHomeOperation") private var pendingHomeOperation = ""
    @AppStorage("openstrudel.pendingHomeID") private var pendingHomeID = ""

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    Picker("Раздел настроек", selection: $section) {
                        ForEach(["Устройства", "Аккаунты", "Копии"], id: \.self) { Text($0) }
                    }.pickerStyle(.segmented)
                    if section == "Устройства" { deviceSection }
                    else if section == "Аккаунты" { accountSection }
                    else { backupSection }
                    if busy { ProgressView("Проверяем…") }
                    if let error { Text(error).foregroundStyle(AppTheme.destructive).textSelection(.enabled).accessibilityIdentifier("homeManagementError") }
                    if let notice { Text(notice).foregroundStyle(AppTheme.secondaryText).textSelection(.enabled) }
                    if let invitation {
                        Text("Передайте это приглашение только своему устройству. Оно действует пять минут.").font(.callout)
                        Text(invitation).font(.caption.monospaced()).textSelection(.enabled)
                        ShareLink(item: invitation) { Label("Передать приглашение", systemImage: "square.and.arrow.up") }
                    }
                }.padding(24).frame(maxWidth: 620, alignment: .leading).frame(maxWidth: .infinity)
            }.background(HomeBackground())
                .navigationTitle("Ваша команда")
                .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Готово") { dismiss() } } }
        }
        #if os(macOS)
        .frame(minWidth: 560, minHeight: 600)
        #endif
        .sheet(isPresented: $showingMainMove) { AgentMoveView(agentId: "main", name: "OpenStrudel", sourceId: mainNodeId).environmentObject(client) }
        .confirmationDialog("Выйти из аккаунта OpenAI?", isPresented: Binding(get: { logoutAccount != nil }, set: { if !$0 { logoutAccount = nil } }), titleVisibility: .visible) {
            if let entry = logoutAccount {
                Button("Выйти", role: .destructive) { perform {
                    let _: HomeActionResult = try await client.management(accountPath(entry.id, "logout"), method: "POST", payload: [:])
                    logoutAccount = nil; await refreshAccounts()
                } }
            }
            Button("Отмена", role: .cancel) { logoutAccount = nil }
        } message: { Text("История останется на месте. Агентам, закреплённым за этим аккаунтом, понадобится повторный вход.") }
        .task { await refreshDevices() }
        .task(id: section + selectedDevice) { if section == "Аккаунты" { await refreshAccounts() } }
        .task(id: login?.loginId) {
            guard let current = login else { return }
            while !Task.isCancelled && login?.loginId == current.loginId {
                try? await Task.sleep(for: .seconds(2))
                do {
                    let value: OpenAILoginStatus = try await client.management(accountPath(loginAccount, "login/" + current.loginId))
                    if value.status == "completed" { login = nil; notice = "Аккаунт подключён."; await refreshAccounts() }
                    else if value.status == "failed" || value.status == "canceled" { login = nil; error = "Вход не завершён. Откройте новый вход в OpenAI." }
                } catch { self.error = "Не удалось проверить вход. Повторим после восстановления связи." }
            }
        }
        .fileExporter(isPresented: $showingExport, document: document, contentType: .data, defaultFilename: exportName) { result in
            document = nil
            switch result {
            case .success(let url):
                if let target = transferTarget { Task { await transfer(to: target, backupURL: url) } }
                else { password = ""; notice = "Зашифрованная копия сохранена. Храните пароль отдельно от файла." }
            case .failure(let failure): error = failure.localizedDescription; password = ""; transferTarget = nil
            }
        }
        .fileImporter(isPresented: $showingImport, allowedContentTypes: [.data, .json], allowsMultipleSelection: false) { result in
            do {
                guard let url = try result.get().first else { return }
                let scoped = url.startAccessingSecurityScopedResource(); defer { if scoped { url.stopAccessingSecurityScopedResource() } }
                let info = try url.resourceValues(forKeys: [.fileSizeKey]); guard (info.fileSize ?? Int.max) < 300 * 1024 * 1024 else { throw HomeClientError.invalidResponse }
                restoreText = try String(contentsOf: url, encoding: .utf8); isolated = false
            } catch { self.error = error.localizedDescription }
        }
    }

    private var deviceSection: some View {
        VStack(alignment: .leading, spacing: 18) {
            Text("Через главное устройство вы подключаетесь к команде. История и файлы каждого агента хранятся там, где он работает.").font(.callout)
            if !client.savedActionIDs.isEmpty {
                Button("Проверить сохранённые действия") { perform { notice = try await client.checkSavedActions(); await refreshDevices() } }
            }
            ForEach(operations) { operation in
                VStack(alignment: .leading, spacing: 6) {
                    Text(operation.phaseDescription).font(.headline)
                    if let issue = operation.error { Text(issue).foregroundStyle(AppTheme.destructive) }
                    ForEach(operation.warnings ?? [], id: \.self) { Text($0).font(.callout) }
                    if operation.phase == "attention", client.canManageOpenAI {
                        Button("Продолжить перенос") { perform {
                            let _: HomeTransferOperation = try await client.management("/v1/home/operations/" + operation.id + "/retry", method: "POST", payload: [:])
                            await refreshDevices()
                        } }
                    }
                }
            }
            if !pendingHomeOperation.isEmpty && pendingHomeID == (client.health?.homeId ?? client.normalizedBaseURL) {
                Button("Проверить передачу главного устройства") { perform { try await checkPendingTransfer() } }
            }
            ForEach(devices) { device in
                VStack(alignment: .leading, spacing: 8) {
                    HStack {
                        Image(systemName: device.platform == "darwin" ? "desktopcomputer" : "server.rack")
                        Text(device.name).font(.headline)
                        if device.primary { Text("Главное").font(.caption).foregroundStyle(AppTheme.accent).padding(.horizontal, 7).padding(.vertical, 3).background(.primary.opacity(0.06), in: Capsule()) }
                        Spacer()
                        if client.canManageOpenAI && !device.primary {
                            Menu {
                                if device.online && device.endpoint != nil {
                                    Button("Сделать главным…") { transferTarget = device; section = "Копии"; notice = "Передача на «\(device.name)» начнётся после сохранения резервной копии." }
                                }
                                Button("Восстановить подключение…") { perform { try await invite(reconnect: device.id) } }
                            } label: { Image(systemName: "ellipsis") }
                                .accessibilityLabel("Действия с устройством «\(device.name)»")
                                #if os(macOS)
                                .menuStyle(.borderlessButton)
                                #endif
                                .fixedSize()
                        }
                    }
                    Text("\(device.online ? "На связи" : "Не на связи") · Агентов: \(device.agents)").font(.callout).foregroundStyle(AppTheme.secondaryText)
                }.padding(16).background(.primary.opacity(0.05), in: RoundedRectangle(cornerRadius: 14))
            }
            if client.canManageOpenAI {
                #if os(macOS)
                Button("Добавить Mac или сервер") { perform { try await invite() } }.buttonStyle(.borderedProminent)
                #endif
                Menu("Пригласить в команду") {
                    Button("Через приложение") { perform {
                        let value: MobileInvitation = try await client.management("/v1/mobile/pairing", method: "POST", payload: ["owner": false])
                        invitation = value.url.absoluteString
                    } }
                    Button("Через браузер") { perform {
                        struct Invitation: Decodable { let url: String }
                        let value: Invitation = try await client.management("/v1/web/invitation", method: "POST", payload: ["owner": false, "local": client.isLocalConnection])
                        invitation = value.url
                    } }
                }.fixedSize()
                Text("Приглашение даёт доступ к переписке. Аккаунты и устройства остаются под вашим управлением.").font(.caption).foregroundStyle(AppTheme.secondaryText)
                DisclosureGroup("Другие действия") {
                    VStack(alignment: .leading, spacing: 14) {
                        if devices.count > 1 { Button("Переместить главного собеседника…") { showingMainMove = true } }
                        #if os(macOS)
                        if client.isLocalConnection { Button("Подключить этот Mac к другой команде…") { showJoin.toggle(); invitation = nil } }
                        #endif
                        Button("Открыть управление в своём браузере") { perform {
                            struct Invitation: Decodable { let url: String }
                            let value: Invitation = try await client.management("/v1/web/invitation", method: "POST", payload: ["owner": true, "local": client.isLocalConnection])
                            if let url = URL(string: value.url) { openURL(url) }
                        } }
                    }.padding(.top, 10)
                }
                #if os(macOS)
                if showJoin && client.isLocalConnection {
                    Text("На главном устройстве нажмите «Добавить Mac или сервер» и вставьте приглашение. Этот Mac продолжит выполнять своих агентов.").font(.callout)
                    TextEditor(text: $joinText).font(.caption.monospaced()).frame(minHeight: 100).accessibilityLabel("Приглашение для устройства")
                    Button("Подключить Mac") {
                        perform {
                            let value = try JSONSerialization.jsonObject(with: Data(joinText.utf8))
                            let _: HomeManagement.State = try await client.management("/v1/home/join", method: "POST", payload: ["invitation": value])
                            joinText = ""; showJoin = false; await client.load(quiet: true); await refreshDevices()
                        }
                    }.disabled(joinText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
                #endif
            }
            Button("Обновить состояние") { Task { await refreshDevices() } }
        }.disabled(busy)
    }

    private var accountSection: some View {
        VStack(alignment: .leading, spacing: 18) {
            Text("Аккаунты подключаются на устройстве, где работают агенты. Приоритет действует на новые поручения; начатая работа сохранит свой аккаунт.").font(.callout)
            Picker("Устройство", selection: $selectedDevice) { ForEach(devices) { Text($0.name).tag($0.id) } }
                .disabled(login != nil)
            ForEach(Array(accounts.enumerated()), id: \.element.id) { index, entry in
                VStack(alignment: .leading, spacing: 8) {
                    Text(entry.account.email ?? entry.name).font(.headline).textSelection(.enabled)
                    Text(entry.account.connected ? (entry.account.planType ?? "Подключён") : "Нужен вход").font(.callout).foregroundStyle(AppTheme.secondaryText)
                    if index == 0 { Text("Первый по приоритету").font(.caption) }
                    if entry.usage.windows.isEmpty { Text("Остатки пока неизвестны").font(.callout) }
                    ForEach(entry.usage.windows) { window in
                        if let remaining = window.remainingPercent {
                            VStack(alignment: .leading, spacing: 5) {
                                Text("\(window.name): осталось \(Int(remaining.rounded()))%").font(.callout)
                                ProgressView(value: remaining, total: 100).accessibilityLabel(window.name).accessibilityValue("Осталось \(Int(remaining)) процентов")
                                if let reset = window.resetsAt { Text("Обновление \(Date(timeIntervalSince1970: reset).formatted(date: .abbreviated, time: .shortened))").font(.caption).foregroundStyle(AppTheme.secondaryText) }
                            }
                        } else { Text(window.name + ": остаток пока неизвестен").font(.callout).foregroundStyle(AppTheme.secondaryText) }
                    }
                    if entry.activeRuns > 0 { Text("Сейчас выполняется поручений: \(entry.activeRuns)").font(.caption) }
                    if canManage {
                        if !entry.account.connected {
                            Button("Войти в OpenAI") { perform { try await beginLogin(entry.id) } }.disabled(login != nil || entry.activeRuns > 0)
                        } else if index > 0 {
                            Button("Использовать первым") { perform {
                                let _: HomeActionResult = try await client.management(accountPath(entry.id, "priority"), method: "POST", payload: [:]); await refreshAccounts()
                            } }
                        }
                        if entry.account.connected {
                            Button("Выйти…", role: .destructive) { logoutAccount = entry }.disabled(entry.activeRuns > 0)
                        }
                    }
                }.padding(.vertical, 4)
                Divider()
            }
            if let login {
                Text("Завершите вход в своём аккаунте на сайте OpenAI.").font(.callout)
                if let code = login.userCode { Text(code).font(.title2.monospaced()).textSelection(.enabled) }
                if let url = login.url, url.scheme == "https", url.host == "auth.openai.com" {
                    Button("Открыть OpenAI") { openURL(url) }.buttonStyle(.borderedProminent)
                }
                Button("Отменить вход") { perform {
                    let _: OpenAILoginStatus = try await client.management(accountPath(loginAccount, "login/" + login.loginId), method: "DELETE"); self.login = nil
                } }
            } else if canManage {
                TextField("Название аккаунта", text: $accountName).textFieldStyle(.roundedBorder)
                Button("Добавить аккаунт") { perform {
                    struct Added: Decodable { let id: String }
                    let result: Added = try await client.management("/v1/accounts" + deviceQuery, method: "POST", payload: ["name": accountName])
                    accountName = ""; try await beginLogin(result.id)
                } }.buttonStyle(.borderedProminent)
            }
            Button("Обновить остатки") { Task { await refreshAccounts(force: true) } }
        }.disabled(busy)
    }

    private var backupSection: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Копия управления содержит каталог и доступы устройств. Историю и файлы агентов сохраняйте отдельно через экспорт на каждом устройстве.").font(.callout)
            if let target = transferTarget { Text("Новое главное: \(target.name). Агенты останутся на своих устройствах.").font(.headline) }
            SecureField("Пароль копии, от 12 символов", text: $password).textFieldStyle(.roundedBorder)
            if let restoreText {
                Text("Восстановление выполняется на чистом устройстве. Прежнее главное должно быть остановлено, чтобы два устройства не управляли одной командой.").font(.callout)
                Toggle("Прежнее главное остановлено или изолировано", isOn: $isolated)
                Button("Восстановить управление") { perform {
                    struct Restored: Decodable { let active: Bool }
                    let _: Restored = try await client.management("/v1/home/restore", method: "POST", payload: ["archive": restoreText, "password": password, "previousPrimaryIsolated": isolated])
                    self.restoreText = nil; password = ""; notice = "Управление восстановлено. Создайте новые приглашения для подключённых устройств."; await refreshDevices()
                } }.disabled(!isolated || password.count < 12)
            } else {
                Button(transferTarget == nil ? "Сохранить зашифрованную копию" : "Сохранить копию и передать управление") { perform {
                    let value: HomeBackup = try await client.management("/v1/home/backup", method: "POST", payload: ["password": password])
                    document = HomeControlDocument(Data(value.archive.utf8)); showingExport = true
                } }.buttonStyle(.borderedProminent).disabled(password.count < 12)
                Button("Восстановить из копии…") { showingImport = true; transferTarget = nil }
            }
            Text("Без файлов агента копия управления не восстановит его историю. Пароль нельзя восстановить через OpenStrudel.").font(.caption).foregroundStyle(AppTheme.secondaryText)
            if transferTarget != nil { Button("Отменить передачу") { transferTarget = nil; notice = nil; password = "" } }
        }.disabled(busy || !client.canManageOpenAI)
    }

    private var deviceQuery: String { "?deviceId=" + selectedDevice }
    private func accountPath(_ id: String, _ action: String) -> String { "/v1/accounts/" + id + "/" + action + deviceQuery }
    private func perform(_ work: @escaping @MainActor () async throws -> Void) {
        guard !busy else { return }; busy = true; error = nil; notice = nil
        Task { defer { busy = false }; do { try await work() } catch { self.error = error.localizedDescription } }
    }
    private func refreshDevices() async {
        do {
            let result: HomeDevices = try await client.management("/v1/devices")
            devices = result.devices
            let control: HomeManagement = try await client.management("/v1/home")
            operations = control.operations ?? []
            mainNodeId = control.home.mainNodeId
            if !devices.contains(where: { $0.id == selectedDevice }) { selectedDevice = result.primaryId }
        } catch { self.error = error.localizedDescription }
    }
    private func refreshAccounts(force: Bool = false) async {
        guard !selectedDevice.isEmpty else { return }
        let device = selectedDevice
        accounts = []; canManage = false
        do {
            let result: ManagedCodexAccounts = try await client.management("/v1/accounts" + deviceQuery + (force ? "&refresh=true" : ""))
            guard !Task.isCancelled, device == selectedDevice else { return }
            accounts = result.accounts; canManage = result.canManage
        } catch { if !Task.isCancelled && device == selectedDevice { accounts = []; self.error = error.localizedDescription } }
    }
    private func beginLogin(_ id: String) async throws {
        loginAccount = id
        login = try await client.management(accountPath(id, "login"), method: "POST", payload: [:])
    }
    private func invite(reconnect: String? = nil) async throws {
        let bytes = try await client.managementFile("/v1/devices/invitation", method: "POST", payload: reconnect.map { ["reconnectId": $0] } ?? [:])
        invitation = String(decoding: bytes, as: UTF8.self)
    }
    private func transfer(to target: HomeDevice, backupURL: URL) async {
        busy = true; error = nil
        let id = UUID().uuidString.lowercased()
        pendingHomeOperation = id
        pendingHomeID = client.health?.homeId ?? client.normalizedBaseURL
        defer { busy = false; transferTarget = nil; password = "" }
        do {
            var operation: HomeTransferOperation = try await client.management("/v1/home/transfer", method: "POST", payload: ["deviceId": target.id, "operationId": id, "backupPassword": password])
            if let final = operation.backup {
                let scoped = backupURL.startAccessingSecurityScopedResource(); defer { if scoped { backupURL.stopAccessingSecurityScopedResource() } }
                try Data(final.utf8).write(to: backupURL, options: .atomic)
            }
            for _ in 0..<30 where operation.phase == "transferred" || operation.phase == "preparing" {
                try await Task.sleep(for: .seconds(1))
                operation = try await client.management("/v1/home/operations/" + id)
            }
            if operation.phase == "completed" || operation.phase == "active" {
                pendingHomeOperation = ""
                notice = "Главное устройство теперь «\(target.name)». Агенты остались на своих местах."; await client.load(quiet: true); await refreshDevices()
            } else { notice = operation.error ?? "Передача ещё не подтверждена. Состояние сохранено; проверьте подключение к новому главному." }
        } catch { self.error = "Не удалось подтвердить завершение передачи. Не создавайте второе главное. Проверка операции: \(id). \(error.localizedDescription)" }
    }
    private func checkPendingTransfer() async throws {
        let operation: HomeTransferOperation = try await client.management("/v1/home/operations/" + pendingHomeOperation)
        notice = operation.error ?? operation.phaseDescription
        if operation.isFinished { pendingHomeOperation = ""; await client.load(quiet: true); await refreshDevices() }
    }
}
