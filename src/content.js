// Content script. Milestone 3: replace each paragraph's Chinese with its
// English in place as translations arrive, keep the original for a toggle,
// and show progress on the page.
//
// Manifest content scripts are classic scripts, not modules: a static
// `import` here is a syntax error that kills the whole file (design doc
// §1.5). The adapters are loaded with dynamic import() instead.

(() => {
  // The background may inject this file into a tab that already has it
  // (background.js ensureContentScript); register everything once.
  if (globalThis.__webnovelTranslatorLoaded) return;
  globalThis.__webnovelTranslatorLoaded = true;

  let adaptersPromise = null;
  const loadAdapters = () =>
    (adaptersPromise ||= import(chrome.runtime.getURL("src/site-adapters/index.js")));

  async function waitForChapterRoot(adapter, timeoutMs = 4000, intervalMs = 150) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const chapter = adapter.extractChapter(document);
      if (chapter && chapter.paragraphs.length > 0) return chapter;
      await new Promise((r) => setTimeout(r, intervalMs));
    }
    return adapter.extractChapter(document);
  }

  // ------------------------------------------------------------ replacement
  //
  // Only the paragraph's own direct text nodes are touched, and only by
  // setting nodeValue — never by replacing or removing nodes. Qidian renders
  // this with Vue, whose virtual DOM holds references to these exact nodes;
  // swapping the node out from under it is how a later re-render would lose
  // track of the paragraph. The sibling span.review badge is left alone.

  const state = {
    adapter: null,
    chapterId: null,
    items: [], // [{ el, zh, en }] — parallel to the paragraphs sent for translation
    showing: "en",
    reapplied: 0,
    observer: null,
  };

  function textHost(p) {
    return p.querySelector(".content-text") || p;
  }

  function setDirectText(el, text) {
    const nodes = Array.from(el.childNodes).filter((n) => n.nodeType === Node.TEXT_NODE);
    if (!nodes.length) {
      el.insertBefore(document.createTextNode(text), el.firstChild);
      return;
    }
    nodes[0].nodeValue = text;
    for (const n of nodes.slice(1)) n.nodeValue = "";
  }

  function directText(el) {
    return Array.from(el.childNodes)
      .filter((n) => n.nodeType === Node.TEXT_NODE)
      .map((n) => n.nodeValue)
      .join("");
  }

  /** `raw` is the paragraph's text exactly as the page had it, including the
   *  full-width indent (　　) Qidian puts before every paragraph. The adapter's
   *  `zh` is trimmed for translation and must never be written back: the
   *  first version did, and the guard then "restored" all 142 untranslated
   *  paragraphs of a test chapter with their indent stripped. */
  function expectedText(item) {
    return state.showing === "en" && item.en ? item.en : item.raw;
  }

  function apply(item) {
    const host = textHost(item.el);
    const want = expectedText(item);
    if (directText(host) !== want) setDirectText(host, want);
  }

  /**
   * Guard against the page re-rendering over a replaced paragraph. Checked
   * directly on 2026-09-28 (design doc §3.2): scrolling, night mode and idle
   * produced zero DOM mutations, but the reader settings panel was never
   * exercised. Rather than assume, re-apply whenever a paragraph's text stops
   * matching what it should show, and count it — `reapplied` in the console
   * is the measurement of whether this risk is real.
   *
   * Idempotent: apply() writes only when the text differs, so the observer
   * firing on our own writes finds nothing to do and cannot loop.
   */
  function guard() {
    state.observer?.disconnect();
    const root = document.querySelector("main.content");
    if (!root) return;
    state.observer = new MutationObserver(() => {
      if (state.items.some((it) => !it.el.isConnected)) rebind();
      let fixed = 0;
      for (const item of state.items) {
        const host = textHost(item.el);
        if (directText(host) !== expectedText(item)) {
          setDirectText(host, expectedText(item));
          fixed++;
        }
      }
      if (fixed) {
        state.reapplied += fixed;
        console.info(`[webnovel-translator] re-applied ${fixed} paragraph(s) after a page re-render (total ${state.reapplied})`);
      }
    });
    state.observer.observe(root, { childList: true, subtree: true, characterData: true });
  }

  /** The page replaced paragraph elements outright: find the new ones by position. */
  function rebind() {
    const fresh = state.adapter?.extractChapter(document);
    if (!fresh || fresh.chapterId !== state.chapterId) return;
    // Re-extracting reads the text now on the page, which may already be our
    // English — so match by position only, never by content.
    if (fresh.paragraphs.length !== state.items.length) {
      console.warn("[webnovel-translator] page re-rendered with a different paragraph count; stopped replacing");
      state.observer?.disconnect();
      return;
    }
    fresh.paragraphs.forEach((p, i) => { state.items[i].el = p.el; });
    guard();
  }

  // --------------------------------------------------------------- the pill
  //
  // Progress and the original/English toggle, on the page. In a shadow root
  // so the site's CSS cannot restyle it, the same isolation JP Subs used for
  // its overlay.

  let pill = null;

  function ensurePill() {
    if (pill) return pill;
    const host = document.createElement("div");
    host.style.cssText = "position:fixed;right:16px;bottom:16px;z-index:2147483647;";
    const root = host.attachShadow({ mode: "open" });
    root.innerHTML = `
      <style>
        .pill { display:flex; gap:8px; align-items:center; padding:6px 8px 6px 12px;
          border-radius:999px; background:#1f2328; color:#fff; font:13px system-ui,sans-serif;
          box-shadow:0 2px 10px rgba(0,0,0,.25); }
        .msg { white-space:nowrap; }
        .msg.error { color:#ff9b9b; }
        button { font:12px system-ui,sans-serif; border:0; border-radius:999px; padding:4px 10px;
          cursor:pointer; background:#3b82f6; color:#fff; }
        button.stop { background:#6b7280; }
        [hidden] { display:none !important; }
      </style>
      <div class="pill">
        <span class="msg"></span>
        <button class="toggle" hidden></button>
        <button class="stop" hidden>Stop</button>
        <button class="close" title="Hide" style="background:transparent;padding:4px 6px">×</button>
      </div>`;
    const $ = (s) => root.querySelector(s);
    $(".toggle").addEventListener("click", () => toggle());
    $(".stop").addEventListener("click", () => chrome.runtime.sendMessage({ type: "run:stop" }));
    $(".close").addEventListener("click", () => { host.hidden = true; });
    document.documentElement.appendChild(host);
    pill = { host, $ };
    return pill;
  }

  function showPill({ text, error = false, running = false }) {
    const { host, $ } = ensurePill();
    host.hidden = false;
    $(".msg").textContent = text;
    $(".msg").className = "msg" + (error ? " error" : "");
    const hasEnglish = state.items.some((it) => it.en);
    $(".toggle").hidden = !hasEnglish;
    $(".toggle").textContent = state.showing === "en" ? "Original" : "English";
    $(".stop").hidden = !running;
  }

  function toggle() {
    if (!state.items.some((it) => it.en)) return state.showing;
    state.showing = state.showing === "en" ? "zh" : "en";
    state.items.forEach(apply);
    const { $ } = ensurePill();
    $(".toggle").textContent = state.showing === "en" ? "Original" : "English";
    return state.showing;
  }

  // ----------------------------------------------------------------- wiring

  const HANDLERS = {
    ping: () => ({}),

    /** Extract the chapter. With `prime` (start of a run), also keep the live
     *  elements for replacement and reset the replacement state; without it
     *  (fixture export), leave an existing translation on the page alone. */
    async "extract-chapter"(msg) {
      const { adapterForUrl } = await loadAdapters();
      const adapter = adapterForUrl(location.href);
      if (!adapter) throw new Error("No site adapter matches this page.");
      const chapter = await waitForChapterRoot(adapter);
      if (!chapter || !chapter.paragraphs.length) {
        throw new Error("Could not find chapter text on this page. The site's layout may have changed.");
      }
      // If a previous run replaced text, the page now shows English — hand the
      // pipeline the stored originals, not what is currently on screen.
      const previous =
        state.chapterId === chapter.chapterId && state.items.length === chapter.paragraphs.length
          ? state.items
          : null;
      if (previous) chapter.paragraphs.forEach((p, i) => { p.zh = previous[i].zh; });
      if (!msg.prime) return { chapter: adapter.toPayload(chapter) };

      state.adapter = adapter;
      state.chapterId = chapter.chapterId;
      state.items = chapter.paragraphs.map((p, i) => ({
        el: p.el,
        zh: p.zh,
        raw: previous ? previous[i].raw : directText(textHost(p.el)),
        en: "",
      }));
      state.showing = "en";
      guard();
      return { chapter: adapter.toPayload(chapter) };
    },

    "replace:progress"(msg) {
      msg.translations.forEach((en, i) => {
        const item = state.items[i];
        if (!item || !en || item.en === en) return;
        item.en = en;
        apply(item);
      });
      showPill({ text: `Translating ${msg.done}/${msg.total}`, running: true });
      return {};
    },

    "replace:finished"(msg) {
      const missing = msg.total - msg.translated;
      showPill({
        text: msg.error
          ? msg.error
          : msg.stopped
            ? `Stopped · ${msg.translated}/${msg.total} paragraphs`
            : `Translated${missing ? ` · ${missing} paragraph(s) failed` : ""}`,
        error: !!msg.error,
      });
      return {};
    },

    "replace:toggle"() {
      return { showing: toggle() };
    },

    "replace:state"() {
      return { hasEnglish: state.items.some((it) => it.en), showing: state.showing, reapplied: state.reapplied };
    },
  };

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    const handler = HANDLERS[msg?.type];
    if (!handler) return false;
    Promise.resolve()
      .then(() => handler(msg))
      .then((data) => sendResponse({ ok: true, ...data }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  });
})();
