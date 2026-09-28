// Site adapter for jjwxc.net (晋江文学城). Milestone 5's second site.
//
// DOM shape checked by hand against free chapters on 2026-09-28 (design doc
// §5.2). Unlike Qidian, a paragraph is not an element: the chapter is loose
// text in #paragraph_comment_content, one text node per paragraph, separated
// by pairs of <br>. That difference is the point of a second adapter — it is
// what made the adapter contract hand content.js text nodes instead of
// elements.
//
// Free chapters only (onebook.php). Jinjiang's VIP chapters live at a
// different URL behind a login and are known to use font obfuscation; they
// are out of scope, same as Qidian's paywalled chapters.

export const site = "jjwxc";

export function idsFromUrl(url) {
  try {
    const u = new URL(url);
    if (!/(^|\.)jjwxc\.net$/.test(u.hostname) || u.pathname !== "/onebook.php") return null;
    const novelId = u.searchParams.get("novelid");
    const chapterId = u.searchParams.get("chapterid");
    return /^\d+$/.test(novelId || "") && /^\d+$/.test(chapterId || "") ? { novelId, chapterId } : null;
  } catch {
    return null;
  }
}

/** A novel's catalog page has a novelid but no chapterid: not a chapter. */
export function isChapterPage(url = location.href) {
  return !!idsFromUrl(url);
}

export function contentRoot(doc = document) {
  return doc.querySelector("#paragraph_comment_content");
}

const trim = (s) => s.replace(/^[\s　]+|[\s　]+$/g, "");

/**
 * Split the root's children into paragraphs at <br>. A paragraph that
 * contains an element with its own text (a <font> or <span> inside the prose)
 * is marked `unsafe`: rewriting only its loose text nodes would leave that
 * element's Chinese sitting in the middle of the English. content.js treats
 * an unsafe paragraph as a reason to fall back to the reader tab (§5.1).
 */
function splitParagraphs(root) {
  const out = [];
  let run = { nodes: [], text: "", unsafe: false };
  const flush = () => {
    const zh = trim(run.text);
    if (zh) out.push({ index: out.length, zh, nodes: run.nodes, unsafe: run.unsafe });
    run = { nodes: [], text: "", unsafe: false };
  };
  for (const node of root.childNodes) {
    if (node.nodeName === "BR") { flush(); continue; }
    if (node.nodeType === Node.TEXT_NODE) {
      run.nodes.push(node);
      run.text += node.nodeValue;
    } else if (node.nodeType === Node.ELEMENT_NODE && !["SCRIPT", "STYLE"].includes(node.tagName)) {
      const inner = trim(node.textContent || "");
      if (inner) {
        run.text += inner;
        run.unsafe = true;
      }
    }
  }
  flush();
  return out;
}

function findNavLink(doc, label) {
  const a = Array.from(doc.querySelectorAll("a")).find((el) => el.textContent.includes(label));
  return a ? a.href : null;
}

export function extractChapter(doc = document) {
  const ids = idsFromUrl(doc.location ? doc.location.href : location.href);
  if (!ids) return null;
  const root = contentRoot(doc);
  if (!root) return null;

  const paragraphs = splitParagraphs(root);
  const bodyText = (doc.body.innerText || "").slice(0, 4000);
  return {
    site,
    novelId: ids.novelId,
    chapterId: ids.chapterId,
    novelTitle: (doc.title.match(/《(.+?)》/) || [])[1] || null,
    chapterTitle: trim(doc.querySelector(".novelbody h2")?.textContent || "") || null,
    paragraphs,
    nextChapterUrl: findNavLink(doc, "下一章"),
    prevChapterUrl: findNavLink(doc, "上一章"),
    // Same honest-degradation rule as qidian.js: a near-empty chapter next
    // to purchase or login wording is a gate, not a short chapter.
    locked: paragraphs.length < 3 && /VIP|购买|登录|订阅/.test(bodyText),
  };
}

export function toPayload(chapter) {
  if (!chapter) return chapter;
  const { paragraphs, ...rest } = chapter;
  return { ...rest, paragraphs: paragraphs.map(({ index, zh }) => ({ index, zh })) };
}
