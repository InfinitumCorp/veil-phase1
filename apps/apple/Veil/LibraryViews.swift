import SwiftUI

struct SettingsView: View {
    @ObservedObject var model: BrowserModel
    @Environment(\.dismiss) private var dismiss
    @State private var bridges = ""

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                header("Settings")
                section("Privacy")
                row("Wipe on close") {
                    Toggle("", isOn: wipeBinding)
                        .labelsHidden()
                        .tint(VeilColor.ink)
                        .accessibilityIdentifier("settings.wipe")
                }
                Text(model.settings.wipeOnClose
                     ? "Bookmarks and history stay in memory for this visit and are discarded when VEIL closes."
                     : "Bookmarks and history are kept on this device.")
                    .font(VeilFont.text(12))
                    .foregroundStyle(VeilColor.inkQuiet)
                    .padding(.horizontal, 14)
                    .padding(.bottom, 12)
                row("HTTPS-only") {
                    Toggle("", isOn: httpsBinding)
                        .labelsHidden()
                        .tint(VeilColor.ink)
                        .accessibilityIdentifier("settings.https")
                }
                Text(model.settings.httpsOnly
                     ? "Web pages load over HTTPS. Onion addresses may use HTTP, because the onion address is the encryption."
                     : "HTTPS-only is off, so VEIL is offline until you turn it back on.")
                    .font(VeilFont.text(12))
                    .foregroundStyle(VeilColor.inkQuiet)
                    .padding(.horizontal, 14)
                    .padding(.bottom, 12)

                section("Tor")
                labeled(model.statusText)
                labeled(model.tor.diagnostics.isEmpty ? "Waiting for Tor." : model.tor.diagnostics)
                labeled("SOCKS \(model.settings.tor.socksHost):\(model.settings.tor.socksPort), version \(model.settings.tor.socksVersion). DNS goes through Tor. Direct fallback is off.")
                labeled(model.systemProxy.reason)
                labeled(model.packetTunnel.reason)
                labeled(model.rulesCompiled ? "Tracker and ad rules are compiled." : (model.rulesDiagnostic.isEmpty ? "Tracker rules are preparing." : model.rulesDiagnostic))
                if !model.anonymityProblems.isEmpty {
                    ForEach(model.anonymityProblems, id: \.pref) { problem in
                        labeled("\(problem.pref): \(problem.why)")
                    }
                }
                Text("Bridge lines")
                    .font(VeilFont.text(13))
                    .padding(.horizontal, 14)
                    .padding(.top, 8)
                TextEditor(text: $bridges)
                    .font(VeilFont.text(13))
                    .frame(minHeight: 80)
                    .padding(8)
                    .scrollContentBackground(.hidden)
                    .background(VeilColor.bg)
                    .overlay(RoundedRectangle(cornerRadius: 2).stroke(VeilColor.rule, lineWidth: 1))
                    .padding(.horizontal, 14)
                Button("Save bridges") {
                    let lines = bridges.split(whereSeparator: \.isNewline).map(String.init)
                    model.updateSettings { settings in
                        settings.tor.bridgeLines = lines
                        settings.tor.useBridges = !lines.isEmpty
                    }
                }
                .buttonStyle(.plain)
                .font(VeilFont.text(12))
                .padding(.horizontal, 14)
                .padding(.vertical, 7)
                .overlay(RoundedRectangle(cornerRadius: 2).stroke(VeilColor.ink, lineWidth: 1))
                .padding(14)
                Text("A bridge line that tries to set a proxy is refused, and VEIL goes offline. Lines are passed to the built-in Tor client. obfs4, snowflake, and webtunnel need a transport program this app does not include, so those bridges will not connect.")
                    .font(VeilFont.text(12))
                    .foregroundStyle(VeilColor.inkQuiet)
                    .padding(.horizontal, 14)
                    .padding(.bottom, 20)
            }
        }
        .background(VeilColor.bg)
        .onAppear {
            bridges = model.settings.tor.bridgeLines.joined(separator: "\n")
        }
    }

    private var wipeBinding: Binding<Bool> {
        Binding(get: { model.settings.wipeOnClose }, set: { value in
            model.updateSettings { $0.wipeOnClose = value }
        })
    }

    private var httpsBinding: Binding<Bool> {
        Binding(get: { model.settings.httpsOnly }, set: { value in
            model.updateSettings { $0.httpsOnly = value }
        })
    }

    private func header(_ title: String) -> some View {
        HStack {
            Text(title)
                .font(VeilFont.text(19))
                .tracking(-0.4)
            Spacer()
            Button("Done") { dismiss() }
                .buttonStyle(.plain)
                .font(VeilFont.text(13))
        }
        .padding(14)
        .overlay(alignment: .bottom) { Rectangle().fill(VeilColor.rule).frame(height: 1) }
    }

    private func section(_ title: String) -> some View {
        Text(title)
            .font(VeilFont.text(12))
            .foregroundStyle(VeilColor.inkQuiet)
            .padding(.horizontal, 14)
            .padding(.top, 18)
            .padding(.bottom, 6)
    }

    private func row<Control: View>(_ title: String, @ViewBuilder control: () -> Control) -> some View {
        HStack {
            Text(title)
                .font(VeilFont.text(14))
                .foregroundStyle(VeilColor.ink)
            Spacer(minLength: 12)
            control()
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
    }

    private func labeled(_ text: String) -> some View {
        Text(text)
            .font(VeilFont.text(13))
            .foregroundStyle(VeilColor.ink)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 14)
            .padding(.vertical, 6)
    }
}

struct LibraryView: View {
    @ObservedObject var model: BrowserModel
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text("Library")
                    .font(VeilFont.text(19))
                    .tracking(-0.4)
                Spacer()
                Button("Done") { dismiss() }
                    .buttonStyle(.plain)
                    .font(VeilFont.text(13))
            }
            .padding(14)
            .overlay(alignment: .bottom) { Rectangle().fill(VeilColor.rule).frame(height: 1) }
            HStack(spacing: 18) {
                ForEach(LibraryTab.allCases) { tab in
                    Button(tab.title) { model.libraryTab = tab }
                        .buttonStyle(.plain)
                        .font(VeilFont.text(13))
                        .foregroundStyle(model.libraryTab == tab ? VeilColor.ink : VeilColor.inkQuiet)
                        .padding(.vertical, 8)
                        .overlay(alignment: .bottom) {
                            Rectangle().fill(VeilColor.ink).frame(height: 2).opacity(model.libraryTab == tab ? 1 : 0)
                        }
                }
                Spacer()
                if model.libraryTab == .history {
                    Button("Clear history") { model.clearHistory() }
                        .buttonStyle(.plain)
                        .font(VeilFont.text(12))
                        .foregroundStyle(VeilColor.inkQuiet)
                }
            }
            .padding(.horizontal, 14)
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0) {
                    switch model.libraryTab {
                    case .bookmarks:
                        if model.bookmarks.isEmpty { empty("No bookmarks in this visit.") }
                        ForEach(model.bookmarks) { item in
                            entry(title: item.title, subtitle: item.url.absoluteString) {
                                model.sheet = nil
                                model.openURL(item.url, newTab: false)
                            }
                        }
                    case .history:
                        if model.history.isEmpty { empty("No history in this visit.") }
                        ForEach(model.history) { item in
                            entry(title: item.title, subtitle: item.url.absoluteString) {
                                model.sheet = nil
                                model.openURL(item.url, newTab: false)
                            }
                        }
                    case .downloads:
                        if model.downloads.isEmpty { empty("No downloads in this visit.") }
                        ForEach(model.downloads) { item in
                            VStack(alignment: .leading, spacing: 4) {
                                Text(item.filename)
                                    .font(VeilFont.text(14))
                                Text(downloadLabel(item))
                                    .font(VeilFont.text(12))
                                    .foregroundStyle(VeilColor.inkQuiet)
                                if item.state == .finished {
                                    ShareLink(item: item.path) {
                                        Text("Share")
                                            .font(VeilFont.text(12))
                                    }
                                }
                            }
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.horizontal, 14)
                            .padding(.vertical, 10)
                            .overlay(alignment: .bottom) { Rectangle().fill(VeilColor.rule).frame(height: 1) }
                        }
                    }
                }
            }
        }
        .background(VeilColor.bg)
        .frame(minWidth: 360, minHeight: 420)
    }

    private func entry(title: String, subtitle: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(VeilFont.text(14)).foregroundStyle(VeilColor.ink).lineLimit(1)
                Text(subtitle).font(VeilFont.text(12)).foregroundStyle(VeilColor.inkQuiet).lineLimit(1)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 14)
            .padding(.vertical, 10)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .overlay(alignment: .bottom) { Rectangle().fill(VeilColor.rule).frame(height: 1) }
    }

    private func empty(_ text: String) -> some View {
        Text(text)
            .font(VeilFont.text(13))
            .foregroundStyle(VeilColor.inkQuiet)
            .padding(14)
    }

    private func downloadLabel(_ item: DownloadItem) -> String {
        switch item.state {
        case .running: return "Downloading"
        case .finished: return "Finished"
        case .failed(let reason): return reason
        }
    }
}

struct AboutView: View {
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text(VeilCopy.brand)
                    .font(VeilFont.text(19))
                    .tracking(-0.76)
                Spacer()
                Button("Done") { dismiss() }
                    .buttonStyle(.plain)
                    .font(VeilFont.text(13))
            }
            Text("VEIL is Infinitum Corporation®'s Tor-first browser. \(VeilCopy.productDomain)")
                .font(VeilFont.text(14))
            Text("This copy uses WKWebView. On iOS, App Store apps that browse the web use WebKit. VEIL does not ship another browser engine, and it does not pretend a WebKit build is desktop Tor Browser.")
                .font(VeilFont.text(13))
                .foregroundStyle(VeilColor.inkQuiet)
            Text("Pages load only after a local Tor SOCKS proxy is running. Nothing here turns that requirement off. The Tor client itself is not bundled in this build, so browsing stays paused.")
                .font(VeilFont.text(13))
                .foregroundStyle(VeilColor.inkQuiet)
            Text(VeilCopy.footerTagline)
                .font(VeilFont.text(12))
            Text(VeilCopy.copyright)
                .font(VeilFont.text(12))
                .foregroundStyle(VeilColor.inkQuiet)
            Spacer()
        }
        .padding(18)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(VeilColor.bg)
        .frame(minWidth: 360, minHeight: 320)
    }
}
