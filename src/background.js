// Service worker. Milestone 1 scope: on request, pull the current tab's
// extracted chapter, run it through the pipeline, stash the result, and open
// a reader tab showing it. No in-place replacement, no caching across visits
// yet (Milestones 3-4) — this is deliberately the smallest thing that proves
// translation quality and the glossary mechanism end to end.

import { ollamaBackend } from "./core/backends.js";
import { run as runPipeline } from "./core/pipeline.js";
import { makeGlossaryStore } from "./core/glossary.js";

const glossaryStore = makeGlossaryStore({
  get: (keys) => chrome.storage.local.get(keys),
  set: (obj) => chrome.storage.local.set(obj),
  remove: (keys) => chrome.storage.local.remove(keys),
});

const RESULT_PREFIX = "result:";

/**
 * Manifest content scripts only reach pages loaded *after* the extension was
 * installed or reloaded. A chapter tab that was already open has no listener,
 * and sendMessage fails with "Receiving end does not exist". Ping first and
 * inject on demand; content.js guards against being loaded twice.
 */
async function ensureContentScript(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: "ping" });
  } catch {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["src/content.js"] });
  }
}

async function extractFromTab(tab) {
  if (!/^https:\/\/www\.qidian\.com\/chapter\/\d+\/\d+/.test(tab.url || "")) {
    throw new Error("This tab isn't a supported chapter page. Open a qidian.com/chapter/... page first.");
  }
  await ensureContentScript(tab.id);
  const res = await chrome.tabs.sendMessage(tab.id, { type: "extract-chapter" });
  if (!res?.ok) throw new Error(res?.error || "Extraction failed.");
  return res.chapter;
}

async function translateChapter(tab, { model } = {}, log = () => {}) {
  const chapter = await extractFromTab(tab);

  if (chapter.locked) {
    throw new Error(
      "This chapter looks paywalled — the page returned only a short preview, " +
      "not the full text. Log in with a subscription that covers it and reload, " +
      "or pick a chapter you already have access to."
    );
  }

  const seed = await glossaryStore.get(chapter.site, chapter.novelId);
  const backend = ollamaBackend({ model });

  const result = await runPipeline(
    chapter,
    backend,
    { seed },
    log,
    () => {} // progress callback: no live overlay yet (Milestone 3)
  );

  await glossaryStore.remember(chapter.site, chapter.novelId, result.glossary, chapter);

  const resultId = `${chapter.site}:${chapter.novelId}:${chapter.chapterId}:${Date.now()}`;
  await chrome.storage.session.set({
    [RESULT_PREFIX + resultId]: {
      chapter,
      translations: result.translations,
      failures: result.failures,
      translated: result.translated,
      total: chapter.paragraphs.length,
      at: Date.now(),
    },
  });

  return resultId;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "translate-active-tab") {
    (async () => {
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab) throw new Error("No active tab.");
        const log = [];
        const resultId = await translateChapter(tab, msg.options || {}, (line) => log.push(line));
        const readerUrl = chrome.runtime.getURL(`src/reader.html?result=${encodeURIComponent(resultId)}`);
        await chrome.tabs.create({ url: readerUrl });
        sendResponse({ ok: true, resultId, log });
      } catch (err) {
        sendResponse({ ok: false, error: err.message });
      }
    })();
    return true;
  }

  if (msg?.type === "glossary:get") {
    (async () => {
      const g = await glossaryStore.get(msg.site, msg.novelId);
      sendResponse({ ok: true, glossary: g });
    })();
    return true;
  }

  if (msg?.type === "glossary:edit") {
    (async () => {
      const g = await glossaryStore.applyEdit(msg.site, msg.novelId, msg.category, msg.term, msg.value);
      sendResponse({ ok: true, glossary: g });
    })();
    return true;
  }

  return false;
});
