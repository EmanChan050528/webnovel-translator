// Site adapter registry. One adapter today (Milestone 0); Milestone 5 adds a
// second one to prove this pattern actually generalises rather than being
// qidian.js with extra steps.

import * as qidian from "./qidian.js";

const ADAPTERS = [qidian];

export function adapterForUrl(url) {
  return ADAPTERS.find((a) => a.isChapterPage(url)) || null;
}

/** { site, novelId, chapterId } for a supported chapter URL, else null. */
export function identifyNovel(url) {
  const adapter = adapterForUrl(url);
  const ids = adapter?.idsFromUrl(url);
  return ids ? { site: adapter.site, ...ids } : null;
}

export { qidian };
