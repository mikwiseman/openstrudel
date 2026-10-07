#if os(macOS)
import Foundation

/// The bundled Home is the same runtime used on a server. No terminal setup.
@MainActor enum LocalHome {
    private static var starting: Task<[String: String], Error>?
    private static var erasing = false
    static var directory: URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
            .appending(path: "OpenStrudel")
    }

    static var isAvailable: Bool {
        FileManager.default.fileExists(atPath: directory.appending(path: "runtime/dist/cli.js").path)
            || Bundle.main.url(forResource: "Runtime", withExtension: nil) != nil
    }

    static func start() async throws -> [String: String] {
        guard !erasing, !LocalDataReset.current.pending else { throw CancellationError() }
        if let starting { return try await starting.value }
        let task = Task { try await startRuntime() }
        starting = task
        defer { starting = nil }
        return try await task.value
    }

    static func prepareForErase() async {
        erasing = true
        // A startup already in flight must finish before its service is stopped.
        if let starting { _ = try? await starting.value }
    }

    static func finishErase() { erasing = false }

    private static func startRuntime() async throws -> [String: String] {
        let bundled = Bundle.main.url(forResource: "Runtime", withExtension: nil)
        let target = directory
        try await Task.detached {
            let manager = FileManager.default
            // Program files follow the installed app; existing user data stays
            // in its original directory and is never copied over by an update.
            let dataDirectory = target.appending(path: "runtime")
            let runtime = bundled ?? dataDirectory
            guard manager.fileExists(atPath: runtime.appending(path: "dist/cli.js").path) else {
                throw HomeClientError.server("Эта сборка не содержит Codex. Установите полную версию OpenStrudel.")
            }
            try manager.createDirectory(at: dataDirectory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
            let install = Process()
            install.executableURL = URL(fileURLWithPath: "/bin/bash")
            install.arguments = [runtime.appending(path: "scripts/install-prebuilt-mac.sh").path, dataDirectory.path]
            install.currentDirectoryURL = dataDirectory
            install.environment = ["HOME": NSHomeDirectory(), "PATH": runtime.appending(path: "bin").path + ":" + NSHomeDirectory() + "/.local/bin:/usr/bin:/bin:/usr/sbin:/sbin", "LANG": "en_US.UTF-8"]
            install.standardOutput = FileHandle.nullDevice
            install.standardError = FileHandle.nullDevice
            try install.run()
            install.waitUntilExit()
            guard install.terminationStatus == 0 else { throw HomeClientError.server("Не удалось запустить OpenStrudel. Попробуйте ещё раз.") }
        }.value
        for _ in 0..<80 {
            if let data = try? Data(contentsOf: target.appending(path: "LocalConnection.json")),
               let connection = try? JSONDecoder().decode([String: String].self, from: data),
               let token = connection["token"], let endpoint = connection["url"],
               let url = URL(string: endpoint + "/health") {
                var request = URLRequest(url: url, timeoutInterval: 1)
                request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
                if let (_, response) = try? await URLSession.shared.data(for: request),
                   (response as? HTTPURLResponse)?.statusCode == 200 { return connection }
            }
            try await Task.sleep(for: .milliseconds(250))
        }
        throw HomeClientError.server("Первый запуск занял больше времени. Попробуйте подключиться ещё раз.")
    }
}
#endif
