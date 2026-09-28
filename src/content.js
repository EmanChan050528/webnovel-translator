// Content script. Milestone 0-1 scope only: detect a chapter page, extract
// it on request, hand the result to the background. No DOM replacement yet —
// that is Milestone 3, and it will live in this same file because it needs
// the live paragraph elements extractChapter() already keeps around.
//
// Manifest content scripts are classic scripts, not modules: a static
// `import` here is a syntax error that kills the whole file before the
// message listener is registered, which surfaces in the background as
// "Receiving end does not exist". The adapters are loaded with dynamic
// import() instead, which classic scripts allow; the files must be listed in
// web_accessible_resources for that to resolve.

(() => {
  // The background may inject this file into a tab that already has it
  // (see background.js ensureContentScript); register the listener once.
  if (globalThis.__webnovelTranslatorLoaded) return;
  globalThis.__webnovelTranslatorLoaded = true;

  let adaptersPromise = null;
  const loadAdapters = () =>
    (adaptersPromise ||= import(chrome.runtime.getURL("src/site-adapters/index.js")));

  /**
   * Qidian renders the chapter body client-side (Vue — note the data-v-*
   * attributes on main.content). Poll briefly rather than trusting a single
   * run_at timing, so a page that needed another 200ms is not reported as
   * "extraction failed".
   */
  async function waitForChapterRoot(adapter, timeoutMs = 4000, intervalMs = 150) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const chapter = adapter.extractChapter(document);
      if (chapter && chapter.paragraphs.length > 0) return chapter;
      await new Promise((r) => setTimeout(r, intervalMs));
    }
    return adapter.extractChapter(document);
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === "ping") {
      sendResponse({ ok: true });
      return false;
    }
    if (msg?.type !== "extract-chapter") return false;

    (async () => {
      try {
        const { adapterForUrl } = await loadAdapters();
        const adapter = adapterForUrl(location.href);
        if (!adapter) {
          sendResponse({ ok: false, error: "No site adapter matches this page." });
          return;
        }
        const chapter = await waitForChapterRoot(adapter);
        if (!chapter || !chapter.paragraphs.length) {
          sendResponse({
            ok: false,
            error: "Could not find chapter text on this page. The site's layout may have changed.",
          });
          return;
        }
        sendResponse({ ok: true, chapter: adapter.toPayload(chapter) });
      } catch (err) {
        sendResponse({ ok: false, error: `Extraction failed: ${err.message}` });
      }
    })();

    return true; // async sendResponse
  });
})();
