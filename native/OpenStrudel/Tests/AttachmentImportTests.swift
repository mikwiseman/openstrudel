import Foundation
import Testing

@Suite("Attachment import")
struct AttachmentImportTests {
    @Test func preservesContentAndFileMetadata() async throws {
        let folder = try temporaryFolder()
        defer { try? FileManager.default.removeItem(at: folder) }
        let file = folder.appendingPathComponent("Заметки.txt")
        let data = Data("Проверка вложения".utf8)
        try data.write(to: file)
        let files = try await AttachmentImport.files(at: [file])
        #expect(files.count == 1)
        #expect(files[0].name == "Заметки.txt")
        #expect(files[0].mimeType == "text/plain")
        #expect(files[0].data == data)
    }

    @Test func rejectsEmptyFilesAndDirectories() async throws {
        let folder = try temporaryFolder()
        defer { try? FileManager.default.removeItem(at: folder) }
        let file = folder.appendingPathComponent("empty.txt")
        try Data().write(to: file)
        await #expect(throws: AttachmentImport.Failure.empty) { try await AttachmentImport.files(at: [file]) }
        await #expect(throws: AttachmentImport.Failure.notAFile) { try await AttachmentImport.files(at: [folder]) }
    }

    @Test func acceptsExactLimitAndRejectsOneByteMore() async throws {
        let folder = try temporaryFolder()
        defer { try? FileManager.default.removeItem(at: folder) }
        let file = folder.appendingPathComponent("limit.dat")
        FileManager.default.createFile(atPath: file.path, contents: nil)
        let handle = try FileHandle(forWritingTo: file)
        defer { try? handle.close() }
        try handle.truncate(atOffset: UInt64(AttachmentImport.byteLimit))
        let files = try await AttachmentImport.files(at: [file])
        #expect(files[0].data.count == AttachmentImport.byteLimit)
        try handle.truncate(atOffset: UInt64(AttachmentImport.byteLimit + 1))
        await #expect(throws: AttachmentImport.Failure.tooLarge) { try await AttachmentImport.files(at: [file]) }
    }

    @Test func cancellationIsNotAFileError() {
        #expect(AttachmentImport.isCancellation(CancellationError()))
        #expect(AttachmentImport.isCancellation(CocoaError(.userCancelled)))
        #expect(AttachmentImport.isCancellation(URLError(.cancelled)))
        #expect(!AttachmentImport.isCancellation(CocoaError(.fileReadNoPermission)))
        #expect(!AttachmentImport.isCancellation(AttachmentImport.Failure.tooLarge))
    }

    private func temporaryFolder() throws -> URL {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("OpenStrudel-attachments-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        return folder
    }
}
