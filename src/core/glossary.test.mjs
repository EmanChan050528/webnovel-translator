// Test for the per-novel glossary merge rule in core/glossary.js.
// Run: node src/core/glossary.test.mjs

import { makeGlossaryStore, novelKey } from "./glossary.js";

function fakeStorage() {
  const data = new Map();
  return {
    async get(keys) {
      if (keys === null || keys === undefined) return Object.fromEntries(data);
      const list = Array.isArray(keys) ? keys : [keys];
      const out = {};
      for (const k of list) if (data.has(k)) out[k] = data.get(k);
      return out;
    },
    async set(obj) {
      for (const [k, v] of Object.entries(obj)) data.set(k, v);
    },
    async remove(keys) {
      for (const k of Array.isArray(keys) ? keys : [keys]) data.delete(k);
    },
  };
}

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

async function run() {
  // 1. Existing entries win over a later chapter's fresh findings.
  {
    const store = makeGlossaryStore(fakeStorage());
    await store.remember("qidian", "1209977", { names: { 萧炎: "Xiao Yan" } }, { novelTitle: "斗破苍穹" });
    // Chapter 2's analysis pass proposes a different spelling for the same name.
    await store.remember("qidian", "1209977", { names: { 萧炎: "Xiao Yen" } });
    const g = await store.get("qidian", "1209977");
    check("existing chapter-1 spelling survives chapter 2's disagreement", g.names["萧炎"], "Xiao Yan");
    check("chapter count accumulates", g.chapters, 2);
  }

  // 2. A hand edit always wins, even over what remember() already has.
  {
    const store = makeGlossaryStore(fakeStorage());
    await store.remember("qidian", "1209977", { names: { 萧炎: "Xiao Yan" } });
    await store.applyEdit("qidian", "1209977", "names", "萧炎", "Xiao Yan (protagonist)");
    await store.remember("qidian", "1209977", { names: { 萧炎: "Xiao Yen" } });
    const g = await store.get("qidian", "1209977");
    check("hand edit survives a later chapter's fresh finding", g.names["萧炎"], "Xiao Yan (protagonist)");
    check("editedByHand flag is set", g.editedByHand, true);
  }

  // 3. Two novels on the same site never collide.
  {
    const store = makeGlossaryStore(fakeStorage());
    await store.remember("qidian", "1209977", { names: { 萧炎: "Xiao Yan" } });
    await store.remember("qidian", "999999", { names: { 萧炎: "A different Xiao Yan" } });
    const a = await store.get("qidian", "1209977");
    const b = await store.get("qidian", "999999");
    check("novel A keeps its own glossary", a.names["萧炎"], "Xiao Yan");
    check("novel B keeps its own glossary", b.names["萧炎"], "A different Xiao Yan");
  }

  // 4. novelKey requires both parts — a silent site-wide key would merge
  //    unrelated novels' glossaries.
  {
    let threw = false;
    try { novelKey("qidian", null); } catch { threw = true; }
    check("novelKey refuses a missing novelId", threw, true);
  }

  console.log(failed ? `\n${failed} failing` : "\nall passing");
  process.exit(failed ? 1 : 0);
}

run();
