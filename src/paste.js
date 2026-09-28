// Paste-a-chapter tab: Milestone 5's fallback for text from any site the
// extension cannot read directly (the brief's "raw pasted chapter" case).
//
// Runs the pipeline in this page, not the service worker — the same choice
// JP Subs made for its subtitle-file tab: a page lives as long as it is
// open, so the MV3 worker-lifetime question does not arise. Extension pages
// hold the localhost host permission, so Ollama is reachable from here.

import { ollamaBackend } from "./core/backends.js";
import { run as runPipeline } from "./core/pipeline.js";
import { makeGlossaryStore } from "./core/glossary.js";
import { looksScrambled } from "./core/text-check.js";

const $ = (id) => document.getElementById(id);
const store = makeGlossaryStore({
  get: (k) => chrome.storage.local.get(k),
  set: (o) => chrome.storage.local.set(o),
  remove: (k) => chrome.storage.local.remove(k),
});

function status(text, isError = false) {
  $("status").textContent = text;
  $("status").className = "status" + (isError ? " error" : "");
}

async function loadNovels() {
  for (const n of await store.list()) {
    const opt = document.createElement("option");
    opt.value = `${n.site}:${n.novelId}`;
    opt.textContent = `${n.title || `Novel ${n.novelId}`} (${n.site}, ${n.chapters} chapter${n.chapters === 1 ? "" : "s"})`;
    $("novel").append(opt);
  }
}

function render(paragraphs, translations) {
  const box = $("result");
  box.innerHTML = "";
  paragraphs.forEach((p, i) => {
    const el = document.createElement("p");
    const zh = document.createElement("div");
    zh.className = "zh";
    zh.textContent = p.zh;
    const en = document.createElement("div");
    en.textContent = translations[i] || "…";
    if (!translations[i]) en.className = "missing";
    el.append(zh, en);
    box.append(el);
  });
}

let controller = null;

$("go").addEventListener("click", async () => {
  const paragraphs = $("source").value
    .split(/\r?\n/)
    .map((l) => l.replace(/^[\s　]+|[\s　]+$/g, ""))
    .filter(Boolean)
    .map((zh) => ({ zh }));

  if (!paragraphs.length) return status("Paste some text first.", true);
  if (looksScrambled(paragraphs)) {
    return status(
      "This text is scrambled by an anti-copy font — pasting copies the scrambled characters, not what the page displayed. There is nothing readable to translate.",
      true
    );
  }

  const [site, novelId] = ($("novel").value || ":").split(":");
  const seed = site && novelId ? await store.get(site, novelId) : null;
  const model = (await chrome.storage.local.get("model")).model || "qwen3.5:9b";

  controller = new AbortController();
  $("go").disabled = true;
  $("stop").hidden = false;
  $("toggle").hidden = false;
  render(paragraphs, []);
  status("Building the glossary…");

  try {
    const result = await runPipeline(
      { paragraphs, novelTitle: seed?.title || null },
      ollamaBackend({ model, signal: controller.signal }),
      { seed, shouldStop: () => controller.signal.aborted },
      () => {},
      ({ translations, done, total }) => {
        render(paragraphs, translations);
        status(`Translating: ${done}/${total} chunks`);
      }
    );
    render(paragraphs, result.translations);
    // The user said this text belongs to that novel; its names should join
    // the novel's glossary like any chapter read on the site.
    if (site && novelId && !result.stopped) await store.remember(site, novelId, result.glossary, {});
    const missing = paragraphs.length - result.translated;
    status(result.stopped
      ? `Stopped: ${result.translated}/${paragraphs.length} paragraphs.`
      : `Done: ${result.translated}/${paragraphs.length} paragraphs${missing ? `, ${missing} failed` : ""}.`);
  } catch (err) {
    status(controller.signal.aborted ? "Stopped." : err.message, !controller.signal.aborted);
  } finally {
    $("go").disabled = false;
    $("stop").hidden = true;
  }
});

$("stop").addEventListener("click", () => controller?.abort());

$("toggle").addEventListener("click", () => {
  const on = document.body.classList.toggle("show-original");
  $("toggle").textContent = on ? "Hide original" : "Show original";
});

loadNovels();
