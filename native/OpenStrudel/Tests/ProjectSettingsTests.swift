import Foundation
import Testing

@MainActor
@Suite("Employee project settings") struct ProjectSettingsTests {
    private let target = EmployeeProjectTarget(connectionID: "connection", homeID: "home", deviceID: "device", employeeID: "employee")
    private let project = DevelopmentProject(id: "project", name: "Source", path: "/source/repo", enabled: true, revision: 1)
    private func catalog() -> DevelopmentProjects { DevelopmentProjects(revision: 4, projects: [project], bindings: [:]) }

    @Test func everyRequestRetainsItsExactEmployeeAndDevice() throws {
        let scope = EmployeeProjectTarget(connectionID: "connection", homeID: "home", deviceID: "device/with?query", employeeID: "employee/with?query")
        let catalog = try #require(URLComponents(string: scope.catalogPath))
        let binding = try #require(URLComponents(string: scope.bindingPath))
        #expect(catalog.path == "/v1/settings/projects")
        #expect(binding.percentEncodedPath == "/v1/profiles/employee%2Fwith%3Fquery/project")
        #expect(catalog.queryItems == [URLQueryItem(name: "deviceId", value: scope.deviceID)])
        #expect(binding.queryItems == catalog.queryItems)
    }

    @Test func anExistingChoiceRequiresTheExactRevisionAndConfirmedBinding() async {
        let model = ProjectSettingsModel()
        await model.load(target: target, current: { true }) { catalog() }
        model.selection = project.id
        var writes = 0
        await model.connect(current: { true }) { revision, id in
            writes += 1; #expect(revision == 4 && id == project.id)
            return ProjectBinding(saved: true, revision: 5, employeeId: target.employeeID, projectId: id)
        }
        #expect(writes == 1 && model.saved && !model.changed)
        #expect(model.catalog?.revision == 5 && model.original == project.id)
        await model.connect(current: { true }) { _, _ in Issue.record("An unchanged selection must not write"); throw ProjectSettingsError.unconfirmed }
        model.selection = ""
        await model.connect(current: { true }) { revision, id in
            #expect(revision == 5 && id == nil)
            return ProjectBinding(saved: true, revision: 6, employeeId: target.employeeID, projectId: nil)
        }
        #expect(model.original.isEmpty && model.saved)
    }

    @Test func anUnconfirmedWriteRequiresReloadAndIsNeverAutomaticallyRepeated() async {
        let model = ProjectSettingsModel()
        await model.load(target: target, current: { true }) { catalog() }
        model.selection = project.id
        var writes = 0
        let send: (Int, String?) async throws -> ProjectBinding = { revision, id in
            writes += 1
            return ProjectBinding(saved: true, revision: revision + 1, employeeId: "different-employee", projectId: id)
        }
        await model.connect(current: { true }, bind: send)
        #expect(!model.saved && model.catalog == nil && model.error != nil)
        await model.connect(current: { true }, bind: send)
        #expect(writes == 1)
    }

    @Test func registrationAndBindingHaveSeparateReceipts() async {
        let model = ProjectSettingsModel()
        await model.load(target: target, current: { true }) { catalog() }
        let added = DevelopmentProject(id: "added", name: "New", path: "/source/new", enabled: true, revision: 1)
        var steps: [String] = []
        await model.registerAndConnect(name: added.name, path: added.path, current: { true }, register: { revision, name, path in
            steps.append("register"); #expect(revision == 4 && name == added.name && path == added.path)
            return ProjectRegistration(saved: true, revision: 5, project: added)
        }, bind: { revision, id in
            steps.append("bind"); #expect(revision == 5 && id == added.id)
            #expect(model.registeredButUnbound == added && !model.saved)
            return ProjectBinding(saved: true, revision: 6, employeeId: target.employeeID, projectId: id)
        })
        #expect(steps == ["register", "bind"])
        #expect(model.saved && model.original == added.id && model.registeredButUnbound == nil)
    }

    @Test func anUncertainBindingKeepsOnlyTheRegistrationReceiptUntilReload() async {
        let model = ProjectSettingsModel()
        await model.load(target: target, current: { true }) { catalog() }
        await model.registerAndConnect(name: project.name, path: project.path, current: { true }, register: { _, _, _ in
            ProjectRegistration(saved: true, revision: 5, project: project)
        }, bind: { _, _ in throw URLError(.networkConnectionLost) })
        #expect(model.registeredButUnbound == project && !model.saved && model.catalog == nil)
        // Read the actual Home state; the previous POST is not repeated.
        await model.load(target: target, current: { true }) { DevelopmentProjects(revision: 6, projects: [project], bindings: [target.employeeID: project.id]) }
        #expect(model.original == project.id && model.registeredButUnbound == nil)
    }

    @Test func aChangedTargetOrOwnerRefusalCannotBindOrKeepPrivateRegistrationData() async {
        let model = ProjectSettingsModel()
        await model.load(target: target, current: { true }) { catalog() }
        var current = true, binds = 0
        await model.registerAndConnect(name: project.name, path: project.path, current: { current }, register: { _, _, _ in
            current = false
            return ProjectRegistration(saved: true, revision: 5, project: project)
        }, bind: { _, _ in binds += 1; throw ProjectSettingsError.unconfirmed })
        #expect(binds == 0 && model.catalog == nil && model.registeredButUnbound == nil)
        await model.load(target: target, current: { true }) { catalog() }
        await model.registerAndConnect(name: project.name, path: project.path, current: { true }, register: { _, _, _ in
            ProjectRegistration(saved: true, revision: 5, project: project)
        }, bind: { _, _ in throw ProjectSettingsError.ownerOnly })
        #expect(model.catalog == nil && model.registeredButUnbound == nil && !model.saved)
    }

    @Test func aLateCatalogCannotReplaceAnotherDeviceAndAPausedProjectCannotBeConnected() async {
        let model = ProjectSettingsModel(), old = catalog()
        var pending: CheckedContinuation<DevelopmentProjects, Error>?
        let reading = Task { await model.load(target: target, current: { true }) { try await withCheckedThrowingContinuation { pending = $0 } } }
        while pending == nil { await Task.yield() }
        let other = EmployeeProjectTarget(connectionID: "connection", homeID: "home", deviceID: "other", employeeID: "employee")
        let paused = DevelopmentProject(id: "paused", name: "Paused", path: "/other/repo", enabled: false, revision: 1)
        await model.load(target: other, current: { true }) { DevelopmentProjects(revision: 9, projects: [paused], bindings: [:]) }
        pending!.resume(returning: old); await reading.value
        #expect(model.target == other && model.catalog?.revision == 9)
        model.selection = paused.id
        await model.connect(current: { true }) { _, _ in Issue.record("A disabled project must not be bound"); throw ProjectSettingsError.unconfirmed }
        #expect(!model.saved && model.catalog?.revision == 9)
    }
}
