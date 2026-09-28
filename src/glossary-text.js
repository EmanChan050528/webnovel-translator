// The glossary editor's text format, both directions. Pure, so it is tested
// in glossary-text.test.mjs rather than discovered broken in the popup.
//
//   [names]
//   萧炎 = Xiao Yan
//   [realms]
//   斗之气 = Dou Qi
//
// Plain text rather than JSON (which JP Subs' editor used): a stray comma or
// quote in hand-edited JSON loses the whole save, and this is edited in a
// 280px popup.

import { CATEGORIES } from "./core/glossary.js";

export function toText(glossary) {
  return CATEGORIES.map((cat) => {
    const lines = Object.entries(glossary?.[cat] || {}).map(([term, en]) => `${term} = ${en}`);
    return [`[${cat}]`, ...lines].join("\n");
  }).join("\n\n");
}

/**
 * After a rename, entries built on the renamed term that still spell out its
 * old rendering. Renaming 斗之气 "Dou Qi" → "Battle Qi" leaves
 * 斗之气旋 = "Dou Qi Spiral" untouched, and the model then follows the
 * glossary faithfully into an inconsistency (design doc §2.4). Warns rather
 * than rewrites: "Dou Qi Spiral" → "Battle Qi Spiral" is usually right, but
 * not always, and the editor should not guess.
 *
 * @returns {string[]} one human-readable warning per stale entry
 */
export function staleCompounds(before, after) {
  const warnings = [];
  const all = CATEGORIES.flatMap((cat) => Object.entries(after?.[cat] || {}));
  for (const cat of CATEGORIES) {
    for (const [term, newValue] of Object.entries(after?.[cat] || {})) {
      const oldValue = before?.[cat]?.[term];
      if (!oldValue || oldValue === newValue) continue;
      for (const [otherTerm, otherValue] of all) {
        if (otherTerm !== term && otherTerm.includes(term) && otherValue.includes(oldValue)) {
          warnings.push(`${otherTerm} = ${otherValue} still uses "${oldValue}" (you renamed ${term} to "${newValue}")`);
        }
      }
    }
  }
  return warnings;
}

/**
 * @returns {{ categories: object, errors: string[] }} Any error means the
 *   save must be refused whole — a half-applied edit would silently suppress
 *   every term on the lines that failed to parse.
 */
export function fromText(text) {
  const categories = Object.fromEntries(CATEGORIES.map((c) => [c, {}]));
  const errors = [];
  let current = null;

  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith("#")) return;

    const header = line.match(/^\[(.+)\]$/);
    if (header) {
      current = header[1].trim().toLowerCase();
      if (!CATEGORIES.includes(current)) {
        errors.push(`Line ${i + 1}: unknown section [${header[1]}] — use ${CATEGORIES.map((c) => `[${c}]`).join(" ")}`);
        current = null;
      }
      return;
    }

    const eq = line.indexOf("=");
    if (eq === -1) {
      errors.push(`Line ${i + 1}: expected "term = English", got "${line}"`);
      return;
    }
    const term = line.slice(0, eq).trim();
    const en = line.slice(eq + 1).trim();
    if (!term || !en) {
      errors.push(`Line ${i + 1}: both sides of "=" need text`);
      return;
    }
    if (!current) {
      errors.push(`Line ${i + 1}: "${term}" is not under a [section] heading`);
      return;
    }
    categories[current][term] = en;
  });

  return { categories, errors };
}
