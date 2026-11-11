import SwiftUI

struct SidePanel: View {
    @ObservedObject var model: BrowserModel

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 2) {
                Text(model.panel?.title ?? "")
                    .font(VeilFont.text(13))
                    .frame(width: 1, height: 1)
                    .clipped()
                    .accessibilityHidden(false)
                Spacer()
                panelButton("Open in a new tab", icon: .external) {
                    guard let panel = model.panel else { return }
                    let url = panel.url
                    model.panel = nil
                    model.openURL(url, newTab: true)
                }
                panelButton("Close panel", icon: .close) {
                    model.panel = nil
                }
            }
            .padding(.horizontal, 6)
            .frame(height: 34)
            .background(VeilColor.strip)
            Group {
                if let panel = model.panel, model.gate.allowsLoads {
                    PanelWebView(model: model, url: panel.url, generation: panel.generation)
                } else {
                    PausedPage(model: model, url: model.panel?.url)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .background(VeilColor.bg)
        .overlay(alignment: .leading) { Rectangle().fill(VeilColor.shellRule).frame(width: 1) }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("App panel")
    }

    private func panelButton(_ label: String, icon: VeilIcon.Kind, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            VeilIcon(kind: icon, size: 16)
                .foregroundStyle(VeilColor.quiet)
                .frame(width: 30, height: 30)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
    }
}

struct PanelSplitter: View {
    @ObservedObject var model: BrowserModel
    @State private var start: CGFloat?

    var body: some View {
        Rectangle()
            .fill(Color.clear)
            .frame(width: 5)
            .contentShape(Rectangle())
            .gesture(
                DragGesture(minimumDistance: 1)
                    .onChanged { value in
                        if start == nil { start = model.panelWidth }
                        let next = (start ?? model.panelWidth) - value.translation.width
                        model.panelWidth = min(720, max(320, next))
                    }
                    .onEnded { _ in start = nil }
            )
            .accessibilityLabel("Resize panel")
            .accessibilityAddTraits(.isButton)
    }
}
