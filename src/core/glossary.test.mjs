// Tests for the per-novel glossary merge rule in core/glossary.js.
// Run: node src/core/glossary.test.mjs

import { makeGlossaryStore, mergeGlossaries, novelKey } from "./glossary.js";

function fakeStorage() {
  const data = new Map();
  return {
    async get(keys) {
      if (keys === null || keys === undefined) return Object.fromEntries(data);
      const out = {};
      for (const k of Array.isArray(keys) ? keys : [keys]) if (data.has(k)) out[k] = data.get(k);
      return out;
    },
    async set(obj) { for (const [k, v] of Object.entries(obj)) data.set(k, v); },
    async remove(keys) { for (const k of Array.isArray(keys) ? keys : [keys]) data.delete(k); },
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

const S = "qidian", N = "1209977";

async function run() {
  {
    const store = makeGlossaryStore(fakeStorage());
    await store.remember(S, N, { names: { 萧炎: "Xiao Yan" } }, { novelTitle: "斗破苍穹" });
    await store.remember(S, N, { names: { 萧炎: "Xiao Yen" } });
    const g = await store.get(S, N);
    check("a stored rendering survives a later chapter's disagreement", g.names["萧炎"], "Xiao Yan");
    check("chapter count accumulates", g.chapters, 2);
    check("title is kept from the first chapter that supplied it", g.title, "斗破苍穹");
  }

  {
    const store = makeGlossaryStore(fakeStorage());
    await store.remember(S, N, { names: { 萧炎: "Xiao Yan" } });
    await store.replaceAll(S, N, { names: { 萧炎: "Xiao Yan (MC)" } });
    await store.remember(S, N, { names: { 萧炎: "Xiao Yen" } });
    const g = await store.get(S, N);
    check("a hand edit survives a later chapter", g.names["萧炎"], "Xiao Yan (MC)");
    check("editedByHand is set", g.editedByHand, true);
  }

  // The bug the first version had: a full category of fresh proposals
  // pushed stored entries out through the cap.
  {
    const base = { names: {} };
    for (let i = 0; i < 40; i++) base.names[`人${i}`] = `Person ${i}`;
    const add = { names: { 新人: "Newcomer" } };
    const merged = mergeGlossaries(base, add);
    check("the cap keeps every stored entry", Object.keys(merged.names).length, 40);
    check("the cap drops the new proposal, not a stored one", "新人" in merged.names, false);
  }

  {
    const store = makeGlossaryStore(fakeStorage());
    await store.remember(S, N, { names: { 萧炎: "Xiao Yan", 天: "Tian" } });
    await store.replaceAll(S, N, { names: { 萧炎: "Xiao Yan" } });
    await store.remember(S, N, { names: { 天: "Tian" } });
    const g = await store.get(S, N);
    check("a term deleted by hand is not re-added by a later chapter", "天" in g.names, false);
    check("the deletion is recorded as suppressed", g.suppressed.names, ["天"]);

    await store.replaceAll(S, N, { names: { 萧炎: "Xiao Yan", 天: "Heaven" } });
    const g2 = await store.get(S, N);
    check("typing a deleted term back in un-suppresses it", g2.suppressed.names, []);
    check("and keeps the new value", g2.names["天"], "Heaven");
  }

  {
    const merged = mergeGlossaries(
      { names: { 萧炎: "Xiao Yan" } },
      { names: { 萧炎: "Xiao Yen", 萧媚: "Xiao Mei", 天: "Tian" } },
      { names: ["天"] }
    );
    check("mergeGlossaries: base wins, new terms fill in, suppressed stay out",
      merged.names, { 萧炎: "Xiao Yan", 萧媚: "Xiao Mei" });
  }

  {
    const store = makeGlossaryStore(fakeStorage());
    await store.remember(S, N, { names: { 萧炎: "Xiao Yan" } });
    await store.remember(S, "999999", { names: { 萧炎: "Someone else" } });
    check("two novels on one site never share a glossary",
      [(await store.get(S, N)).names["萧炎"], (await store.get(S, "999999")).names["萧炎"]],
      ["Xiao Yan", "Someone else"]);
  }

  {
    let threw = false;
    try { novelKey(S, null); } catch { threw = true; }
    check("novelKey refuses a missing novelId", threw, true);
  }

  console.log(failed ? `\n${failed} failing` : "\nall passing");
  process.exit(failed ? 1 : 0);
}

run();
