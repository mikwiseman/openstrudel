import Foundation
import Testing
import Security

@Suite("Primary Home safety")
struct PrimaryHomeTests {
    #if os(macOS)
    @Test func hostingUsesOnlyTheExplicitOriginAndKeepsRedirectsOutsideTheApp() throws {
        for value in ["http://public.example", "https://user:secret@host.example", "https://host.example/path", "https://host.example?token=secret", "https://host.example#invite=secret"] {
            #expect(HostingStore.approvedOrigin(value) == nil)
        }
        let origin = try #require(HostingStore.approvedOrigin("https://host.example"))
        #expect(HostingStore.sameOrigin(origin, try #require(URL(string: "https://host.example/checkout"))))
        #expect(!HostingStore.sameOrigin(origin, try #require(URL(string: "https://other.example/checkout"))))
        #expect(!HostingStore.sameOrigin(origin, try #require(URL(string: "https://host.example:8443"))))
    }
    #endif
    @Test func certificateKeyMatchesTheServerPinAndEnforcesExpiry() throws {
        struct Fixture: Decodable { let certificate: String; let spki: String }
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appending(path: "Fixtures/home-certificate.json")
        let fixture = try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: url))
        let data = try #require(Data(base64Encoded: fixture.certificate))
        let certificate = try #require(SecCertificateCreateWithData(nil, data as CFData))
        let parsed = try #require(HomeCertificate.publicKeyAndValidity(data))
        #expect(HomeCertificate.matches(certificate, pin: "spki:" + fixture.spki, at: parsed.from.addingTimeInterval(10)))
        #expect(!HomeCertificate.matches(certificate, pin: "spki:" + String(repeating: "0", count: 64), at: parsed.from.addingTimeInterval(10)))
        #expect(!HomeCertificate.matches(certificate, pin: "spki:" + fixture.spki, at: parsed.until.addingTimeInterval(1)))
        #expect(!HomeCertificate.matches(certificate, pin: "spki:" + fixture.spki, at: parsed.from.addingTimeInterval(-1)))
        #expect(HomeCertificate.publicKeyAndValidity(data.prefix(30)) == nil)
    }
    @Test func renewedInvitationsPreferPublicKeyPin() throws {
        let pin = String(repeating: "a", count: 64), key = String(repeating: "b", count: 64)
        let url = try #require(URL(string: "openstrudel://connect?host=home.example&port=443&key=\(key)&pin=\(pin)&keyPin=\(key)"))
        #expect(try MacPairing(url: url).pin == "spki:" + key)
        let legacy = try #require(URL(string: "openstrudel://connect?host=home.example&port=443&key=\(key)&pin=\(pin)"))
        #expect(try MacPairing(url: legacy).pin == pin)
    }
    @Test func outboxKeepsMessageAndAttachmentIdentityAcrossRestarts() throws {
        let directory = FileManager.default.temporaryDirectory.appending(path: "strudel-outbox-" + UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let file = PickedFile(name: "note.txt", mimeType: "text/plain", data: Data("private note".utf8))
        let message = PendingHomeMessage(text: "Прочитай", profileID: "agent", files: [file], deviceID: "mac")
        try PendingMessagesFile.save([message], directory: directory, home: "https://one.example")
        #expect(try PendingMessagesFile.read(directory: directory, home: "https://one.example") == [message])
        #expect(try PendingMessagesFile.read(directory: directory, home: "https://two.example").isEmpty)
        let attributes = try FileManager.default.attributesOfItem(atPath: PendingMessagesFile.url(directory: directory, home: "https://one.example").path)
        #expect((attributes[.posixPermissions] as? NSNumber)?.intValue == 0o600)
    }
    @Test func movingPrimaryPreservesDraftsAndDoesNotOverwriteNewDestinationDrafts() throws {
        let name = "strudel-drafts-" + UUID().uuidString, defaults = try #require(UserDefaults(suiteName: name))
        defer { defaults.removePersistentDomain(forName: name) }
        let old = "https://old.example", new = "https://new.example"
        defaults.set([HomeDrafts.key(home: old, profile: "a", chat: nil): "Keep", HomeDrafts.key(home: new, profile: "a", chat: nil): "Newer"], forKey: "openstrudel.drafts")
        HomeDrafts.relocate(defaults, from: old, to: new)
        let values = try #require(defaults.dictionary(forKey: "openstrudel.drafts") as? [String: String])
        #expect(values[HomeDrafts.key(home: new, profile: "a", chat: nil)] == "Newer")
        #expect(values[HomeDrafts.key(home: old, profile: "a", chat: nil)] == "Keep")
    }
}
