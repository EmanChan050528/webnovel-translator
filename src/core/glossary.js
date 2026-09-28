// Per-novel glossary storage and merge rule.
//
// JP Subs kept this inline in background.js, keyed by channel ID. It gets its
// own module here: the merge rule is subtle enough to test without chrome.*,
// and "per-novel" needs a composite key a channel ID never did.
//
// The rule, from the brief: existing entries always win. That covers three
// cases, each of which has a test in glossary.test.mjs:
//   1. A later chapter's pass 1 proposing a different rendering for a term
//      already stored does not change it.
//   2. The per-category size cap evicts new proposals, never stored entries.
//   3. A term deleted by hand stays deleted — a later chapter's pass 1
//      proposing it again does not bring it back.

const KEY_PREFIX = "novel:";
export const CATEGORIES = ["names", "factions", "realms", "techniques", "terms"];
const MAX_ENTRIES_PER_CATEGORY = 40;
const MAX_NOVELS = 200;

/** A novel is site + the site's own novel ID, not its title — titles collide. */
export function novelKey(site, novelId) {
  if (!site || !novelId) throw new Error("novelKey requires both site and novelId.");
  return `${KEY_PREFIX}${site}:${novelId}`;
}

const emptyCategories = () => Object.fromEntries(CATEGORIES.map((k) => [k, {}]));

/**
 * Merge `add` into `base`, category by category. `base` wins every key
 * collision and is always kept whole; `add` only fills the space left under
 * the cap, and never re-adds a key listed in `suppressed[category]`.
 *
 * Pure, so the pipeline uses the same rule to build the glossary a chapter is
 * translated with — storing a hand edit is worthless if the translation
 * itself then uses pass 1's fresh guess instead.
 */
export function mergeGlossaries(base = {}, add = {}, suppressed = {}) {
  const out = {};
  for (const cat of CATEGORIES) {
    const kept = { ...(base[cat] || {}) };
    const blocked = new Set(suppressed[cat] || []);
    for (const [term, value] of Object.entries(add[cat] || {})) {
      if (Object.keys(kept).length >= MAX_ENTRIES_PER_CATEGORY) break;
      if (term in kept || blocked.has(term)) continue;
      kept[term] = value;
    }
    out[cat] = kept;
  }
  return out;
}

/**
 * @param storage - chrome.storage.local-shaped { get(keys), set(obj), remove(keys) }.
 *   Injected so this module runs under Node (tests, the CLI's --glossary file).
 */
export function makeGlossaryStore(storage) {
  async function get(site, novelId) {
    const key = novelKey(site, novelId);
    const stored = (await storage.get(key))[key];
    return {
      ...emptyCategories(),
      title: null,
      chapters: 0,
      editedByHand: false,
      suppressed: {},
      at: 0,
      ...(stored || {}),
    };
  }

  /** Fold one chapter's pass-1 findings into the novel's running glossary. */
  async function remember(site, novelId, glossary, meta = {}) {
    if (!site || !novelId || !glossary) return null;
    const prev = await get(site, novelId);
    const next = {
      ...prev,
      ...mergeGlossaries(prev, glossary, prev.suppressed),
      title: meta.novelTitle || prev.title || null,
      chapters: prev.chapters + 1,
      at: Date.now(),
    };
    await storage.set({ [novelKey(site, novelId)]: next });
    await prune();
    return next;
  }

  /**
   * Replace the whole glossary with what the editor saved. Unlike remember(),
   * this is not one more opinion to merge: it is the ground truth. Terms that
   * were present and are now gone are recorded as suppressed so pass 1 cannot
   * re-add them; a term typed back in by hand is un-suppressed.
   */
  async function replaceAll(site, novelId, categories) {
    const prev = await get(site, novelId);
    const suppressed = {};
    const next = { ...prev, editedByHand: true, at: Date.now() };
    for (const cat of CATEGORIES) {
      const now = { ...(categories[cat] || {}) };
      const removed = Object.keys(prev[cat] || {}).filter((t) => !(t in now));
      suppressed[cat] = [...new Set([...(prev.suppressed[cat] || []), ...removed])]
        .filter((t) => !(t in now));
      next[cat] = now;
    }
    next.suppressed = suppressed;
    await storage.set({ [novelKey(site, novelId)]: next });
    return next;
  }

  /** LRU over novels; hand-edited glossaries are never evicted for being old. */
  async function prune() {
    const all = await storage.get(null);
    const keys = Object.keys(all).filter((k) => k.startsWith(KEY_PREFIX));
    if (keys.length <= MAX_NOVELS) return;
    const drop = keys
      .filter((k) => !all[k]?.editedByHand)
      .sort((a, b) => (all[a]?.at || 0) - (all[b]?.at || 0))
      .slice(0, keys.length - MAX_NOVELS);
    if (drop.length) await storage.remove(drop);
  }

  /** Every remembered novel, for the paste tab's novel picker. */
  async function list() {
    const all = await storage.get(null);
    return Object.entries(all)
      .filter(([k]) => k.startsWith(KEY_PREFIX))
      .map(([k, v]) => {
        const [site, novelId] = k.slice(KEY_PREFIX.length).split(":");
        return { site, novelId, title: v.title, chapters: v.chapters || 0 };
      })
      .sort((a, b) => (a.title || "").localeCompare(b.title || ""));
  }

  return { get, remember, replaceAll, list };
}
