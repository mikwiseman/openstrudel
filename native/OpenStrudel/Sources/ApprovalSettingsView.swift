import SwiftUI

enum EmployeeApprovalMode: String, Codable, CaseIterable, Identifiable {
    case ask, auto, approveAll = "approve_all"
    var id: String { rawValue }
    var title: String {
        switch self {
        case .ask: "Спрашивать"
        case .auto: "Автоматически проверять"
        case .approveAll: "Без подтверждений"
        }
    }
    var explanation: String {
        switch self {
        case .ask: "Вы подтверждаете действия, которым нужно разрешение."
        case .auto: "Codex проверяет такие действия и выполняет разрешённые."
        case .approveAll: "Сотрудники выполняют поручения без дополнительных разрешений."
        }
    }
}

struct EmployeeApprovalSettings: Decodable {
    let mode: EmployeeApprovalMode
    let canManage: Bool
}

struct ApprovalSettingsView: View {
    @EnvironmentObject private var client: HomeClient
    @State private var settings: EmployeeApprovalSettings?
    @State private var loading = true
    @State private var saving = false
    @State private var error: String?
    @State private var confirmAll = false

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Действия сотрудников").font(.headline)
            Text("На «\(client.displayName)» · в приложении и Telegram")
                .font(.caption).foregroundStyle(AppTheme.secondaryText)
            if loading { ProgressView("Загружаем режим…").controlSize(.small) }
            if let settings {
                ForEach(EmployeeApprovalMode.allCases) { mode in
                    Button {
                        guard mode != settings.mode else { return }
                        if mode == .approveAll { confirmAll = true }
                        else { Task { await save(mode) } }
                    } label: {
                        HStack(alignment: .top, spacing: 12) {
                            Image(systemName: settings.mode == mode ? "checkmark.circle.fill" : "circle")
                                .foregroundStyle(settings.mode == mode ? AppTheme.accent : AppTheme.secondaryText)
                                .font(.title3).padding(.top, 1)
                            VStack(alignment: .leading, spacing: 4) {
                                Text(mode.title).font(.body.weight(.medium))
                                Text(mode.explanation).font(.callout).foregroundStyle(AppTheme.secondaryText)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                            Spacer(minLength: 0)
                        }.padding(.vertical, 7).frame(maxWidth: .infinity, alignment: .leading).contentShape(Rectangle())
                    }.buttonStyle(.plain).disabled(!settings.canManage || saving)
                        .accessibilityElement(children: .combine)
                        .accessibilityAddTraits(settings.mode == mode ? [.isSelected] : [])
                        .accessibilityIdentifier("approvalMode-" + mode.rawValue)
                }
                if saving { ProgressView("Сохраняем…").controlSize(.small) }
                Text(settings.canManage ? "Режим меняется со следующего поручения. Доступ к сервисам и правила сотрудника сохраняются." : "Режим меняет владелец этого устройства.")
                    .font(.caption).foregroundStyle(AppTheme.secondaryText).fixedSize(horizontal: false, vertical: true)
            }
            if let error {
                Text(error).font(.callout).foregroundStyle(AppTheme.warning)
                Button("Повторить") { Task { await load() } }.disabled(loading || saving)
            }
        }
        .task { await load() }
        .confirmationDialog("Выполнять без подтверждений?", isPresented: $confirmAll, titleVisibility: .visible) {
            Button("Включить для этого устройства") { Task { await save(.approveAll) } }
            Button("Отмена", role: .cancel) { }
        } message: {
            Text("Все сотрудники на «\(client.displayName)» смогут выполнять порученные действия в доступных сервисах, включая изменение и удаление данных. В Telegram это относится к запросам допущенных участников.")
        }
    }

    private func load() async {
        loading = true; error = nil
        defer { loading = false }
        do { settings = try await client.management("/v1/settings/approvals") }
        catch is CancellationError { }
        catch { self.error = UserFacingError.text(error.localizedDescription) }
    }
    private func save(_ mode: EmployeeApprovalMode) async {
        saving = true; error = nil
        defer { saving = false }
        do { settings = try await client.management("/v1/settings/approvals", method: "POST", payload: ["mode": mode.rawValue, "confirm": mode == .approveAll]) }
        catch is CancellationError { }
        catch { self.error = UserFacingError.text(error.localizedDescription) }
    }
}
