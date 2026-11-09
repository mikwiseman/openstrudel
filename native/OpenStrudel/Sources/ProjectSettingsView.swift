import SwiftUI
import UniformTypeIdentifiers

/// An advanced employee setting in the existing details sheet. Only the Home grants filesystem access.
struct ProjectSettingsView: View {
    @EnvironmentObject private var client: HomeClient
    let employeeID: String
    @StateObject private var model = ProjectSettingsModel()
    @State private var adding = false
    @State private var name = ""
    @State private var path = ""
    @State private var choosingFolder = false
    @State private var folderTarget: EmployeeProjectTarget?
    @State private var fileError: String?
    private enum Field: Hashable { case name, path }
    @FocusState private var field: Field?
    private struct LoadKey: Equatable { let target: EmployeeProjectTarget?; let owner: Bool }

    private var profile: EmployeeProfile? { client.profiles.first { $0.id == employeeID } }
    private var target: EmployeeProjectTarget? {
        guard let profile, let homeID = client.health?.homeId,
              let deviceID = profile.deviceId ?? client.health?.nodeId else { return nil }
        return EmployeeProjectTarget(connectionID: client.id, homeID: homeID, deviceID: deviceID, employeeID: employeeID)
    }
    private var deviceName: String {
        guard let target else { return client.displayName }
        return target.deviceID == client.health?.nodeId ? client.displayName : client.devices.first { $0.id == target.deviceID }?.name ?? target.deviceID
    }
    private var canChooseLocalFolder: Bool {
        #if os(macOS)
        target != nil && client.isLocalConnection && target?.deviceID == client.health?.nodeId
        #else
        false
        #endif
    }
    private func current(_ captured: EmployeeProjectTarget) -> Bool {
        target == captured && client.canManageOpenAI && !client.isOffline(profile)
    }

    var body: some View {
        Form {
            SheetTitleSection(title: L("Project"), beforeHeader: true)
            Section {
                Text(L("Project on \(deviceName)"))
                    .font(.subheadline).foregroundStyle(.secondary)
                Text(L("This employee can edit the checkout in your private chat. Shared groups and scheduled runs cannot use it."))
                    .font(.subheadline).fixedSize(horizontal: false, vertical: true)
                Text(L("Project work requires Codex. Use the employee’s existing model settings."))
                    .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
            if model.loading {
                Section { ProgressView().accessibilityLabel(L("Loading projects")) }
            } else if client.canManageOpenAI, model.target == target, let catalog = model.catalog, let captured = target {
                Section {
                    Picker(L("Project"), selection: $model.selection) {
                        Text(L("None")).tag("")
                        ForEach(catalog.projects.filter { $0.enabled || $0.id == model.original }) { project in
                            Text(project.enabled ? project.name : L("\(project.name) · disabled"))
                                .tag(project.id).disabled(!project.enabled)
                        }
                    }
                    .accessibilityIdentifier("employeeProjectChoice")
                    if let project = catalog.projects.first(where: { $0.id == model.selection }) {
                        Text(project.path).font(.caption.monospaced()).foregroundStyle(.secondary).textSelection(.enabled)
                    }
                    if model.changed {
                        Button(model.selection.isEmpty ? L("Disconnect project") : L("Connect project")) {
                            Task { await model.connect(current: { current(captured) }, bind: { revision, id in
                                try await client.projectSettings(captured.bindingPath, method: "POST", payload: ["revision": revision, "projectId": id as Any? ?? NSNull()])
                            }) }
                        }.accessibilityIdentifier("connectEmployeeProject")
                    }
                    if model.saved { Text(L("Project saved. It applies to the next private request.")).foregroundStyle(.secondary).accessibilityIdentifier("projectSaved") }
                }
                Section {
                    DisclosureGroup(isExpanded: $adding) {
                        TextField(L("Project name"), text: $name).focused($field, equals: .name)
                            .submitLabel(.next).onSubmit { field = .path }.accessibilityIdentifier("projectName")
                        TextField(L("Checkout path on this device"), text: $path)
                            .focused($field, equals: .path).submitLabel(.done).onSubmit { field = nil }
                            .autocorrectionDisabled()
                            #if os(iOS)
                            .textInputAutocapitalization(.never)
                            #endif
                            .accessibilityIdentifier("projectPath")
                        if canChooseLocalFolder {
                            Button(L("Choose folder…")) { fileError = nil; folderTarget = captured; choosingFolder = true }.accessibilityIdentifier("chooseProjectFolder")
                        }
                        Text(L("Choose an existing Git checkout. Files stay on the employee’s device."))
                            .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                        Button(L("Register and connect")) {
                            let projectName = name.trimmingCharacters(in: .whitespacesAndNewlines)
                            let checkout = path.trimmingCharacters(in: .whitespacesAndNewlines)
                            Task {
                                await model.registerAndConnect(name: projectName, path: checkout, current: { current(captured) }, register: { revision, name, path in
                                    try await client.projectSettings(captured.catalogPath, method: "POST", payload: ["revision": revision, "name": name, "path": path, "enabled": true])
                                }, bind: { revision, id in
                                    try await client.projectSettings(captured.bindingPath, method: "POST", payload: ["revision": revision, "projectId": id as Any? ?? NSNull()])
                                })
                                if model.saved { adding = false; name = ""; path = "" }
                            }
                        }
                        .disabled(name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || name.count > 80 || !path.trimmingCharacters(in: .whitespacesAndNewlines).hasPrefix("/"))
                        .accessibilityIdentifier("registerEmployeeProject")
                    } label: {
                        // Named on its label: an identifier on the group would reach every field inside it.
                        Text(L("Add project")).accessibilityIdentifier("addProject")
                    }
                    if let fileError { Text(fileError).foregroundStyle(AppTheme.warning) }
                }
            }
            if model.busy { Section { ProgressView().accessibilityLabel(L("Сохраняем…")) } }
            if client.canManageOpenAI, model.target == target, let project = model.registeredButUnbound {
                Section { Text(L("\(project.name) was registered, but its employee connection was not confirmed. Reload to check before continuing.")) }
            }
            if let error = model.error, model.target == target || model.target == nil {
                Section {
                    Text(L10n.serviceText(error)).foregroundStyle(AppTheme.warning).fixedSize(horizontal: false, vertical: true)
                    Button(L("Reload projects")) { Task { await load() } }.disabled(model.busy)
                }.accessibilityIdentifier("projectSettingsError")
            } else if target == nil {
                Section { Text(L("The employee’s device is unavailable. Reconnect and reopen Project.")) }
            }
        }
        .formStyle(.grouped).sheetPageTitle(L("Project"))
        .disabled(model.busy)
        .task(id: LoadKey(target: target, owner: client.canManageOpenAI)) {
            name = ""; path = ""; fileError = nil; adding = false; choosingFolder = false; folderTarget = nil; await load()
        }
        .fileImporter(isPresented: $choosingFolder, allowedContentTypes: [.folder]) { result in
            guard canChooseLocalFolder, let captured = folderTarget, current(captured) else { return }
            if case .success(let url) = result {
                let granted = url.startAccessingSecurityScopedResource()
                defer { if granted { url.stopAccessingSecurityScopedResource() } }
                let canonical = url.resolvingSymlinksInPath().standardizedFileURL
                path = canonical.path
                if name.isEmpty { name = canonical.lastPathComponent }
            } else if case .failure(let error) = result, (error as? CocoaError)?.code != .userCancelled {
                fileError = error.localizedDescription
            }
        }
        #if os(iOS)
        .toolbar {
            ToolbarItemGroup(placement: .keyboard) {
                Spacer()
                Button { field = nil } label: { Image(systemName: "keyboard.chevron.compact.down") }
                    .accessibilityLabel(L("Скрыть клавиатуру")).accessibilityIdentifier("hideProjectKeyboard")
            }
        }
        #endif
        .accessibilityIdentifier("employeeProjectSettings")
    }

    private func load() async {
        guard client.canManageOpenAI else { model.refuseOwner(); return }
        guard let captured = target else { model.clear(); return }
        await model.load(target: captured, current: { current(captured) }) { try await client.projectSettings(captured.catalogPath) }
    }
}
