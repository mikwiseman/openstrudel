import SwiftUI
import Observation

enum AppLanguage: String, CaseIterable, Identifiable, Sendable {
    case english = "en", russian = "ru", french = "fr", spanish = "es", hebrew = "he"
    var id: Self { self }
    var title: String {
        switch self {
        case .english: "English"
        case .russian: "Русский"
        case .french: "Français"
        case .spanish: "Español"
        case .hebrew: "עברית"
        }
    }
    var locale: Locale { Locale(identifier: rawValue) }
    var isRightToLeft: Bool { self == .hebrew }
    var speechLocale: String {
        switch self { case .english: "en-US"; case .russian: "ru-RU"; case .french: "fr-FR"; case .spanish: "es-ES"; case .hebrew: "he-IL" }
    }
}

/// One device preference. Observation redraws text without replacing views,
/// losing drafts or moving employees to another device.
final class L10n: Observable, Sendable {
    static let shared = L10n()
    static let preferenceKey = "openstrudel.language"
    private let observation = ObservationRegistrar()
    private let suiteName: String?
    init(suiteName: String? = nil) {
        self.suiteName = suiteName
        let selected = defaults.string(forKey: Self.preferenceKey).flatMap(AppLanguage.init(rawValue:)) ?? .english
        Self.prepareLaunch(selected, in: defaults)
    }
    /// The system reads these when the app opens. AppKit mirrors windows from AppleTextDirection;
    /// the language alone leaves them left to right.
    private static func prepareLaunch(_ language: AppLanguage, in defaults: UserDefaults) {
        defaults.set([language.rawValue], forKey: "AppleLanguages")
        defaults.set(language.isRightToLeft, forKey: "AppleTextDirection")
    }
    private var defaults: UserDefaults { suiteName.flatMap(UserDefaults.init(suiteName:)) ?? .standard }
    var language: AppLanguage {
        get {
            observation.access(self, keyPath: \.language)
            return defaults.string(forKey: Self.preferenceKey).flatMap(AppLanguage.init(rawValue:)) ?? .english
        }
        set {
            observation.withMutation(of: self, keyPath: \.language) {
                defaults.set(newValue.rawValue, forKey: Self.preferenceKey)
                Self.prepareLaunch(newValue, in: defaults)
            }
        }
    }
    static var locale: Locale { shared.language.locale }
    static let catalog: [String: [String: String]] = {
        let bundle = Bundle(for: ResourceMarker.self)
        guard let url = bundle.url(forResource: "localizations", withExtension: "json"),
              let data = try? Data(contentsOf: url),
              let entries = try? JSONDecoder().decode([String: [String: String]].self, from: data) else { return [:] }
        return entries
    }()
    private final class ResourceMarker {}

    // Only service-authored interface copy goes through this boundary. Never
    // use it for employee names, conversation messages or file contents.
    static func serviceText(_ message: String, language: AppLanguage? = nil) -> String {
        let language = language ?? shared.language
        if catalog[message] != nil { return text(message, language: language) }
        if let key = translatedServiceKeys[message] { return text(key, language: language) }
        for (key, expression) in servicePatterns {
            guard let match = expression.firstMatch(in: message, range: NSRange(message.startIndex..., in: message)) else { continue }
            let arguments = (1..<match.numberOfRanges).map { Range(match.range(at: $0), in: message).map { String(message[$0]) } ?? "" }
            return text(key, arguments: arguments, language: language)
        }
        if language != .russian, message.range(of: "[А-Яа-яЁё]", options: .regularExpression) != nil {
            return text("Не удалось получить ответ. Попробуйте ещё раз.", language: language)
        }
        return message
    }
    // A notice may remain visible while the user switches languages.
    private static let translatedServiceKeys: [String: String] = {
        var result: [String: String] = [:]
        for key in catalog.keys.sorted() where !key.contains("{0}") && !key.contains("<") {
            for value in catalog[key]?.values ?? [:].values where result[value] == nil { result[value] = key }
        }
        return result
    }()
    // A key is a pattern only when its own words identify a sentence: «{0} в {1}» matched any Russian sentence with « в »
    // and printed «Войдите at OpenAI…». The shortest sentence the Home sends with a slot, «{0} не завершил ответ: {1}», has three.
    private static let servicePatterns: [(String, NSRegularExpression)] = {
        let slot = try! NSRegularExpression(pattern: #"\{\d+\}"#)
        func words(_ key: String) -> Int {
            slot.stringByReplacingMatches(in: key, range: NSRange(key.startIndex..., in: key), withTemplate: " ").split { !$0.isLetter }.count
        }
        return catalog.keys.filter { $0.contains("{0}") && !$0.contains("<") && words($0) >= 3 }.sorted().compactMap { key in
            var parts: [String] = [], start = key.startIndex
            for match in slot.matches(in: key, range: NSRange(key.startIndex..., in: key)) {
                guard let range = Range(match.range, in: key) else { continue }
                parts.append(NSRegularExpression.escapedPattern(for: String(key[start..<range.lowerBound])))
                parts.append("([\\s\\S]*?)"); start = range.upperBound
            }
            parts.append(NSRegularExpression.escapedPattern(for: String(key[start...])))
            return try? (key, NSRegularExpression(pattern: "^" + parts.joined() + "$"))
        }
    }()

    static func text(_ key: String, arguments: [String] = [], language: AppLanguage? = nil) -> String {
        let language = language ?? shared.language
        let template = catalog[key]?[language.rawValue] ?? catalog[key]?["en"] ?? key
        // Replace in one pass: braces within names or pasted content are data.
        let expression = try! NSRegularExpression(pattern: #"\{(\d+)\}"#)
        var result = template
        for match in expression.matches(in: template, range: NSRange(template.startIndex..., in: template)).reversed() {
            guard let indexRange = Range(match.range(at: 1), in: template), let index = Int(template[indexRange]),
                  arguments.indices.contains(index), let range = Range(match.range, in: result) else { continue }
            let argument = arguments[index]
            // Hebrew isolates names and dates. Numbers stay in the run of their %, which would otherwise render as %66.
            let isolated = language == .hebrew && argument.unicodeScalars.contains(where: CharacterSet.letters.contains)
            result.replaceSubrange(range, with: isolated ? "\u{2068}" + argument + "\u{2069}" : argument)
        }
        return result
    }
}

struct LocalizedMessage: ExpressibleByStringLiteral, ExpressibleByStringInterpolation {
    let key: String
    let arguments: [String]
    init(stringLiteral value: String) { key = value; arguments = [] }
    init(stringInterpolation: StringInterpolation) { key = stringInterpolation.key; arguments = stringInterpolation.arguments }
    struct StringInterpolation: StringInterpolationProtocol {
        var key = ""
        var arguments: [String] = []
        init(literalCapacity: Int, interpolationCount: Int) { arguments.reserveCapacity(interpolationCount) }
        mutating func appendLiteral(_ literal: String) { key += literal }
        mutating func appendInterpolation<T>(_ value: T) { key += "{\(arguments.count)}"; arguments.append(String(describing: value)) }
    }
}

func L(_ message: LocalizedMessage) -> String { L10n.text(message.key, arguments: message.arguments) }

struct InterfaceLanguage: ViewModifier {
    func body(content: Content) -> some View {
        content.environment(\.locale, L10n.locale)
            .environment(\.layoutDirection, Self.direction)
    }

    /// A Mac window takes one direction from AppKit, fixed when the app opens, so its split view, toolbar
    /// and content always mirror together. A language that reads the other way applies after a relaunch.
    private static var direction: LayoutDirection {
        #if os(macOS)
        NSApplication.shared.userInterfaceLayoutDirection == .rightToLeft ? .rightToLeft : .leftToRight
        #else
        L10n.shared.language.isRightToLeft ? .rightToLeft : .leftToRight
        #endif
    }
}
