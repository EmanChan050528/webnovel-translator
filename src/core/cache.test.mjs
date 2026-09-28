// Tests for the finished-chapter cache.
// Run: node src/core/cache.test.mjs

import { makeChapterCache, sourceHash, PIPELINE_VERSION } from "./cache.js";

function fakeStorage({ failWrites = false } = {}) {
  const data = new Map();
  return {
    data,
    async get(keys) {
      if (keys === null || keys === undefined) return Object.fromEntries(data);
      const out = {};
      for (const k of Array.isArray(keys) ? keys : [keys]) if (data.has(k)) out[k] = structuredClone(data.get(k));
      return out;
    },
    async set(obj) {
      if (failWrites) throw new Error("QUOTA_BYTES quota exceeded");
      for (const [k, v] of Object.entries(obj)) data.set(k, structuredClone(v));
    },
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
const tick = () => new Promise((r) => setTimeout(r, 2));

const paras = (...zh) => zh.map((z) => ({ zh: z }));
const S = "qidian", N = "1033999771";

async function run() {
  {
    const cache = makeChapterCache(fakeStorage());
    const hash = sourceHash(paras("第一段", "第二段"));
    await cache.put(S, N, "1", { hash, translations: ["One.", "Two."] });
    check("a stored chapter comes back", (await cache.get(S, N, "1", hash))?.translations, ["One.", "Two."]);
    check("an unknown chapter is a miss", await cache.get(S, N, "2", hash), null);
  }

  {
    const storage = fakeStorage();
    const cache = makeChapterCache(storage);
    const hash = sourceHash(paras("第一段"));
    await cache.put(S, N, "1", { hash, translations: ["One."] });
    const edited = sourceHash(paras("第一段（修改）"));
    check("an edited chapter is a miss", await cache.get(S, N, "1", edited), null);
    check("with the reason stated", (await cache.lookup(S, N, "1", edited)).reason, "text-changed");
    // The bug this replaced: a partial read of a page still rendering
    // deleted a good entry.
    const partial = sourceHash(paras());
    await cache.get(S, N, "1", partial);
    check("a mismatched read does not delete the entry", (await cache.get(S, N, "1", hash))?.translations, ["One."]);
  }

  {
    const storage = fakeStorage();
    const cache = makeChapterCache(storage);
    const hash = sourceHash(paras("第一段"));
    await cache.put(S, N, "1", { hash, translations: ["One."] });
    const key = `chapter:${S}:${N}:1`;
    storage.data.set(key, { ...storage.data.get(key), pipeline: PIPELINE_VERSION - 1 });
    check("an entry from an older pipeline is a miss", await cache.get(S, N, "1", hash), null);
  }

  {
    check("the hash changes when a paragraph splits in two",
      sourceHash(paras("甲乙")) === sourceHash(paras("甲", "乙")), false);
  }

  // LRU: budget fits two chapters; reading chapter 1 makes chapter 2 the oldest.
  {
    // Each entry below is ~220 bytes: 500 fits two, not three.
    const cache = makeChapterCache(fakeStorage(), { budgetBytes: 500 });
    const big = Array(4).fill("x".repeat(30));
    await cache.put(S, N, "1", { hash: "h1", translations: big }); await tick();
    await cache.put(S, N, "2", { hash: "h2", translations: big }); await tick();
    await cache.get(S, N, "1", "h1"); await tick();
    await cache.put(S, N, "3", { hash: "h3", translations: big });
    check("eviction drops the least recently *used* chapter",
      [!!(await cache.get(S, N, "1", "h1")), !!(await cache.get(S, N, "2", "h2")), !!(await cache.get(S, N, "3", "h3"))],
      [true, false, true]);
  }

  {
    const cache = makeChapterCache(fakeStorage());
    await cache.put(S, N, "1", { hash: "a", translations: ["Dou Qi rose.", ""] });
    await cache.put(S, N, "2", { hash: "b", translations: ["No names here."] });
    await cache.put(S, "999", "1", { hash: "c", translations: ["Dou Qi elsewhere."] });
    const n = await cache.rewriteNovel(S, N, [{ from: "Dou Qi", to: "Battle Qi" }]);
    check("rewriteNovel counts chapters actually changed", n, 1);
    check("rewriteNovel rewrites this novel's chapters", (await cache.get(S, N, "1", "a")).translations, ["Battle Qi rose.", ""]);
    check("rewriteNovel leaves other novels alone", (await cache.get(S, "999", "1", "c")).translations, ["Dou Qi elsewhere."]);
  }

  {
    const cache = makeChapterCache(fakeStorage({ failWrites: true }));
    const ok = await cache.put(S, N, "1", { hash: "a", translations: ["One."] });
    check("a failed write returns false instead of throwing", ok, false);
  }

  console.log(failed ? `\n${failed} failing` : "\nall passing");
  process.exit(failed ? 1 : 0);
}

run();
