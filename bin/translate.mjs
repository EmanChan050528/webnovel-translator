#!/usr/bin/env node
// CLI for the translation core, independent of the extension shell — same
// role JP Subs' core/bin/jpsub.js plays: iterate on prompt.js and pipeline.js
// against a captured fixture, fast, with no browser involved. This is how
// Milestone 1 gets proven before any DOM-injection code exists.
//
// Usage:
//   node bin/translate.mjs eval/fixtures/doupo-ch1.zh.json
//   node bin/translate.mjs eval/fixtures/doupo-ch1.zh.json --model qwen3.5:9b

import { readFile, writeFile } from "node:fs/promises";
import { ollamaBackend } from "../src/core/backends.js";
import { run as runPipeline } from "../src/core/pipeline.js";

function parseArgs(argv) {
  const [file, ...rest] = argv;
  const opts = { model: undefined, out: null };
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--model") opts.model = rest[++i];
    if (rest[i] === "--out") opts.out = rest[++i];
  }
  return { file, ...opts };
}

async function main() {
  const { file, model, out } = parseArgs(process.argv.slice(2));
  if (!file) {
    console.error("Usage: node bin/translate.mjs <fixture.json> [--model NAME] [--out result.json]");
    process.exit(1);
  }

  const chapter = JSON.parse(await readFile(file, "utf8"));
  const backend = ollamaBackend({ model });

  const log = (line) => console.error(`  ${line}`);
  console.error(`Translating "${chapter.chapterTitle || file}" (${chapter.paragraphs.length} paragraphs)…`);

  const result = await runPipeline(chapter, backend, {}, log);

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
