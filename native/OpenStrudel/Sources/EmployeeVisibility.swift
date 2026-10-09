import SwiftUI

struct HiddenEmployeesButton: View {
    @EnvironmentObject private var library: DeviceLibrary
    @State private var showing = false
    private var count: Int { library.visibleClients.reduce(0) { $0 + library.hiddenProfiles(on: $1).count } }

    var body: some View {
        if count > 0 {
            Button { showing = true } label: {
                Label("Скрытые сотрудники · \(count)", systemImage: "eye.slash")
                    .font(.callout).foregroundStyle(.secondary)
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("hiddenEmployees")
            .sheet(isPresented: $showing) { HiddenEmployeesView() }
        }
    }
}

private struct HiddenEmployeesView: View {
    @EnvironmentObject private var library: DeviceLibrary
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        NavigationStack {
            List {
                Text("Скрыты только в этом приложении. Сотрудники продолжают работать и доступны на других устройствах.")
                    .font(.callout).foregroundStyle(.secondary)
                ForEach(library.visibleClients) { source in
                    let hidden = library.hiddenProfiles(on: source)
                    if !hidden.isEmpty {
                        Section(source.displayName) {
                            ForEach(hidden) { profile in
                                HStack(spacing: 12) {
                                    AgentAvatar(appearance: profile.resolvedAppearance, size: 32)
                                    Text(profile.name)
                                    Spacer()
                                    Button("Показать") { Task { await library.setHidden(false, profile: profile, on: source) } }
                                        .buttonStyle(.borderless)
                                        .accessibilityLabel("Показать «\(profile.name)»")
                                }.padding(.vertical, 4).accessibilityElement(children: .contain)
                            }
                        }
                    }
                }
            }
            .navigationTitle("Скрытые сотрудники")
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Готово") { dismiss() } } }
        }
        #if os(macOS)
        .frame(width: 480, height: 400)
        #endif
    }
}
