import Foundation
import Testing

struct AgentTransferTests {
    @Test func readsTheWholeFileWithoutTreatingItsContentsAsInstructions() async throws {
        let path = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + ".openstrudel")
        let data = Data(#"{"format":"openstrudel.team","instructions":"Quoted employee data"}"#.utf8)
        try data.write(to: path)
        defer { try? FileManager.default.removeItem(at: path) }
        let actual = try await AgentTransferFile.read(path)
        #expect(actual == data)
    }

    @Test func refusesEmptyFilesDirectoriesAndOversizedFilesBeforeUploading() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        await #expect(throws: AgentTransferFile.Failure.self) { try await AgentTransferFile.read(root) }
        let file = root.appendingPathComponent("large.openstrudel")
        try Data().write(to: file)
        await #expect(throws: AgentTransferFile.Failure.self) { try await AgentTransferFile.read(file) }
        let handle = try FileHandle(forWritingTo: file)
        try handle.truncate(atOffset: UInt64(AgentTransferFile.byteLimit + 1)); try handle.close()
        await #expect(throws: AgentTransferFile.Failure.self) { try await AgentTransferFile.read(file) }
    }
}
