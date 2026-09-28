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
  refreshRun();
  setInterval(refreshRun, 1000);
}

// The popup only *shows* run state; the background owns it (see
// background.js `runs`). Polling while open is enough — the popup lives for
// seconds at a time.
function renderRun(run) {
  const running = run?.status === "running";
  $("translate").disabled = running;
  $("stop").hidden = !running;
  $("toggle").hidden = !run || run.done === 0 && run.status !== "done";
  $("reader").hidden = !run?.resultId;

  if (!run) return note("status", "");
  switch (run.status) {
    case "running":
      return note("status", run.total
        ? `Translating on the page: ${run.done}/${run.total} chunks. You can close this popup.`
        : "Reading the chapter and building the glossary…");
    case "done":
      return note("status", `Translated ${run.translated} paragraphs on the page.`);
    case "stopped":
      return note("status", `Stopped. ${run.translated ? `${run.translated} paragraphs` : "What was translated"} stays on the page.`);
    case "error":
      return note("status", run.error || "Translation failed.", true);
  }
}

async function refreshRun() {
  const res = await send({ type: "run:state" });
  if (!res?.ok) return;
  renderRun(res.run);
  $("reapplied").textContent = res.reapplied
    ? `The page re-rendered over the translation ${res.reapplied} time(s); each was corrected.`
    : res.reapplied === 0 && res.run ? "Page re-renders corrected: 0" : "";
}

$("translate").addEventListener("click", async () => {
  $("translate").disabled = true;
  note("status", "Starting…");
  const model = $("model").value.trim() || undefined;
  const res = await send({ type: "translate-active-tab", options: { model } });
  if (!res?.ok) {
    $("translate").disabled = false;
    return note("status", res?.error || "Something went wrong.", true);
  }
  renderRun(res.run);
});

$("stop").addEventListener("click", async () => {
  await send({ type: "run:stop" });
  refreshRun();
});

$("toggle").addEventListener("click", async () => {
  const res = await send({ type: "page:toggle" });
  if (!res?.ok) return note("status", res?.error || "Could not toggle.", true);
  $("toggle").textContent = res.showing === "en" ? "Show original" : "Show English";
});

$("reader").addEventListener("click", () => send({ type: "reader:open" }));

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
