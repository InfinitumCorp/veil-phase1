import CryptoKit
import Foundation

enum Base64URL {
    static func encode(_ data: Data) -> String {
        data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    static func decode(_ text: String) -> Data? {
        var converted = text.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        let remainder = converted.count % 4
        if remainder > 0 { converted += String(repeating: "=", count: 4 - remainder) }
        return Data(base64Encoded: converted)
    }
}

enum PKCE {
    static func challenge(for verifier: String) -> String {
        let digest = SHA256.hash(data: Data(verifier.utf8))
        return Base64URL.encode(Data(digest))
    }
}

struct CumulusConfig: Equatable {
    var issuer: URL
    /// The issuer string from the registry, compared exactly with the ID token.
    var issuerString: String
    var authorizeURL: URL
    var tokenURL: URL
    var clientID: String
    var redirectURI: URL
}

enum CumulusSignInError: Error, Equatable {
    case message(String)
}

enum CumulusConfigReader {
    static let fields = ["issuer", "authorize_url", "token_url", "client_id", "redirect_uri"]
    static let scope = "openid profile"
    static let pendingTTL: TimeInterval = 10 * 60

    /// The real browser never sets `allowLoopbackHTTP`. The prototype does,
    /// only while the page itself is served from localhost.
    static func read(_ registry: [String: Any], allowLoopbackHTTP: Bool = false) throws -> CumulusConfig? {
        guard let signin = registry["signin"] as? [String: Any] else { return nil }
        guard let cid = signin["cid"] as? [String: Any] else { return nil }
        var values: [String: String] = [:]
        for field in fields {
            guard let value = cid[field] as? String, !value.isEmpty else {
                throw CumulusSignInError.message("cid.\(field) is missing")
            }
            values[field] = value
        }
        func url(_ field: String) throws -> URL {
            guard let text = values[field], let url = URL(string: text) else {
                throw CumulusSignInError.message("cid.\(field) must be a plain https:// address")
            }
            try validate(url, field: field, allowLoopbackHTTP: allowLoopbackHTTP)
            return url
        }
        return CumulusConfig(
            issuer: try url("issuer"),
            issuerString: values["issuer"] ?? "",
            authorizeURL: try url("authorize_url"),
            tokenURL: try url("token_url"),
            clientID: values["client_id"] ?? "",
            redirectURI: try url("redirect_uri")
        )
    }

    private static func validate(_ url: URL, field: String, allowLoopbackHTTP: Bool) throws {
        let scheme = url.scheme?.lowercased()
        let host = (url.host ?? "").trimmingCharacters(in: CharacterSet(charactersIn: "[]")).lowercased()
        let loopback = host == "localhost" || host == "127.0.0.1" || host == "::1"
        let loopbackOK = allowLoopbackHTTP && scheme == "http" && loopback
        if (scheme != "https" && !loopbackOK) || url.user != nil || url.password != nil {
            throw CumulusSignInError.message("cid.\(field) must be a plain https:// address")
        }
    }
}

enum IDTokenClaims {
    static func decode(_ jwt: String) throws -> [String: Any] {
        let parts = jwt.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count == 3, let data = Base64URL.decode(String(parts[1])) else {
            throw CumulusSignInError.message("ID token is malformed")
        }
        guard let object = try? JSONSerialization.jsonObject(with: data), let claims = object as? [String: Any] else {
            throw CumulusSignInError.message("ID token payload is unreadable")
        }
        return claims
    }

    static func check(_ claims: [String: Any], issuer: String, clientID: String, nonce: String, nowS: TimeInterval) throws {
        if string(claims["iss"]) != issuer {
            throw CumulusSignInError.message("ID token is from the wrong issuer")
        }
        let audience = audienceValues(claims["aud"])
        if !audience.contains(clientID) {
            throw CumulusSignInError.message("ID token is not for VEIL")
        }
        if audience.count > 1 && string(claims["azp"]) != clientID {
            throw CumulusSignInError.message("ID token azp is not VEIL")
        }
        guard let exp = number(claims["exp"]) else {
            throw CumulusSignInError.message("ID token has expired")
        }
        if exp + 120 < nowS {
            throw CumulusSignInError.message("ID token has expired")
        }
        if let iat = number(claims["iat"]), iat - 120 > nowS {
            throw CumulusSignInError.message("ID token is from the future")
        }
        if string(claims["nonce"]) != nonce {
            throw CumulusSignInError.message("ID token nonce does not match")
        }
        if string(claims["sub"]) == nil {
            throw CumulusSignInError.message("ID token has no subject")
        }
    }

    static func displayName(_ claims: [String: Any]) -> String {
        for key in ["name", "preferred_username", "email"] {
            if let value = string(claims[key]) { return String(value.prefix(64)) }
        }
        return ""
    }

    private static func string(_ value: Any?) -> String? {
        guard let text = value as? String, !text.isEmpty else { return nil }
        return text
    }

    private static func number(_ value: Any?) -> Double? {
        (value as? NSNumber)?.doubleValue
    }

    private static func audienceValues(_ value: Any?) -> [String] {
        if let one = value as? String { return [one] }
        if let many = value as? [String] { return many }
        if let many = value as? [Any] { return many.compactMap { $0 as? String } }
        return []
    }
}

struct HTTPResult: Equatable {
    var status: Int
    var body: Data
}

protocol FormPosting: AnyObject {
    func post(url: URL, body: String) async throws -> HTTPResult
}

/// Refuses anything that is not an allowed Tor path. The live poster is
/// `ProxiedFormPoster`, which uses a URLSession bound to the local SOCKS port.
final class RefusingFetcher: FormPosting, Sendable {
    func post(url: URL, body: String) async throws -> HTTPResult {
        throw TorClientError.trafficPaused
    }
}

enum TorProtectedRequest {
    static func validate(url: URL, gate: TrafficGate) throws -> TorEndpoint {
        guard case .allowed(let endpoint) = gate else { throw TorClientError.trafficPaused }
        guard AnonymityGuard.isLoopback(endpoint.host) else { throw TorClientError.trafficPaused }
        let scheme = url.scheme?.lowercased()
        let onion = url.host?.lowercased().hasSuffix(".onion") == true
        if scheme == "https" || (scheme == "http" && onion) { return endpoint }
        throw TorClientError.refusedCleartext
    }
}

struct CumulusAccount: Equatable {
    var name: String
    var subject: String
}

struct CumulusPending: Equatable {
    var verifier: String
    var state: String
    var nonce: String
    var startedAt: Date
}

/// Authorization-code + PKCE sign-in. Tokens stay in memory. The shipped
/// registry has no `cid` block, so Sign In opens the registry page instead.
@MainActor
final class CumulusSession {
    let config: CumulusConfig?
    private let fetcher: any FormPosting
    private let now: () -> Date
    private let random: () -> String
    private(set) var pending: CumulusPending?
    private var idToken: String?
    private var accessToken: String?
    private var expiresAt: Date?
    private(set) var account: CumulusAccount?

    init(registryJSON: [String: Any], fetcher: any FormPosting, allowLoopbackHTTP: Bool = false, now: @escaping () -> Date = Date.init, random: @escaping () -> String = CumulusSession.randomToken) {
        do {
            config = try CumulusConfigReader.read(registryJSON, allowLoopbackHTTP: allowLoopbackHTTP)
        } catch {
            config = nil
        }
        self.fetcher = fetcher
        self.now = now
        self.random = random
    }

    var enabled: Bool { config != nil }

    func authorizeURL() throws -> URL {
        guard let config else { throw CumulusSignInError.message("Cumulus://ID is not configured in this build") }
        let verifier = random()
        let state = random()
        let nonce = random()
        pending = CumulusPending(verifier: verifier, state: state, nonce: nonce, startedAt: now())
        var components = URLComponents(url: config.authorizeURL, resolvingAgainstBaseURL: false)
        components?.queryItems = [
            URLQueryItem(name: "response_type", value: "code"),
            URLQueryItem(name: "client_id", value: config.clientID),
            URLQueryItem(name: "redirect_uri", value: config.redirectURI.absoluteString),
            URLQueryItem(name: "scope", value: CumulusConfigReader.scope),
            URLQueryItem(name: "state", value: state),
            URLQueryItem(name: "nonce", value: nonce),
            URLQueryItem(name: "code_challenge", value: PKCE.challenge(for: verifier)),
            URLQueryItem(name: "code_challenge_method", value: "S256"),
        ]
        guard let url = components?.url else {
            throw CumulusSignInError.message("Cumulus://ID is not configured in this build")
        }
        return url
    }

    func isRedirect(_ address: URL) -> Bool {
        guard let config else { return false }
        guard address.scheme?.lowercased() == config.redirectURI.scheme?.lowercased(),
              address.host?.lowercased() == config.redirectURI.host?.lowercased(),
              address.path == config.redirectURI.path else { return false }
        return true
    }

    func handleRedirect(_ address: URL, gate: TrafficGate) async throws -> CumulusAccount {
        guard let config, isRedirect(address) else {
            throw CumulusSignInError.message("not the Cumulus://ID redirect address")
        }
        let current = pending
        pending = nil
        guard let current else { throw CumulusSignInError.message("no sign-in was started") }
        if now().timeIntervalSince(current.startedAt) > CumulusConfigReader.pendingTTL {
            throw CumulusSignInError.message("sign-in took too long; try again")
        }
        guard let components = URLComponents(url: address, resolvingAgainstBaseURL: false) else {
            throw CumulusSignInError.message("not the Cumulus://ID redirect address")
        }
        let params = Dictionary(uniqueKeysWithValues: (components.queryItems ?? []).map { ($0.name, $0.value ?? "") })
        if params["state"] != current.state { throw CumulusSignInError.message("sign-in state does not match") }
        if let error = params["error"], !error.isEmpty {
            throw CumulusSignInError.message("Cumulus://ID refused sign-in: \(error)")
        }
        guard let code = params["code"], !code.isEmpty else {
            throw CumulusSignInError.message("Cumulus://ID returned no code")
        }
        _ = try TorProtectedRequest.validate(url: config.tokenURL, gate: gate)
        let body = form([
            "grant_type": "authorization_code",
            "code": code,
            "redirect_uri": config.redirectURI.absoluteString,
            "client_id": config.clientID,
            "code_verifier": current.verifier,
        ])
        let response = try await fetcher.post(url: config.tokenURL, body: body)
        guard (200..<300).contains(response.status) else {
            throw CumulusSignInError.message("token request failed (\(response.status))")
        }
        let object = try JSONSerialization.jsonObject(with: response.body)
        guard let tokens = object as? [String: Any], let jwt = tokens["id_token"] as? String else {
            throw CumulusSignInError.message("no ID token returned")
        }
        let claims = try IDTokenClaims.decode(jwt)
        try IDTokenClaims.check(
            claims,
            issuer: config.issuerString,
            clientID: config.clientID,
            nonce: current.nonce,
            nowS: now().timeIntervalSince1970
        )
        let name = IDTokenClaims.displayName(claims)
        let subject = (claims["sub"] as? String) ?? ""
        idToken = jwt
        accessToken = tokens["access_token"] as? String
        if let exp = (claims["exp"] as? NSNumber)?.doubleValue {
            expiresAt = Date(timeIntervalSince1970: exp)
        }
        let account = CumulusAccount(name: name, subject: subject)
        self.account = account
        return account
    }

    func signedIn(at date: Date? = nil) -> Bool {
        guard account != nil, let expiresAt else { return false }
        return expiresAt > (date ?? now())
    }

    func forget() {
        pending = nil
        idToken = nil
        accessToken = nil
        expiresAt = nil
        account = nil
    }

    private func form(_ fields: [String: String]) -> String {
        fields.map { key, value in
            "\(AppCommands.encodeURIComponent(key))=\(AppCommands.encodeURIComponent(value))"
        }.sorted().joined(separator: "&")
    }

    static func randomToken() -> String {
        var bytes = [UInt8](repeating: 0, count: 32)
        let status = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        if status != errSecSuccess {
            for index in bytes.indices { bytes[index] = UInt8.random(in: 0...255) }
        }
        return Base64URL.encode(Data(bytes))
    }
}
