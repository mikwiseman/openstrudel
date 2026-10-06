import Foundation
import Testing

@Suite struct AgentAppearanceTests {
    @Test func portableIdentitiesAndOlderProfiles() throws {
        #expect(AgentAppearance.seeded("main") == AgentAppearance(kind: "coil", tone: 4))
        #expect(AgentAppearance.seeded("Редактор") == AgentAppearance(kind: "coil", tone: 0))
        #expect(AgentAppearance.seeded("🍊") == AgentAppearance(kind: "pillow", tone: 3))
        let data = Data(#"{"id":"main","name":"Имя","instructions":"Правила","capabilities":[],"model":null,"tokenLimit":null,"createdAt":"2026-10-06"}"#.utf8)
        let old = try JSONDecoder().decode(EmployeeProfile.self, from: data)
        #expect(old.resolvedAppearance == .seeded("main"))
        var chosen = old
        chosen.appearance = AgentAppearance(kind: "wave", tone: 7)
        let copy = try JSONDecoder().decode(EmployeeProfile.self, from: JSONEncoder().encode(chosen))
        #expect(copy.resolvedAppearance == chosen.resolvedAppearance)
        #expect(copy.instructions == old.instructions)
    }
    @Test func shuffleChangesOnlyTheVisualIdentity() {
        for kind in AgentAppearance.kinds {
            for tone in 0..<8 {
                let original = AgentAppearance(kind: kind, tone: tone)
                let next = original.shuffled()
                #expect(next != original)
                #expect(next.isValid)
            }
        }
    }
}
