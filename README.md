# Webnovel Translator

Chinese web novel → English, translated in place, using a local model through
[Ollama](https://ollama.com). Nothing is uploaded; nothing costs per chapter.
Same posture as [JP Subs](../Translator%20Project), aimed at prose instead of
subtitles. Full design rationale, what's built vs. not, and open risks: see
[translator-design.md](translator-design.md).

**Status:** 1.0.0, the first release — Milestones 0–5 of the brief. See
[CHANGELOG.md](CHANGELOG.md). Japanese/Korean novels and a UI redesign are
planned but not part of it.

## Setup

1. Install [Ollama](https://ollama.com) and pull a model:
   ```
   ollama pull qwen3.5:9b
   ```
2. Allow the extension to reach Ollama:
   ```
   setx OLLAMA_ORIGINS "chrome-extension://*"
   ```
   (restart Ollama after this)
3. `ollama serve` if it isn't already running.

## Try the translation core without the extension

```
node bin/translate.mjs eval/fixtures/doupo-ch1.zh.json
```

Translates a real captured chapter (chapter 1 of 斗破苍穹) and prints the
English to stdout, with progress/glossary logging on stderr. Add
`--model qwen3.5:4b` to try a different installed model, or
`--out result.json` to keep the full structured result (units, glossary,
translations, failures) for inspection. Add `--glossary glossary.json` to
carry a per-novel glossary across runs, with the same merge rule the
extension uses:

```
node bin/translate.mjs ch1.json --glossary eval/fixtures/glossary.json
node bin/translate.mjs ch2.json --glossary eval/fixtures/glossary.json
```

To capture a fixture, open the chapter, then use **Export chapter as test
fixture** in the popup and move the downloaded file into `eval/fixtures/`.

`eval/fixtures/` is gitignored: captured chapter text is copyrighted and
stays on the machine that captured it. A fresh clone has no fixtures —
capture one from a chapter you can read, in the same shape:
```json
{
  "site": "qidian", "novelId": "...", "chapterId": "...",
  "novelTitle": "...", "chapterTitle": "...",
  "paragraphs": [{ "zh": "..." }, ...]
}
```

## Load the extension

`chrome://extensions` → enable Developer mode → **Load unpacked** → select
this folder. Open a Qidian chapter (`qidian.com/chapter/{bookId}/{chapterId}/`),
click the extension icon, **Translate this chapter**. Opens the result in a
new tab.

Supported sites: **Qidian** (qidian.com/chapter/…) and **Jinjiang** free
chapters (jjwxc.net/onebook.php…). For any other site, **Paste a chapter**
in the popup opens a tab where you paste the text and translate it there. A
page whose text is scrambled by an anti-copy font (e.g. Fanqie) is refused
with the reason — there is nothing readable to translate.

Finished chapters are cached on your machine (about 370–400 chapters fit),
so reopening one replaces it instantly with no model run. Tick **Translate
this novel's chapters automatically** in the popup to have each new chapter
of that novel translate as soon as you open it; other novels are never
touched unless you ask. **Re-translate** skips the cache for the current
chapter.

The popup also shows the novel's glossary, one `term = English` per line
under a `[names]` / `[factions]` / `[realms]` / `[techniques]` / `[terms]`
heading. Glossary entries you already have always win over what a new
chapter proposes, and a term you delete stays deleted.

## Tests

```
npm test
```
Covers the glossary merge rule (`src/core/glossary.test.mjs`) and the
editor's text format (`src/glossary-text.test.mjs`). Each also runs on its
own with `node <file>`.

## Layout

```
manifest.json              MV3 manifest
src/
  background.js            service worker: orchestrates a translation, glossary storage
  content.js                content script: runs the site adapter on request
  popup.html / popup.js     translate, glossary editor, fixture export
  glossary-text.js          the editor's `term = English` text format
  reader.html / reader.js   Milestone 1 output tab; becomes the Milestone 5 fallback view
  site-adapters/
    qidian.js               chapter detection + extraction for qidian.com
    index.js                adapter registry
  core/                     no chrome.* dependency — usable from the CLI or the extension
    backends.js             Ollama call, ported from JP Subs
    chunk.js                paragraphs -> request chunks, ported from JP Subs
    prompt.js                two-pass prompts, written for Chinese web novel prose
    pipeline.js              two-pass orchestration, adapted from JP Subs
    glossary.js              per-novel glossary storage and merge rule
bin/translate.mjs           CLI: run the pipeline against a fixture, no browser needed
eval/fixtures/               real captured chapters, kept for regression testing
```
