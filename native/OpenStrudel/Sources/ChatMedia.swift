import SwiftUI
import ImageIO
import QuickLook

/// The same image presentation for Markdown, incoming photos and generated files.
struct ChatImage: View {
    let name: String
    let identity: String
    let load: () async throws -> URL
    @State private var thumbnail: CGImage?
    @State private var fileURL: URL?
    @State private var previewURL: URL?
    @State private var failed = false
    @State private var attempt = 0

    var body: some View {
        Group {
            if let thumbnail {
                Button { previewURL = fileURL } label: {
                    Image(decorative: thumbnail, scale: 1)
                        .resizable().scaledToFit()
                        .frame(maxWidth: 440, maxHeight: 360)
                        .clipShape(RoundedRectangle(cornerRadius: 12))
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Открыть изображение: " + (name.isEmpty ? "Фото" : name))
            } else {
                VStack(spacing: 10) {
                    if failed {
                        Image(systemName: "photo").font(.title2).foregroundStyle(.secondary)
                        Button("Загрузить изображение") { attempt += 1 }.font(.callout)
                    } else {
                        ProgressView().controlSize(.small)
                    }
                }
                .frame(maxWidth: 360, minHeight: 140)
                .background(.primary.opacity(0.035), in: RoundedRectangle(cornerRadius: 12))
            }
        }
        .quickLookPreview($previewURL)
        .task(id: identity + ":" + String(attempt)) {
            failed = false
            do {
                let url = try await load()
                try Task.checkCancellation()
                guard let image = ChatMedia.thumbnail(url) else { throw URLError(.cannotDecodeContentData) }
                fileURL = url; thumbnail = image
            } catch is CancellationError { }
            catch { if !Task.isCancelled { failed = true } }
        }
    }
}

enum ChatMedia {
    private static let publicImages: URLSession = {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpCookieStorage = nil
        configuration.urlCredentialStorage = nil
        return URLSession(configuration: configuration)
    }()
    static func thumbnail(_ url: URL, maxPixels: Int = 1200) -> CGImage? {
        guard let source = CGImageSourceCreateWithURL(url as CFURL, nil) else { return nil }
        return CGImageSourceCreateThumbnailAtIndex(source, 0, [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: maxPixels
        ] as CFDictionary)
    }

    static func thumbnail(_ data: Data, maxPixels: Int = 180) -> CGImage? {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil) else { return nil }
        return CGImageSourceCreateThumbnailAtIndex(source, 0, [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: maxPixels
        ] as CFDictionary)
    }

    /// Web pictures use a separate, unauthenticated session, never the Home token.
    static func download(_ url: URL) async throws -> URL {
        guard ["https", "http"].contains(url.scheme?.lowercased() ?? ""), url.host != nil,
              url.user == nil, url.password == nil else { throw URLError(.unsupportedURL) }
        var request = URLRequest(url: url)
        request.timeoutInterval = 30
        let (bytes, response) = try await publicImages.bytes(for: request)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode),
              response.expectedContentLength <= 25 * 1024 * 1024 else { throw URLError(.badServerResponse) }
        var data = Data()
        for try await byte in bytes {
            guard data.count < 25 * 1024 * 1024 else { throw URLError(.dataLengthExceedsMaximum) }
            data.append(byte)
        }
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("OpenStrudelImages")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let ext = ["jpg", "jpeg", "png", "webp", "heic", "gif"].contains(url.pathExtension.lowercased()) ? url.pathExtension : "png"
        let file = folder.appendingPathComponent(UUID().uuidString).appendingPathExtension(ext)
        try data.write(to: file, options: [.atomic, .completeFileProtectionUnlessOpen])
        return file
    }
}
