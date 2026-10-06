import SwiftUI

struct AgentAppearance: Codable, Hashable, Sendable {
    var version = 1
    var kind: String
    var tone: Int

    static let kinds = ["coil", "fold", "knot", "curl", "wave", "pillow"]
    static let names = ["Завиток", "Конвертик", "Узелок", "Рогалик", "Волна", "Подушечка"]
    static let tones = ["Абрикос", "Мёд", "Фисташка", "Мята", "Небо", "Черника", "Сирень", "Малина"]
    static let angles: [Double] = [0, 32, 72, 125, 180, 215, 255, 315]
    var isValid: Bool { version == 1 && Self.kinds.contains(kind) && Self.tones.indices.contains(tone) }
    var label: String { Self.names[Self.kinds.firstIndex(of: kind) ?? 0] }
    var hue: Angle { .degrees(Self.angles.indices.contains(tone) ? Self.angles[tone] : 0) }

    static func seeded(_ id: String) -> Self {
        let hash = id.utf8.reduce(UInt32(2166136261)) { ($0 ^ UInt32($1)) &* 16777619 }
        return Self(kind: kinds[Int(hash) % kinds.count], tone: Int(hash) / kinds.count % tones.count)
    }
    func shuffled() -> Self {
        let current = (Self.kinds.firstIndex(of: kind) ?? 0) * 8 + tone
        let next = (current + Int.random(in: 1..<48)) % 48
        return Self(kind: Self.kinds[next / 8], tone: next % 8)
    }
    var payload: [String: Any] { ["version": version, "kind": kind, "tone": tone] }
}

extension EmployeeProfile {
    var resolvedAppearance: AgentAppearance {
        if let appearance, appearance.isValid { return appearance }
        return .seeded(id)
    }
}
