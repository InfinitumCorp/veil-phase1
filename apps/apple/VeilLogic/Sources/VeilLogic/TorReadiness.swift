import Foundation

public struct TorControlStatus: Equatable, Sendable {
    public var type: String
    public var severity: String
    public var action: String
    public var arguments: [String: String]

    public init(type: String, severity: String, action: String, arguments: [String: String]) {
        self.type = type
        self.severity = severity
        self.action = action
        self.arguments = arguments
    }
}

public enum TorControlStatusParser {
    /// Body of a control-port status event, without the numeric code.
    /// `STATUS_CLIENT NOTICE BOOTSTRAP PROGRESS=15 TAG=handshake SUMMARY="Handshaking with a relay"`
    public static func parse(_ body: String) -> TorControlStatus? {
        let tokens = tokenize(body)
        guard tokens.count >= 3 else { return nil }
        var arguments: [String: String] = [:]
        if tokens.count > 3 {
            for token in tokens.dropFirst(3) {
                guard let eq = token.firstIndex(of: "=") else { continue }
                let key = String(token[..<eq])
                var value = String(token[token.index(after: eq)...])
                if value.count >= 2, value.hasPrefix("\""), value.hasSuffix("\"") {
                    value.removeFirst()
                    value.removeLast()
                }
                arguments[key] = value
            }
        }
        return TorControlStatus(type: tokens[0], severity: tokens[1], action: tokens[2], arguments: arguments)
    }

    static func tokenize(_ body: String) -> [String] {
        var tokens: [String] = []
        var current = ""
        var quoted = false
        for character in body {
            if character == "\"" {
                quoted.toggle()
                current.append(character)
                continue
            }
            if character.isWhitespace, !quoted {
                if !current.isEmpty {
                    tokens.append(current)
                    current = ""
                }
                continue
            }
            current.append(character)
        }
        if !current.isEmpty {
            tokens.append(current)
        }
        return tokens
    }
}

public struct TorReadiness: Equatable, Sendable {
    public var progress: Int
    public var summary: String
    public var circuitEstablished: Bool
    public var threadAlive: Bool

    public init(progress: Int, summary: String, circuitEstablished: Bool, threadAlive: Bool) {
        self.progress = progress
        self.summary = summary
        self.circuitEstablished = circuitEstablished
        self.threadAlive = threadAlive
    }

    public static let booting = TorReadiness(progress: 0, summary: "", circuitEstablished: false, threadAlive: true)

    /// Pages may load only after a live thread has a circuit and bootstrap has finished.
    public var acceptsTraffic: Bool {
        threadAlive && circuitEstablished && progress >= 100
    }
}

public enum TorReadinessReducer {
    public static func apply(status: TorControlStatus, threadAlive: Bool = true, to current: TorReadiness) -> TorReadiness {
        var next = current
        next.threadAlive = threadAlive
        guard status.type == "STATUS_CLIENT" else { return next }
        switch status.action {
        case "BOOTSTRAP":
            if let raw = status.arguments["PROGRESS"], let value = Int(raw) {
                next.progress = min(100, max(0, value))
            }
            if let summary = status.arguments["SUMMARY"], !summary.isEmpty {
                next.summary = summary
            }
        case "CIRCUIT_ESTABLISHED":
            next.circuitEstablished = true
            next.progress = max(next.progress, 100)
        case "CIRCUIT_NOT_ESTABLISHED":
            next.circuitEstablished = false
        default:
            break
        }
        return next
    }
}

public enum TorSignals {
    public static let newIdentity = ["SIGNAL CLEARDNSCACHE", "SIGNAL NEWNYM"]
    public static let newCircuit = ["SIGNAL CLEARDNSCACHE"]
}

public enum TorStatusLine {
    public static func connecting(_ base: String, progress: Int) -> String {
        guard progress > 0 else { return base }
        return "\(base) \(min(max(progress, 0), 100))%"
    }
}
