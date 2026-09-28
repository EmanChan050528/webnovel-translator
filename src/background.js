// Service worker. Milestone 3: translate the chapter in the active tab and
// replace it in place, paragraph by paragraph, as each chunk finishes. The
// reader tab stays available as the fallback view (Milestone 5 routes to it
// automatically; for now it is a button).
//
// Run state lives here, per tab, not in the popup. Chrome destroys the popup
// page whenever it loses focus, and the first real use showed what happens
// when the popup owns the state: it "forgets" a running translation and will
// happily start a second one on the same GPU (design doc Build Order).

import { ollamaBackend } from "./core/backends.js";
import { run as runPipeline } from "./core/pipeline.js";
import { makeGlossaryStore } from "./core/glossary.js";
import { identifyNovel } from "./site-adapters/index.js";

const glossaryStore = makeGlossaryStore({
  get: (keys) => chrome.storage.local.get(keys),
  set: (obj) => chrome.storage.local.set(obj),
  remove: (keys) => chrome.storage.local.remove(keys),
});

const RESULT_PREFIX = "result:";

/**
 * tabId -> { status: "running"|"done"|"stopped"|"error", chapterId, done,
 *            total, translated, error, resultId, controller }
 * In memory only: a run cannot outlive the service worker anyway, since its
 * fetches are what keep the worker alive.
 */
const runs = new Map();

function publicRun(run) {
  if (!run) return null;
  const { controller, ...rest } = run;
  return rest;
}

/**
 * Manifest content scripts only reach pages loaded *after* the extension was
 * installed or reloaded. Ping first and inject on demand; content.js guards
 * against being loaded twice.
 */
async function ensureContentScript(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: "ping" });
  } catch {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["src/content.js"] });
  }
}

/** @param prime - true when starting a run: the content script keeps the live
 *  paragraph elements and resets its replacement state. Export must not. */
async function extractFromTab(tab, { prime = false } = {}) {
  if (!identifyNovel(tab.url)) {
    throw new Error("This tab isn't a supported chapter page. Open a qidian.com/chapter/... page first.");
  }
  await ensureContentScript(tab.id);
  const res = await chrome.tabs.sendMessage(tab.id, { type: "extract-chapter", prime });
  if (!res?.ok) throw new Error(res?.error || "Extraction failed.");
  return res.chapter;
}

/** Best-effort message to the page. A closed or navigated tab is not an error
 *  worth failing the run over — the navigation listener stops the run. */
function tellTab(tabId, msg) {
  return chrome.tabs.sendMessage(tabId, msg).catch(() => {});
}

async function startRun(tab, { model } = {}) {
  const existing = runs.get(tab.id);
  if (existing?.status === "running") {
    throw new Error("Already translating this tab. Stop it first, or wait for it to finish.");
  }

  const chapter = await extractFromTab(tab, { prime: true });
  if (chapter.locked) {
    throw new Error(
      "This chapter looks paywalled — the page returned only a short preview, " +
      "not the full text. Log in with a subscription that covers it and reload, " +
      "or pick a chapter you already have access to."
    );
  }

  const controller = new AbortController();
  const run = {
    status: "running",
    chapterId: chapter.chapterId,
    done: 0,
    total: 0,
    translated: 0,
    error: null,
    resultId: null,
    controller,
  };
  runs.set(tab.id, run);

  // Not awaited: the popup gets an immediate answer and can close. Progress
  // reaches the page directly, and the popup reads `runs` when reopened.
  translateInPlace(tab.id, chapter, run, model);
  return publicRun(run);
}

async function translateInPlace(tabId, chapter, run, model) {
  const log = (line) => console.log(`[tab ${tabId}] ${line}`);
  try {
    const seed = await glossaryStore.get(chapter.site, chapter.novelId);
    const backend = ollamaBackend({ model, signal: run.controller.signal });

    const result = await runPipeline(
      chapter,
      backend,
      { seed, shouldStop: () => run.controller.signal.aborted },
      log,
      ({ translations, done, total }) => {
        run.done = done;
        run.total = total;
        tellTab(tabId, { type: "replace:progress", translations, done, total });
      }
    );

    // A run stopped after pass 1 still produced a real glossary, worth
    // keeping. One stopped *during* pass 1 produced an empty fallback, and
    // remembering it would only inflate the chapter count. A stopped run's
    // partial translation is shown on the page but never stored as finished.
    if (!result.stopped || run.done > 0) {
      await glossaryStore.remember(chapter.site, chapter.novelId, result.glossary, chapter);
    }

    run.translated = result.translated;
    run.status = result.stopped ? "stopped" : "done";
    if (!result.stopped) {
      run.resultId = `${chapter.site}:${chapter.novelId}:${chapter.chapterId}:${Date.now()}`;
      await chrome.storage.session.set({
        [RESULT_PREFIX + run.resultId]: {
          chapter,
          translations: result.translations,
          failures: result.failures,
          translated: result.translated,
          total: chapter.paragraphs.length,
          at: Date.now(),
        },
      });
    }
    tellTab(tabId, {
      type: "replace:finished",
      translated: result.translated,
      total: chapter.paragraphs.length,
      stopped: !!result.stopped,
    });
  } catch (err) {
    const stopped = run.controller.signal.aborted;
    run.status = stopped ? "stopped" : "error";
    run.error = stopped ? null : err.message;
    tellTab(tabId, {
      type: "replace:finished",
      translated: run.translated,
      total: chapter.paragraphs.length,
      stopped,
      error: run.error,
    });
  }
}

function stopRun(tabId) {
  const run = runs.get(tabId);
  if (run?.status === "running") run.controller.abort();
}

// Leaving the chapter ends its run: the paragraphs it would write into are
// gone, and it should not keep occupying the GPU. Same rule JP Subs applies
// when a tab navigates to another video.
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (!info.url) return;
  const run = runs.get(tabId);
  if (!run) return;
  if (identifyNovel(info.url)?.chapterId !== run.chapterId) {
    stopRun(tabId);
    runs.delete(tabId);
  }
});
chrome.tabs.onRemoved.addListener((tabId) => {
  stopRun(tabId);
  runs.delete(tabId);
});

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) throw new Error("No active tab.");
  return tab;
}

const HANDLERS = {
  async "translate-active-tab"(msg) {
    return { run: await startRun(await activeTab(), msg.options || {}) };
  },

  /** From the popup, or from the page's own Stop button (sender.tab). */
  async "run:stop"(_msg, sender) {
    const tabId = sender.tab?.id ?? (await activeTab()).id;
    stopRun(tabId);
    return {};
  },

  async "run:state"() {
    const tab = await activeTab();
    // How many times the page re-rendered over a replaced paragraph (design
    // doc §3.2). Surfaced in the popup because the console is not always
    // reachable — on Qidian, opening DevTools closed the user's other tabs.
    const page = await chrome.tabs.sendMessage(tab.id, { type: "replace:state" }).catch(() => null);
    return { run: publicRun(runs.get(tab.id)), reapplied: page?.ok ? page.reapplied : null };
  },

  async "reader:open"() {
    const run = runs.get((await activeTab()).id);
    if (!run?.resultId) throw new Error("No finished translation for this tab yet.");
    await chrome.tabs.create({
      url: chrome.runtime.getURL(`src/reader.html?result=${encodeURIComponent(run.resultId)}`),
    });
    return {};
  },

  async "page:toggle"() {
    const tab = await activeTab();
    const res = await chrome.tabs.sendMessage(tab.id, { type: "replace:toggle" });
    if (!res?.ok) throw new Error(res?.error || "Could not toggle.");
    return { showing: res.showing };
  },

  /** Everything the popup needs on open: which novel, its glossary, the run. */
  async "popup:init"() {
    const tab = await activeTab();
    const novel = identifyNovel(tab.url);
    if (!novel) return { novel: null };
    const glossary = await glossaryStore.get(novel.site, novel.novelId);
    return { novel, glossary, run: publicRun(runs.get(tab.id)) };
  },

  async "glossary:save"(msg) {
    const glossary = await glossaryStore.replaceAll(msg.site, msg.novelId, msg.categories);
    return { glossary };
  },

  /** The extracted chapter, for the popup to save as a local test fixture. */
  async "export-active-tab"() {
    return { chapter: await extractFromTab(await activeTab()) };
  },
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const handler = HANDLERS[msg?.type];
  if (!handler) return false;
  handler(msg, sender)
    .then((data) => sendResponse({ ok: true, ...data }))
    .catch((err) => sendResponse({ ok: false, error: err.message }));
  return true;
});
