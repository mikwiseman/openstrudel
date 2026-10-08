import Foundation
import Testing

struct TelegramLinkTests {
    @Test func pairingAndGroupLinksKeepTheirPayload() throws {
        for parameter in ["", "?start=one_use-123", "?startgroup=choose"] {
            let web = try #require(URL(string: "https://t.me/our_bot" + parameter))
            let native = try #require(TelegramLink.nativeURL(for: web))
            let parts = try #require(URLComponents(url: native, resolvingAgainstBaseURL: false))
            #expect(parts.scheme == "tg")
            #expect(parts.host == "resolve")
            #expect(parts.queryItems?.first == URLQueryItem(name: "domain", value: "our_bot"))
            #expect(Array((parts.queryItems ?? []).dropFirst()) == (URLComponents(url: web, resolvingAgainstBaseURL: false)?.queryItems ?? []))
        }
    }

    @Test func unrelatedOrAmbiguousLinksStayInTheBrowser() throws {
        for value in ["https://example.com/our_bot", "https://t.me/our_bot/123", "https://t.me/", "https://user@t.me/our_bot", "https://t.me:443/our_bot", "https://t.me/our_bot#other", "https://t.me/our_bot?start=a&start=b", "https://t.me/our_bot?startgroup=choose&admin=delete_messages"] {
            #expect(TelegramLink.nativeURL(for: try #require(URL(string: value))) == nil)
        }
    }
}
