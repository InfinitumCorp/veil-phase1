import Foundation

/// Words taken from the VEIL start page and toolbar.
/// `veil-chrome/src/home/home.html`, `home.js`, and `veil-prototype/static/index.html`
/// are the source. Tests fail if those files and these strings drift apart.
enum VeilCopy {
    static let brand = "VEIL</>"
    static let searchPlaceholder = "Search privately over Tor"
    static let addressPlaceholder = "Search privately over Tor, type an address, or @scalvs / @cndctr"
    static let workspace = "Anonymous"
    static let workspaceSignedIn = "Signed in · IP hidden by Tor"
    static let workspaceHint = "Every connection goes over Tor. Your IP address and location stay hidden, signed in or not."
    static let chipAnonymous = "Anonymous"
    static let chipSignedIn = "Signed in"
    static let signIn = "Sign In"
    static let signInHint = "Sign in with Cumulus://ID"
    static let mail = "Mail"
    static let mailHint = "Cumulus://Mail"
    static let apps = "Apps"
    static let newCircuit = "New circuit"
    static let newCircuitHint = "New route for the current site"
    static let newIdentity = "New identity"
    static let newIdentityHint = "Close all tabs and start fresh"
    static let footerTagline = "AI-powered. Blockchain-governed™."
    static let copyright = "© 2026 Infinitum Corporation"
    static let commandFootnote = "Commands run in VEIL. They are never sent to a search engine or saved."
    static let panelHint = "opens beside the page"

    static let statusChecking = "Checking Tor…"
    static let statusConnected = "Connected to Tor"
    static let statusConnecting = "Connecting to Tor…"
    static let statusError = "Not connected to Tor; browsing is paused until Tor reconnects"
    static let statusBlocked = "Tor settings were changed; VEIL is offline to protect you"
    static let statusUnknown = "Tor status unknown"

    static let newTab = "New tab"
    static let productDomain = "infinitumveil.app"
}
