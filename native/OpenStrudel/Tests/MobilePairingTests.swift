import Foundation
import Testing

struct MobilePairingTests {
    private let key = String(repeating: "a", count: 64)
    private let pin = String(repeating: "b", count: 64)

    private func invitation(host: String = "home.local") -> String {
        "openstrudel://connect?host=\(host)&port=7789&key=\(key)&pin=\(pin)&name=My%20OpenStrudel"
    }

    @Test func macAndPublicServerUseTheSameInvitation() throws {
        for host in ["home.local", "8.8.8.8", "home.example.com"] {
            let pairing = try MacPairing(url: #require(URL(string: invitation(host: host))))
            #expect(pairing.baseURL == "https://\(host):7789")
            #expect(pairing.name == "My OpenStrudel")
            #expect(pairing.key == key)
            #expect(pairing.pin == pin)
        }
    }

    @Test func ambiguousInvitationsAreRejected() throws {
        let original = invitation()
        for value in [
            original + "&host=other.example.com",
            original + "&key=" + key,
            original + "#anything",
            original.replacingOccurrences(of: "connect?", with: "connect/another?"),
            original.replacingOccurrences(of: "connect?", with: "user@connect?"),
            original.replacingOccurrences(of: "connect?", with: "connect:443?"),
            invitation(host: "my..host"),
            invitation(host: "my.-host")
        ] {
            let url = try #require(URL(string: value))
            #expect(throws: (any Error).self) { try MacPairing(url: url) }
        }
    }

    @Test func namesDecodeSpacesAndLiteralPluses() throws {
        let named = invitation().replacingOccurrences(of: "My%20OpenStrudel", with: "Mac+mini+%2B+iPhone")
        #expect(try MacPairing(url: #require(URL(string: named))).name == "Mac mini + iPhone")
    }

    @Test func expirationCountdownStopsAtZero() throws {
        let item = try MobileInvitation(url: #require(URL(string: invitation())), expiresAt: "2026-09-30T12:05:00.000Z")
        let start = try Date.ISO8601FormatStyle().parse("2026-09-30T12:00:00Z")
        #expect(item.remainingSeconds(at: start) == 300)
        #expect(item.remainingSeconds(at: start.addingTimeInterval(299.5)) == 1)
        #expect(item.remainingSeconds(at: start.addingTimeInterval(301)) == 0)
    }

    @Test func missingOrWeakCredentialsCannotConnect() throws {
        for value in [invitation().replacingOccurrences(of: key, with: "123456"), invitation().replacingOccurrences(of: pin, with: ""), invitation().replacingOccurrences(of: "7789", with: "0")] {
            let url = try #require(URL(string: value))
            #expect(throws: (any Error).self) { try MacPairing(url: url) }
        }
    }
}
