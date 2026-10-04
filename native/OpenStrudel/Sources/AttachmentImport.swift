import Foundation
import UniformTypeIdentifiers

/// Read outside the UI actor, with a hard limit even if the file changes while reading.
enum AttachmentImport {
    static let byteLimit = 25 * 1024 * 1024
    static let countLimit = 6

    enum Failure: LocalizedError, Equatable {
        case empty, tooLarge, notAFile
        var errorDescription: String? {
            switch self {
            case .empty: "Этот файл пуст. Выберите другой файл."
            case .tooLarge: "Файл больше 25 МБ. Выберите файл меньшего размера."
            case .notAFile: "Выберите файл. Чтобы отправить папку, сначала сохраните её как ZIP-архив."
            }
        }
    }

    static func isCancellation(_ error: Error) -> Bool {
        let value = error as NSError
        return error is CancellationError
            || (value.domain == NSCocoaErrorDomain && value.code == NSUserCancelledError)
            || (value.domain == NSURLErrorDomain && value.code == NSURLErrorCancelled)
    }

    static func files(at urls: [URL]) async throws -> [PickedFile] {
        let worker = Task.detached(priority: .userInitiated) {
            try urls.map { url in
                try Task.checkCancellation()
                let scoped = url.startAccessingSecurityScopedResource()
                defer { if scoped { url.stopAccessingSecurityScopedResource() } }
                let properties = try url.resourceValues(forKeys: [.isRegularFileKey, .fileSizeKey])
                guard properties.isRegularFile == true else { throw Failure.notAFile }
                guard (properties.fileSize ?? 0) <= byteLimit else { throw Failure.tooLarge }
                let handle = try FileHandle(forReadingFrom: url)
                defer { try? handle.close() }
                var data = Data()
                while data.count <= byteLimit {
                    try Task.checkCancellation()
                    guard let part = try handle.read(upToCount: min(64 * 1024, byteLimit + 1 - data.count)), !part.isEmpty else { break }
                    data.append(part)
                }
                guard data.count <= byteLimit else { throw Failure.tooLarge }
                guard !data.isEmpty else { throw Failure.empty }
                let mime = UTType(filenameExtension: url.pathExtension)?.preferredMIMEType ?? "application/octet-stream"
                return PickedFile(name: url.lastPathComponent, mimeType: mime, data: data)
            }
        }
        return try await withTaskCancellationHandler { try await worker.value } onCancel: { worker.cancel() }
    }
}
