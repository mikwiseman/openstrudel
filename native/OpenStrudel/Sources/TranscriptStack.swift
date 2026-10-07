import SwiftUI

struct TranscriptStack<Content: View>: View {
    @ViewBuilder let content: () -> Content
    var body: some View {
        #if os(macOS)
        LazyVStack(alignment: .leading, spacing: 16, content: content)
        #else
        // Avoid the iPad keyboard/lazy-layout loop when a pending row becomes a reply.
        VStack(alignment: .leading, spacing: 16, content: content)
        #endif
    }
}
