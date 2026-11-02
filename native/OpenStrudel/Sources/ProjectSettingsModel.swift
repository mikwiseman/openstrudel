import Foundation
import Combine

struct DevelopmentProject: Decodable, Identifiable, Equatable {
    let id: String; let name: String; let path: String; let enabled: Bool; let revision: Int
}
struct DevelopmentProjects: Decodable {
    var revision: Int
    var projects: [DevelopmentProject]
    var bindings: [String: String]
}
struct ProjectRegistration: Decodable { let saved: Bool; let revision: Int; let project: DevelopmentProject }
struct ProjectBinding: Decodable { let saved: Bool; let revision: Int; let employeeId: String; let projectId: String? }

/// Captured before reading or writing. A path belongs to this device, never to the phone displaying it.
struct EmployeeProjectTarget: Equatable {
    let connectionID: String; let homeID: String; let deviceID: String; let employeeID: String
    var catalogPath: String { routed("/v1/settings/projects") }
    var bindingPath: String {
        let component = employeeID.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? ""
        return routed("/v1/profiles/" + component + "/project")
    }
    private func routed(_ path: String) -> String {
        var url = URLComponents(); url.path = path
        url.queryItems = [URLQueryItem(name: "deviceId", value: deviceID)]
        return path + "?" + (url.percentEncodedQuery ?? "")
    }
}

enum ProjectSettingsError: LocalizedError, Equatable {
    case unsupported, ownerOnly, changed, unconfirmed
    var errorDescription: String? {
        switch self {
        case .unsupported: L("Update this Home to connect a development project.")
        case .ownerOnly: L("Only the Home owner can connect a development project.")
        case .changed: L("The employee or its device changed. Reopen Project before making changes.")
        case .unconfirmed: L("The Home did not confirm this change. Reload Project before trying again.")
        }
    }
}

/// Uses the existing owner API. Registration and binding remain separate acknowledged changes.
@MainActor
final class ProjectSettingsModel: ObservableObject {
    @Published private(set) var catalog: DevelopmentProjects?
    @Published var selection = ""
    @Published private(set) var loading = false
    @Published private(set) var busy = false
    @Published private(set) var error: String?
    @Published private(set) var registeredButUnbound: DevelopmentProject?
    @Published private(set) var saved = false
    private(set) var target: EmployeeProjectTarget?
    private var generation = 0
    var original: String { target.flatMap { catalog?.bindings[$0.employeeID] } ?? "" }
    var changed: Bool { catalog != nil && selection != original }

    func clear() {
        generation += 1; target = nil; catalog = nil; selection = ""; error = nil
        registeredButUnbound = nil; saved = false; loading = false; busy = false
    }
    func refuseOwner() { clear(); error = ProjectSettingsError.ownerOnly.localizedDescription }

    func load(target next: EmployeeProjectTarget, current: () -> Bool, read: () async throws -> DevelopmentProjects) async {
        clear(); target = next; let run = generation; loading = true
        defer { if generation == run { loading = false } }
        do {
            guard current() else { throw ProjectSettingsError.changed }
            let value = try await read()
            guard generation == run, !Task.isCancelled else { return }
            guard current() else { throw ProjectSettingsError.changed }
            catalog = value; selection = value.bindings[next.employeeID] ?? ""
        } catch {
            guard generation == run, !Task.isCancelled else { return }
            catalog = nil; self.error = error.localizedDescription
        }
    }

    func connect(current: () -> Bool, bind: (Int, String?) async throws -> ProjectBinding) async {
        guard !busy, changed, let catalog, let target else { return }
        let requested = selection.isEmpty ? nil : selection, run = generation
        guard requested == nil || catalog.projects.contains(where: { $0.id == requested && $0.enabled }) else { return }
        busy = true; error = nil; saved = false
        defer { if generation == run { busy = false } }
        do {
            guard current() else { throw ProjectSettingsError.changed }
            let receipt = try await bind(catalog.revision, requested)
            guard generation == run, !Task.isCancelled else { return }
            guard current() else { throw ProjectSettingsError.changed }
            try accept(receipt, expected: requested, target: target)
        } catch { fail(error, run: run, current: current()) }
    }

    func registerAndConnect(name: String, path: String, current: () -> Bool,
                            register: (Int, String, String) async throws -> ProjectRegistration,
                            bind: (Int, String?) async throws -> ProjectBinding) async {
        guard !busy, let catalog, let target else { return }
        let run = generation
        busy = true; error = nil; saved = false; registeredButUnbound = nil
        defer { if generation == run { busy = false } }
        do {
            guard current() else { throw ProjectSettingsError.changed }
            let receipt = try await register(catalog.revision, name, path)
            guard generation == run, !Task.isCancelled else { return }
            guard current() else { throw ProjectSettingsError.changed }
            guard receipt.saved, receipt.revision > catalog.revision, receipt.project.enabled,
                  !receipt.project.id.isEmpty, receipt.project.path == path else { throw ProjectSettingsError.unconfirmed }
            registeredButUnbound = receipt.project
            self.catalog = DevelopmentProjects(revision: receipt.revision, projects: catalog.projects + [receipt.project], bindings: catalog.bindings)
            selection = receipt.project.id
            // Recheck before the second write; a changed connection must never receive the binding.
            guard current() else { throw ProjectSettingsError.changed }
            let binding = try await bind(receipt.revision, receipt.project.id)
            guard generation == run, !Task.isCancelled else { return }
            guard current() else { throw ProjectSettingsError.changed }
            try accept(binding, expected: receipt.project.id, target: target)
        } catch { fail(error, run: run, current: current()) }
    }

    private func accept(_ receipt: ProjectBinding, expected: String?, target: EmployeeProjectTarget) throws {
        guard var catalog, receipt.saved, receipt.employeeId == target.employeeID,
              receipt.projectId == expected, receipt.revision > catalog.revision else { throw ProjectSettingsError.unconfirmed }
        catalog.revision = receipt.revision; catalog.bindings[target.employeeID] = expected
        self.catalog = catalog; selection = expected ?? ""; registeredButUnbound = nil; saved = true
    }

    private func fail(_ failure: Error, run: Int, current: Bool) {
        guard generation == run else { return }
        // An ambiguous write is never retried. Reload reads the actual saved binding and current revision.
        catalog = nil; selection = ""; saved = false
        if !current || failure is CancellationError { registeredButUnbound = nil }
        if case ProjectSettingsError.ownerOnly = failure { registeredButUnbound = nil }
        if case HomeClientError.authenticationExpired = failure { registeredButUnbound = nil }
        error = failure.localizedDescription
    }
}
