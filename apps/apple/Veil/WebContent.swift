import SwiftUI
import WebKit

#if os(macOS)
import AppKit
typealias VeilRepresentable = NSViewRepresentable
#else
import UIKit
typealias VeilRepresentable = UIViewRepresentable
#endif

struct TabWebView: View {
    @ObservedObject var model: BrowserModel
    let tabID: UUID

    var body: some View {
        if let tab = model.tabs.first(where: { $0.id == tabID }), let url = tab.url {
            WebRepresentable(model: model, tabID: tabID, url: url, generation: tab.loadGeneration)
                .id(model.sessionGeneration)
        }
    }
}

struct PanelWebView: View {
    @ObservedObject var model: BrowserModel
    let url: URL
    let generation: Int

    var body: some View {
        WebRepresentable(model: model, tabID: nil, url: url, generation: generation)
            .id(model.sessionGeneration)
    }
}

struct WebRepresentable: VeilRepresentable {
    @ObservedObject var model: BrowserModel
    var tabID: UUID?
    var url: URL
    var generation: Int

    func makeCoordinator() -> WebCoordinator {
        WebCoordinator(model: model, tabID: tabID)
    }

    #if os(macOS)
    func makeNSView(context: Context) -> WKWebView { makeView(context) }
    func updateNSView(_ view: WKWebView, context: Context) { update(view, context) }
    #else
    func makeUIView(context: Context) -> WKWebView { makeView(context) }
    func updateUIView(_ view: WKWebView, context: Context) { update(view, context) }
    #endif

    private func makeView(_ context: Context) -> WKWebView {
        let webView = WKWebView(frame: .zero, configuration: model.webConfiguration())
        webView.navigationDelegate = context.coordinator
        webView.uiDelegate = context.coordinator
        webView.allowsBackForwardNavigationGestures = true
        webView.isInspectable = false
        #if os(iOS)
        webView.allowsLinkPreview = false
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        #endif
        context.coordinator.attach(webView, url: url, generation: generation)
        return webView
    }

    private func update(_ webView: WKWebView, _ context: Context) {
        context.coordinator.model = model
        context.coordinator.tabID = tabID
        context.coordinator.apply(order: model.tabOrder, webView: webView)
        context.coordinator.loadIfNeeded(webView, url: url, generation: generation)
    }
}

@MainActor
final class WebCoordinator: NSObject, WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate {
    var model: BrowserModel
    var tabID: UUID?
    private var loadedGeneration = -1
    private var appliedOrder = 0
    private var downloads: [ObjectIdentifier: UUID] = [:]

    init(model: BrowserModel, tabID: UUID?) {
        self.model = model
        self.tabID = tabID
    }

    func attach(_ webView: WKWebView, url: URL, generation: Int) {
        guard model.gate.allowsLoads else { return }
        loadedGeneration = generation
        webView.load(URLRequest(url: url))
    }

    func loadIfNeeded(_ webView: WKWebView, url: URL, generation: Int) {
        guard generation != loadedGeneration else { return }
        guard model.gate.allowsLoads else { return }
        loadedGeneration = generation
        webView.load(URLRequest(url: url))
    }

    func apply(order: TabOrder?, webView: WKWebView) {
        guard let order, order.id == tabID, order.token != appliedOrder else { return }
        appliedOrder = order.token
        switch order.action {
        case .back where webView.canGoBack: webView.goBack()
        case .forward where webView.canGoForward: webView.goForward()
        case .reload: webView.reload()
        case .stop: webView.stopLoading()
        default: break
        }
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if navigationAction.shouldPerformDownload {
            decisionHandler(.download)
            return
        }
        guard let url = navigationAction.request.url else {
            decisionHandler(.cancel)
            return
        }
        switch model.decideNavigation(url) {
        case .allow:
            decisionHandler(.allow)
        case .cancel:
            decisionHandler(.cancel)
        case .redirect(let replacement):
            decisionHandler(.cancel)
            webView.load(URLRequest(url: replacement))
        }
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse, decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        if navigationResponse.canShowMIMEType {
            decisionHandler(.allow)
        } else {
            decisionHandler(.download)
        }
    }

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
        download.delegate = self
    }

    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
        download.delegate = self
    }

    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        report(webView, loading: true)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        report(webView, loading: false)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        report(webView, loading: false)
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        report(webView, loading: false)
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if navigationAction.targetFrame == nil, let url = navigationAction.request.url {
            model.openURL(url, newTab: true)
        }
        return nil
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        model.toast = String(message.prefix(180))
        completionHandler()
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        completionHandler(false)
    }

    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (String?) -> Void) {
        completionHandler(nil)
    }

    func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin, initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType, decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        decisionHandler(.deny)
    }

    #if os(iOS)
    func webView(_ webView: WKWebView, requestDeviceOrientationAndMotionPermissionFor origin: WKSecurityOrigin, initiatedByFrame frame: WKFrameInfo, decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        decisionHandler(.deny)
    }
    #endif

    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String, completionHandler: @escaping (URL?) -> Void) {
        let directory = DownloadDirectory.directory()
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let suggested = suggestedFilename.isEmpty ? (response.suggestedFilename ?? "download") : suggestedFilename
        let destination = DownloadDirectory.uniqueDestination(
            directory: directory,
            suggested: suggested,
            exists: { FileManager.default.fileExists(atPath: $0.path) }
        )
        guard SessionPaths.isWipeable(directory) else {
            completionHandler(nil)
            return
        }
        let item = DownloadItem(id: UUID(), filename: destination.lastPathComponent, path: destination, state: .running)
        downloads[ObjectIdentifier(download)] = item.id
        model.addDownload(item)
        completionHandler(destination)
    }

    func downloadDidFinish(_ download: WKDownload) {
        if let id = downloads[ObjectIdentifier(download)] {
            model.updateDownload(id, state: .finished)
        }
    }

    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        // Resume data can contain the URL. It is not written to disk.
        if let id = downloads[ObjectIdentifier(download)] {
            model.updateDownload(id, state: .failed("The download stopped."))
        }
    }

    private func report(_ webView: WKWebView, loading: Bool) {
        guard let tabID else { return }
        model.notePage(tabID, title: webView.title, url: webView.url, back: webView.canGoBack, forward: webView.canGoForward, loading: loading)
    }
}
