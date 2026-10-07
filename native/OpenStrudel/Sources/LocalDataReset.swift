#if os(macOS)
import Foundation
import Security

/// Only the native app's managed installation. Never follows a saved remote
/// connection, a custom database path, ~/.codex, or a developer checkout.
struct LocalDataReset: Sendable {
    let home: URL
    let bundleID: String
    var temporaryDirectory: URL? = nil
    static var current: Self { Self(home: URL(fileURLWithPath: NSHomeDirectory()), bundleID: Bundle.main.bundleIdentifier ?? "is.openstrudel.mac", temporaryDirectory: FileManager.default.temporaryDirectory.resolvingSymlinksInPath()) }
    private var manager: FileManager { .default }
    private var support: URL { home.appending(path: "Library/Application Support") }
    var marker: URL { support.appending(path: "." + bundleID + "-erase-pending") }
    var pending: Bool { manager.fileExists(atPath: marker.path) }
    var runtime: URL { support.appending(path: "OpenStrudel/runtime") }
    var launchAgent: URL { home.appending(path: "Library/LaunchAgents/is.openstrudel.home.plist") }
    var paths: [URL] {
        var result = [support.appending(path: "OpenStrudel"), support.appending(path: bundleID),
         home.appending(path: ".config/openstrudel"),
         home.appending(path: "Library/Caches/" + bundleID),
         home.appending(path: "Library/WebKit/" + bundleID),
         home.appending(path: "Library/HTTPStorages/" + bundleID),
         home.appending(path: "Library/Cookies/" + bundleID + ".binarycookies"),
         home.appending(path: "Library/Saved Application State/" + bundleID + ".savedState"), launchAgent]
        if let temporaryDirectory {
            result += ["OpenStrudelImages", "OpenStrudelFiles"].map { temporaryDirectory.appending(path: $0) }
            let downloads = (try? manager.contentsOfDirectory(atPath: temporaryDirectory.path)) ?? []
            result += downloads.filter { $0.hasPrefix("openstrudel-download-") }.map { temporaryDirectory.appending(path: $0) }
        }
        return result
    }

    enum Failure: LocalizedError {
        case unsafeLocation, customRuntime, cannotStop, cannotErase, keychain
        var errorDescription: String? {
            switch self {
            case .unsafeLocation: "Папка OpenStrudel перенесена или содержит перенаправление. Автоматический сброс остановлен, чтобы не затронуть другие данные."
            case .customRuntime: "На этом Mac используется нестандартная установка OpenStrudel. Автоматический сброс остановлен: её данные нужно проверить отдельно."
            case .cannotStop: "OpenStrudel на этом Mac ещё не остановился. Данные пока не удалены. Попробуйте продолжить сброс."
            case .cannotErase: "Не удалось удалить все данные. Часть сброса уже выполнена. Проверьте доступ к папке пользователя и продолжите сброс."
            case .keychain: "Не удалось удалить сохранённые входы. Разблокируйте Связку ключей и продолжите сброс."
            }
        }
    }

    func validate() throws {
        for path in paths + [marker] { try validatePath(path) }
        if manager.fileExists(atPath: launchAgent.path) {
            guard let data = try? Data(contentsOf: launchAgent),
                  let value = try? PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any],
                  value["Label"] as? String == "is.openstrudel.home",
                  value["WorkingDirectory"] as? String == runtime.path,
                  let env = value["EnvironmentVariables"] as? [String: String],
                  env["OPENSTRUDEL_DB"] == runtime.appending(path: ".data/openstrudel.sqlite").path
            else { throw Failure.customRuntime }
        }
    }

    private func validatePath(_ path: URL) throws {
        let base: URL
        if let temporaryDirectory, path.standardizedFileURL.path.hasPrefix(temporaryDirectory.path + "/") { base = temporaryDirectory }
        else { base = home.standardizedFileURL }
        guard path.standardizedFileURL.path.hasPrefix(base.path + "/") else { throw Failure.unsafeLocation }
        var item = path.standardizedFileURL
        while item.path != base.path {
            if let attributes = try? manager.attributesOfItem(atPath: item.path),
               attributes[.type] as? FileAttributeType == .typeSymbolicLink { throw Failure.unsafeLocation }
            item.deleteLastPathComponent()
        }
    }

    func begin() throws {
        try validate()
        try manager.createDirectory(at: support, withIntermediateDirectories: true)
        try Data("OpenStrudel local erase v1\n".utf8).write(to: marker, options: .atomic)
        try manager.setAttributes([.posixPermissions: 0o600], ofItemAtPath: marker.path)
    }

    /// Injecting the stop operation allows a full erase test in a temporary
    /// home without touching launchd or real credentials.
    func eraseFiles(stop: @Sendable () throws -> Void) throws {
        try validate()
        try stop()
        // Validate again after stopping; deleting a link's target is forbidden.
        try validate()
        for path in paths where manager.fileExists(atPath: path.path) {
            do { try manager.removeItem(at: path) }
            catch { throw Failure.cannotErase }
        }
    }

    func erasePreferences(connectionIDs: [String] = []) throws {
        let directory = home.appending(path: "Library/Preferences")
        try validatePath(directory)
        let names = (try? manager.contentsOfDirectory(atPath: directory.path)) ?? []
        let domains = Set([bundleID] + connectionIDs.filter { $0 != "current" }.map { bundleID + ".device." + $0 }
            + names.filter { $0.hasPrefix(bundleID + ".device.") && $0.hasSuffix(".plist") }.map { String($0.dropLast(6)) })
        for name in domains {
            try validatePath(directory.appending(path: name + ".plist"))
            UserDefaults.standard.removePersistentDomain(forName: name)
            UserDefaults(suiteName: name)?.synchronize()
        }
        UserDefaults.standard.synchronize()
    }

    func eraseCredentials() throws {
        let service = bundleID == "is.openstrudel.mac" ? "is.openstrudel.native" : bundleID + ".credentials"
        for name in [service, bundleID + ".digitalocean"] {
            let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: name]
            let status = SecItemDelete(query as CFDictionary)
            guard status == errSecSuccess || status == errSecItemNotFound else { throw Failure.keychain }
        }
    }

    func finish() throws {
        if pending { try manager.removeItem(at: marker) }
    }

    func stopManagedService() throws {
        let service = "gui/\(getuid())/is.openstrudel.home"
        let current = try Self.launchctl(["print", service])
        if current.status != 0 { try ensureNoListener(); return }
        // Inspect the loaded job too: its plist could have changed since boot.
        guard current.output.contains("working directory = " + runtime.path + "\n") else { throw Failure.customRuntime }
        let pid = current.output.split(separator: "\n").compactMap { line -> Int32? in
            let text = line.trimmingCharacters(in: .whitespaces)
            return text.hasPrefix("pid = ") ? Int32(text.dropFirst(6)) : nil
        }.first
        _ = try Self.launchctl(["bootout", service])
        for _ in 0..<100 {
            let removed = try Self.launchctl(["print", service]).status != 0
            let stopped = pid.map { kill($0, 0) != 0 && errno == ESRCH } ?? true
            if removed && stopped { try ensureNoListener(); return }
            Thread.sleep(forTimeInterval: 0.1)
        }
        throw Failure.cannotStop
    }

    private func ensureNoListener() throws {
        var ports: Set<Int> = [7788, 7789]
        if let data = try? Data(contentsOf: support.appending(path: "OpenStrudel/LocalConnection.json")),
           let value = try? JSONDecoder().decode([String: String].self, from: data),
           let text = value["url"], let url = URL(string: text), let port = url.port { ports.insert(port) }
        // A manually started runtime is not ours to kill. Refuse to erase its
        // live database rather than treating a missing launchd job as success.
        for port in ports {
            let result = try Self.run("/usr/sbin/lsof", ["-nP", "-t", "-iTCP:\(port)", "-sTCP:LISTEN"])
            guard result.status == 1 && result.output.isEmpty else { throw Failure.cannotStop }
        }
    }

    private static func launchctl(_ arguments: [String]) throws -> (status: Int32, output: String) {
        try run("/bin/launchctl", arguments)
    }

    private static func run(_ executable: String, _ arguments: [String]) throws -> (status: Int32, output: String) {
        let process = Process(), pipe = Pipe()
        process.executableURL = URL(fileURLWithPath: executable)
        process.arguments = arguments
        process.standardOutput = pipe; process.standardError = FileHandle.nullDevice
        try process.run()
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        return (process.terminationStatus, String(decoding: data, as: UTF8.self))
    }
}
#endif
