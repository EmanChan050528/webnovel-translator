// Per-novel glossary storage.
//
// JP Subs kept this logic inline in background.js, keyed by YouTube channel
// ID. It gets its own module here for two reasons: the merge rule is subtle
// enough to deserve tests independent of chrome.storage and message-passing
// (Milestone 2), and "per-novel" needs a composite key that a channel ID
// never did.
//
// The merge rule is unchanged from JP Subs: existing entries always win.
// Chapter 1's analysis pass proposes a glossary; a hand correction made later
// must never be overwritten by chapter 12's analysis pass finding the same
// name spelled differently.

const KEY_PREFIX = "novel:";
const CATEGORIES = ["names", "factions", "realms", "techniques", "terms"];
const MAX_ENTRIES_PER_CATEGORY = 40; // keeps the prompt small, same cap JP Subs used
const MAX_NOVELS = 200;

/** A novel is identified by site + the site's own novel ID, not by title —
 *  titles collide across sites and sometimes across novels on one site. */
export function novelKey(site, novelId) {
  if (!site || !novelId) throw new Error("novelKey requires both site and novelId.");
  return `${KEY_PREFIX}${site}:${novelId}`;
}

const empty = () => Object.fromEntries(CATEGORIES.map((k) => [k, {}]));

/**
 * @param storage - a chrome.storage.local-shaped object: { get(keys), set(obj), remove(keys) }.
 *   Passed in rather than imported so this module has no chrome.* dependency
 *   and can be unit-tested with a plain in-memory stub.
 */
export function makeGlossaryStore(storage) {
  async function get(site, novelId) {
    const key = novelKey(site, novelId);
    const stored = (await storage.get(key))[key];
    return stored || { ...empty(), title: null, chapters: 0, editedByHand: false, at: 0 };
  }

  /** Merge one chapter's pass-1 findings into the novel's running glossary.
   *  `base` (what's already stored, including any hand edits) wins over
   *  `add` (this chapter's fresh findings) on every key collision. */
  function merge(base, add) {
    const out = { ...(add || {}), ...(base || {}) };
    return Object.fromEntries(Object.entries(out).slice(0, MAX_ENTRIES_PER_CATEGORY));
  }

  async function remember(site, novelId, glossary, meta = {}) {
    if (!site || !novelId || !glossary) return;
    const key = novelKey(site, novelId);
    const prev = await get(site, novelId);

    const next = {
      title: meta.novelTitle || prev.title || null,
      ...Object.fromEntries(CATEGORIES.map((k) => [k, merge(prev[k], glossary[k])])),
      chapters: (prev.chapters || 0) + 1,
      editedByHand: prev.editedByHand || false,
      at: Date.now(),
    };
    await storage.set({ [key]: next });
    await prune();
    return next;
  }

  /**
   * Apply a hand edit made in the glossary editor. Unlike `remember`, the
   * edited value always wins outright — a person correcting an entry is not
   * "one more chapter's opinion" to be merged, it is the ground truth.
   */
  async function applyEdit(site, novelId, category, term, englishValue) {
    if (!CATEGORIES.includes(category)) {
      throw new Error(`Unknown glossary category "${category}".`);
    }
    const key = novelKey(site, novelId);
    const prev = await get(site, novelId);
    const next = {
      ...prev,
      [category]: { ...prev[category], [term]: englishValue },
      editedByHand: true,
      at: Date.now(),
    };
    await storage.set({ [key]: next });
    return next;
  }

  async function remove(site, novelId, category, term) {
    const key = novelKey(site, novelId);
    const prev = await get(site, novelId);
    const rest = { ...prev[category] };
    delete rest[term];
    const next = { ...prev, [category]: rest, editedByHand: true, at: Date.now() };
    await storage.set({ [key]: next });
    return next;
  }

  /** Bound the number of novels remembered, same LRU-with-hand-edit-immunity
   *  rule JP Subs used for channels: a glossary someone corrected by hand
   *  cost real effort and is never evicted for being old. */
  async function prune() {
    const all = await storage.get(null);
    const keys = Object.keys(all).filter((k) => k.startsWith(KEY_PREFIX));
    if (keys.length <= MAX_NOVELS) return;
    const droppable = keys
      .filter((k) => !all[k]?.editedByHand)
      .sort((a, b) => (all[a]?.at || 0) - (all[b]?.at || 0));
    const drop = droppable.slice(0, keys.length - MAX_NOVELS);
    if (drop.length) await storage.remove(drop);
  }

  /** For the glossary editor / stretch reference: every novel remembered. */
  async function list() {
    const all = await storage.get(null);
    return Object.entries(all)
      .filter(([k]) => k.startsWith(KEY_PREFIX))
      .map(([k, v]) => ({ key: k, ...v }));
  }

  return { get, remember, applyEdit, remove, list };
}
