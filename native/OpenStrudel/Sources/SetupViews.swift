import SwiftUI

/// A generous, wrapping label; native glass supplies the material and interaction.
struct SetupActionLabel: View {
    let title: String
    var icon: String? = nil

    var body: some View {
        HStack(spacing: 10) {
            if let icon { Image(systemName: icon).accessibilityHidden(true) }
            Text(title).fixedSize(horizontal: false, vertical: true)
        }
        #if os(macOS)
        .font(.system(size: 16, weight: .semibold))
        #else
        .font(.body.weight(.semibold))
        #endif
        .multilineTextAlignment(.center)
        .frame(maxWidth: .infinity, minHeight: 32)
        .padding(.vertical, 6)
        .contentShape(Rectangle())
    }
}

/// Cloud setup keeps the provider's account and billing in the user's name.
struct ServerSetupView: View {
    @Environment(\.dismiss) private var dismiss
    @EnvironmentObject private var client: HomeClient
    @StateObject private var cloud = DigitalOceanCloud.shared
    @State private var connecting = false
    @State private var connectionError: String?

    private var working: Bool {
        [.signingIn, .creating, .waitingForServer].contains(cloud.phase)
    }

    private var title: String {
        switch cloud.phase {
        case .idle: "Сотрудники в облаке"
        case .signingIn: "Войдите в DigitalOcean."
        case .billingRequired: "Подключите оплату."
        case .readyToCreate: "Всё готово к запуску."
        case .creating, .waitingForServer: "Готовим вашу команду."
        case .connected: "Всё готово."
        case .failed: "Настройка не завершена"
        }
    }

    private var explanation: String {
        switch cloud.phase {
        case .idle:
            "Сотрудники смогут работать, когда Mac выключен. Размещение предоставляет DigitalOcean. Для начала войдите в свой аккаунт или создайте его."
        case .signingIn:
            "Завершите вход в открывшемся окне. Пароль получает только DigitalOcean."
        case .billingRequired:
            "Добавьте способ оплаты на сайте DigitalOcean, затем вернитесь сюда. Данные карты остаются у провайдера."
        case .readyToCreate:
            "OpenStrudel установится на отдельном сервере в вашем аккаунте DigitalOcean. Проверьте стоимость перед запуском."
        case .creating, .waitingForServer:
            "Обычно настройка занимает несколько минут. Можно закрыть окно и вернуться позже. Прогресс сохранится."
        case .connected:
            "Открываем OpenStrudel. Дальше останется войти в свой аккаунт OpenAI."
        case .failed:
            "Ваш прогресс сохранён. Продолжите настройку, когда будете готовы."
        }
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 28) {
                    Image(systemName: cloud.phase == .connected ? "checkmark" : "cloud")
                        .font(.system(size: 34, weight: .light))
                        .foregroundStyle(AppTheme.secondaryText).accessibilityHidden(true)
                    VStack(alignment: .leading, spacing: 16) {
                        Text(title)
                            .font(.system(.largeTitle, design: .serif, weight: .medium))
                            .fixedSize(horizontal: false, vertical: true)
                        Text(explanation)
                            .font(.body).foregroundStyle(AppTheme.secondaryText)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    if cloud.phase == .readyToCreate, let quote = cloud.quote {
                        VStack(alignment: .leading, spacing: 8) {
                            Text(quote.monthlyPrice.formatted(.currency(code: "USD")) + " / месяц")
                                .font(.title2.weight(.semibold)).monospacedDigit()
                            Text("Оплата напрямую DigitalOcean. Подписка ChatGPT оплачивается отдельно.")
                                .font(.callout).foregroundStyle(AppTheme.secondaryText)
                                .fixedSize(horizontal: false, vertical: true)
                            Text("Начисляется за время размещения, пока вы не удалите его в DigitalOcean. Налоги могут добавляться отдельно.")
                                .font(.footnote).foregroundStyle(AppTheme.secondaryText)
                                .fixedSize(horizontal: false, vertical: true)
                        }.accessibilityElement(children: .combine)
                    }
                    if let message = connectionError ?? cloud.message {
                        Text(message).font(.callout).foregroundStyle(AppTheme.secondaryText)
                            .fixedSize(horizontal: false, vertical: true)
                            .accessibilityIdentifier("cloudSetupMessage")
                    }
                    if working {
                        HStack(spacing: 12) {
                            ProgressView().controlSize(.small)
                            Text(cloud.phase == .signingIn ? "Ожидаем входа" : "Настраиваем OpenStrudel")
                                .font(.callout).foregroundStyle(AppTheme.secondaryText)
                        }.accessibilityElement(children: .combine)
                    }
                    actions
                    if let url = cloud.managementURL, cloud.phase != .connected {
                        Link("Открыть в DigitalOcean", destination: url)
                            .font(.callout)
                            .buttonStyle(.plain).foregroundStyle(AppTheme.accent)
                        Text("Размещение оплачивается, пока вы не удалите его в DigitalOcean.")
                            .font(.footnote).foregroundStyle(AppTheme.secondaryText)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    if cloud.phase == .idle {
                        Text("Понадобится аккаунт DigitalOcean и способ оплаты. Стоимость покажем до запуска.")
                            .font(.footnote).foregroundStyle(AppTheme.secondaryText)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }.padding(32).frame(maxWidth: 480).frame(maxWidth: .infinity)
            }
            .defaultScrollAnchor(.center, for: .alignment)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(working ? "Продолжить позже" : "Закрыть") {
                        cloud.cancel()
                        dismiss()
                    }
                }
            }
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
        }
        .task {
            await cloud.resume()
            await finishConnection()
        }
        .onChange(of: cloud.connection?.url) { _, _ in
            Task { await finishConnection() }
        }
        #if os(macOS)
        .frame(width: 520, height: 620)
        #else
        .presentationDetents([.large])
        .presentationDragIndicator(.visible)
        #endif
    }

    @ViewBuilder private var actions: some View {
        switch cloud.phase {
        case .idle:
            Button { Task { await cloud.signIn() } } label: {
                SetupActionLabel(title: "Продолжить с DigitalOcean", icon: "arrow.up.right")
            }.buttonStyle(.glassProminent).controlSize(.large)
                .accessibilityIdentifier("cloudSignIn")
        case .billingRequired:
            VStack(spacing: 12) {
                Link(destination: URL(string: "https://cloud.digitalocean.com/account/billing")!) {
                    SetupActionLabel(title: "Добавить способ оплаты", icon: "arrow.up.right")
                }.buttonStyle(.glassProminent).controlSize(.large)
                Button { Task { await cloud.resume() } } label: {
                    SetupActionLabel(title: "Продолжить")
                }.buttonStyle(.glass).controlSize(.large)
            }
        case .readyToCreate:
            Button { Task { await cloud.confirmCreate() } } label: {
                SetupActionLabel(title: "Подтвердить и запустить", icon: "arrow.right")
            }.buttonStyle(.glassProminent).controlSize(.large)
                .accessibilityIdentifier("cloudConfirmCost")
        case .failed:
            Button { Task { await cloud.resume() } } label: {
                SetupActionLabel(title: "Продолжить настройку", icon: "arrow.clockwise")
            }.buttonStyle(.glassProminent).controlSize(.large)
        case .connected:
            if connectionError != nil {
                Button { Task { await finishConnection() } } label: {
                    SetupActionLabel(title: "Открыть команду", icon: "arrow.right")
                }.buttonStyle(.glassProminent).controlSize(.large).disabled(connecting)
            }
        case .signingIn:
            #if os(macOS)
            if let url = cloud.authorizationURL {
                Link("Открыть вход в браузере", destination: url)
                    .buttonStyle(.glass).controlSize(.large)
            }
            #endif
        case .creating, .waitingForServer:
            EmptyView()
        }
    }

    private func finishConnection() async {
        guard let connection = cloud.connection, !connecting else { return }
        connecting = true
        defer { connecting = false }
        if await client.connectToCloud(connection) {
            dismiss()
        } else {
            connectionError = client.pairingError ?? "Не удалось сохранить подключение. Разблокируйте устройство и попробуйте ещё раз."
        }
    }
}

struct AIDataConsentView: View {
    let accept: () -> Void

    var body: some View {
        ScrollView {
            VStack(spacing: 24) {
                OpenStrudelMark(size: 76)
                Text("Как используются ваши данные")
                    .font(.system(.largeTitle, design: .serif, weight: .medium))
                Text("Чтобы ответить вам, OpenStrudel передаёт сообщения, выбранные файлы и нужные сведения из переписки в OpenAI. История хранится на вашем Mac или личном сервере.")
                    .font(.body).foregroundStyle(AppTheme.secondaryText)
                Text("Подключённые сервисы получают данные только при использовании их инструментов. Добавляйте только то, чем готовы поделиться.")
                    .font(.callout).foregroundStyle(AppTheme.secondaryText)
                Link(destination: URL(string: "https://waiwai.is/openstrudel/privacy")!) {
                    Text("Как используются данные").frame(minHeight: 44).contentShape(Rectangle())
                }
                    .font(.callout)
                    .buttonStyle(.plain).foregroundStyle(AppTheme.accent)
                Button(action: accept) {
                    SetupActionLabel(title: "Разрешить и продолжить")
                }
                    .buttonStyle(.glassProminent).controlSize(.large)
                    .accessibilityIdentifier("acceptAIDataSharing")
            }.multilineTextAlignment(.center).padding(32).frame(maxWidth: 480)
                .frame(maxWidth: .infinity)
        }.defaultScrollAnchor(.center, for: .alignment)
    }
}
