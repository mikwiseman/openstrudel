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
            try urls.map { try read($0) }
        }
        return try await withTaskCancellationHandler { try await worker.value } onCancel: { worker.cancel() }
    }

    /// File picker, drag/drop and paste share the same size and count limits.
    /// Provider temporary URLs are read inside their callback, before expiry.
    @MainActor static func providers(_ providers: [NSItemProvider]) async throws -> [PickedFile] {
        guard providers.count <= countLimit else { throw Failure.tooLarge }
        var files: [PickedFile] = []
        for provider in providers {
            try Task.checkCancellation()
            if provider.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier) {
                let path: String = try await withCheckedThrowingContinuation { continuation in
                    provider.loadItem(forTypeIdentifier: UTType.fileURL.identifier) { value, error in
                        if let error { continuation.resume(throwing: error); return }
                        let url = (value as? URL) ?? (value as? Data).flatMap { URL(dataRepresentation: $0, relativeTo: nil) }
                        guard let url, url.isFileURL else { continuation.resume(throwing: Failure.notAFile); return }
                        continuation.resume(returning: url.path)
                    }
                }
                files += try await Self.files(at: [URL(fileURLWithPath: path)])
            } else if let type = provider.registeredTypeIdentifiers.first(where: { UTType($0)?.conforms(to: .image) == true }) {
                let name = provider.suggestedName
                let file: PickedFile = try await withCheckedThrowingContinuation { continuation in
                    provider.loadFileRepresentation(forTypeIdentifier: type) { url, error in
                        if let error { continuation.resume(throwing: error); return }
                        guard let url else { continuation.resume(throwing: Failure.empty); return }
                        do {
                            let file = try read(url)
                            let imageType = UTType(type)
                            continuation.resume(returning: PickedFile(name: name ?? "Изображение." + (imageType?.preferredFilenameExtension ?? "png"), mimeType: imageType?.preferredMIMEType ?? file.mimeType, data: file.data))
                        } catch { continuation.resume(throwing: error) }
                    }
                }
                files.append(file)
            } else { throw Failure.notAFile }
        }
        try Task.checkCancellation()
        return files
    }

    private static func read(_ url: URL) throws -> PickedFile {
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
