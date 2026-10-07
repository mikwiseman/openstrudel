#if os(macOS)
import SwiftUI

struct LocalDataResetButton: View {
    @State private var showing = false
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Divider().padding(.bottom, 8)
            Button("Стереть данные OpenStrudel на этом Mac…", role: .destructive) { showing = true }
                .accessibilityIdentifier("eraseLocalData")
            Text("Удалить местных сотрудников, переписку и настройки и начать заново.")
                .font(.caption).foregroundStyle(AppTheme.secondaryText)
        }
        .sheet(isPresented: $showing) { LocalDataResetConfirmation() }
    }
}

struct LocalDataResetConfirmation: View {
    @EnvironmentObject private var library: DeviceLibrary
    @Environment(\.dismiss) private var dismiss
    @State private var acknowledged = false
    @State private var preparingBackup = false
    @State private var backup: HomeClient?
    @State private var backupError: String?

    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 20) {
                Label("Стереть данные этого Mac?", systemImage: "trash").font(.title2.weight(.semibold))
                Text("Сотрудники, которые работают на этом Mac, их чаты, файлы и расписания будут удалены. С других устройств они тоже станут недоступны.")
                    .fixedSize(horizontal: false, vertical: true)
                Text("Сохранённые входы и подключения будут сброшены. Сотрудники на других Mac и серверах продолжат работать. Оплата серверов не остановится.")
                    .font(.callout).foregroundStyle(AppTheme.secondaryText).fixedSize(horizontal: false, vertical: true)
                Button {
                    preparingBackup = true; backupError = nil
                    Task {
                        let local = library.clients.first(where: \.isLocalConnection) ?? library.newConnection()
                        if local.health == nil { await local.startLocalHome() }
                        if local.health != nil { backup = local }
                        else { backupError = local.errorMessage ?? "Не удалось открыть сотрудников этого Mac для копии." }
                        preparingBackup = false
                    }
                } label: {
                    HStack { if preparingBackup { ProgressView().controlSize(.small) }; Text("Сначала сохранить копию…") }
                }.disabled(preparingBackup).accessibilityIdentifier("backupBeforeErase")
                if let message = backupError ?? library.eraseError { Text(message).font(.callout).foregroundStyle(AppTheme.destructive) }
                Toggle("Я понимаю, что удаление нельзя отменить", isOn: $acknowledged)
                    .accessibilityIdentifier("acknowledgeLocalErase")
                HStack {
                    Spacer()
                    Button("Отмена") { dismiss() }.keyboardShortcut(.cancelAction)
                    Button("Стереть данные", role: .destructive) { Task { await library.eraseThisMac() } }
                        .disabled(!acknowledged || preparingBackup)
                        .accessibilityIdentifier("confirmLocalErase")
                }
            }.padding(28)
        }.frame(width: 550)
        .sheet(item: $backup) { client in
            NavigationStack {
                ScrollView { AgentTransferSettings(localOnly: true).environmentObject(client).padding(24) }
                    .navigationTitle("Копия сотрудников этого Mac")
                    .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Готово") { backup = nil } } }
            }.frame(width: 560, height: 450)
        }
    }
}

struct LocalDataResetProgress: View {
    @EnvironmentObject private var library: DeviceLibrary
    var body: some View {
        VStack(spacing: 20) {
            Image(systemName: library.erased ? "checkmark.circle" : "externaldrive")
                .font(.system(size: 44)).foregroundStyle(AppTheme.accent)
            Text(library.erased ? "Этот Mac готов к новому началу" : "Сброс OpenStrudel")
                .font(.title2.weight(.semibold))
            if let phase = library.erasePhase {
                ProgressView(phase).controlSize(.small)
                Text("Это может занять некоторое время. Не закрывайте приложение.")
                    .font(.caption).foregroundStyle(AppTheme.secondaryText)
            } else if library.erased {
                Text("Местные данные и сохранённые входы удалены.").foregroundStyle(AppTheme.secondaryText)
                Button("Начать заново") { library.startAfterErase() }.buttonStyle(.borderedProminent)
                    .accessibilityIdentifier("startAfterErase")
            } else {
                Text(library.eraseError ?? "Предыдущий сброс не завершился. Продолжите удаление данных этого Mac.")
                    .font(.callout).multilineTextAlignment(.center)
                Button("Продолжить сброс") { Task { await library.eraseThisMac() } }.buttonStyle(.borderedProminent)
                Button("Закрыть OpenStrudel") { NSApp.terminate(nil) }
            }
        }.padding(32).frame(maxWidth: .infinity, maxHeight: .infinity).background(HomeBackground())
            .accessibilityIdentifier("localEraseProgress")
    }
}
#endif
