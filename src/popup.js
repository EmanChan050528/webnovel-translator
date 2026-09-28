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
  $("auto").checked = !!res.auto;
  renderCache(res.cache);
  $("chapterTools").hidden = false;
  loadModels();
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
  $("retranslate").hidden = running || run?.status !== "done";
  $("reader").hidden = !run?.resultId;

  if (!run) return note("status", "");
  switch (run.status) {
    case "running":
      return note("status", run.total
        ? `Translating on the page: ${run.done}/${run.total} chunks. You can close this popup.`
        : "Reading the chapter and building the glossary…");
    case "done":
      return note("status", run.cached
        ? `Loaded from cache: ${run.translated} paragraphs, no model run needed.`
        : `Translated ${run.translated} paragraphs on the page.`);
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
  const lines = [
    res.arrival,
    res.run?.cacheNote,
    res.reapplied
      ? `The page re-rendered over the translation ${res.reapplied} time(s); each was corrected.`
      : res.reapplied === 0 && res.run ? "Page re-renders corrected: 0" : "",
  ].filter(Boolean);
  $("reapplied").textContent = lines.join("\n");
}

/** Installed Ollama models, ported from JP Subs' popup. The choice is stored
 *  by the background, so chapters translated on arrival use it too. */
async function loadModels() {
  const select = $("model");
  const res = await send({ type: "models:list" });
  select.innerHTML = "";
  const option = (value, label) => {
    const opt = document.createElement("option");
    opt.value = value;
    opt.textContent = label;
    select.append(opt);
    return opt;
  };

  if (!res?.ok) {
    option("", "(could not reach Ollama)");
    return note("modelNote", res?.error || "Ollama unreachable.", true);
  }
  const { models, selected } = res;
  if (!models.length) {
    option("", "(no models installed)");
    return note("modelNote", "Pull one first, e.g. ollama pull qwen3.5:9b", true);
  }
  for (const name of models) option(name, name).selected = name === selected;
  // The stored model may have been removed since it was chosen.
  if (!models.includes(selected)) {
    option(selected, `${selected} (not installed)`).selected = true;
    note("modelNote", `"${selected}" is not installed; pick another.`, true);
  } else {
    note("modelNote", "Smaller models are faster and quieter, and less accurate.");
  }
}

$("model").addEventListener("change", async (e) => {
  if (!e.target.value) return;
  await send({ type: "model:set", model: e.target.value });
  note("modelNote", "Saved. Used for every translation from now on, including automatic ones.");
});

async function translate(force) {
  $("translate").disabled = true;
  note("status", "Starting…");
  const res = await send({ type: "translate-active-tab", options: { force } });
  if (!res?.ok) {
    $("translate").disabled = false;
    return note("status", res?.error || "Something went wrong.", true);
  }
  renderRun(res.run);
}

$("translate").addEventListener("click", () => translate(false));
$("retranslate").addEventListener("click", () => translate(true));

$("auto").addEventListener("change", async (e) => {
  await send({ type: "auto:set", site: novel.site, novelId: novel.novelId, on: e.target.checked });
});

function renderCache(stats) {
  const kb = Math.round(stats.bytes / 1024);
  const pct = Math.round((stats.bytes / stats.budget) * 100);
  $("cacheStats").textContent =
    `${stats.chapters} chapter${stats.chapters === 1 ? "" : "s"}, ${kb} KB (${pct}% of the ${Math.round(stats.budget / 1048576)} MB budget). Oldest-read chapters are dropped first when full.`;
}

$("clearCache").addEventListener("click", async () => {
  const res = await send({ type: "cache:clear" });
  if (res?.ok) renderCache(res.cache);
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
  const rewritten = res.rewritten
    ? ` Renames applied to ${res.rewritten} cached chapter${res.rewritten === 1 ? "" : "s"}.`
    : "";
  note("glossaryNote", stale.length
    ? `Saved.${rewritten} Check these — they still use a name you changed:\n` + stale.join("\n")
    : `Saved.${rewritten} Used from the next translation of this novel on.`);
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
