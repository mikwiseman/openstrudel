import SwiftUI

struct TelegramSetupView: View {
    @EnvironmentObject private var client: HomeClient
    @Environment(\.openURL) private var openURL
    @State private var token = ""
    @State private var busy = false
    @State private var error: String?
    @State private var linking = false
    private var linked: Bool {
        client.telegram?.chats?.contains { !$0.chatId.hasPrefix("-") && $0.allowedSenders.contains($0.chatId) && $0.profileId == client.activeProfile?.id } == true
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Telegram на «\(client.executionDeviceName)»").font(.headline)
            if client.telegram?.configured == true {
                Label(linked ? "Чат подключён" : "Бот подключён", systemImage: "checkmark.circle.fill").foregroundStyle(AppTheme.accent)
                Text(linked ? "Пишите в Telegram — отвечает «\(client.activeAgentName)»." : "Свяжите личный чат с «\(client.activeAgentName)».")
                    .font(.callout).foregroundStyle(AppTheme.secondaryText)
                if let problem = client.telegram?.lastError {
                    Text(UserFacingError.text(problem)).font(.callout).foregroundStyle(AppTheme.destructive)
                    Button("Проверить связь") { Task { await client.loadChatSettings() } }
                } else if client.telegram?.running != true {
                    Text("Бот остановлен. Проверьте, что OpenStrudel работает на этом устройстве.").font(.callout).foregroundStyle(AppTheme.secondaryText)
                }
                Button(linking ? "Готовим подключение…" : "Открыть чат в Telegram") {
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
                }.buttonStyle(.borderedProminent).disabled(linking)
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
        .task(id: client.telegramLink?.code) {
            guard client.telegramLink != nil else { return }
            for _ in 0..<300 {
                if linked || Task.isCancelled { return }
                do { try await Task.sleep(for: .seconds(2)) } catch { return }
                await client.loadChatSettings()
            }
        }
    }
}
