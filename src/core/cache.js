// Finished-chapter cache, so a re-read is instant. Ported from JP Subs'
// background.js cache (byte budget, LRU eviction, pipeline versioning) and
// pulled into its own module, storage-injected like glossary.js, so it is
// tested without chrome.*.
//
// Two things chapters need that videos did not:
//   - A source fingerprint. Web novel authors revise published chapters; a
//     cached translation of the old text must not be served for the new one.
//   - Novel-wide rewrites, so a glossary correction reaches chapters already
//     read (rewriteNovel, below; JP Subs' glossary:apply did this per video).

import { applyReplacements } from "./glossary-apply.js";

/**
 * Bump whenever a change to prompt.js or pipeline.js should re-translate
 * chapters already cached. Without it, a fix never reaches a chapter read
 * before the fix — the cache keeps serving what the old pipeline made.
 *
 * 1 — Milestone 4, first cached version.
 */
export const PIPELINE_VERSION = 1;

const PREFIX = "chapter:";
const INDEX = "chapterIndex";
// Headroom under chrome.storage.local's 10 MB quota, same as JP Subs. The
// glossaries share that quota but are tiny by comparison.
const BUDGET_BYTES = 7 * 1024 * 1024;

export function chapterKey(site, novelId, chapterId) {
  if (!site || !novelId || !chapterId) throw new Error("chapterKey needs site, novelId and chapterId.");
  return `${site}:${novelId}:${chapterId}`;
}

/** FNV-1a over the chapter's source paragraphs. Detects an edited chapter;
 *  not a security hash, and does not need to be. */
export function sourceHash(paragraphs) {
  let h = 0x811c9dc5;
  const text = paragraphs.map((p) => p.zh).join("\n");
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${paragraphs.length}:${h.toString(16)}`;
}

/**
 * @param storage - chrome.storage.local-shaped { get, set, remove }
 * @param options.budgetBytes - override for tests
 */
export function makeChapterCache(storage, { budgetBytes = BUDGET_BYTES } = {}) {
  const readIndex = async () => (await storage.get(INDEX))[INDEX] || {};
  const writeIndex = (index) => storage.set({ [INDEX]: index });

  async function drop(keys) {
    const index = await readIndex();
    for (const k of keys) delete index[k];
    await storage.remove(keys.map((k) => PREFIX + k));
    await writeIndex(index);
  }

  /**
   * The cached translation for this chapter, with the reason when there is
   * none: "none", "old-pipeline", or "text-changed".
   *
   * Only an old-pipeline entry is discarded. A text mismatch is NOT: the
   * first version dropped the entry, which meant one early, partial read of
   * a page still rendering (fewer paragraphs, so a different hash) deleted a
   * perfectly good translation. A mismatched entry now stays until a
   * complete re-translation overwrites it.
   */
  async function lookup(site, novelId, chapterId, hash) {
    const key = chapterKey(site, novelId, chapterId);
    const entry = (await storage.get(PREFIX + key))[PREFIX + key];
    if (!entry) return { entry: null, reason: "none" };
    if (entry.pipeline !== PIPELINE_VERSION) {
      await drop([key]);
      return { entry: null, reason: "old-pipeline" };
    }
    if (hash && entry.hash !== hash) {
      const count = (h) => Number(String(h).split(":")[0]);
      return { entry: null, reason: "text-changed", stored: count(entry.hash), found: count(hash) };
    }
    // Touch it so eviction sees recent reads, not just recent writes.
    const index = await readIndex();
    if (index[key]) {
      index[key].at = Date.now();
      await writeIndex(index);
    }
    return { entry, reason: "hit" };
  }

  async function get(site, novelId, chapterId, hash) {
    return (await lookup(site, novelId, chapterId, hash)).entry;
  }

  /** Store a finished chapter. Never throws: a failed cache write must not
   *  fail a run whose translation is already on the page. */
  async function put(site, novelId, chapterId, { hash, translations, title = null, model = null }) {
    const key = chapterKey(site, novelId, chapterId);
    const entry = { pipeline: PIPELINE_VERSION, hash, translations, title, model, at: Date.now() };
    try {
      const index = await readIndex();
      index[key] = { bytes: JSON.stringify(entry).length, at: entry.at, site, novelId, title };
      await storage.set({ [PREFIX + key]: entry });
      await writeIndex(index);
      await evict();
      return true;
    } catch (err) {
      console.warn("[webnovel-translator] could not cache chapter:", err?.message || err);
      return false;
    }
  }

  async function evict() {
    const index = await readIndex();
    let total = Object.values(index).reduce((n, e) => n + (e.bytes || 0), 0);
    if (total <= budgetBytes) return 0;
    const victims = [];
    for (const [key, meta] of Object.entries(index).sort((a, b) => a[1].at - b[1].at)) {
      if (total <= budgetBytes) break;
      victims.push(key);
      total -= meta.bytes || 0;
    }
    if (victims.length) await drop(victims);
    return victims.length;
  }

  /**
   * Apply glossary renames to every cached chapter of one novel. Works on
   * the English, because that is all an entry holds; it is possible because
   * an edit carries both the old and the new rendering. Returns the number
   * of chapters changed.
   */
  async function rewriteNovel(site, novelId, replacements) {
    if (!replacements.length) return 0;
    const index = await readIndex();
    const keys = Object.keys(index).filter((k) => index[k].site === site && index[k].novelId === novelId);
    let changed = 0;
    for (const key of keys) {
      const entry = (await storage.get(PREFIX + key))[PREFIX + key];
      if (!entry) continue;
      const { out, changed: lines } = applyReplacements(entry.translations, replacements);
      if (!lines) continue;
      entry.translations = out;
      index[key].bytes = JSON.stringify(entry).length;
      await storage.set({ [PREFIX + key]: entry });
      changed++;
    }
    if (changed) await writeIndex(index);
    return changed;
  }

  async function stats() {
    const entries = Object.values(await readIndex());
    return {
      chapters: entries.length,
      bytes: entries.reduce((n, e) => n + (e.bytes || 0), 0),
      budget: budgetBytes,
    };
  }

  async function clear() {
    await drop(Object.keys(await readIndex()));
  }

  return { get, lookup, put, rewriteNovel, stats, clear };
}
