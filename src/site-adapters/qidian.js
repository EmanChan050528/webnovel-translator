// Site adapter for qidian.com (起点中文网). Milestone 0.
//
// DOM shape confirmed by hand against a live chapter on 2026-09-28 — see
// translator-design.md §0 for the full scouting notes and why Qidian was
// chosen over fanqienovel.com (which turned out to obfuscate its DOM text
// with a randomized per-chapter font, even on free chapters).

export const site = "qidian";

const CHAPTER_URL_RE = /qidian\.com\/chapter\/(\d+)\/(\d+)\/?/;

export function isChapterPage(url = location.href) {
  return CHAPTER_URL_RE.test(url);
}

function parseIds(url = location.href) {
  const m = url.match(CHAPTER_URL_RE);
  return m ? { novelId: m[1], chapterId: m[2] } : null;
}

/**
 * Qidian nests a `span.review` (a "hot comment count" badge like "999") right
 * after the real text, inside both `h1.title` and every paragraph's
 * `span.content-text`. `el.textContent` walks into it and glues the number
 * onto the end of the real text — confirmed on chapter 1 of 斗破苍穹, where
 * the chapter title textContent came back "第一章 陨落的天才999". Reading only
 * direct text-node children avoids it without needing to know the badge's
 * class name, so it keeps working if Qidian renames it.
 */
function directText(el) {
  if (!el) return "";
  let out = "";
  for (const node of el.childNodes) {
    if (node.nodeType === Node.TEXT_NODE) out += node.textContent;
  }
  return out.replace(/^[\s　]+|[\s　]+$/g, "");
}

function findNavLink(doc, label) {
  const a = Array.from(doc.querySelectorAll("a")).find((el) => el.textContent.trim() === label);
  return a ? a.href : null;
}

/**
 * A VIP (paid) chapter renders only a truncated preview to a logged-out /
 * unsubscribed session — cut off mid-sentence, with "订阅" or "VIP" text
 * nearby — rather than an empty or error page. Confirmed on chapter 183 of
 * 斗破苍穹: 2 paragraphs came back instead of the usual ~50+, ending mid-word.
 * This is a real auth boundary, not anti-scraping obfuscation: a paragraph
 * count this low on a chapter that should be full-length is the signal to
 * degrade honestly rather than translate a fragment as if it were the whole
 * chapter. See translator-design.md §0.3.
 */
function looksLocked(doc, paragraphs) {
  const bodyText = doc.body.innerText || "";
  const paywallMarker = /订阅|VIP|开通/.test(bodyText.slice(0, 4000));
  return paywallMarker && paragraphs.length < 5;
}

/**
 * @returns {object|null} null if this is not a chapter page or has no
 *   recognisable content root. Otherwise:
 *   { site, novelId, chapterId, novelTitle, chapterTitle, paragraphs, nextChapterUrl, prevChapterUrl, locked }
 *   `paragraphs` is [{ index, zh, el }] — `el` is the live DOM node, kept for
 *   Milestone 3's in-place replacement; strip it (see toPayload below) before
 *   sending a chapter across a runtime.sendMessage boundary, which cannot
 *   serialise DOM nodes.
 */
export function extractChapter(doc = document) {
  const ids = parseIds(doc.location ? doc.location.href : location.href);
  if (!ids) return null;

  const main = doc.querySelector("main.content");
  if (!main) return null;

  const novelTitle = directText(doc.querySelector("h1.text-rh3")) || null;
  const chapterTitle = directText(doc.querySelector("h1.title")) || null;

  const paragraphs = Array.from(main.querySelectorAll(":scope > p"))
    .map((el, index) => ({ index, zh: directText(el.querySelector(".content-text") || el), el }))
    .filter((p) => p.zh.length > 0);

  return {
    site,
    novelId: ids.novelId,
    chapterId: ids.chapterId,
    novelTitle,
    chapterTitle,
    paragraphs,
    nextChapterUrl: findNavLink(doc, "下一章"),
    prevChapterUrl: findNavLink(doc, "上一章"),
    locked: looksLocked(doc, paragraphs),
  };
}

/** Strip DOM element references so a chapter can cross a message boundary
 *  (content script -> service worker). Milestone 3's in-place replacement
 *  runs entirely inside the content script and can use extractChapter()'s
 *  `el` refs directly without ever needing this. */
export function toPayload(chapter) {
  if (!chapter) return chapter;
  const { paragraphs, ...rest } = chapter;
  return { ...rest, paragraphs: paragraphs.map(({ index, zh }) => ({ index, zh })) };
}
