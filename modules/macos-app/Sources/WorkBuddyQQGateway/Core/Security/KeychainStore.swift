import Foundation
import Security

public enum KeychainAccount: String, CaseIterable, Sendable {
    case hubApiToken = "hub-api-token"
    case oneBotApiToken = "onebot-api-token"
    case homeAssistantApiToken = "home-assistant-api-token"
    case snowlumaVncPassword = "snowluma-vnc-password"
}

public enum KeychainError: LocalizedError, Sendable {
    case unexpectedStatus(OSStatus)
    case randomGenerationFailed(OSStatus)

    public var errorDescription: String? {
        switch self {
        case .unexpectedStatus(let status):
            if let message = SecCopyErrorMessageString(status, nil) as String? {
                return "钥匙串操作失败（\(status)）：\(message)"
            }
            return "钥匙串操作失败（状态码：\(status)）"
        case .randomGenerationFailed(let status):
            return "生成安全随机凭据失败（状态码：\(status)）"
        }
    }
}

public final class KeychainStore: Sendable {
    public static let defaultServiceName = "WorkBuddy QQ Gateway"
    public let serviceName: String

    public init(serviceName: String = KeychainStore.defaultServiceName) {
        self.serviceName = serviceName
    }

    public func read(account: KeychainAccount) -> String? {
        read(accountName: account.rawValue)
    }

    public func read(accountName: String) -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: serviceName,
            kSecAttrAccount as String: accountName,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne
        ]
        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        guard status == errSecSuccess, let data = result as? Data else {
            return nil
        }
        return String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    public func exists(account: KeychainAccount) -> Bool {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: serviceName,
            kSecAttrAccount as String: account.rawValue,
            kSecReturnAttributes as String: false,
            kSecMatchLimit as String: kSecMatchLimitOne
        ]
        let status = SecItemCopyMatching(query as CFDictionary, nil)
        return status == errSecSuccess
    }

    public func write(_ secret: String, account: KeychainAccount) throws {
        try write(secret, accountName: account.rawValue)
    }

    public func write(_ secret: String, accountName: String) throws {
        let data = Data(secret.utf8)
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: serviceName,
            kSecAttrAccount as String: accountName
        ]
        let attributes: [String: Any] = [
            kSecValueData as String: data
        ]
        let updateStatus = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if updateStatus == errSecSuccess {
            return
        }
        if updateStatus != errSecItemNotFound {
            throw KeychainError.unexpectedStatus(updateStatus)
        }
        var addQuery = query
        addQuery[kSecValueData as String] = data
        addQuery[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
        let addStatus = SecItemAdd(addQuery as CFDictionary, nil)
        guard addStatus == errSecSuccess else {
            throw KeychainError.unexpectedStatus(addStatus)
        }
    }

    public func delete(account: KeychainAccount) throws {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: serviceName,
            kSecAttrAccount as String: account.rawValue
        ]
        let status = SecItemDelete(query as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw KeychainError.unexpectedStatus(status)
        }
    }

    public static func generateHexSecret(byteCount: Int = 32) throws -> String {
        var bytes = [UInt8](repeating: 0, count: max(16, byteCount))
        let status = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        guard status == errSecSuccess else {
            throw KeychainError.randomGenerationFailed(status)
        }
        return bytes.map { String(format: "%02x", $0) }.joined()
    }
}
