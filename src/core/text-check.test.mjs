// Tests for the scrambled-text check.
// Run: node src/core/text-check.test.mjs

import { scrambledShare, looksScrambled } from "./text-check.js";

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
const p = (...zh) => zh.map((z) => ({ zh: z }));

check("ordinary Chinese is not scrambled", looksScrambled(p("他走进了房间。", "“你好！”")), false);
check("private-use code points in place of characters are",
  looksScrambled(p("他进了间。", "“你！”")), true);
check("punctuation and whitespace do not dilute the share",
  scrambledShare(p("。。。。。。　　　　")), 1);
check("an empty chapter is not scrambled", looksScrambled(p("")), false);
check("one stray private-use character in a long chapter is tolerated",
  looksScrambled(p("字".repeat(200) + "")), false);

console.log(failed ? `\n${failed} failing` : "\nall passing");
process.exit(failed ? 1 : 0);
