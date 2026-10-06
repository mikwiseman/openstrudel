import SwiftUI

struct AgentAvatar: View {
    var appearance: AgentAppearance?
    let size: CGFloat
    var body: some View {
        if let appearance, appearance.isValid {
            Image("Agent-" + appearance.kind).resizable().scaledToFit()
                .hueRotation(appearance.hue)
                .frame(width: size, height: size).accessibilityHidden(true)
        } else { OpenStrudelMark(size: size) }
    }
}

struct AgentAppearancePicker: View {
    @Binding var selection: AgentAppearance
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            headerLayout {
                Text("Образ").font(.subheadline.weight(.medium))
                if !dynamicTypeSize.isAccessibilitySize { Spacer() }
                Button { selection = selection.shuffled() } label: { Label("Другой", systemImage: "shuffle") }
                    .fixedSize(horizontal: true, vertical: false)
                    .buttonStyle(.borderless).accessibilityLabel("Случайный образ")
                    .accessibilityIdentifier("shuffleAgentAppearance")
            }
            LazyVGrid(columns: Array(repeating: GridItem(.flexible(minimum: 62), spacing: 10), count: 3), spacing: 10) {
                ForEach(Array(AgentAppearance.kinds.enumerated()), id: \.element) { index, kind in
                    Button { selection.kind = kind } label: {
                        AgentAvatar(appearance: .init(kind: kind, tone: selection.tone), size: 52)
                            .padding(5).frame(maxWidth: .infinity)
                            .background(selection.kind == kind ? AppTheme.accent.opacity(0.15) : Color.primary.opacity(0.04), in: RoundedRectangle(cornerRadius: 16))
                            .overlay { if selection.kind == kind { RoundedRectangle(cornerRadius: 16).stroke(AppTheme.accent, lineWidth: 2) } }
                    }.buttonStyle(.plain).accessibilityLabel(AgentAppearance.names[index])
                        .accessibilityAddTraits(selection.kind == kind ? .isSelected : [])
                        .accessibilityIdentifier("agentKind-" + kind)
                }
            }
            LazyVGrid(columns: Array(repeating: GridItem(.flexible(minimum: 44), spacing: 4), count: 4), spacing: 4) {
                ForEach(AgentAppearance.tones.indices, id: \.self) { tone in
                    Button { selection.tone = tone } label: {
                        Circle().fill(Color(red: 0.96, green: 0.60, blue: 0.24))
                            .hueRotation(.degrees(AgentAppearance.angles[tone])).frame(width: 25, height: 25)
                            .overlay { if selection.tone == tone { Image(systemName: "checkmark").font(.system(size: 12, weight: .bold)).foregroundStyle(.black) } }
                            .frame(minWidth: 40, minHeight: 44).contentShape(Rectangle())
                    }.buttonStyle(.plain).accessibilityLabel(AgentAppearance.tones[tone])
                        .accessibilityAddTraits(selection.tone == tone ? .isSelected : [])
                        .accessibilityIdentifier("agentTone-\(tone)")
                }
            }
        }
    }
    private var headerLayout: AnyLayout {
        dynamicTypeSize.isAccessibilitySize
            ? AnyLayout(VStackLayout(alignment: .leading, spacing: 8))
            : AnyLayout(HStackLayout())
    }
}
