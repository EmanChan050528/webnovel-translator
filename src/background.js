// Service worker. Translates the chapter in a tab and replaces it in place
// (Milestone 3); serves finished chapters from a cache and, for novels the
// user opts in, translates each chapter on arrival (Milestone 4).
//
// Run state lives here, per tab, not in the popup. Chrome destroys the popup
// page whenever it loses focus; the first real use showed a popup-owned run
// "forgetting" itself and allowing a duplicate on the same GPU.

import { ollamaBackend } from "./core/backends.js";
import { run as runPipeline } from "./core/pipeline.js";
import { makeGlossaryStore, CATEGORIES } from "./core/glossary.js";
import { makeChapterCache, sourceHash } from "./core/cache.js";
import { renamesBetween } from "./core/glossary-apply.js";
import { looksScrambled } from "./core/text-check.js";
import { identifyNovel } from "./site-adapters/index.js";

const storage = {
  get: (keys) => chrome.storage.local.get(keys),
  set: (obj) => chrome.storage.local.set(obj),
  remove: (keys) => chrome.storage.local.remove(keys),
};
const glossaryStore = makeGlossaryStore(storage);
const chapterCache = makeChapterCache(storage);

const RESULT_PREFIX = "result:";
const AUTO_PREFIX = "auto:";
const DEFAULT_MODEL = "qwen3.5:9b";
const OLLAMA_HOST = "http://localhost:11434";

/** The model the user picked in the popup. Stored, not passed per click: a
 *  chapter translated on arrival has no popup open to ask. */
async function chosenModel() {
  return (await chrome.storage.local.get("model")).model || DEFAULT_MODEL;
}

/**
 * tabId -> { status: "running"|"done"|"stopped"|"error", chapterId, done,
 *            total, translated, error, resultId, cached, controller }
 * In memory only: a run cannot outlive the service worker, since its fetches
 * are what keep the worker alive.
 */
const runs = new Map();

/**
 * tabId -> what happened when the chapter page last arrived. Shown in the
 * popup: the first cache report ("reloaded, no English") could not be
 * diagnosed because Qidian breaks DevTools, so the cache explains itself.
 */
const arrivals = new Map();

function describeLookup(found) {
  switch (found.reason) {
    case "hit": return "loaded from cache";
    case "none": return "not in cache";
    case "old-pipeline": return "cached by an older version of the extension; discarded";
    case "text-changed":
      return `cached for a different version of this chapter (${found.stored} paragraphs cached, ${found.found} on the page)`;
    default: return found.reason;
  }
}

function publicRun(run) {
  if (!run) return null;
  const { controller, ...rest } = run;
  return rest;
}

/**
 * Manifest content scripts only reach pages loaded *after* the extension was
 * installed or reloaded. Ping first and inject on demand. The flag set first
 * tells content.js it was injected here, mid-request, and must not announce
 * an arrival — that would race this request into a duplicate run.
 */
async function ensureContentScript(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: "ping" });
  } catch {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: () => { globalThis.__webnovelTranslatorInjected = true; },
    });
    await chrome.scripting.executeScript({ target: { tabId }, files: ["src/content.js"] });
  }
}

/** @param prime - true when starting a run: the content script keeps the live
 *  paragraph elements and resets its replacement state. Export must not. */
async function extractFromTab(tab, { prime = false, withFallback = false } = {}) {
  if (!identifyNovel(tab.url)) {
    throw new Error(
      "This tab isn't a supported chapter page (Qidian or Jinjiang). " +
      "For any other site, use \"Paste a chapter\" in the popup."
    );
  }
  await ensureContentScript(tab.id);
  const res = await chrome.tabs.sendMessage(tab.id, { type: "extract-chapter", prime });
  if (!res?.ok) throw new Error(res?.error || "Extraction failed.");
  return withFallback ? { chapter: res.chapter, fallback: res.fallback || null } : res.chapter;
}

async function openReader(resultId) {
  await chrome.tabs.create({
    url: chrome.runtime.getURL(`src/reader.html?result=${encodeURIComponent(resultId)}`),
  });
}

/** Best-effort message to the page; a closed or navigated tab is not an error
 *  worth failing a run over — the navigation listener stops the run. */
function tellTab(tabId, msg) {
  return chrome.tabs.sendMessage(tabId, msg).catch(() => {});
}

/** Keep a finished chapter for the reader tab (session-only). */
async function storeResult(chapter, translations, failures) {
  const resultId = `${chapter.site}:${chapter.novelId}:${chapter.chapterId}:${Date.now()}`;
  await chrome.storage.session.set({
    [RESULT_PREFIX + resultId]: {
      chapter,
      translations,
      failures,
      translated: translations.filter(Boolean).length,
      total: chapter.paragraphs.length,
      at: Date.now(),
    },
  });
  return resultId;
}

const autoKey = (site, novelId) => `${AUTO_PREFIX}${site}:${novelId}`;
async function isAuto(site, novelId) {
  return !!(await chrome.storage.local.get(autoKey(site, novelId)))[autoKey(site, novelId)];
}

/**
 * Translate `chapter` into the tab, or serve it from the cache.
 * @param chapter - already extracted *and primed* in the content script
 * @param force - skip the cache (the popup's Re-translate)
 */
/**
 * @param fallback - why this chapter cannot be replaced in place, if it
 *   cannot; the translation then opens in the reader tab when finished.
 */
async function beginRun(tabId, chapter, { force = false, fallback = null } = {}) {
  const model = await chosenModel();
  if (runs.get(tabId)?.status === "running") {
    throw new Error("Already translating this tab. Stop it first, or wait for it to finish.");
  }
  if (chapter.locked) {
    throw new Error(
      "This chapter looks paywalled — the page returned only a short preview, " +
      "not the full text. Log in with a subscription that covers it and reload, " +
      "or pick a chapter you already have access to."
    );
  }
  if (looksScrambled(chapter.paragraphs)) {
    throw new Error(
      "This page's text is scrambled by an anti-copy font: what the page " +
      "shows is not what its text actually contains, so there is nothing " +
      "readable to translate. Copying or pasting it would copy the same " +
      "scrambled characters."
    );
  }

  const hash = sourceHash(chapter.paragraphs);
  const total = chapter.paragraphs.length;

  if (!force) {
    const hit = await chapterCache.get(chapter.site, chapter.novelId, chapter.chapterId, hash);
    if (hit) {
      const run = {
        status: "done",
        cached: true,
        chapterId: chapter.chapterId,
        done: 1,
        total: 1,
        translated: hit.translations.filter(Boolean).length,
        error: null,
        fallback,
        resultId: await storeResult(chapter, hit.translations, []),
      };
      runs.set(tabId, run);
      if (fallback) {
        await openReader(run.resultId);
      } else {
        await tellTab(tabId, { type: "replace:progress", translations: hit.translations, done: 1, total: 1 });
        await tellTab(tabId, { type: "replace:finished", translated: run.translated, total, cached: true });
      }
      return publicRun(run);
    }
  }

  const run = {
    status: "running",
    cached: false,
    chapterId: chapter.chapterId,
    done: 0,
    total: 0,
    translated: 0,
    error: null,
    fallback,
    resultId: null,
    controller: new AbortController(),
  };
  runs.set(tabId, run);
  // Not awaited: the caller gets an immediate answer. Progress reaches the
  // page directly, and the popup reads `runs` when reopened.
  translateInPlace(tabId, chapter, hash, run, model);
  return publicRun(run);
}

async function translateInPlace(tabId, chapter, hash, run, model) {
  const log = (line) => console.log(`[tab ${tabId}] ${line}`);
  const total = chapter.paragraphs.length;
  try {
    const seed = await glossaryStore.get(chapter.site, chapter.novelId);
    const backend = ollamaBackend({ model, signal: run.controller.signal });

    const result = await runPipeline(
      chapter,
      backend,
      { seed, shouldStop: () => run.controller.signal.aborted },
      log,
      ({ translations, done, total: chunks }) => {
        run.done = done;
        run.total = chunks;
        tellTab(tabId, { type: "replace:progress", translations, done, total: chunks });
      }
    );

    // A run stopped during pass 1 produced only an empty fallback glossary;
    // remembering it would just inflate the chapter count.
    if (!result.stopped || run.done > 0) {
      await glossaryStore.remember(chapter.site, chapter.novelId, result.glossary, chapter);
    }

    run.translated = result.translated;
    run.status = result.stopped ? "stopped" : "done";
    if (!result.stopped) {
      run.resultId = await storeResult(chapter, result.translations, result.failures);
      // Only a complete translation is cached, the rule JP Subs settled on:
      // a chapter with gaps that looks finished on the next visit is worse
      // than one that plainly needs another run. Say which happened — the
      // popup never did, and a silently skipped write looks like a broken
      // cache.
      const missing = total - result.translated;
      if (missing > 0) {
        run.cacheNote = `Not cached: ${missing} paragraph(s) failed. Re-translate to retry.`;
      } else {
        const saved = await chapterCache.put(chapter.site, chapter.novelId, chapter.chapterId, {
          hash,
          translations: result.translations,
          title: chapter.chapterTitle,
          model: model || null,
        });
        run.cacheNote = saved ? `Saved to cache (${total} paragraphs).` : "Could not write to the cache (storage full or unavailable).";
      }
      // In-place replacement was ruled out (before the run, or by the page
      // rearranging itself during it): the reader tab is the result.
      if (run.fallback) await openReader(run.resultId);
    }
    tellTab(tabId, { type: "replace:finished", translated: result.translated, total, stopped: !!result.stopped });
  } catch (err) {
    const stopped = run.controller.signal.aborted;
    run.status = stopped ? "stopped" : "error";
    run.error = stopped ? null : err.message;
    tellTab(tabId, { type: "replace:finished", translated: run.translated, total, stopped, error: run.error });
  }
}

function stopRun(tabId) {
  const run = runs.get(tabId);
  if (run?.status === "running") run.controller.abort();
}

// Leaving the chapter ends its run: the paragraphs it would write into are
// gone. Same rule JP Subs applies when a tab navigates to another video.
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
  arrivals.delete(tabId);
});

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) throw new Error("No active tab.");
  return tab;
}

const HANDLERS = {
  async "translate-active-tab"(msg) {
    const tab = await activeTab();
    const { chapter, fallback } = await extractFromTab(tab, { prime: true, withFallback: true });
    return { run: await beginRun(tab.id, chapter, { ...(msg.options || {}), fallback }) };
  },

  /** The page gave up replacing in place mid-run (content.js abandon()):
   *  finish the run anyway and open the result in the reader tab. */
  async "page:fallback"(msg, sender) {
    const run = runs.get(sender.tab?.id);
    if (run) run.fallback = msg.reason;
    return {};
  },

  /**
   * A chapter page finished loading (sent by content.js, already primed).
   * Serve it from the cache if possible; otherwise translate it only if the
   * user opted this novel in. Anything else stays untouched — opening a
   * Qidian page must never start GPU work on its own.
   */
  async "page:arrived"(msg, sender) {
    const tabId = sender.tab?.id;
    const chapter = msg.chapter;
    if (tabId === undefined || !chapter || chapter.locked) return { action: "none" };
    if (runs.get(tabId)?.status === "running") return { action: "none" };
    // Pages that cannot be replaced in place are left alone on arrival:
    // opening a new tab unasked, every time a chapter loads, is not a
    // reasonable default. Translate from the popup opens the reader tab.
    if (msg.fallback) {
      arrivals.set(tabId, {
        chapterId: chapter.chapterId,
        note: `On arrival: ${msg.fallback} Use Translate to read it in a reader tab.`,
      });
      return { action: "none" };
    }
    if (looksScrambled(chapter.paragraphs)) {
      arrivals.set(tabId, { chapterId: chapter.chapterId, note: "On arrival: this page's text is scrambled by an anti-copy font; nothing readable to translate." });
      return { action: "none" };
    }

    const hash = sourceHash(chapter.paragraphs);
    const found = await chapterCache.lookup(chapter.site, chapter.novelId, chapter.chapterId, hash);
    const auto = await isAuto(chapter.site, chapter.novelId);
    arrivals.set(tabId, {
      chapterId: chapter.chapterId,
      note: `On arrival (${chapter.paragraphs.length} paragraphs read): ${describeLookup(found)}` +
        (found.entry ? "." : auto ? "; auto-translate is on, translating." : "; auto-translate is off."),
    });
    if (found.entry || auto) {
      const run = await beginRun(tabId, chapter, {});
      return { action: run.cached ? "cached" : "translating" };
    }
    return { action: "none" };
  },

  /** From the popup, or from the page's own Stop button (sender.tab). */
  async "run:stop"(_msg, sender) {
    stopRun(sender.tab?.id ?? (await activeTab()).id);
    return {};
  },

  async "run:state"() {
    const tab = await activeTab();
    // How often the page re-rendered over a replaced paragraph (design doc
    // §3.2). In the popup because DevTools is not always reachable — on
    // Qidian, opening it closed the user's other tabs.
    const page = await chrome.tabs.sendMessage(tab.id, { type: "replace:state" }).catch(() => null);
    const here = identifyNovel(tab.url)?.chapterId;
    const arrival = arrivals.get(tab.id);
    return {
      run: publicRun(runs.get(tab.id)),
      reapplied: page?.ok ? page.reapplied : null,
      arrival: arrival?.chapterId === here ? arrival.note : null,
    };
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

  /** Everything the popup needs on open. */
  async "popup:init"() {
    const tab = await activeTab();
    const novel = identifyNovel(tab.url);
    if (!novel) return { novel: null };
    return {
      novel,
      glossary: await glossaryStore.get(novel.site, novel.novelId),
      auto: await isAuto(novel.site, novel.novelId),
      cache: await chapterCache.stats(),
      run: publicRun(runs.get(tab.id)),
    };
  },

  /** Installed Ollama models, for the popup's dropdown. Fetched here because
   *  only the extension's own context holds the localhost permission. */
  async "models:list"() {
    const selected = await chosenModel();
    let res;
    try {
      res = await fetch(`${OLLAMA_HOST}/api/tags`);
    } catch {
      throw new Error(`Cannot reach Ollama at ${OLLAMA_HOST}. Is it running? Start it with "ollama serve".`);
    }
    if (res.status === 403) {
      throw new Error('Ollama refused the extension (403). Run: setx OLLAMA_ORIGINS "chrome-extension://*" and restart Ollama.');
    }
    if (!res.ok) throw new Error(`Ollama returned HTTP ${res.status}.`);
    const models = ((await res.json()).models || []).map((m) => m.name).sort();
    return { models, selected };
  },

  async "model:set"(msg) {
    await chrome.storage.local.set({ model: msg.model });
    return { model: msg.model };
  },

  async "auto:set"(msg) {
    await chrome.storage.local.set({ [autoKey(msg.site, msg.novelId)]: !!msg.on });
    return { auto: !!msg.on };
  },

  async "cache:clear"() {
    await chapterCache.clear();
    return { cache: await chapterCache.stats() };
  },

  /**
   * Save the glossary, then carry any renames into chapters already cached
   * — and into the page on screen, if it is showing a cached chapter of this
   * novel — so a correction does not wait for a re-translation.
   */
  async "glossary:save"(msg) {
    const before = await glossaryStore.get(msg.site, msg.novelId);
    const glossary = await glossaryStore.replaceAll(msg.site, msg.novelId, msg.categories);
    const renames = renamesBetween(before, glossary, CATEGORIES);
    const rewritten = await chapterCache.rewriteNovel(msg.site, msg.novelId, renames);

    if (renames.length) {
      const tab = await activeTab();
      const here = identifyNovel(tab.url);
      if (here?.novelId === msg.novelId && runs.get(tab.id)?.status === "done") {
        const chapter = await extractFromTab(tab).catch(() => null);
        const hit = chapter &&
          await chapterCache.get(chapter.site, chapter.novelId, chapter.chapterId, sourceHash(chapter.paragraphs));
        if (hit) await tellTab(tab.id, { type: "replace:progress", translations: hit.translations, done: 1, total: 1, quiet: true });
      }
    }
    return { glossary, rewritten };
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
