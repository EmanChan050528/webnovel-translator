# Webnovel Translator

Chinese web novel → English, translated in place, using a local model through
[Ollama](https://ollama.com). Nothing is uploaded; nothing costs per chapter.
Same posture as [JP Subs](../Translator%20Project), aimed at prose instead of
subtitles. Full design rationale, what's built vs. not, and open risks: see
[translator-design.md](translator-design.md).

**Status:** early. Milestone 0 (site adapter for Qidian) is done. Milestone 1
(translate a chapter, read the result) is proven from the command line; the
extension shell exists but has not been loaded into a real browser yet.

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
translations, failures) for inspection.

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
new tab. This path has not been exercised end-to-end yet — see
translator-design.md §1.5 if it doesn't work on the first try.

## Tests

```
npm test
```
Currently covers `core/glossary.js`'s merge rule (per-novel keying, existing
entries win, hand edits outrank everything). Run individually with
`node src/core/glossary.test.mjs`.

## Layout

```
manifest.json              MV3 manifest
src/
  background.js            service worker: orchestrates a translation, glossary storage
  content.js                content script: runs the site adapter on request
  popup.html / popup.js     trigger + (eventually) glossary editor
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
