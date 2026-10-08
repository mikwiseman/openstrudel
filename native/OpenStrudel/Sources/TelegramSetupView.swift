import SwiftUI

struct TelegramSetupView: View {
    @EnvironmentObject private var client: HomeClient
    @Environment(\.openURL) private var openURL
    @State private var token = ""
    @State private var busy = false
    @State private var error: String?
    @State private var linking = false
    @State private var checking = false
    @State private var checked = false
    @State private var confirmDisconnect = false
    private var privateChats: [TelegramChat] { (client.telegram?.chats ?? []).filter(\.isPairedOwner) }
    private var linked: Bool { !privateChats.isEmpty }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack {
                Text("Telegram на «\(client.executionDeviceName)»").font(.headline)
                Spacer()
                if client.telegram?.configured == true {
                    Menu {
                        Button("Отключить бота…", role: .destructive) { confirmDisconnect = true }
                    } label: { Image(systemName: "ellipsis.circle") }.menuIndicator(.hidden).accessibilityLabel("Настройки бота Telegram")
                }
            }
            if client.telegram?.configured == true {
                Label(client.telegram?.connectionError != nil ? "Telegram недоступен" : "Бот подключён", systemImage: client.telegram?.connectionError != nil ? "wifi.exclamationmark" : "checkmark.circle.fill").foregroundStyle(AppTheme.accent)
                if let name = client.telegram?.botUsername { Text("@" + name).font(.callout).textSelection(.enabled) }
                if linked {
                    ForEach(privateChats) { chat in
                        let name = client.profiles.first(where: { $0.id == chat.profileId })?.name ?? "Общий помощник"
                        Text("Личный чат: \(name)").font(.callout).foregroundStyle(AppTheme.secondaryText)
                    }
                } else {
                    Text("Свяжите свой Telegram, чтобы писать общему помощнику и добавлять сотрудников в группы.")
                        .font(.callout).foregroundStyle(AppTheme.secondaryText)
                }
                if let problem = client.telegram?.lastError {
                    Text(UserFacingError.text(problem)).font(.callout).foregroundStyle(AppTheme.destructive)
                } else if client.telegram?.running != true {
                    Text("Бот остановлен. Проверьте, что OpenStrudel работает на этом устройстве.").font(.callout).foregroundStyle(AppTheme.secondaryText)
                }
                HStack {
                    Button(checking ? "Проверяем…" : "Проверить связь") {
                        checking = true; checked = false; error = nil
                        Task {
                            defer { checking = false }
                            do { try await client.checkTelegramConnection(); checked = client.telegram?.connectionError == nil }
                            catch { self.error = UserFacingError.text(error.localizedDescription) }
                        }
                    }.disabled(checking).accessibilityIdentifier("checkTelegramConnection")
                    if checking { ProgressView().controlSize(.small) }
                    else if checked && client.telegram?.connectionError == nil { Text("Telegram отвечает").font(.caption).foregroundStyle(AppTheme.secondaryText) }
                }
                Button(linking ? "Готовим подключение…" : linked ? "Открыть личный чат" : "Связать мой Telegram") {
                    linking = true; error = nil
                    Task {
                        if linked, let name = client.telegram?.botUsername, let url = URL(string: "https://t.me/" + name) {
                            openURL(url)
                        } else {
                            await client.createTelegramLink()
                            if let url = client.telegramLink?.url { openURL(url) }
                            else { error = client.errorMessage; client.errorMessage = nil }
                        }
                        linking = false
                    }
                }.buttonStyle(.borderedProminent).disabled(linking).accessibilityIdentifier("openPersonalTelegram")
                if linked {
                    Text("Для группы откройте сотрудника → Telegram → Добавить в группу.").font(.caption).foregroundStyle(AppTheme.secondaryText)
                }
                if client.telegramLink != nil && !linked {
                    Text("Нажмите «Начать» в Telegram. Здесь появится подтверждение подключения.").font(.caption).foregroundStyle(AppTheme.secondaryText)
                }
            } else {
                Text("1. Откройте BotFather и создайте бота командой /newbot.")
                    .font(.callout).fixedSize(horizontal: false, vertical: true)
                Link("Открыть BotFather", destination: URL(string: "https://t.me/BotFather")!)
                Text("2. Скопируйте выданный ключ и вставьте сюда.").font(.callout)
                SecureField("Ключ бота из BotFather", text: $token).textFieldStyle(.roundedBorder)
                    .accessibilityIdentifier("telegramBotToken")
                Button {
                    busy = true; error = nil
                    Task {
                        do { try await client.configureTelegram(token: token); token = "" }
                        catch { self.error = UserFacingError.text(error.localizedDescription) }
                        busy = false
                    }
                } label: {
                    HStack { if busy { ProgressView().controlSize(.small) }; Text(busy ? "Проверяем бота…" : "Подключить бота") }
                }.buttonStyle(.borderedProminent).disabled(busy || token.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    .accessibilityIdentifier("connectTelegramBot")
                Text("Ключ хранится на устройстве сотрудника. Используйте отдельного бота для каждого устройства.")
                    .font(.caption).foregroundStyle(AppTheme.secondaryText).fixedSize(horizontal: false, vertical: true)
            }
            if let error { Text(error).font(.callout).foregroundStyle(AppTheme.destructive) }
        }
        .task { await client.loadChatSettings() }
        .confirmationDialog("Отключить бота?", isPresented: $confirmDisconnect, titleVisibility: .visible) {
            Button("Отключить", role: .destructive) {
                Task {
                    await client.disconnectTelegram()
                    if let problem = client.errorMessage { error = UserFacingError.text(problem); client.errorMessage = nil }
                }
            }
            Button("Отмена", role: .cancel) {}
        } message: { Text("Бот перестанет отвечать в личном чате и группах. Сотрудники и переписка сохранятся.") }
        .task(id: client.normalizedBaseURL) {
            while !Task.isCancelled {
                do { try await Task.sleep(for: .seconds(5)) } catch { return }
                await client.loadChatSettings()
            }
        }
    }
}
