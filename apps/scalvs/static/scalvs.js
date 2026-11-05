"use strict";
(async () => {
  const feed = document.getElementById("feed");
  const history = [];               // this conversation, in this page only
  let busy = false;

  async function ask(text) {
    if (busy) return;
    busy = true;
    Infinitum.bubble(feed, "user", text);
    history.push({ role: "user", content: text });
    const waiting = Infinitum.bubble(feed, "app", "Thinking…");
    waiting.classList.add("thinking");
    try {
      const r = await Infinitum.api("/api/ask", { messages: history });
      waiting.remove();
      if (r.notice) {
        Infinitum.bubble(feed, "notice", r.notice);
        history.pop();
      } else {
        Infinitum.bubble(feed, "app", r.reply);
        history.push({ role: "assistant", content: r.reply });
      }
    } catch (err) {
      waiting.remove();
      Infinitum.bubble(feed, "app error", err.message);
      history.pop();
    } finally {
      busy = false;
    }
  }

  Infinitum.composer(document.getElementById("ask"), document.getElementById("q"), ask);
  Infinitum.api("/api/me").then(({ user }) => Infinitum.renderWho(document.getElementById("who"), user)).catch(() => {});

  const prompt = Infinitum.takePrompt();      // from "@scalvs …" in the address bar
  if (prompt) ask(prompt);
})();
