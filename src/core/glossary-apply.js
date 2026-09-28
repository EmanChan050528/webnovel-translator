// Rewrite already-translated English after a glossary rename. Ported from JP
// Subs' in-place glossary rewrite (its background.js glossary:apply and
// glossary-apply.test.mjs), with one change: longer renderings are replaced
// first. Renaming both "Dou Qi" and "Dou Qi Spiral" in one save otherwise
// turns "Dou Qi Spiral" into "Battle Qi Spiral" before the longer rename can
// match it — the compound case measured in design doc §2.4.

/**
 * @param lines - English strings, one per paragraph ("" for untranslated)
 * @param replacements - [{ from, to }], old rendering -> new rendering
 * @returns {{ out: string[], changed: number }} changed = lines touched
 */
export function applyReplacements(lines, replacements) {
  const rules = (replacements || [])
    .filter(({ from, to }) => from && to && from !== to)
    .sort((a, b) => b.from.length - a.from.length);
  if (!rules.length) return { out: lines.slice(), changed: 0 };

  // One alternation, longest first, applied in a single pass: at each
  // position the longest rendering wins, and replaced text is never
  // re-matched by a shorter rule.
  const pattern = rules
    .map(({ from }) => {
      const esc = from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      // Whole words when the rendering starts and ends with a word
      // character, so "Frea" never matches inside "freak".
      const wordish = /^\w/.test(from) && /\w$/.test(from);
      return `(${wordish ? `\\b${esc}\\b` : esc})`;
    })
    .join("|");
  const re = new RegExp(pattern, "g");

  let changed = 0;
  const out = lines.map((line) => {
    if (!line) return line;
    const next = line.replace(re, (...args) => {
      const groups = args.slice(1, rules.length + 1);
      return rules[groups.findIndex((g) => g !== undefined)].to;
    });
    if (next !== line) changed++;
    return next;
  });
  return { out, changed };
}

/** Glossary renames between two saved versions, as replacement rules. */
export function renamesBetween(before, after, categories) {
  const out = [];
  for (const cat of categories) {
    for (const [term, to] of Object.entries(after?.[cat] || {})) {
      const from = before?.[cat]?.[term];
      if (from && from !== to) out.push({ from, to });
    }
  }
  return out;
}
