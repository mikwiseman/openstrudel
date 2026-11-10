import SwiftUI
import ImageIO
import QuickLook

/// The same image presentation for Markdown, incoming photos and generated files.
struct ChatImage: View {
    let name: String
    let identity: String
    /// Attachments load on sight. A web picture named in a reply waits for a click,
    /// because its address can carry data out of the conversation.
    var autoload = true
    /// Where a waiting picture would come from, shown under its download button.
    var origin: String?
    let load: () async throws -> URL
    @State private var thumbnail: CGImage?
    @State private var fileURL: URL?
    @State private var previewURL: URL?
    @State private var failed = false
    @State private var attempt = 0

    var body: some View {
        Group {
            if let thumbnail {
                Button { previewURL = fileURL } label: { ChatPicture(image: thumbnail) }
                    .buttonStyle(.plain)
                    .accessibilityLabel(L("Open image: \(name.isEmpty ? L("Фото") : name)"))
            } else {
                VStack(spacing: 8) {
                    if failed || (!autoload && attempt == 0) {
                        Image(systemName: "photo").font(.title2).foregroundStyle(AppTheme.secondaryText)
                            .accessibilityHidden(true)
                        if failed {
                            Text(L("Не удалось загрузить изображение.")).font(AppTypography.meta).foregroundStyle(AppTheme.warning)
                                .multilineTextAlignment(.center)
                        }
                        if let origin {
                            Text(origin).font(AppTypography.meta).foregroundStyle(AppTheme.secondaryText)
                                .lineLimit(1).truncationMode(.middle)
                        }
                        Button(failed ? L("Повторить") : L("Загрузить изображение")) { attempt += 1 }.font(AppTypography.interface)
                    } else {
                        ProgressView().controlSize(.small)
                    }
                }
                .padding(12)
                .frame(width: 240, height: 180)
                .chatSurface(AppTheme.surface, radius: Radius.card)
            }
        }
        .quickLookPreview($previewURL)
        .task(id: identity + ":" + String(attempt)) {
            guard autoload || attempt > 0 else { return }
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

/// A picture at its own aspect ratio, at most 320 × 240 and never wider than its column.
struct ChatPicture: View {
    let image: CGImage

    var body: some View {
        let size = ChatMedia.fitted(CGSize(width: image.width, height: image.height))
        Image(decorative: image, scale: 1)
            .resizable()
            .frame(maxWidth: size.width, maxHeight: size.height)
            .aspectRatio(size.width / max(size.height, 1), contentMode: .fit)
            .clipShape(RoundedRectangle(cornerRadius: Radius.card, style: .continuous))
    }
}

/// A file in the transcript: its kind, its name and a quiet detail line.
struct FileChip: View {
    let icon: String
    let name: String
    let detail: String
    @ScaledMetric(relativeTo: .body) private var iconBox: CGFloat = 20

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: icon)
                .font(iconFont)
                .foregroundStyle(AppTheme.secondaryText)
                .frame(width: iconBox, height: iconBox)
            VStack(alignment: .leading, spacing: 2) {
                Text(name)
                    .font(AppTypography.interface.weight(.medium))
                    .foregroundStyle(.primary)
                    .lineLimit(2)
                Text(detail)
                    .font(AppTypography.meta)
                    .foregroundStyle(AppTheme.secondaryText)
                    .monospacedDigit()
            }
        }
        .padding(12)
        .chatSurface(AppTheme.surface, radius: Radius.card)
        .contentShape(RoundedRectangle(cornerRadius: Radius.card, style: .continuous))
    }

    private var iconFont: Font {
        #if os(macOS)
        .system(size: 16)
        #else
        .body
        #endif
    }
}

enum ChatMedia {
    private static let publicImages: URLSession = {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpCookieStorage = nil
        configuration.urlCredentialStorage = nil
        return URLSession(configuration: configuration)
    }()
    /// Pictures keep their aspect ratio inside 320 × 240.
    static func fitted(_ size: CGSize) -> CGSize {
        guard size.width > 0, size.height > 0 else { return CGSize(width: 320, height: 240) }
        let scale = min(1, 320 / size.width, 240 / size.height)
        return CGSize(width: (size.width * scale).rounded(), height: (size.height * scale).rounded())
    }

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

    /// A story's picture, read into memory over https with the same unauthenticated session and limits.
    static func picture(_ address: String, maxPixels: Int = 1600) async throws -> CGImage {
        guard let url = URL(string: address), url.scheme?.lowercased() == "https", url.host != nil, url.user == nil, url.password == nil else { throw URLError(.unsupportedURL) }
        var request = URLRequest(url: url)
        request.timeoutInterval = 30
        let (data, response) = try await publicImages.data(for: request)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode), data.count <= 25 * 1024 * 1024,
              let image = thumbnail(data, maxPixels: maxPixels) else { throw URLError(.cannotDecodeContentData) }
        return image
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
            try Task.checkCancellation()
            guard data.count < 25 * 1024 * 1024 else { throw URLError(.dataLengthExceedsMaximum) }
            data.append(byte)
        }
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("OpenStrudelImages")
        try Task.checkCancellation()
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let ext = ["jpg", "jpeg", "png", "webp", "heic", "gif"].contains(url.pathExtension.lowercased()) ? url.pathExtension : "png"
        let file = folder.appendingPathComponent(UUID().uuidString).appendingPathExtension(ext)
        try data.write(to: file, options: [.atomic, .completeFileProtectionUnlessOpen])
        return file
    }
}
