// Tests for the glossary editor's text format.
// Run: node src/glossary-text.test.mjs

import { toText, fromText, staleCompounds } from "./glossary-text.js";

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

const g = {
  names: { 萧炎: "Xiao Yan", 萧薰儿: "Xiao Xun'er" },
  factions: {}, realms: { 斗之气: "Dou Qi" }, techniques: {}, terms: {},
};

check("round-trips a glossary", fromText(toText(g)).categories, g);
check("round-trip has no errors", fromText(toText(g)).errors, []);

{
  const { categories } = fromText("[names]\n萧炎 = Xiao = Yan");
  check("splits on the first '=' only", categories.names["萧炎"], "Xiao = Yan");
}
{
  const { categories } = fromText("  [Names]  \n\n# a comment\n  萧炎=Xiao Yan  ");
  check("tolerates case, spacing, blank lines and comments", categories.names, { 萧炎: "Xiao Yan" });
}
{
  const { errors } = fromText("[people]\n萧炎 = Xiao Yan");
  check("rejects an unknown section", errors.length, 2);
}
{
  const { errors } = fromText("萧炎 = Xiao Yan");
  check("rejects an entry outside any section", errors.length, 1);
}
{
  const { errors } = fromText("[names]\n萧炎 Xiao Yan\n萧媚 = ");
  check("rejects a line with no '=' and a line with an empty side", errors.length, 2);
}

// The case measured in design doc §2.4: a rename that a compound term
// across a different category still spells the old way.
{
  const before = { realms: { 斗之气: "Dou Qi" }, terms: { 斗之气旋: "Dou Qi Spiral" } };
  const after = { realms: { 斗之气: "Battle Qi" }, terms: { 斗之气旋: "Dou Qi Spiral" } };
  check("warns about a compound still using the old rendering", staleCompounds(before, after).length, 1);

  const fixed = { realms: { 斗之气: "Battle Qi" }, terms: { 斗之气旋: "Battle Qi Spiral" } };
  check("is quiet once the compound is updated too", staleCompounds(before, fixed), []);
  check("is quiet when nothing was renamed", staleCompounds(before, before), []);
}

console.log(failed ? `\n${failed} failing` : "\nall passing");
process.exit(failed ? 1 : 0);
