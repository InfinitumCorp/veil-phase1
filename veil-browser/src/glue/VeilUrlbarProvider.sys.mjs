/* VEIL address-bar commands for Firefox's urlbar (patch 0006).
 *
 * Typing "@scalvs ..." or "@cndctr ..." (also "@scalus", "@conductor") shows
 * one row, "Ask SCALVS.ai™: ..." / "Run in /CNDCTR/™: ...", and pressing
 * Enter opens that app in VEIL's side panel with the request.
 *
 * Privacy: while a command is typed, this provider takes the highest
 * priority, so the urlbar runs no other provider. Nothing typed after "@scalvs"
 * reaches search suggestions, history matching or the search engine, and
 * running the command doesn't navigate, so nothing is added to history.
 *
 * Built against the UrlbarProvider API of Firefox ESR 153; confirm method
 * names (onEngagement vs. pickResult) when cutting the patch.
 */
import { UrlbarProvider, UrlbarUtils } from "resource:///modules/UrlbarUtils.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  UrlbarResult: "resource:///modules/UrlbarResult.sys.mjs",
  UrlbarView: "resource:///modules/UrlbarView.sys.mjs",
  VeilAppCommands: "resource:///modules/veil/VeilAppCommands.sys.mjs",
  VeilBrowser: "resource:///modules/veil/VeilBrowser.sys.mjs",
});

const DYNAMIC_TYPE = "veilAppCommand";
// Higher than every built-in provider: when we're active, nothing else runs.
const PRIORITY = 100;

export class VeilUrlbarProvider extends UrlbarProvider {
  get name() {
    return "VeilAppCommands";
  }

  get type() {
    return UrlbarUtils.PROVIDER_TYPE.HEURISTIC;
  }

  isActive(queryContext) {
    return !!lazy.VeilAppCommands.suggestion(queryContext.searchString, lazy.VeilBrowser.registry);
  }

  getPriority(queryContext) {
    return this.isActive(queryContext) ? PRIORITY : 0;
  }

  async startQuery(queryContext, addCallback) {
    const s = lazy.VeilAppCommands.suggestion(queryContext.searchString, lazy.VeilBrowser.registry);
    if (!s) return;
    const result = new lazy.UrlbarResult(
      UrlbarUtils.RESULT_TYPE.DYNAMIC,
      UrlbarUtils.RESULT_SOURCE.OTHER_LOCAL,
      { dynamicType: DYNAMIC_TYPE, appId: s.id, label: s.label, input: queryContext.searchString }
    );
    result.heuristic = true;
    result.suggestedIndex = 0;
    addCallback(this, result);
  }

  getViewUpdate(result) {
    return {
      icon: { attributes: { src: `chrome://browser/content/veil/icons/${result.payload.appId}.svg` } },
      label: { textContent: result.payload.label },
      hint: { textContent: "Opens in side panel" },
    };
  }

  /** Enter or click on our row: run the command in the window's side panel. */
  onEngagement(queryContext, controller, details) {
    if (details.result?.providerName !== this.name) return;
    this.#run(controller.browserWindow, details.result.payload.input);
    controller.view.close();
    controller.input.handleRevert();
  }

  // Older urlbar API name for the same thing.
  pickResult(result, element) {
    this.#run(element.ownerGlobal, result.payload.input);
  }

  #run(win, input) {
    lazy.VeilAppCommands.run(input, lazy.VeilBrowser.appPanelFor(win));
  }
}

const VIEW_TEMPLATE = {
  attributes: { selectable: true },
  children: [
    { name: "icon", tag: "img", classList: ["urlbarView-favicon"] },
    { name: "label", tag: "span", classList: ["urlbarView-title"] },
    { name: "hint", tag: "span", classList: ["urlbarView-action"] },
  ],
};

export function registerVeilUrlbarProvider(UrlbarProvidersManager) {
  lazy.UrlbarView.addDynamicViewTemplate(DYNAMIC_TYPE, VIEW_TEMPLATE);
  UrlbarProvidersManager.registerProvider(new VeilUrlbarProvider());
}
