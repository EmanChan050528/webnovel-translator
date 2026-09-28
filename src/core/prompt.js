// Prompt construction for both passes.
//
// Structured the same way as JP Subs' core/prompt.js — a per-language table of
// what genuinely differs, plus a language-neutral rule set everything shares —
// so that Milestone 6 (JP/KR novels) is a data addition later, not a rewrite.
// Only "zh" exists today. Nothing here is measured yet; every rule is a
// prediction to be checked against real chapters, same epistemic status JP
// Subs' Korean prompt had before it got a reader. See translator-design.md §3.

const LANGUAGES = {
  zh: {
    name: "Chinese",
    forwardContext:
      "in Chinese narration, what comes next often reveals who or what the current line is about — Chinese drops subjects even more freely than it marks them.",
    termExample: `For example 金丹 is "Golden Core" (a cultivation stage), not "golden pill", when the setting is xianxia.`,
    // Shown as the key in the JSON template. Real characters rather than a
    // description like "chinese name": the first real run (design doc §2.3)
    // was given descriptions and returned pinyin and English keys throughout.
    keyExample: { name: "张三", faction: "青云门", realm: "筑基", technique: "御剑术", term: "灵石" },
    rules: [
      `Chinese narrative prose drops the subject constantly, and there is no verb agreement to recover it from. Decide who or what each line is about using the context above and the reference sheet. Do not default to a pronoun where the reference sheet gives a name — reuse the name instead, the way the source does less often than natural English would.`,
      `Chinese is topic-prominent: a sentence often opens with the thing being talked about, not the grammatical subject of the English sentence it will become. Translate for natural English sentence order and rhythm, not the source's clause order. Do not produce a literal transliteration of Chinese sentence structure.`,
      `Four-character idioms (成语) and other set phrases carry a meaning that is not the sum of their characters. Translate the sense, never character-by-character. If unsure of an idiom's meaning, translate the surrounding sentence's plain meaning rather than guessing at the idiom literally.`,
      `Forms of address between characters (师兄/师姐/师弟/师妹, 师父/师尊, 道友, 前辈, 阁下, and similar) mark relationship and social rank, not literal kinship. Do not render 师兄 as "older brother" — use the reference sheet's chosen English rendering (typically a title like "senior brother" or the character's name), and keep it consistent for the same relationship throughout.`,
      `Cultivation-realm names, technique names, and sect/faction names are proper nouns in this genre. Use the reference sheet's exact rendering every time; never re-translate one from scratch mid-chapter even if a different phrasing would also be defensible in isolation.`,
    ],
  },
};

const languageFor = (code) => LANGUAGES[code] || LANGUAGES.zh;

/**
 * Pass 1. Read a sample of the chapter (or several), produce a glossary and
 * a short style note.
 *
 * This is where cross-chapter consistency comes from — the same role §3.1
 * plays in JP Subs, and it matters more here: a web novel invents a whole
 * vocabulary of names, realms, techniques and sects that an LLM will render
 * inconsistently chapter to chapter without this.
 */
export function analysisPrompt(fullSourceText, meta = {}, seed = null) {
  const L = languageFor(meta.source_lang || meta.lang);
  const novelTitle = meta.novelTitle ? `Novel title: ${meta.novelTitle}\n` : "";
  const chapterTitle = meta.chapterTitle ? `Chapter: ${meta.chapterTitle}\n` : "";

  // Names and genre terms belong to the novel, not to one chapter. Carrying
  // them forward is what stops the same character or realm being rendered a
  // different way every chapter — this is the seeded, per-novel glossary from
  // src/core/glossary.js, not a fresh guess each time.
  const seedCount = (o) => Object.keys(o || {}).length;
  const hasSeed =
    seed && ["names", "factions", "realms", "techniques", "terms"].some((k) => seedCount(seed[k]));
  const seeded = hasSeed
    ? `\nALREADY ESTABLISHED FOR THIS NOVEL. Reuse these renderings exactly, and add to them:\n` +
      JSON.stringify(
        {
          names: seed.names || {},
          factions: seed.factions || {},
          realms: seed.realms || {},
          techniques: seed.techniques || {},
          terms: seed.terms || {},
        },
        null,
        2
      ) +
      `\n`
    : "";

  return `You are preparing to translate ${L.name} web novel chapters into English.
${seeded}
Before translating, read the sample below and build a reference sheet.

${novelTitle}${chapterTitle}
CHAPTER TEXT
${fullSourceText}

Produce JSON with exactly these keys:

{
  "setting": "One or two sentences: genre, premise, and where this chapter falls in the story so far, as best you can tell. Be specific — this disambiguates terms later.",
  "names": { "${L.keyExample.name}": "how to render it in English, consistently" },
  "factions": { "${L.keyExample.faction}": "how to render this sect, clan, or organisation name in English" },
  "realms": { "${L.keyExample.realm}": "how to render this cultivation stage or power-ranking name in English" },
  "techniques": { "${L.keyExample.technique}": "how to render this skill, technique, or cultivation method name in English" },
  "terms": { "${L.keyExample.term}": "English meaning IN THIS CONTEXT, not the dictionary default — items, treasures, and other recurring vocabulary that does not fit the categories above" },
  "register": "How the narration and dialogue sound, and what English register matches (e.g. wry and understated, or breathless and dramatic). One or two sentences."
}

Guidance:
- Every key is the term **exactly as it is written in the ${L.name} text above, in ${L.name} characters** — never pinyin, never English. The key is how the term is found in later chapters; a key that does not appear in the source text is useless.
- "terms" is for words whose ordinary dictionary sense would be wrong here. ${L.termExample}
- A name only belongs in "factions", "realms", or "techniques" if it is a recurring proper noun in this genre's sense, not an ordinary word that happens to appear once.
- If a category is empty, use an empty object. Do not invent entries.
- Output only the JSON object. No preamble, no code fence.

Hard limits — a reply that breaks these is useless:
- **This is a reference sheet, NOT a translation.** Do not translate the chapter. Do not add an entry per line.
- Keys must be single words or short phrases. Never a whole sentence.
- At most 15 entries in "names", 8 in "factions", 10 in "realms", 12 in "techniques", 15 in "terms". Choose the ones that matter most and leave the rest out.
- Keep the whole reply under 2500 characters.`;
}

/**
 * Rules that hold whatever the source language is: output shape, length, and
 * the bans on inventing content or translating the context.
 */
const GENERIC_RULES = [
  `Use the reference sheet for names, factions, realms, techniques, and terms, every time, without variation.`,
  `Match the register on the reference sheet. Keep it natural written English prose, not a literal gloss.`,
  `Never invent content that is not in the source. If a line is genuinely unclear, translate the part you are sure of.`,
  `This is prose for reading, not subtitles for a screen — do not compress or shorten a paragraph to fit a length target. Translate the whole paragraph's meaning; length should follow from the source, not be capped against it.`,
  `Translate ONLY the numbered paragraphs. The context sections are for understanding; never fold their content into an answer, and never translate a context paragraph in place of a numbered one.`,
  `Preserve paragraph breaks: each numbered source paragraph produces exactly one English paragraph, not more, not fewer. Do not merge two source paragraphs into one translation or split one into several.`,
  `Output plain prose. No surrounding quotation marks around a whole paragraph, no paragraph numbering in the output text itself, no translator's notes or bracketed commentary.`,
];

export function translationPrompt(chunk, glossary, lines = null, { echo = false, lang = "zh" } = {}) {
  const L = languageFor(lang);
  const context = (units, label) =>
    units.length
      ? `${label}\n${units.map((u) => `${u.n}\t${u.zh}`).join("\n")}\n`
      : "";

  // `lines` carries explicit numbers, so a retry can resend an arbitrary
  // subset of a chunk without the numbering drifting.
  const items =
    lines || chunk.target.map((u, i) => ({ n: chunk.firstUnit + i + 1, zh: u.zh }));

  const numbered = items.map((it) => `${it.n}\t${it.zh}`).join("\n");

  const rules = [...L.rules, ...GENERIC_RULES]
    .map((rule, i) => `${i + 1}. ${typeof rule === "function" ? rule(L) : rule}`)
    .join("\n");

  return `Translate ${L.name} web novel prose into English.

REFERENCE SHEET
${JSON.stringify(glossary, null, 2)}

${context(chunk.before, "CONTEXT — the paragraphs immediately before (do not translate):")}
${context(chunk.after, `CONTEXT — the paragraphs immediately after (do not translate). Use these: ${L.forwardContext}`)}
PARAGRAPHS TO TRANSLATE
${numbered}

Rules:
${rules}

${echo ? replyEcho(items) : replyPlain(items)}`;
}

function replyPlain(items) {
  return `Return JSON mapping each paragraph number to its English translation, and nothing else:

{${items.slice(0, 2).map((it) => `"${it.n}": "..."`).join(", ")}}

Every number listed above must appear exactly once. No preamble, no code fence.`;
}

function replyEcho(items) {
  const example = items
    .slice(0, 2)
    .map((it) => `"${it.n}": {"zh": ${JSON.stringify(it.zh)}, "en": "..."}`)
    .join(", ");
  return `Return JSON mapping each paragraph number to an object holding that paragraph's Chinese, copied exactly, and its English translation, and nothing else:

{${example}}

Every number listed above must appear exactly once, with its own Chinese copied into "zh". Each "en" translates only the Chinese in its own "zh". Never move text to a neighbouring paragraph, and never leave a paragraph's "en" empty because its meaning was folded into another. No preamble, no code fence.`;
}
