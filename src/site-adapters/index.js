// Site adapter registry. Qidian (Milestone 0) and Jinjiang (Milestone 5, the
// second site that tested whether the adapter pattern generalises — it did
// not, as first written, and the contract changed; design doc §5.2).

import * as qidian from "./qidian.js";
import * as jjwxc from "./jjwxc.js";

const ADAPTERS = [qidian, jjwxc];

export function adapterForUrl(url) {
  return ADAPTERS.find((a) => a.isChapterPage(url)) || null;
}

/** { site, novelId, chapterId } for a supported chapter URL, else null. */
export function identifyNovel(url) {
  const adapter = adapterForUrl(url);
  const ids = adapter?.idsFromUrl(url);
  return ids ? { site: adapter.site, ...ids } : null;
}

export { qidian, jjwxc };
