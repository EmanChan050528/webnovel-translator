// Two-pass orchestration: analyse a sample of the chapter, then translate
// paragraph chunks. Adapted from JP Subs' core/pipeline.js.
//
// One real simplification versus JP Subs: there is no segment() step. JP
// Subs' segment.js existed because ASR cues arrive as arbitrary fragments
// that must be re-cut into sentence-bounded units before translation. A site
// adapter's extractChapter() already returns real paragraph boundaries — the
// unit the model should translate is exactly the unit the page already has.
// If a site turns out to emit unusably long or short paragraphs, re-add a
// segmentation step then; do not build one speculatively now.

import { chunk } from "./chunk.js";
import { analysisPrompt, translationPrompt } from "./prompt.js";
import { parseJson } from "./backends.js";

/**
 * How much source text to show pass 1. A single chapter is usually small
 * enough to send whole (JP Subs' 6000-char cap existed for multi-hour video
 * transcripts, which chapters are nowhere near) but the cap stays as a
 * safety net for unusually long chapters or a future "seed from several
 * chapters at once" mode (Milestone 2).
 */
const MAX_ANALYSIS_CHARS = 6000;

/** Evenly sample paragraphs across the text rather than taking a prefix, so
 *  the glossary still sees names introduced later in the chapter. */
function analysisText(units, budget = MAX_ANALYSIS_CHARS) {
  const all = units.map((u) => u.zh);
  const total = all.reduce((n, s) => n + s.length + 1, 0);
  if (total <= budget) return { text: all.join("\n"), sampled: false };

  const step = total / budget;
  const kept = [];
  let used = 0;
  for (let i = 0; i < all.length; i += Math.max(1, Math.round(step))) {
    if (used + all[i].length > budget) break;
    kept.push(all[i]);
    used += all[i].length + 1;
  }
  return { text: kept.join("\n"), sampled: true, keptUnits: kept.length };
}

const GLOSSARY_KEYS = ["names", "factions", "realms", "techniques", "terms"];

/** Pass 1: glossary and style note, seeded from the novel's running glossary. */
export async function analyse(units, backend, meta = {}, log = () => {}, seed = null) {
  const { text, sampled, keptUnits } = analysisText(units);
  log(
    `pass 1: analysing ${units.length} paragraphs (${text.length} chars` +
    (sampled ? `, sampled down to ${keptUnits} paragraphs` : "") + ")"
  );

  const count = (o) => (o && typeof o === "object" ? Object.keys(o).length : 0);
  const useful = (g) =>
    !!g &&
    ((typeof g.setting === "string" && g.setting.trim().length > 0) ||
      GLOSSARY_KEYS.reduce((n, k) => n + count(g[k]), 0) > 0);

  let glossary = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      glossary = parseJson(
        await backend(analysisPrompt(text, meta, seed), { json: true }),
        "analysis pass"
      );
      if (useful(glossary)) break;
      log(`pass 1: attempt ${attempt} came back empty`);
    } catch (err) {
      // A malformed or truncated reply must NOT end the run. Losing the
      // glossary costs quality; throwing here costs the whole chapter.
      log(`pass 1: attempt ${attempt} failed — ${err.message.split("\n")[0]}`);
      glossary = null;
    }
  }

  if (!useful(glossary)) {
    log("pass 1: WARNING — no glossary. Names, realms, techniques and");
    log("        faction terms will NOT be applied consistently. Translating");
    log("        anyway; expect names to drift chapter to chapter.");
    glossary = {};
  } else {
    log(
      GLOSSARY_KEYS.map((k) => `${count(glossary[k])} ${k}`).join(", ") + " found"
    );
  }
  return glossary;
}

/** Punctuation and spacing a model drops or changes when copying a paragraph. */
const COPY_NOISE = /[\s　、。，．！？!?“”‘’「」『』…—～~《》·]/g;

/** Longest common subsequence length, for echoMatches. */
function lcs(a, b) {
  const row = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    let diag = 0;
    for (let j = 1; j <= b.length; j++) {
      const up = row[j];
      row[j] = a[i - 1] === b[j - 1] ? diag + 1 : Math.max(row[j], row[j - 1]);
      diag = up;
    }
  }
  return row[b.length];
}

/**
 * Is `copied` this paragraph's Chinese, allowing for a slightly garbled copy?
 * Ported from JP Subs' echoMatches — same 2*LCS/(|a|+|b|) test, Chinese
 * punctuation class instead of Japanese.
 */
export function echoMatches(source, copied, threshold = 0.7) {
  if (typeof copied !== "string") return false;
  const a = [...source.normalize("NFKC").replace(COPY_NOISE, "")];
  const b = [...copied.normalize("NFKC").replace(COPY_NOISE, "")];
  if (!a.length || !b.length) return a.length === b.length;
  if (a.join("") === b.join("")) return true;
  return (2 * lcs(a, b)) / (a.length + b.length) >= threshold;
}

/** Pass 2: translate every paragraph. Returns an array parallel to `units`. */
export async function translateUnits(
  units, glossary, backend, options = {}, log = () => {}, onProgress = () => {}
) {
  const chunks = chunk(units, options);
  const translations = new Array(units.length).fill("");
  const failures = [];
  // Default true, unlike JP Subs (default false there): a shifted subtitle
  // desyncs briefly and self-corrects at the next cue, but a shifted chapter
  // paragraph is a permanently wrong sentence sitting in running prose.
  // Unmeasured whether the extra output tokens are worth it here — see
  // translator-design.md §3.4.
  const echo = options.echo !== false;
  const lang = options.lang || "zh";

  const request = async (c, lines, label, lastTry = false) => {
    const raw = await backend(
      translationPrompt(c, glossary, lines, { echo, lang }), { json: true }
    );
    const map = parseJson(raw, label);
    let filled = 0;
    let rejected = 0;
    for (const line of lines) {
      let value = map[String(line.n)];
      if (echo && value && typeof value === "object") {
        if (!echoMatches(line.zh, value.zh)) {
          rejected += 1;
          continue;
        }
        value = value.en;
      } else if (echo && !lastTry) {
        rejected += 1;
        continue;
      }
      if (typeof value === "string" && value.trim()) {
        translations[line.n - 1] = value.trim();
        filled += 1;
      }
    }
    if (rejected) log(`${label}: rejected ${rejected} paragraph(s) whose copied Chinese did not match`);
    return filled;
  };

  const outstanding = (c) =>
    c.target
      .map((u, i) => ({ n: c.firstUnit + i + 1, zh: u.zh }))
      .filter((line) => !translations[line.n - 1]);

  for (const c of chunks) {
    // Checked between chunks rather than mid-request: a caller that has lost
    // interest (navigated to another chapter, closed the tab) should not
    // keep occupying the GPU.
    if (options.shouldStop && options.shouldStop()) {
      log(`stopped after ${c.index} of ${chunks.length} chunks`);
      return { translations, failures, stopped: true };
    }

    const label = `chunk ${c.index + 1}/${chunks.length}`;
    const total = c.target.length;

    try {
      await request(c, outstanding(c), label);
    } catch (err) {
      log(`${label}: ${err.message}`);
    }

    for (let attempt = 1; attempt <= 2 && outstanding(c).length; attempt++) {
      const missing = outstanding(c);
      log(`${label}: retrying ${missing.length} missing paragraph(s)`);
      try {
        await request(c, missing, `${label} retry ${attempt}`, attempt === 2);
      } catch (err) {
        log(`${label}: retry ${attempt} failed — ${err.message}`);
      }
    }

    // Hand back what exists so far: this is what lets Milestone 3 start
    // replacing paragraphs at the top of the chapter while the rest is
    // still translating.
    onProgress(translations, c.index + 1, chunks.length);

    const left = outstanding(c).length;
    if (left) {
      failures.push(`${label}: ${left} of ${total} paragraphs still missing after 2 retries`);
    }
    log(`${label}: ${total - left}/${total} paragraphs`);
  }

  return { translations, failures };
}

/**
 * @param chapter - { novelTitle, chapterTitle, paragraphs: [{ zh }], ...meta }
 *   as produced by a site adapter's extractChapter().
 */
export async function run(chapter, backend, options = {}, log = () => {}, onProgress = () => {}) {
  const units = (chapter.paragraphs || []).map((p) => ({ zh: p.zh }));
  if (!units.length) throw new Error("Chapter contains no paragraphs.");

  const glossary = await analyse(units, backend, chapter, log, options.seed);
  const { translations, failures, stopped } = await translateUnits(
    units, glossary, backend, options, log, (partial, done, total) =>
      onProgress({ units, translations: partial, done, total })
  );

  const translated = translations.filter(Boolean).length;
  return { units, glossary, translations, failures, translated, stopped };
}
