import SwiftUI

#if os(macOS)
import AppKit
#endif

@main
struct VeilApp: App {
    var body: some Scene {
        WindowGroup {
            BrowserWindow()
        }
        #if os(macOS)
        .defaultSize(width: 1100, height: 760)
        .windowStyle(.hiddenTitleBar)
        .commands {
            CommandGroup(replacing: .newItem) {
                NewTabCommands()
            }
        }
        #endif
    }
}

private struct BrowserWindow: View {
    @StateObject private var model = MainActor.assumeIsolated { BrowserModel.live() }

    var body: some View {
        BrowserRoot(model: model)
        #if os(macOS)
        .frame(minWidth: 720, minHeight: 520)
        .onAppear(perform: styleWindow)
        #endif
    }

    #if os(macOS)
    private func styleWindow() {
        for window in NSApplication.shared.windows {
            window.titlebarAppearsTransparent = true
            window.titleVisibility = .hidden
            window.backgroundColor = .white
            window.isMovableByWindowBackground = true
        }
    }
    #endif
}

private struct NewTabCommands: View {
    @FocusedValue(\.veilModel) private var model

    var body: some View {
        Button("New Tab") { model?.newTab() }
        Button("New Identity") { model?.newIdentity() }
    }
}

private struct VeilModelKey: FocusedValueKey {
    typealias Value = BrowserModel
}

extension FocusedValues {
    var veilModel: BrowserModel? {
        get { self[VeilModelKey.self] }
        set { self[VeilModelKey.self] = newValue }
    }
}
