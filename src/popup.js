import { toText, fromText, staleCompounds } from "./glossary-text.js";

const $ = (id) => document.getElementById(id);
const send = (msg) => chrome.runtime.sendMessage(msg);

function note(id, text, isError = false) {
  $(id).textContent = text;
  $(id).className = "note" + (isError ? " error" : "");
}

let novel = null;
let saved = null; // the glossary as last loaded or saved, for staleCompounds()

async function init() {
  const res = await send({ type: "popup:init" });
  if (!res?.ok) {
    $("novel").textContent = res?.error || "Could not read this tab.";
    return;
  }
  if (!res.novel) {
    $("novel").textContent = "Not a supported chapter page. Open a qidian.com/chapter/… page.";
    return;
  }
  novel = res.novel;
  const g = res.glossary;
  $("novel").textContent =
    `${g.title || `Novel ${novel.novelId}`} · glossary built from ${g.chapters} chapter${g.chapters === 1 ? "" : "s"}` +
    (g.editedByHand ? " · edited by hand" : "");
  saved = g;
  $("glossary").value = toText(g);
  $("chapterTools").hidden = false;
}

$("translate").addEventListener("click", async () => {
  $("translate").disabled = true;
  note("status", "Extracting and translating — a full chapter takes a few minutes. The result opens in a new tab even if this popup closes.");
  const model = $("model").value.trim() || undefined;
  const res = await send({ type: "translate-active-tab", options: { model } });
  $("translate").disabled = false;
  if (!res?.ok) return note("status", res?.error || "Something went wrong.", true);
  note("status", "Opened in a new tab.");
});

$("saveGlossary").addEventListener("click", async () => {
  const { categories, errors } = fromText($("glossary").value);
  if (errors.length) {
    // Refuse the whole save: applying the lines that parsed would record
    // every term on the broken lines as deleted.
    return note("glossaryNote", "Not saved:\n" + errors.join("\n"), true);
  }
  const res = await send({ type: "glossary:save", site: novel.site, novelId: novel.novelId, categories });
  if (!res?.ok) return note("glossaryNote", res?.error || "Could not save.", true);
  const stale = staleCompounds(saved, res.glossary);
  saved = res.glossary;
  $("glossary").value = toText(res.glossary);
  note("glossaryNote", stale.length
    ? "Saved, but check these — they still use a name you changed:\n" + stale.join("\n")
    : "Saved. Used from the next translation of this novel on.");
});

$("export").addEventListener("click", async () => {
  $("export").disabled = true;
  const res = await send({ type: "export-active-tab" });
  $("export").disabled = false;
  if (!res?.ok) return note("exportNote", res?.error || "Could not extract this chapter.", true);

  const { chapter } = res;
  const fixture = {
    ...chapter,
    sourceUrl: chapter.sourceUrl || null,
    capturedAt: new Date().toISOString().slice(0, 10),
    note: "Captured with the extension for local regression testing. Copyrighted text: keep in eval/fixtures/ (gitignored), never commit or share.",
  };
  const blob = new Blob([JSON.stringify(fixture, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${chapter.site}-${chapter.novelId}-${chapter.chapterId}.zh.json`;
  a.click();
  URL.revokeObjectURL(a.href);
  note("exportNote", `Saved ${chapter.paragraphs.length} paragraphs. Move the file into eval/fixtures/.`);
});

init();
