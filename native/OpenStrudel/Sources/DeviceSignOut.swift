import SwiftUI

struct DeviceSignOutButton: View {
    let completed: () -> Void
    @State private var showing = false
    var body: some View {
        Button { showing = true } label: {
            Label("Выйти на этом устройстве", systemImage: "rectangle.portrait.and.arrow.right")
                .frame(minHeight: 44, alignment: .leading)
        }.buttonStyle(.plain).accessibilityIdentifier("signOutThisDevice")
            .sheet(isPresented: $showing) { DeviceSignOutView { showing = false; completed() } }
    }
}

struct DeviceSignOutView: View {
    @EnvironmentObject private var client: HomeClient
    @Environment(\.dismiss) private var dismiss
    let completed: () -> Void
    @State private var documents: [AgentTeamDocument] = []
    @State private var showingExport = false
    @State private var preparing = false
    @State private var error: String?
    @State private var progress = ""
    private var busy: Bool { preparing || showingExport || client.isSigningOut }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    Text("Агенты, переписка, файлы и расписания сохранятся на ваших устройствах. Команда продолжит работать, пока её Mac или сервер включён.")
                        .fixedSize(horizontal: false, vertical: true)
                    Text(client.isLocalConnection
                         ? "Чтобы вернуться, выберите «На этом Mac» на начальном экране."
                         : "Для повторного подключения понадобится новое приглашение от владельца команды.")
                        .font(.callout).foregroundStyle(AppTheme.secondaryText)
                    if !client.pendingMessages.isEmpty {
                        Text("Неотправленные сообщения останутся на этом устройстве. Вы сможете проверить их после повторного подключения к этой команде.")
                            .font(.callout).foregroundStyle(AppTheme.secondaryText)
                    }
                    if client.canTransferAgents {
                        Text("Можно также сохранить копию агентов в файл. В неё войдут инструкции, переписка, файлы и расписания. Доступы к OpenAI и сервисам нужно будет подключить заново.")
                            .font(.callout).foregroundStyle(AppTheme.secondaryText)
                        if client.devices.count > 1 {
                            Text("Для каждого устройства будет отдельный файл. Если одно из них недоступно, выход с копией подождёт его подключения.")
                                .font(.caption).foregroundStyle(AppTheme.secondaryText)
                        }
                    }
                    if preparing { HStack(spacing: 10) { ProgressView().controlSize(.small); Text(progress) } }
                    if let error { Text(error).foregroundStyle(AppTheme.destructive).accessibilityIdentifier("signOutError") }
                    VStack(spacing: 10) {
                        if client.canTransferAgents {
                            Button { Task { await prepareCopies() } } label: {
                                Text("Сохранить копию и выйти").frame(maxWidth: .infinity, minHeight: 36)
                            }.buttonStyle(.borderedProminent).accessibilityIdentifier("exportAndSignOut")
                        }
                        Button { Task { await finish() } } label: {
                            Text(client.isSigningOut ? "Выходим…" : "Выйти").frame(maxWidth: .infinity, minHeight: 36)
                        }.buttonStyle(.bordered).accessibilityIdentifier("confirmDeviceSignOut")
                    }.disabled(busy)
                }.padding(24).frame(maxWidth: 520, alignment: .leading)
            }
            .navigationTitle("Выход")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Отмена") { dismiss() }.disabled(busy) } }
        }
        .interactiveDismissDisabled(busy)
        .fileExporter(isPresented: $showingExport, documents: documents, contentTypes: [.openStrudelTeam], onCompletion: { result in
            switch result {
            case .success(let urls):
                guard !documents.isEmpty, urls.count == documents.count else { error = "Сохранены не все файлы. Вы остались подключены."; return }
                documents = []
                Task { await finish() }
            case .failure(let value):
                documents = []
                if !AttachmentImport.isCancellation(value) { error = "Копию не удалось сохранить. Вы остались подключены. " + UserFacingError.text(value.localizedDescription) }
            }
        }, onCancellation: { documents = [] })
        #if os(macOS)
        .frame(width: 520, height: 530)
        #endif
    }

    private func prepareCopies() async {
        preparing = true; error = nil; documents = []
        defer { preparing = false }
        let connection = client.normalizedBaseURL
        do {
            // Refresh the catalog before exporting so a recently added device is included.
            let available: [HomeDevice]
            if client.health?.homeProtocol == 1 {
                let latest: HomeDevices = try await client.management("/v1/devices")
                available = latest.devices
            } else { available = client.devices }
            let devices = available
            var copies: [AgentTeamDocument] = []
            if devices.isEmpty {
                progress = "Собираем копию команды…"
                copies = [AgentTeamDocument(data: try await client.exportAgents(), filename: "OpenStrudel.openstrudel")]
            } else {
                for (index, device) in devices.enumerated() {
                    progress = "Сохраняем «\(device.name)»…"
                    let data = try await client.exportAgents(deviceID: device.id)
                    let safeName = device.name.components(separatedBy: CharacterSet.alphanumerics.inverted).filter { !$0.isEmpty }.joined(separator: "-")
                    copies.append(AgentTeamDocument(data: data, filename: "OpenStrudel-\(index + 1)-\(String(safeName.prefix(50))).openstrudel"))
                }
            }
            guard connection == client.normalizedBaseURL, !client.isSignedOut else { throw CancellationError() }
            documents = copies; showingExport = true
        } catch {
            self.error = "Копия пока не готова. Вы остались подключены. " + UserFacingError.text(error.localizedDescription)
        }
    }
    private func finish() async {
        await client.signOutOnThisDevice()
        if client.isSignedOut { completed() }
    }
}
