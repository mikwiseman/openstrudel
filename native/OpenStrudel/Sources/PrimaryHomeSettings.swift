import SwiftUI

struct AgentAccountPreference: View {
    @EnvironmentObject private var client: HomeClient
    let profile: EmployeeProfile
    @State private var accounts: [ManagedCodexAccount] = []
    @State private var selection = ""
    @State private var original = ""
    @State private var error: String?
    @State private var busy = false
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Divider()
            Text("Аккаунт OpenAI").font(.subheadline.weight(.medium))
            if let device = client.devices.first(where: { $0.id == profile.deviceId }) {
                Text("Работает на «\(device.id == client.health?.nodeId ? client.displayName : device.name)»")
                    .font(.caption).foregroundStyle(AppTheme.secondaryText)
            }
            Picker("Использовать", selection: $selection) {
                Text("По умолчанию").tag("")
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
            if let error { Text(error).font(.caption).foregroundStyle(AppTheme.destructive) }
        }.task {
            do {
                struct Policy: Decodable { let accountIds: [String]? }
                let result: ManagedCodexAccounts = try await client.management("/v1/accounts" + (profile.deviceId.map { "?deviceId=" + $0 } ?? ""))
                accounts = result.accounts
                let policy: Policy = try await client.management("/v1/agents/" + profile.id + "/accounts")
                if let ids = policy.accountIds, ids.count == 1 { selection = ids[0] }
                else if (policy.accountIds?.count ?? 0) > 1 { error = "У сотрудника свой порядок аккаунтов. Новый выбор заменит его." }
                original = selection
            } catch { self.error = error.localizedDescription }
        }
    }
}
