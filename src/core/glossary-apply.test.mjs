// Tests for rewriting cached English after a glossary rename.
// The first nine cases are JP Subs' glossary-apply.test.mjs, kept as-is.
// Run: node src/core/glossary-apply.test.mjs

import { applyReplacements, renamesBetween } from "./glossary-apply.js";

let failed = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? "ok  " : "FAIL"}  ${name}`);
  if (!ok) {
    failed++;
    console.log(`        got:  ${JSON.stringify(got)}`);
    console.log(`        want: ${JSON.stringify(want)}`);
  }
}
const one = (en, reps) => applyReplacements([en], reps).out[0];

check("renames a mis-romanised name",
  one("Shiranui Frea is streaming again today.", [{ from: "Shiranui Frea", to: "Shiranui Flare" }]),
  "Shiranui Flare is streaming again today.");
check("handles hyphenated and possessive forms",
  one("Frea said it was Frea's turn, and Frea-chan agreed.", [{ from: "Frea", to: "Flare" }]),
  "Flare said it was Flare's turn, and Flare-chan agreed.");
check("does NOT match inside a longer word",
  one("That was a total freak accident and Freakazoid agreed.", [{ from: "Frea", to: "Flare" }]),
  "That was a total freak accident and Freakazoid agreed.");
check("is case sensitive", one("the frea was fine", [{ from: "Frea", to: "Flare" }]), "the frea was fine");
check("corrects a domain term",
  one("I don't want to do that on delivery.", [{ from: "delivery", to: "stream" }]),
  "I don't want to do that on stream.");
check("leaves unrelated lines alone", one("Nothing relevant here.", [{ from: "Frea", to: "Flare" }]), "Nothing relevant here.");
check("escapes regex metacharacters in the old value",
  one("It cost $5 (roughly).", [{ from: "$5 (roughly)", to: "five dollars" }]), "It cost five dollars.");
check("ignores a no-op replacement", one("Flare is here.", [{ from: "Flare", to: "Flare" }]), "Flare is here.");
check("applies several replacements to one line",
  one("Frea talked about delivery for ages.", [{ from: "Frea", to: "Flare" }, { from: "delivery", to: "stream" }]),
  "Flare talked about stream for ages.");

// New: the compound case from design doc §2.4, both renamed in one save.
check("the longer rendering wins where both match",
  one("His Dou Qi Spiral formed; Dou Qi flowed.", [
    { from: "Dou Qi", to: "Battle Qi" },
    { from: "Dou Qi Spiral", to: "Battle Qi Vortex" },
  ]),
  "His Battle Qi Vortex formed; Battle Qi flowed.");
check("a replacement's output is never re-matched",
  one("Xiao Yan left.", [{ from: "Xiao Yan", to: "Xiao Yan the Younger" }, { from: "Younger", to: "Elder" }]),
  "Xiao Yan the Younger left.");
check("untranslated paragraphs stay empty",
  applyReplacements(["", "Frea"], [{ from: "Frea", to: "Flare" }]).out, ["", "Flare"]);
check("counts changed lines, not replacements",
  applyReplacements(["Frea one", "Frea two", "nothing"], [{ from: "Frea", to: "Flare" }]).changed, 2);

check("renamesBetween finds changed values only",
  renamesBetween(
    { names: { 萧炎: "Xiao Yan", 萧媚: "Xiao Mei" }, realms: { 斗之气: "Dou Qi" } },
    { names: { 萧炎: "Xiao Yan", 萧薰儿: "Xun'er" }, realms: { 斗之气: "Battle Qi" } },
    ["names", "realms"]
  ),
  [{ from: "Dou Qi", to: "Battle Qi" }]);

console.log(failed ? `\n${failed} failing` : "\nall passing");
process.exit(failed ? 1 : 0);
