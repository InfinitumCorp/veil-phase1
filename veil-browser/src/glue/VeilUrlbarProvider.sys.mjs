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
 * Written against the UrlbarProvider API of Firefox ESR 153 (as used by
 * UrlbarProviderCalculator there): async isActive, sync getPriority,
 * object-form UrlbarResult, getViewTemplate/getViewUpdate, onEngagement.
 * Registered through localProviderModules in UrlbarProvidersManager.
 */
import {
  UrlbarProvider,
  UrlbarUtils,
} from "moz-src:///browser/components/urlbar/UrlbarUtils.sys.mjs";
// VeilAppCommands exports plain functions (parse, suggestion, run, ...).
import * as VeilAppCommands from "moz-src:///browser/components/veil/VeilAppCommands.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  UrlbarResult: "chrome://browser/content/urlbar/UrlbarResult.mjs",
  VeilBrowser: "moz-src:///browser/components/veil/VeilBrowser.sys.mjs",
});

const DYNAMIC_TYPE = "veilAppCommand";
// Higher than every built-in provider: when we're active, nothing else runs.
const PRIORITY = 100;

const VIEW_TEMPLATE = {
  attributes: { selectable: true },
  children: [
    { name: "icon", tag: "img", attributes: { class: "urlbarView-favicon" } },
    { name: "label", tag: "span", attributes: { class: "urlbarView-title" } },
    { name: "hint", tag: "span", attributes: { class: "urlbarView-action" } },
  ],
};

export class VeilUrlbarProvider extends UrlbarProvider {
  get name() {
    return "VeilAppCommands";
  }

  /** @returns {Values<typeof UrlbarUtils.PROVIDER_TYPE>} */
  get type() {
    return UrlbarUtils.PROVIDER_TYPE.HEURISTIC;
  }

  #suggestion(queryContext) {
    if (queryContext.sapName && queryContext.sapName != "urlbar") {
      return null;
    }
    return VeilAppCommands.suggestion(queryContext.searchString, lazy.VeilBrowser.registry);
  }

  async isActive(queryContext) {
    return !!this.#suggestion(queryContext);
  }

  getPriority(queryContext) {
    return this.#suggestion(queryContext) ? PRIORITY : 0;
  }

  async startQuery(queryContext, addCallback) {
    const s = this.#suggestion(queryContext);
    if (!s) {
      return;
    }
    const result = new lazy.UrlbarResult({
      type: UrlbarUtils.RESULT_TYPE.DYNAMIC,
      source: UrlbarUtils.RESULT_SOURCE.OTHER_LOCAL,
      heuristic: true,
      suggestedIndex: 0,
      payload: {
        dynamicType: DYNAMIC_TYPE,
        appId: s.id,
        label: s.label,
        input: queryContext.searchString,
      },
    });
    addCallback(this, result);
  }

  getViewTemplate(_result) {
    return VIEW_TEMPLATE;
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
    const { result } = details;
    if (result?.providerName != this.name) {
      return;
    }
    const win = controller.browserWindow;
    VeilAppCommands.run(result.payload.input, lazy.VeilBrowser.appPanelFor(win));
    controller.view.close();
    controller.input.handleRevert();
  }
}
