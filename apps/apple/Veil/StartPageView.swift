import SwiftUI

struct StartPageView: View {
    @ObservedObject var model: BrowserModel
    @Environment(\.colorSchemeContrast) private var contrast
    @Environment(\.horizontalSizeClass) private var sizeClass
    @State private var query = ""
    @FocusState private var searchFocused: Bool

    private var palette: VeilPalette { VeilPalette(contrast: contrast) }
    private var compact: Bool { sizeClass == .compact }

    var body: some View {
        GeometryReader { geo in
            ScrollView {
                VStack(spacing: 0) {
                    header
                    Spacer(minLength: 0)
                    center
                    Spacer(minLength: 0)
                    launcher
                    footer
                }
                .frame(minHeight: geo.size.height)
                .frame(maxWidth: .infinity)
            }
        }
        .background(VeilColor.bg)
        .overlay(alignment: .topTrailing) {
            if model.appsMenuOpen {
                appsOverlay
            }
        }
    }

    private var header: some View {
        HStack(spacing: compact ? 16 : 22) {
            Text(VeilCopy.brand)
                .font(VeilFont.text(19))
                .tracking(-0.76)
                .foregroundStyle(VeilColor.ink)
                .accessibilityIdentifier("start.brand")
            Spacer(minLength: 8)
            if model.registry.mail != nil {
                NavLink(title: model.registry.mail?.label ?? VeilCopy.mail, identifier: "start.mail", hint: VeilCopy.mailHint) {
                    model.openMail()
                }
            }
            if !model.registry.apps.isEmpty {
                NavLink(title: VeilCopy.apps, identifier: "start.apps", selected: model.appsMenuOpen) {
                    model.appsMenuOpen.toggle()
                }
            }
            if model.registry.signIn != nil {
                NavLink(title: model.accountName == nil ? (model.registry.signIn?.label ?? VeilCopy.signIn) : "Signed in", identifier: "start.signin", hint: VeilCopy.signInHint) {
                    model.signIn()
                }
            }
        }
        .padding(.horizontal, compact ? 8 : 14)
        .frame(minHeight: 52)
        .overlay(alignment: .bottom) { Rectangle().fill(palette.rule).frame(height: 1) }
    }

    private var center: some View {
        VStack(spacing: 0) {
            TextField(VeilCopy.searchPlaceholder, text: $query)
                .textFieldStyle(.plain)
                .font(VeilFont.text(16))
                .foregroundStyle(VeilColor.ink)
                .padding(.horizontal, 16)
                .padding(.vertical, 14)
                .background(VeilColor.bg)
                .overlay(RoundedRectangle(cornerRadius: 2).stroke(searchFocused ? VeilColor.ink : palette.rule, lineWidth: 1))
                .focused($searchFocused)
                .submitLabel(.search)
                .autocorrectionDisabled()
                .onSubmit(search)
                .accessibilityIdentifier("start.search")
                .accessibilityLabel(VeilCopy.searchPlaceholder)
            HStack(spacing: 8) {
                Circle().fill(VeilColor.accent).frame(width: 8, height: 8)
                Text(model.workspaceText)
                    .font(VeilFont.text(12))
                    .foregroundStyle(VeilColor.ink)
            }
            .padding(.top, 16)
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier("start.workspace")
            .accessibilityLabel(model.workspaceText)
            .accessibilityHint(VeilCopy.workspaceHint)
            status
            if !model.bookmarks.isEmpty {
                bookmarks
            }
        }
        .frame(maxWidth: 620)
        .padding(.horizontal, 16)
        .padding(.top, 48)
        .padding(.bottom, 80)
    }

    private var status: some View {
        HStack(spacing: 14) {
            HStack(spacing: 7) {
                Circle().fill(VeilColor.status(model.torState, blocked: model.torState == .blocked)).frame(width: 7, height: 7)
                Text(model.statusText)
                    .font(VeilFont.text(12))
                    .foregroundStyle(palette.inkQuiet)
                    .accessibilityIdentifier("tor.status")
            }
            textButton(VeilCopy.newCircuit, hint: VeilCopy.newCircuitHint, identifier: "start.newCircuit") {
                model.newCircuit()
            }
            textButton(VeilCopy.newIdentity, hint: VeilCopy.newIdentityHint, identifier: "start.newIdentity") {
                model.newIdentity()
            }
        }
        .padding(.top, 8)
    }

    private var bookmarks: some View {
        Flow(spacing: 6) {
            ForEach(model.bookmarks.prefix(12)) { bookmark in
                Button {
                    model.openURL(bookmark.url, newTab: false)
                } label: {
                    Text(bookmark.title)
                        .font(VeilFont.text(12))
                        .foregroundStyle(VeilColor.ink)
                        .lineLimit(1)
                        .padding(.horizontal, 12)
                        .padding(.vertical, 6)
                        .frame(maxWidth: 200)
                        .overlay(RoundedRectangle(cornerRadius: 2).stroke(palette.rule, lineWidth: 1))
                }
                .buttonStyle(.plain)
                .help(bookmark.title)
            }
        }
        .padding(.top, 32)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Bookmarks")
    }

    private var launcher: some View {
        HStack(spacing: compact ? 18 : 22) {
            ForEach(model.registry.apps.filter(\.panel)) { app in
                AppLink(title: app.name, identifier: "start.app.\(app.id)", help: app.summary) {
                    model.openApp(app)
                }
            }
        }
        .padding(.horizontal, 14)
        .padding(.bottom, 14)
    }

    private var footer: some View {
        HStack(alignment: .firstTextBaseline) {
            Text(VeilCopy.footerTagline)
                .font(VeilFont.text(12))
                .foregroundStyle(VeilColor.ink)
                .accessibilityIdentifier("start.tagline")
            Spacer(minLength: 16)
            HStack(spacing: 18) {
                ForEach(model.registry.apps.filter(\.footer)) { app in
                    Button(app.name) { model.openApp(app) }
                        .buttonStyle(.plain)
                        .font(VeilFont.text(12))
                        .foregroundStyle(VeilColor.ink)
                        .help(app.summary)
                }
                Text(VeilCopy.copyright)
                    .font(VeilFont.text(12))
                    .foregroundStyle(palette.inkQuiet)
                    .accessibilityIdentifier("start.copyright")
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 14)
        .overlay(alignment: .top) { Rectangle().fill(palette.rule).frame(height: 1) }
    }

    private var appsOverlay: some View {
        VStack(alignment: .trailing, spacing: 0) {
            AppsPanel(model: model)
                .padding(.top, 44)
                .padding(.trailing, compact ? 8 : 14)
            Color.white.opacity(0.001)
                .contentShape(Rectangle())
                .onTapGesture { model.appsMenuOpen = false }
        }
    }

    private func search() {
        let text = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        model.openURL(VeilSearch.query(text), newTab: false)
        query = ""
    }

    private func textButton(_ title: String, hint: String, identifier: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title)
                .font(VeilFont.text(12))
                .foregroundStyle(palette.inkQuiet)
                .padding(.horizontal, 10)
                .padding(.vertical, 6)
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier(identifier)
        .accessibilityHint(hint)
    }
}

private struct NavLink: View {
    var title: String
    var identifier: String
    var hint: String = ""
    var selected = false
    var action: () -> Void
    @State private var hover = false

    var body: some View {
        Button(action: action) {
            Text(title)
                .font(VeilFont.text(13))
                .foregroundStyle(VeilColor.ink)
                .padding(.vertical, 8)
                .overlay(alignment: .bottom) {
                    Rectangle()
                        .fill(VeilColor.ink)
                        .frame(height: 2)
                        .scaleEffect(x: hover || selected ? 1 : 0.001, y: 1)
                }
        }
        .buttonStyle(.plain)
        .onHover { hover = $0 }
        .animation(.easeOut(duration: 0.15), value: hover)
        .accessibilityIdentifier(identifier)
        .accessibilityHint(hint)
        .accessibilityAddTraits(selected ? AccessibilityTraits.isSelected : AccessibilityTraits())
    }
}

private struct AppLink: View {
    var title: String
    var identifier: String
    var help: String
    var action: () -> Void
    @State private var hover = false

    var body: some View {
        Button(action: action) {
            Text(title)
                .font(VeilFont.text(13))
                .foregroundStyle(hover ? VeilColor.ink : VeilColor.appLink)
                .padding(.vertical, 8)
                .overlay(alignment: .bottom) {
                    Rectangle()
                        .fill(VeilColor.ink)
                        .frame(height: 2)
                        .scaleEffect(x: hover ? 1 : 0.001, y: 1)
                }
        }
        .buttonStyle(.plain)
        .onHover { hover = $0 }
        .animation(.easeOut(duration: 0.15), value: hover)
        .help(help)
        .accessibilityIdentifier(identifier)
    }
}

struct AppsPanel: View {
    @ObservedObject var model: BrowserModel

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(model.registry.apps) { app in
                Button {
                    model.openApp(app)
                } label: {
                    VStack(alignment: .leading, spacing: 1) {
                        Text(app.name)
                            .font(VeilFont.text(14))
                            .foregroundStyle(VeilColor.ink)
                        Text(app.panel ? "\(app.summary) · \(VeilCopy.panelHint)" : app.summary)
                            .font(VeilFont.text(12))
                            .foregroundStyle(VeilColor.inkQuiet)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 9)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
        }
        .padding(8)
        .frame(width: 300)
        .background(VeilColor.bg)
        .overlay(RoundedRectangle(cornerRadius: 4).stroke(VeilColor.rule, lineWidth: 1))
        .shadow(color: VeilColor.shadow.opacity(0.12), radius: 14, y: 8)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Infinitum apps")
    }
}

struct PausedPage: View {
    @ObservedObject var model: BrowserModel
    var url: URL?

    var body: some View {
        VStack(spacing: 14) {
            HStack(spacing: 8) {
                Circle().fill(VeilColor.status(model.torState, blocked: model.torState == .blocked)).frame(width: 8, height: 8)
                Text(model.workspaceText)
                    .font(VeilFont.text(12))
            }
            Text(model.statusText)
                .font(VeilFont.text(15))
                .foregroundStyle(VeilColor.ink)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 420)
            if let url {
                Text(url.absoluteString)
                    .font(VeilFont.text(12))
                    .foregroundStyle(VeilColor.inkQuiet)
                    .lineLimit(2)
                    .frame(maxWidth: 420)
            }
            Text(model.tor.diagnostics)
                .font(VeilFont.text(12))
                .foregroundStyle(VeilColor.inkQuiet)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 460)
        }
        .padding(24)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(VeilColor.bg)
    }
}

/// Wrapping row for bookmark chips. Matches the start page's flex wrap.
struct Flow: Layout {
    var spacing: CGFloat = 6

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = proposal.width ?? 620
        let lines = makeRows(width: width, subviews: subviews)
        let height = lines.map { $0.map(\.height).max() ?? 0 }.reduce(0, +) + spacing * CGFloat(max(lines.count - 1, 0))
        return CGSize(width: width, height: height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var y = bounds.minY
        for line in makeRows(width: bounds.width, subviews: subviews) {
            var x = bounds.minX
            let height = line.map(\.height).max() ?? 0
            for item in line {
                item.view.place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(width: item.width, height: item.height))
                x += item.width + spacing
            }
            y += height + spacing
        }
    }

    private func makeRows(width: CGFloat, subviews: Subviews) -> [[Item]] {
        var rows: [[Item]] = [[]]
        var used: CGFloat = 0
        for view in subviews {
            let size = view.sizeThatFits(.unspecified)
            let itemWidth = min(size.width, 200)
            if used + itemWidth > width, used > 0 {
                rows.append([])
                used = 0
            }
            rows[rows.count - 1].append(Item(view: view, width: itemWidth, height: size.height))
            used += itemWidth + spacing
        }
        return rows
    }

    private struct Item {
        var view: LayoutSubview
        var width: CGFloat
        var height: CGFloat
    }
}
