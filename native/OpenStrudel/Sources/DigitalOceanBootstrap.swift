import Foundation
import CryptoKit

enum DigitalOceanBootstrap {
    private final class ResourceBundle: NSObject {}
    enum Failure: LocalizedError {
        case invalidIdentity, missingInstaller
        var errorDescription: String? {
            switch self {
            case .invalidIdentity: return "Не удалось подготовить защищённое подключение. Начните установку заново."
            case .missingInstaller: return "В этой версии нет файла облачной установки. Обновите OpenStrudel."
            }
        }
    }

    static func userData(installationID: String, privateKeyPEM: String, ownerTokenHash: String, releaseSHA256: String) throws -> String {
        guard let url = Bundle.main.url(forResource: "cloud-init", withExtension: "sh")
                ?? Bundle(for: ResourceBundle.self).url(forResource: "cloud-init", withExtension: "sh"),
              let installer = try? Data(contentsOf: url) else { throw Failure.missingInstaller }
        return try userData(installationID: installationID, privateKeyPEM: privateKeyPEM,
                            ownerTokenHash: ownerTokenHash, releaseSHA256: releaseSHA256, installer: installer)
    }

    // The shell file is bundled unchanged by both application targets; this
    // overload lets tests verify the exact shipped resource without duplication.
    static func userData(installationID: String, privateKeyPEM: String, ownerTokenHash: String,
                         releaseSHA256: String, installer: Data) throws -> String {
        guard let id = UUID(uuidString: installationID),
              ownerTokenHash.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil,
              releaseSHA256.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil,
              privateKeyPEM.utf8.count <= 4096,
              let key = try? P256.Signing.PrivateKey(pemRepresentation: privateKeyPEM) else { throw Failure.invalidIdentity }
        guard let script = String(data: installer, encoding: .utf8), script.hasPrefix("#!/usr/bin/env bash\n"),
              installer.count < 40_000 else { throw Failure.missingInstaller }
        let payload = try JSONSerialization.data(withJSONObject: [
            "installationId": id.uuidString.lowercased(), "privateKeyPEM": key.pemRepresentation,
            "ownerTokenHash": ownerTokenHash
        ], options: [.sortedKeys])
        return """
        #cloud-config
        write_files:
          - path: /var/lib/openstrudel-cloud/bootstrap.json
            owner: root:root
            permissions: '0600'
            encoding: b64
            content: \(payload.base64EncodedString())
          - path: /var/lib/openstrudel-cloud/release.sha256
            owner: root:root
            permissions: '0600'
            encoding: b64
            content: \(Data(releaseSHA256.utf8).base64EncodedString())
          - path: /var/lib/openstrudel-cloud/install.sh
            owner: root:root
            permissions: '0700'
            encoding: b64
            content: \(installer.base64EncodedString())
        runcmd:
          - [bash, /var/lib/openstrudel-cloud/install.sh]
        """ + "\n"
    }
}
