import Foundation

struct AgentImportPreview: Decodable {
    struct Employee: Decodable { let name: String; let importedName: String }
    struct Counts: Decodable {
        let employees: Int; let conversations: Int; let messages: Int; let files: Int; let schedules: Int
    }
    let archiveId: String
    let createdAt: String
    let planToken: String
    let alreadyImported: Bool
    let employees: [Employee]
    let counts: Counts
    let connections: [String]
}

struct PendingAgentImport: Identifiable {
    let data: Data
    let preview: AgentImportPreview
    let connectionGeneration: Int
    var deviceID: String? = nil
    var id: String { preview.archiveId }
}

struct AgentImportResult: Decodable {
    let profileIds: [String]
    let preview: AgentImportPreview
}

enum AgentTransferFile {
    static let byteLimit = 192 * 1024 * 1024
    static func isProtected(_ data: Data) -> Bool {
        guard data.first == 123, let value = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return false }
        return value["format"] as? String == "openstrudel.home.backup"
    }
    static func protectedUpload(_ data: Data, password: String) throws -> Data {
        let upload = try JSONSerialization.data(withJSONObject: ["protectedArchive": data.base64EncodedString(), "password": password])
        guard upload.count <= byteLimit else { throw Failure.tooLarge }
        return upload
    }
    enum Failure: LocalizedError {
        case tooLarge, invalidFile
        var errorDescription: String? {
            switch self {
            case .tooLarge: "Файл экспорта больше 192 МБ. Выберите файл меньшего размера."
            case .invalidFile: "Выберите файл экспорта команды OpenStrudel."
            }
        }
    }
    static func read(_ url: URL) async throws -> Data {
        let worker = Task.detached(priority: .userInitiated) {
            let scoped = url.startAccessingSecurityScopedResource()
            defer { if scoped { url.stopAccessingSecurityScopedResource() } }
            let values = try url.resourceValues(forKeys: [.isRegularFileKey, .fileSizeKey])
            guard values.isRegularFile == true else { throw Failure.invalidFile }
            guard (values.fileSize ?? 0) <= byteLimit else { throw Failure.tooLarge }
            let handle = try FileHandle(forReadingFrom: url)
            defer { try? handle.close() }
            var data = Data()
            while data.count <= byteLimit {
                try Task.checkCancellation()
                guard let part = try handle.read(upToCount: min(64 * 1024, byteLimit + 1 - data.count)), !part.isEmpty else { break }
                data.append(part)
            }
            guard data.count <= byteLimit else { throw Failure.tooLarge }
            guard !data.isEmpty else { throw Failure.invalidFile }
            return data
        }
        return try await withTaskCancellationHandler { try await worker.value } onCancel: { worker.cancel() }
    }
}
