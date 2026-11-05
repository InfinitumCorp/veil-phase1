/* VEIL app commands: run /CNDCTR/ and SCALVS.ai from the address bar.
 *
 * Typing a command in the address bar opens that app in the side panel
 * (VeilAppPanel) and hands it the rest of the line:
 *
 *   @scalvs summarize this page      -> SCALVS.ai, prompt "summarize this page"
 *   @scalus what is Tor?             -> same app (spoken name also works)
 *   @cndctr every Monday, export my reports
 *   @conductor ...                   -> /CNDCTR/
 *   @scalvs                          -> just opens SCALVS.ai
 *
 * Privacy rules:
 *  - A command is handled entirely in the browser. It is never sent to the
 *    search engine and never added to address-bar history.
 *  - The prompt is passed to the app in the URL fragment (#prompt=...),
 *    which browsers never send to any server; only the app's own page reads
 *    it, after it has loaded over Tor.
 *  - The app's address still comes from the signed registry, never from
 *    what was typed.
 *
 * Browser glue (patch 0006, [chrome]) registers an address-bar provider that
 * calls suggestion() to show the "Ask SCALVS.ai: ..." row while typing and
 * run() when the user presses Enter on it.
 */

// Command words for each app id. Case-insensitive; must be followed by a
// space or the end of the input.
export const COMMANDS = Object.freeze({
  scalvs: ["scalvs", "scalus"],
  cndctr: ["cndctr", "conductor"],
});

export const MAX_PROMPT = 2000;
const VERBS = { scalvs: "Ask", cndctr: "Run in" };

/** Parse address-bar input. Returns {id, prompt} or null if not a command. */
export function parse(input) {
  if (typeof input !== "string") return null;
  const m = /^\s*@([A-Za-z]+)(?:\s+([\s\S]*))?$/.exec(input);
  if (!m) return null;
  const word = m[1].toLowerCase();
  const id = Object.keys(COMMANDS).find(k => COMMANDS[k].includes(word));
  if (!id) return null;
  const prompt = (m[2] || "").replace(/\s+/g, " ").trim().slice(0, MAX_PROMPT);
  return { id, prompt };
}

/** The address-bar row shown while typing, or null. */
export function suggestion(input, registry) {
  const cmd = parse(input);
  if (!cmd) return null;
  const app = (registry && Array.isArray(registry.apps) ? registry.apps : []).find(a => a.id === cmd.id);
  if (!app) return null;
  const verb = VERBS[cmd.id] || "Open";
  const label = cmd.prompt ? `${verb} ${app.name}: ${cmd.prompt}` : `Open ${app.name}`;
  return { ...cmd, label, recordInHistory: false, sendToSearchEngine: false };
}

/** The panel address: the registry URL with the prompt in its fragment. */
export function panelUrl(baseUrl, prompt) {
  const url = new URL(baseUrl);
  url.hash = prompt ? `prompt=${encodeURIComponent(prompt)}` : "";
  return url.href;
}

/**
 * Run a command: open the app in the side panel with the prompt.
 * `appPanel` is a VeilAppPanel.AppPanel; it validates the registry address.
 */
export function run(input, appPanel) {
  const cmd = parse(input);
  if (!cmd) return null;
  return appPanel.openWithPrompt(cmd.id, cmd.prompt);
}
