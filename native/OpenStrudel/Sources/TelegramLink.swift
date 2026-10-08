import Foundation

/// Open Telegram itself when installed; retain the HTTPS link as the fallback.
/// https://core.telegram.org/api/links#bot-links
enum TelegramLink {
    static func nativeURL(for webURL: URL) -> URL? {
        guard let source = URLComponents(url: webURL, resolvingAgainstBaseURL: false),
              source.scheme == "https", source.host == "t.me",
              source.user == nil, source.password == nil, source.port == nil,
              source.fragment == nil else { return nil }
        let username = String(source.path.dropFirst())
        guard !username.isEmpty,
              username.range(of: "^[A-Za-z0-9_]+$", options: .regularExpression) != nil else { return nil }
        let parameters = source.queryItems ?? []
        guard parameters.count <= 1,
              parameters.allSatisfy({ ["start", "startgroup"].contains($0.name) }) else { return nil }
        var target = URLComponents()
        target.scheme = "tg"
        target.host = "resolve"
        target.queryItems = [URLQueryItem(name: "domain", value: username)] + parameters
        return target.url
    }
}
