#!/usr/bin/env node
// CLI for the translation core, independent of the extension shell — same
// role JP Subs' core/bin/jpsub.js plays: iterate on prompt.js and pipeline.js
// against a captured fixture, fast, with no browser involved. This is how
// Milestone 1 gets proven before any DOM-injection code exists.
//
// Usage:
//   node bin/translate.mjs eval/fixtures/doupo-ch1.zh.json
//   node bin/translate.mjs eval/fixtures/doupo-ch1.zh.json --model qwen3.5:9b
//   node bin/translate.mjs ch1.json --glossary g.json && node bin/translate.mjs ch2.json --glossary g.json
//
// --glossary keeps a per-novel glossary in a JSON file across runs, through
// the same store and merge rule the extension uses with chrome.storage.

import { readFile, writeFile } from "node:fs/promises";
import { ollamaBackend } from "../src/core/backends.js";
import { run as runPipeline } from "../src/core/pipeline.js";
import { makeGlossaryStore } from "../src/core/glossary.js";

function parseArgs(argv) {
  const [file, ...rest] = argv;
  const opts = { model: undefined, out: null, glossary: null };
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--model") opts.model = rest[++i];
    if (rest[i] === "--out") opts.out = rest[++i];
    if (rest[i] === "--glossary") opts.glossary = rest[++i];
  }
  return { file, ...opts };
}

/** chrome.storage.local-shaped store over one JSON file. */
function fileStorage(path) {
  const load = async () => {
    try { return JSON.parse(await readFile(path, "utf8")); } catch { return {}; }
  };
  return {
    async get(keys) {
      const all = await load();
      if (keys === null || keys === undefined) return all;
      const out = {};
      for (const k of Array.isArray(keys) ? keys : [keys]) if (k in all) out[k] = all[k];
      return out;
    },
    async set(obj) { await writeFile(path, JSON.stringify({ ...(await load()), ...obj }, null, 2)); },
    async remove(keys) {
      const all = await load();
      for (const k of Array.isArray(keys) ? keys : [keys]) delete all[k];
      await writeFile(path, JSON.stringify(all, null, 2));
    },
  };
}

async function main() {
  const { file, model, out, glossary } = parseArgs(process.argv.slice(2));
  if (!file) {
    console.error("Usage: node bin/translate.mjs <fixture.json> [--model NAME] [--out result.json] [--glossary glossary.json]");
    process.exit(1);
  }

  const chapter = JSON.parse(await readFile(file, "utf8"));
  const backend = ollamaBackend({ model });

  const log = (line) => console.error(`  ${line}`);
  console.error(`Translating "${chapter.chapterTitle || file}" (${chapter.paragraphs.length} paragraphs)…`);

  const store = glossary ? makeGlossaryStore(fileStorage(glossary)) : null;
  const seed = store && chapter.site && chapter.novelId
    ? await store.get(chapter.site, chapter.novelId)
    : null;
  if (seed?.chapters) console.error(`  seeded from ${seed.chapters} earlier chapter(s) in ${glossary}`);

  const result = await runPipeline(chapter, backend, { seed }, log);

  if (store && chapter.site && chapter.novelId) {
    await store.remember(chapter.site, chapter.novelId, result.glossary, chapter);
  }

  console.log(`\n--- ${chapter.novelTitle || ""} — ${chapter.chapterTitle || ""} ---\n`);
  result.translations.forEach((en, i) => {
    console.log(en || `[missing: paragraph ${i + 1}]`);
    console.log();
  });

  console.error(`\n${result.translated}/${chapter.paragraphs.length} paragraphs translated.`);
  if (result.failures.length) console.error("Failures:\n" + result.failures.join("\n"));

  if (out) {
    await writeFile(out, JSON.stringify({ chapter, ...result }, null, 2));
    console.error(`Full result written to ${out}`);
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
