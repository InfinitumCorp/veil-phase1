import SwiftUI

struct BrowserRoot: View {
    @ObservedObject var model: BrowserModel
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.horizontalSizeClass) private var sizeClass

    private var regularPanel: Bool {
        #if os(macOS)
        return true
        #else
        return sizeClass != .compact
        #endif
    }

    var body: some View {
        ZStack(alignment: .topTrailing) {
            VStack(spacing: 0) {
                TabStrip(model: model)
                Toolbar(model: model)
                ZStack(alignment: .top) {
                    HStack(spacing: 0) {
                        page
                        if regularPanel, model.panel != nil {
                            PanelSplitter(model: model)
                            SidePanel(model: model)
                                .frame(width: model.panelWidth)
                        }
                    }
                    if !model.suggestions.isEmpty {
                        SuggestionList(model: model)
                            .padding(.top, 4)
                            .padding(.horizontal, 56)
                    }
                }
            }
            .background(VeilColor.bg)
            if model.menuOpen {
                Color.white.opacity(0.001)
                    .ignoresSafeArea()
                    .onTapGesture { model.menuOpen = false }
                BrowserMenu(model: model)
                    .padding(.top, 80)
                    .padding(.trailing, 8)
            }
            if let toast = model.toast {
                VStack {
                    Spacer()
                    Text(toast)
                        .font(VeilFont.text(13))
                        .foregroundStyle(.white)
                        .padding(.horizontal, 16)
                        .padding(.vertical, 10)
                        .background(VeilColor.ink)
                        .clipShape(RoundedRectangle(cornerRadius: 8))
                        .padding(.bottom, 18)
                        .onAppear {
                            Task {
                                try? await Task.sleep(nanoseconds: 4_000_000_000)
                                if model.toast == toast { model.toast = nil }
                            }
                        }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .allowsHitTesting(false)
            }
            if !regularPanel, model.panel != nil {
                SidePanel(model: model)
                    .background(VeilColor.bg)
            }
        }
        .background(VeilColor.strip.ignoresSafeArea(edges: .top))
        .sheet(item: $model.sheet) { sheet in
            switch sheet {
            case .settings: SettingsView(model: model)
            case .library: LibraryView(model: model)
            case .about: AboutView()
            }
        }
        .task { await model.start() }
        .onChange(of: scenePhase) { _, phase in
            if phase == .background { model.discardDiskIfWiping() }
        }
        .onReceive(NotificationCenter.default.publisher(for: terminateNotification)) { _ in
            model.wipeIfNeeded()
        }
        .focusedSceneValue(\.veilModel, model)
        .background(keyCommands)
    }

    private var page: some View {
        Group {
            if model.selected.showsStartPage {
                StartPageView(model: model)
            } else if model.gate.allowsLoads, model.selected.url != nil {
                TabWebView(model: model, tabID: model.selected.id)
            } else {
                PausedPage(model: model, url: model.selected.url)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(VeilColor.bg)
    }

    private var keyCommands: some View {
        Group {
            Button("") { model.newTab() }.keyboardShortcut("t", modifiers: .command)
            Button("") { model.closeTab(model.selectedTabID) }.keyboardShortcut("w", modifiers: .command)
            Button("") { model.reload() }.keyboardShortcut("r", modifiers: .command)
            Button("") { model.addressFocusToken += 1 }.keyboardShortcut("l", modifiers: .command)
        }
        .opacity(0)
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}

#if os(macOS)
import AppKit
private let terminateNotification = NSApplication.willTerminateNotification
#else
import UIKit
private let terminateNotification = UIApplication.willTerminateNotification
#endif

struct TabStrip: View {
    @ObservedObject var model: BrowserModel
    @Environment(\.horizontalSizeClass) private var sizeClass

    var body: some View {
        HStack(spacing: 4) {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 2) {
                    ForEach(model.tabs) { tab in
                        tabButton(tab)
                    }
                }
            }
            Button {
                model.newTab()
            } label: {
                Text("+")
                    .font(VeilFont.text(19))
                    .foregroundStyle(VeilColor.quiet)
                    .frame(width: 30, height: 30)
            }
            .buttonStyle(.plain)
            .accessibilityLabel(VeilCopy.newTab)
            .accessibilityIdentifier("tabs.new")
        }
        .padding(.horizontal, 8)
        .padding(.leading, trafficInset)
        .frame(height: 42)
        .background(VeilColor.strip)
    }

    private var trafficInset: CGFloat {
        #if os(macOS)
        return 70
        #else
        return 0
        #endif
    }

    private func tabButton(_ tab: BrowserTab) -> some View {
        let active = tab.id == model.selectedTabID
        return HStack(spacing: 8) {
            Text(String(tab.title.prefix(1)).uppercased())
                .font(VeilFont.text(8))
                .foregroundStyle(.white)
                .frame(width: 16, height: 16)
                .background(VeilColor.ink)
                .clipShape(RoundedRectangle(cornerRadius: 4))
            Text(tab.title)
                .font(VeilFont.text(13))
                .lineLimit(1)
                .frame(maxWidth: .infinity, alignment: .leading)
            Button {
                model.closeTab(tab.id)
            } label: {
                Text("×")
                    .font(VeilFont.text(14))
                    .foregroundStyle(VeilColor.quiet)
                    .frame(width: 20, height: 20)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Close tab")
        }
        .padding(.leading, 12)
        .padding(.trailing, 6)
        .frame(width: sizeClass == .compact ? 160 : 220, height: 34)
        .foregroundStyle(active ? VeilColor.ink : VeilColor.quiet)
        .background(active ? VeilColor.bg : Color.clear)
        .clipShape(UnevenRoundedRectangle(topLeadingRadius: 9, bottomLeadingRadius: 0, bottomTrailingRadius: 0, topTrailingRadius: 9))
        .contentShape(Rectangle())
        .onTapGesture { model.selectTab(tab.id) }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(tab.title)
        .accessibilityAddTraits(active ? .isSelected : [])
    }
}

struct Toolbar: View {
    @ObservedObject var model: BrowserModel
    @FocusState private var addressFocused: Bool

    var body: some View {
        HStack(spacing: 2) {
            tool("Back", icon: .back, identifier: "toolbar.back", enabled: model.selected.canGoBack) { model.goBack() }
            tool("Forward", icon: .forward, identifier: "toolbar.forward", enabled: model.selected.canGoForward) { model.goForward() }
            tool("Reload", icon: .reload, identifier: "toolbar.reload", enabled: !model.selected.showsStartPage) { model.reload() }
            omnibox
            tool(VeilCopy.newIdentity, icon: .identity, identifier: "toolbar.newIdentity", enabled: true) { model.newIdentity() }
            tool("Menu", icon: .menu, identifier: "toolbar.menu", enabled: true) { model.menuOpen.toggle() }
        }
        .padding(.horizontal, 8)
        .frame(height: 46)
        .background(VeilColor.bg)
        .onChange(of: model.addressFocusToken) { _, _ in addressFocused = true }
    }

    private var omnibox: some View {
        HStack(spacing: 8) {
            HStack(spacing: 7) {
                Circle().fill(VeilColor.accent).frame(width: 8, height: 8)
                Text(model.chipText)
                    .font(VeilFont.text(12.5))
                    .foregroundStyle(VeilColor.ink)
            }
            .padding(.leading, 9)
            .padding(.trailing, 11)
            .frame(height: 26)
            .background(VeilColor.bg)
            .clipShape(Capsule())
            .accessibilityIdentifier("toolbar.chip")
            TextField(VeilCopy.addressPlaceholder, text: $model.addressText)
                .textFieldStyle(.plain)
                .font(VeilFont.text(14))
                .foregroundStyle(VeilColor.ink)
                .focused($addressFocused)
                .autocorrectionDisabled()
                .submitLabel(.go)
                .onSubmit { model.submitAddress() }
                .onChange(of: addressFocused) { _, focused in
                    model.addressEditing = focused
                    if focused { model.addressChanged() }
                }
                .onChange(of: model.addressText) { _, _ in
                    if model.addressEditing { model.addressChanged() }
                }
                .onKeyPress(.downArrow) {
                    model.moveSuggestion(1)
                    return .handled
                }
                .onKeyPress(.upArrow) {
                    model.moveSuggestion(-1)
                    return .handled
                }
                .accessibilityIdentifier("toolbar.address")
                .accessibilityLabel("Address")
        }
        .padding(.leading, 5)
        .padding(.trailing, 14)
        .frame(height: 36)
        .background(addressFocused ? VeilColor.bg : VeilColor.strip)
        .clipShape(Capsule())
        .overlay(Capsule().stroke(VeilColor.ink, lineWidth: addressFocused ? 2 : 0))
        .padding(.horizontal, 6)
    }

    private func tool(_ label: String, icon: VeilIcon.Kind, identifier: String, enabled: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            VeilIcon(kind: icon)
                .foregroundStyle(enabled ? VeilColor.ink : VeilColor.disabled)
                .frame(width: 34, height: 34)
                // Plain buttons only hit-test the drawn glyph on macOS (the menu
                // icon was a 4 pt wide target); make the whole 34 pt square clickable.
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(!enabled)
        .accessibilityLabel(label)
        .accessibilityIdentifier(identifier)
    }
}

struct SuggestionList: View {
    @ObservedObject var model: BrowserModel

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(model.suggestions.enumerated()), id: \.element.id) { index, row in
                Button {
                    model.suggestionIndex = index
                    model.apply(row)
                } label: {
                    HStack(spacing: 12) {
                        Text(row.icon)
                            .font(VeilFont.text(8.5))
                            .foregroundStyle(.white)
                            .frame(width: 16, height: 16)
                            .background(VeilColor.ink)
                            .clipShape(RoundedRectangle(cornerRadius: 4))
                        Text(row.title)
                            .font(VeilFont.text(14))
                            .foregroundStyle(VeilColor.ink)
                            .lineLimit(1)
                        Spacer(minLength: 8)
                        Text(row.hint)
                            .font(VeilFont.text(12.5))
                            .foregroundStyle(VeilColor.quiet)
                    }
                    .padding(.horizontal, 18)
                    .padding(.vertical, 9)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(index == model.suggestionIndex ? VeilColor.strip : Color.clear)
                }
                .buttonStyle(.plain)
            }
            if model.suggestions.contains(where: \.isCommand) {
                Text(VeilCopy.commandFootnote)
                    .font(VeilFont.text(12))
                    .foregroundStyle(VeilColor.quiet)
                    .padding(.horizontal, 18)
                    .padding(.vertical, 8)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .overlay(alignment: .top) { Rectangle().fill(VeilColor.shellRule).frame(height: 1) }
            }
        }
        .background(VeilColor.bg)
        .clipShape(UnevenRoundedRectangle(topLeadingRadius: 0, bottomLeadingRadius: 14, bottomTrailingRadius: 14, topTrailingRadius: 0))
        .shadow(color: VeilColor.shadow.opacity(0.14), radius: 15, y: 14)
        .overlay(
            UnevenRoundedRectangle(topLeadingRadius: 0, bottomLeadingRadius: 14, bottomTrailingRadius: 14, topTrailingRadius: 0)
                .stroke(VeilColor.shellRule, lineWidth: 1)
        )
    }
}

struct BrowserMenu: View {
    @ObservedObject var model: BrowserModel

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            menu("Open SCALVS.ai") { model.openCommand(AppCommands.Command(id: "scalvs", prompt: "")) }
            menu("Open /CNDCTR/") { model.openCommand(AppCommands.Command(id: "cndctr", prompt: "")) }
            menu("New circuit for this site") { model.menuOpen = false; model.newCircuit() }
            menu(model.bookmarks.contains { $0.url == model.selected.url } ? "Remove bookmark" : "Bookmark this page") {
                model.menuOpen = false
                model.toggleBookmark()
            }
            menu("Library", identifier: "menu.library") {
                model.menuOpen = false
                model.sheet = .library
            }
            menu("Settings", identifier: "menu.settings") {
                model.menuOpen = false
                model.sheet = .settings
            }
            menu("About VEIL", identifier: "menu.about") {
                model.menuOpen = false
                model.sheet = .about
            }
        }
        .padding(6)
        .frame(minWidth: 220, alignment: .leading)
        .background(VeilColor.bg)
        .clipShape(RoundedRectangle(cornerRadius: 8))
        .shadow(color: VeilColor.shadow.opacity(0.16), radius: 15, y: 12)
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(VeilColor.shellRule, lineWidth: 1))
    }

    private func menu(_ title: String, identifier: String? = nil, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title)
                .font(VeilFont.text(13.5))
                .foregroundStyle(VeilColor.ink)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 12)
                .padding(.vertical, 9)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier(identifier ?? "menu.\(title)")
    }
}
