# Chinese → English Web Novels, In Place

A browser extension that takes a Chinese web novel chapter on a supported
site, translates it with a **local model through Ollama**, and replaces the
Chinese text with English directly on the page, paragraph by paragraph.

> **Status: Milestones 0–2 done. Next is Milestone 3, in-place
> replacement.** This document is
> written the way [JP Subs' design doc](../Translator%20Project/translator-design.md)
> ended up, not the way it started: predictions are kept next to their
> corrections rather than silently replaced, and every claim below is either
> measured (with the measurement) or explicitly marked as not yet checked.
> Almost everything here is the second kind. Read the "Progress at a glance"
> table as an honest map of that, not as a completion percentage.

### Progress at a glance

| Milestone | State |
|---|---|
| 0 — Scope, one site | **Done.** Qidian chosen after Fanqie was tested and rejected (§0). Adapter built and tested against a real chapter. |
| 1 — Translate MVP, no live overlay | **Done.** CLI: 54/54 paragraphs, 0 failures (§1.4). Extension: failed on first load (static imports in a content script), fixed, then translated a live chapter end to end into the reader tab (§1.5). Quality is *fluent*, not checked *accurate* — see §Questions. |
| 2 — Glossary system | **Done.** Per-novel storage, existing-entries-win merge, hand edits and deletions that stick, a popup editor, and a fixture exporter. Three defects in the first version found and fixed (§2.3), the worst being that every glossary key came back in pinyin, which silently disabled the merge rule. Hand edits verified reaching the translation (§2.4). Across two real chapters, all 6 recurring terms kept chapter 1's rendering (§2.5). Not yet seen: storage overriding a *naturally* conflicting proposal between chapters. |
| 3 — Live in-place replacement | **Not built.** Real open question found during scoping, not present in JP Subs: Qidian is a Vue SPA, and a framework re-render could silently wipe a DOM-injected translation. See §3. |
| 4 — Chapter flow and caching | **Not built.** Design notes only, §4. |
| 5 — Fallback polish, second site | **Half-built by accident.** The Milestone 1 reader tab (`src/reader.html`) already **is** the fallback view Milestone 5 asks for — it just isn't wired to trigger automatically yet. Second site: not started. |
| 6 — Stretch: JP/KR | **Not started, deliberately.** `core/prompt.js` is already shaped to take a second language as a data addition, the way JP Subs' Korean support was — see §6. |

**Reuse from JP Subs, checked against the actual files rather than assumed
from the brief:** `core/backends.js` and `core/chunk.js` ported with no
logic change — neither ever referred to subtitles specifically. `core/
prompt.js` and `core/pipeline.js` share JP Subs' *shape* (two-pass,
per-language rule tables, echo-verified chunk translation, LCS-based
`echoMatches`) but every string and category inside them is new, because the
content is prose in a different language with a different failure surface.
`core/glossary.js` is **new**, not ported — JP Subs kept this logic inline in
`background.js`; it was pulled into its own module here because "per-novel"
needs a composite key a channel ID never did, and because the brief makes the
glossary more central to this project than it was there.

**Design principle carried over unchanged, stated once so it can be checked
against every later decision:** this stays a personal reading aid, not a
scraper. Translation happens client-side against a local model; nothing is
uploaded, nothing is cached or served to anyone else; the extension never
bulk-downloads or mirrors a site ahead of what is actually being read. Same
posture as a browser's built-in "translate this page," aimed at prose instead
of a single page at a time. This is why Milestone 4's cache stays local and
per-reader (§4), and why there is no prefetch-ahead-of-reading mode without a
separate decision to add one (§Questions).

---

## Milestone 0 — Scope: pick one site

### 0.1 Site candidates considered

Four were considered before touching any code — see the chat history that
produced this document for the full comparison. Short version:

- **Qidian (起点中文网)** — chosen. See §0.2–0.3.
- **Fanqie/Tomato Novel (fanqienovel.com)** — **tested and rejected.** The
  initial assumption was that a free, ad-supported platform would have no
  reason to obfuscate its DOM text. Wrong: every chapter checked, including
  fully free ones, ships a **randomized custom `@font-face` per chapter**
  (`https://lf6-awef.bytetos.com/obj/awesome-font/c/<hash>.woff2`, a fresh
  hash each time) that visually renders correctly but does not correspond to
  the actual Unicode text in the DOM. Reading `textContent` directly produced
  garbled fragments — `："，迷途审判，拥欲，欲"` instead of real sentences — on a
  chapter that displayed perfectly on screen. This is the same anti-scraping
  technique Qidian and Jinjiang use on *paid* chapters, applied here
  site-wide. A real subsystem (download the chapter's woff2, map glyphs back
  to characters, likely via reference-font comparison or OCR) would be needed
  before any text extraction works at all, and that subsystem would have to
  exist before Milestone 1 could even get clean input. Rejected on cost, not
  on principle — nothing else about Fanqie was a problem.
- **Jinjiang (jjwxc.net)** — not tested directly, but known from research to
  use the same font-obfuscation family as Qidian on VIP chapters. A candidate
  for Milestone 5's second site once the pattern is proven, not for
  Milestone 0.
- **Biquge-style mirror sites** (various domains branded 笔趣阁) — plain HTML,
  no obfuscation, technically the easiest target. Not chosen: the underlying
  content on these is an unauthorized mirror of a paid platform's text rather
  than something the reader has their own access to, which sits badly against
  this project's "personal reading aid over content you already have" framing
  (see the Design principle above). Kept here as a fallback option if Qidian
  turns out to have a blocking problem later, not as a first choice.

### 0.2 Qidian — confirmed DOM shape

Checked by hand against `https://www.qidian.com/chapter/1209977/23183869/`
(斗破苍穹, chapter 1) on 2026-09-28. This is chapter 1's actual opening line,
extracted with no font obfuscation and no garbling: `"斗之力，三段！"` — real
text, standard system fonts (`SourceHanSansSC`, `PingFangSC`).

| | |
|---|---|
| Chapter URL | `https://www.qidian.com/chapter/{bookId}/{chapterId}/` |
| Novel title | `h1.text-rh3`, direct text — **first chapter only**; falls back to the `《…》` in the tab title (found when 九君齐天 ch. 2 exported with no title) |
| Chapter title | `h1.title`, **direct text nodes only** — see gotcha below |
| Content root | `main.content` (its own id is literally `c-{chapterId}`) |
| Paragraphs | `main > p > span.content-text`, direct text nodes only |
| Next/prev chapter | plain `<a>` tags, exact visible text `下一章` / `上一章` |
| Full chapter catalog | ordinary `<a>` tags on the book page, `/chapter/{bookId}/{chapterId}/` — 1,681 of them for this novel, no pagination fighting needed |

**Gotcha, and why `directText()` exists in `qidian.js`.** Both the chapter
title and every paragraph carry a nested `span.review` badge (a "hot comment
count," e.g. `999`) as a sibling of the real text inside the same element.
`el.textContent` walks into it and glues the number onto the end — measured:
chapter 1's title came back as `"第一章 陨落的天才999"` via `textContent`. The
fix reads only direct text-node children, which is also robust to Qidian
renaming the badge's class later, since it does not depend on knowing what
the badge is called — only that it is not a text node.

### 0.3 VIP chapters: an auth wall, not another obfuscation fight

Checked chapter 183 of the same novel (a later, further-into-the-story
chapter, no longer part of the free preview) anonymously. Result: **2
paragraphs instead of the usual ~50+, cut off mid-sentence**, with `订阅` /
`VIP` text nearby in the page. This is a straightforward server-side auth
gate — the real paragraphs are presumably rendered for a session that is
logged in with a subscription covering that chapter, the same as any other
paywalled content site — **not** the font-remapping trick Fanqie uses
site-wide. `qidian.js`'s `looksLocked()` treats "paywall text present and
fewer than 5 paragraphs" as locked and the pipeline refuses to translate it
rather than silently translating a truncated fragment as if it were the whole
chapter (§1.4 shows the resulting error message).

**Not yet verified:** whether a logged-in, subscribed reader's own browser
receives the real paragraphs in the same `main.content > p > span.content-
text` shape. Structurally there's no reason to expect otherwise — it would be
strange for Qidian to maintain a second DOM shape just for paying readers —
but nobody has pointed this extension at an account with an active
subscription yet. Flagged here rather than assumed, the way JP Subs flagged
the multi-hour MV3 stress test as "worked, never deliberately tested."

### 0.4 Cost

Not modelled, on purpose — same resolution JP Subs reached in its own §0.4,
for the same reason. Ollama is local; there is no per-chapter cost to budget
against. The constraint is GPU throughput, and model choice is the only real
lever on it (§1.4 used the largest model already installed, `qwen3.5:9b`).

---

## Milestone 1 — Translate MVP, no live overlay yet

**Scope, deliberately narrower than the brief's eventual product:** feed one
extracted chapter through the two-pass Ollama pipeline and show the English
result somewhere a person can read it — a CLI printout or a reader tab, not
the live page. This exists to prove translation quality and the glossary
mechanism before any DOM-injection risk is taken on, exactly the reasoning
JP Subs used for putting its CLI core before its extension shell.

### 1.1 What was ported vs. rewritten

| File | Status |
|---|---|
| `src/core/backends.js` | **Ported, unchanged logic.** Only the Gemini fallback was dropped — out of scope per the brief's "nothing costs per chapter" framing, and JP Subs' own Gemini path was unverified anyway. |
| `src/core/chunk.js` | **Ported, unchanged logic.** Defaults changed: `size` 20→8, `contextBefore` 10→4, `contextAfter` 6→2. Chosen because prose paragraphs run far longer than subtitle cues, not measured against real chunking behaviour yet. |
| `src/core/prompt.js` | **Rewritten.** Same two-table shape (per-language rules + generic rules) as JP Subs, but every rule is new — see §1.2. |
| `src/core/pipeline.js` | **Adapted.** `analyse()` and `translateUnits()` carry over near-verbatim (glossary-useful check, retry-missing-lines logic, echo verification). One real simplification: **no `segment()` step.** JP Subs needed one because ASR cues are fragments that must be re-cut into sentence units before translation; a site adapter's paragraphs are already real translation units, so there is nothing to re-segment. If a site turns out to emit unusably long or short paragraphs, add a segmentation step then — not speculatively now. |
| `src/core/glossary.js` | **New**, see Milestone 2. |
| `src/site-adapters/qidian.js` | **New**, Milestone 0's deliverable. |

### 1.2 Chinese-specific translation problems — predictions, not yet measured

Written the way JP Subs wrote its Japanese §3.3 rules *before* they were
checked against real output — each one is a plausible failure mode for this
language and genre, none has a scored failure category behind it yet the way
JP Subs' Japanese rules eventually did. Treat this list as the first thing to
revisit once there's a reason to distrust a translation.

- **Pro-drop.** Chinese narrative prose drops subjects about as freely as
  Japanese does, with no verb agreement to recover them from. Mitigated the
  same way as JP Subs: forward context plus an explicit rule to prefer the
  glossary's names over a bare pronoun.
- **Topic-prominent sentence structure.** Chinese often opens a sentence with
  the thing being discussed rather than the grammatical subject the English
  sentence will need. A literal clause-order translation reads as stilted
  English even when every word is individually correct. Ruled against
  explicitly; not yet checked whether the model needs more than one line to
  actually stop doing it.
- **Four-character idioms (成语).** Translate the sense, not the characters.
  No measurement of how often the model does this wrong yet — chapter 1 of
  the test fixture happened to contain none, so this rule is still
  completely unexercised.
- **Address terms as titles, not kinship.** 师兄/师姐/师父/道友 and similar mark
  relationship and rank in this genre, not literal family — the direct
  Chinese-genre analogue of JP Subs' Korean finding that 오빠/형/누나 are address,
  not siblings (its §8.5). Unlike the Korean case, this was written from
  genre knowledge, not from a measured YouTube-style baseline failure — there
  is no baseline to compare against here, so this is an even weaker claim
  than JP Subs' unvalidated Korean rules were.
- **Genre proper nouns.** Realm names, technique names, sect names are where
  this project's glossary earns its keep — see §1.4 for a first real
  measurement of this actually working.

### 1.3 Chunk-level robustness: echo verification, defaulted differently than JP Subs

`translateUnits()` asks the model to copy each paragraph's Chinese back
before its English translation, then rejects a translation whose copy
doesn't match (LCS ratio ≥ 0.7, ported from JP Subs' `echoMatches` with a
Chinese punctuation-noise class instead of a Japanese one). JP Subs
**defaults this off**; this project **defaults it on**
(`options.echo !== false` in `pipeline.js`). Reasoning, not yet measured: a
shifted subtitle desyncs for a few seconds and self-corrects at the next cue;
a shifted chapter paragraph is a permanently wrong sentence sitting in
running prose a reader has no way to notice. The cost is roughly double the
output tokens per chunk. Whether that trade is worth it in practice is open
— §1.4's run had it on throughout and produced 0 rejected paragraphs, which
is a good sign but a sample of one chapter from one model.

### 1.4 First real run — measured

`node bin/translate.mjs eval/fixtures/doupo-ch1.zh.json`, against
`qwen3.5:9b` on the machine this was built on, 2026-09-28.

The fixture is chapter 1 of 斗破苍穹 (Doupo Cangqiong), captured by hand
through `qidian.js`'s own selectors against the live page — real site output
kept as a regression fixture, the same practice as JP Subs'
`eval/fixtures/*.json`.

| | |
|---|---|
| Paragraphs | 54 |
| Translated | **54/54** |
| Failures | **0** |
| Paragraphs rejected by echo mismatch | 0 |

**Pass 1's glossary, produced automatically from the chapter alone (no
seed):**

```json
{
  "names": { "Xiao Yan": "Xiao Yan", "Xiao Mei": "Xiao Mei",
             "Xiao Xun'er": "Xiao Xun'er", "Tian": "Tian" },
  "factions": { "Xiao Family": "Xiao Family", "Wutan City": "Wutan City" },
  "realms": { "Dou Zhi Li": "Dou Power", "Dou Qi": "Dou Energy",
              "Dou Zhe": "Dou Expert", "Dou Qi Xuan": "Dou Energy Spiral" },
  "techniques": {},
  "terms": { "Test Stone Demon": "Demon Test Stone", "Low Rank": "Low Rank",
             "High Rank": "High Rank", "Seed Level": "Seed-Level Talent",
             "Dou Qi Segment": "Segment of Dou Energy" }
}
```

Read through the actual translation, the glossary categories did what §2 (and
the brief) predicted: `Dou Qi` stayed "Dou Energy" and `Dou Zhe` stayed "Dou
Expert" consistently from the first paragraph to the last, across 54
independently-requested chunks. That consistency is the whole point of
having a pass 1 at all, and this is the first chapter it has ever been tried
against.

**One rough edge, kept rather than quietly fixed before anyone saw it:** the
glossary's `names` includes a stray entry, `"Tian": "Tian"`, which is not a
character name in the chapter — the pass 1 prompt was not shown the author's
name, so this is most likely the model picking up a stray token near the
sampled text boundary (chapter text is sampled evenly if it exceeds 6,000
characters; this chapter is well under that, so the more likely cause is
just an LLM inventing a plausible-looking but spurious entry). Harmless here
— nothing in the translation used it — but exactly the kind of thing
Milestone 2's editable glossary needs a delete affordance for, which
`glossary.js`'s `remove()` already supports (§2.1) even though no UI calls it
yet.

**Translation quality, read by the person who built this, not scored against
anything independent:** reads as fluent, consistent English prose. This is
the same caveat JP Subs' own evaluation stage never got past — "coherent" and
"accurate" are different claims, and only a fluent-Chinese reader checking
specific lines against the source would tell them apart. Not done. See
§Questions.

### 1.5 What's built vs. what's been clicked through

Honest gap, stated the way JP Subs would state it: the CLI path (§1.4) has
been run for real. The extension path — `popup.js` → `background.js`
`translate-active-tab` → `content.js` `extract-chapter` → `pipeline.run()` →
`chrome.storage.session` → `reader.html` — has been written to the same
contract the CLI exercises (`core/pipeline.js`'s `run()` takes the same
chapter shape either way) but **has not yet been loaded into a real browser
and clicked**. The most likely first failure, based on nothing but
experience: `chrome.tabs.sendMessage` timing against `content.js`'s
`waitForChapterRoot()` poll, or a permissions gap in `manifest.json`. Load it
as an unpacked extension and try it on a live chapter before trusting this
path the way §1.4 trusts the CLI path.

> **First real load, 2026-09-28: failed as predicted, for a different reason.**
> "Could not establish connection. Receiving end does not exist." Not a
> timing race: `content.js` used static `import` statements, and manifest
> content scripts load as classic scripts, so the file died with a syntax
> error before its listener existed. The CLI could never have caught this —
> it never loads `content.js`. Fixed in 0.1.1 by loading the adapters with a
> dynamic `import()` (adapter files listed in `web_accessible_resources`).
> A second cause of the same error was fixed alongside it: a tab already
> open before the extension is (re)loaded never receives manifest content
> scripts, so the background now pings the tab and injects `content.js`
> via `chrome.scripting` if nothing answers.
>
> **Second load: worked.** A live 九君齐天 chapter (152 short paragraphs)
> translated end to end and opened in the reader tab. One UX defect found in
> the same session — the popup forgets a running translation when it closes
> — is recorded in the Build Order, not fixed here.

---

## Milestone 2 — Glossary system

### 2.1 What's built

`src/core/glossary.js`, storage- and chrome-independent (takes a
`{get,set,remove}` object shaped like `chrome.storage.local`, so it is
tested with a plain in-memory stub — `src/core/glossary.test.mjs`, 14 cases,
all passing). Ported design, new implementation — and rewritten once, see
§2.3 for the three defects the first version shipped with:

- **Keyed by `site:novelId`**, not by title — titles collide across sites and
  occasionally within one. The brief's "per-novel, not per-channel" is
  exactly JP Subs' per-channel key with the identity swapped.
- **Existing entries always win** when a later chapter's pass 1 proposes a
  different rendering for something already in the glossary — ported
  unchanged from JP Subs' channel-glossary merge (`{...add, ...base}`).
  Tested directly: chapter 1 sets 萧炎 → "Xiao Yan"; a simulated chapter 2
  proposes "Xiao Yen" for the same key; the stored value stays "Xiao Yan"
  (`glossary.test.mjs`, case 1).
- **A hand edit outranks even that** — the editor saves through
  `replaceAll()`, and the result survives *any* later `remember()` call,
  because a correction a person made on purpose is ground truth, not one
  more chapter's opinion to blend in.
- **A deletion stays deleted.** A term removed in the editor is recorded in
  `suppressed`, and a later chapter's pass 1 proposing it again is ignored.
  Typing it back in by hand un-suppresses it. Without this, deleting a stray
  entry like §1.4's `"Tian"` would last exactly until the next chapter.
- **The glossary a chapter is translated with is the merged one**, not pass
  1's fresh output. `pipeline.run()` applies `mergeGlossaries(seed, found)`
  — the same rule storage uses — before translating. Seeding pass 1's prompt
  alone does not guarantee anything: the model can re-render a seeded term or
  drop it under the per-category caps, and a hand edit that reaches storage
  but not the translation has not actually won.
- **Pass-1 entries not keyed in Chinese are dropped** before they reach
  storage (`keepSourceKeys()` in `pipeline.js`) — §2.3.
- **`editedByHand` protects a novel from the LRU prune** at 200 novels
  remembered, same rule JP Subs used for channels at 200: an edited glossary
  cost someone real effort and should not be evicted for being old.
- **Five categories**, not JP Subs' two: `names`, `factions`, `realms`,
  `techniques`, `terms` — expanded from JP Subs' `names`/`terms` because the
  brief calls out character names, cultivation-realm names, technique names
  and sect names as distinct things worth keeping straight from each other,
  and §1.4's real run confirms the model does populate all but `techniques`
  from a single ordinary chapter (that chapter's plot has not reached a named
  technique yet — not a bug, just this fixture's content).

### 2.2 The editor

In the popup, for whichever novel the active tab belongs to (identified from
the URL alone — `identifyNovel()` — so the editor opens even before a
chapter has been extracted). One `term = English` per line under a
`[names]` / `[factions]` / `[realms]` / `[techniques]` / `[terms]` heading.

**Plain text, not the JSON textbox JP Subs used.** A stray comma or quote in
hand-edited JSON loses the whole save, and this is edited in a narrow popup.
The format lives in `src/glossary-text.js` with its own tests
(`glossary-text.test.mjs`, 7 cases), not in the popup where a parsing mistake
would only surface as a bad save.

**A save with any error is refused whole.** This is not caution for its own
sake: `replaceAll()` treats a missing term as a deletion, so applying only the
lines that parsed would silently record every term on a broken line as
deleted — and suppressed from every future chapter.

**Not built, deliberately:** the per-entry diff JP Subs' editor computed on
save, used there to rewrite already-cached subtitles in place. There is no
cache yet to rewrite (Milestone 4). When there is, JP Subs'
`glossary:apply` and its `glossary-apply.test.mjs` port directly.

### 2.3 Three defects in the first version, found from real output

The first `glossary.js` passed all seven of its tests and was wrong in three
ways. Only one was visible in real output; the other two were found by
reading the code while fixing it. All three are now tests.

1. **Every glossary key was in pinyin or English, never Chinese.** §1.4's
   glossary reads `"Xiao Yan": "Xiao Yan"`, `"Dou Qi": "Dou Energy"` — no
   entry anywhere was keyed in the characters that actually appear in the
   text. The prompt showed placeholder keys as descriptions (`"chinese
   name"`), and the model filled them with romanisations. The consequence was
   worse than a cosmetic one: a hand edit to `萧炎` could never collide with
   pass 1's `Xiao Yan`, so **"existing entries win" would never have
   triggered** — duplicates would have accumulated instead, with the merge
   rule silently doing nothing. The tests missed it because they were written
   with Chinese keys, i.e. with the output the prompt was *supposed* to
   produce. Fixed twice over: the prompt now shows real Chinese example keys
   and says outright that keys must be the characters as written, and
   `keepSourceKeys()` drops any entry without a Han character in its key.
   After the fix, a fresh run on the same chapter keyed all 13 entries in
   Chinese and dropped none (§2.4).
2. **The per-category cap could evict stored entries.** `{...add, ...base}`
   puts the *new* keys first in insertion order, and the cap then kept the
   first 40 — so a chapter full of new proposals could push out old entries,
   hand edits included. Now `base` is always kept whole and new proposals
   only fill the space left.
3. **A deleted entry came back.** Nothing recorded that a term had been
   removed, so the next chapter's pass 1 re-added it. Now `suppressed`.

### 2.4 Measured — one chapter, three runs

`qwen3.5:9b`, 2026-09-28, 斗破苍穹 chapter 1 fixture, via
`bin/translate.mjs --glossary`, which drives the same store and merge rule
the extension uses.

**Run 1 — fresh glossary, after the key fix.** 54/54 paragraphs, 0 failures.
Pass 1 stored 13 entries, **all keyed in Chinese**, none dropped by
`keepSourceKeys()`: `萧炎`, `萧媚`, `萧薰儿`, `乌坦城` (names), `萧家` (factions),
`斗之力`, `斗之气`, `斗者` (realms), `测验魔石碑`, `斗之气旋`, `低级`, `高级`,
`种子级别` (terms). Compare §1.4, where the same chapter produced zero
Chinese keys.

Rendering drift between runs is real: this run chose "Dou Qi" / "Dou Zhe"
where §1.4's chose "Dou Energy" / "Dou Expert" for the same two terms. Both
are defensible; neither is wrong. It is exactly why the first stored
rendering has to win — without storage, every chapter re-rolls this.

**Hand edit, through `replaceAll()`** as the popup saves it: `斗之气` →
"Battle Qi", `斗者` → "Fighter" — chosen because the model would never pick
them on its own, so every occurrence is attributable — and `低级` deleted.

**Run 2 — same chapter, seeded from the edited glossary.** 54/54, 0 failures.

| | Run 1 | Run 2 |
|---|---|---|
| "Dou Zhe" | 5 | **0** |
| "Fighter" | 0 | **5** |
| "Dou Qi" (standalone) | 14 | **0** |
| "Battle Qi" | 0 | **9** |
| "Dou Qi Spiral" | — | **4** |
| `低级` in stored glossary | yes | **no** — pass 1 proposed it again; suppressed |
| Chapters counted | 1 | 2 |

The hand edits reached the translation completely: every standalone
occurrence of both renamed terms changed. Pass 1 re-proposing the deleted
`低级` did not bring it back.

**The one inconsistency is the glossary's, not the model's.** The four
surviving "Dou Qi"s are all "Dou Qi Spiral" — the stored rendering of the
*compound* term `斗之气旋`, which the rename of `斗之气` did not touch. The
model followed the glossary exactly into an inconsistency the glossary
itself contained. This is a real editor problem and it will recur with
every renamed realm or name that has compounds built on it, which in this
genre is most of them. Fixed as a warning, not an automatic rewrite:
`staleCompounds()` in `glossary-text.js` lists, after a save, every entry
whose key contains a renamed term and whose English still contains its old
rendering. It does not rewrite them — "Battle Qi Spiral" is the likely
intent here, but not a safe guess in general.

**What this does and doesn't show.** It shows the whole mechanism working
end to end against a real model. It does not show cross-chapter
consistency, because pass 1 in run 2 saw the same text as run 1 — see
§2.5.

### 2.5 Measured — across two real chapters

九君齐天 chapters 1 and 2, exported with the popup's **Export chapter as
test fixture** during a normal reading session (capturing from a scripted
browser was tried first and stopped: Qidian answers a plain fetch with a
bot-check page and intercepts scripted requests in-page — not something this
project should work around). `qwen3.5:9b`, 2026-09-28, one fresh glossary
file shared by both runs.

| | Chapter 1 | Chapter 2 |
|---|---|---|
| Paragraphs translated | 152/152 | 147/147 |
| Failures | 0 | 0 |
| Glossary entries after the run | 18 | 24 (6 added by ch. 2) |

Of chapter 1's 18 stored entries, **6 recur in chapter 2's source text, and
all 6 kept chapter 1's rendering in chapter 2's English**:

| Term | In ch. 2 source | Stored rendering | Uses in ch. 2 English |
|---|---|---|---|
| 许曜 | 23 | Xu Yao | 24 |
| 刘振 | 25 | Liu Zhen | 25 |
| 大胖 | 8 | Dapang | 8 |
| 九斤 | 1 | Jiujin | 1 |
| 书吏 | 1 | Clerk | 1 |
| 游魂 | 1 | Wandering Souls | 1, as lowercase "wandering soul" — same term used as a common noun |

That is the brief's goal met on the first real attempt: the names and
recurring terms of one chapter stayed fixed in the next, where the next
chapter's pass 1 had never seen the first chapter's text. (许曜's 24 against
23 is one extra English mention, most likely a resolved pronoun — a gain, not
drift.)

**What this run did *not* exercise:** chapter 2's own pass 1 **never
disagreed** with storage. Seeded with chapter 1's glossary, it re-listed none
of the four stored names and agreed on both stored terms it did repeat. So
"storage beats a conflicting fresh proposal" has only been observed through
the deliberate hand edit in §2.4, never occurring on its own between
chapters. Two chapters is a short distance; drift is more likely to show up
twenty chapters later, when a name reappears after a long absence. Worth
re-checking once the Milestone 4 cache makes long runs of chapters cheap to
look back over.

**Milestone 2 is closed on this result.**

### 2.6 One decision, and what's left
- **Seeding "from several chapters" is as-you-read, not a bulk pass.** The
  brief says pass 1 "reads a chapter (or several)." Reading several at once
  would mean fetching chapters the reader has not opened, which is exactly
  what the Design principle rules out. The glossary instead accumulates one
  chapter at a time as they are read — `chapters` in the stored record counts
  them — which reaches the same place by the second or third chapter
  without the extension ever fetching ahead.
- **Categories are fuzzy to the model.** The same run filed `乌坦城`, a city,
  under `names` rather than `factions`. Harmless for translation, since every
  category is sent to the model the same way; it matters only for how the
  editor reads. Not worth prompt changes until it causes an actual
  mistranslation.

---

## Milestone 3 — Live in-place replacement

**Not built.** Design notes and one real risk that JP Subs' overlay-based
approach never had to face.

### 3.1 The mechanism, as planned

`extractChapter()` already returns each paragraph's live DOM element (`el`)
alongside its text — kept specifically for this milestone, stripped out by
`toPayload()` only when a chapter needs to cross the content-script/
service-worker message boundary (§1.5). In-place replacement is meant to run
entirely inside `content.js`, paragraph by paragraph, using
`pipeline.translateUnits()`'s `onProgress` callback to swap each paragraph's
text as its translation arrives — this is the direct reason
`translateUnits()` reports progress after every chunk rather than only at
the end (ported from JP Subs' "progressive, not blocking" delivery, §4.1
there).

### 3.2 A risk JP Subs never had: framework re-render

JP Subs' overlay never touched YouTube's own DOM — it painted subtitles into
a separate shadow-root element anchored to the player, so nothing about
YouTube's own rendering could ever disturb it. In-place replacement is a
different shape of problem by design: it has to mutate node's Qidian
actually renders.

Qidian's chapter page is a **Vue SPA** — every content element carries a
`data-v-f233f990`-style scoped-style attribute, confirmed during §0.2's
scouting. If Vue's reactivity system re-renders the paragraph list for any
reason after a translation has been written in — a font-size setting
toggled, a "load next chapter inline" feature, anything that touches the
component's own state — a plain `textContent` write is exactly the kind of
DOM mutation a virtual-DOM diff doesn't know about and can silently
overwrite. This has not been tested. It is the single largest open technical
risk in this milestone, worth checking early and cheaply (translate one
paragraph, toggle an unrelated page setting, see if the translation
survives) rather than discovering it after the rest of the milestone is
built.

### 3.3 The original/English toggle

Planned to work the way JP Subs' hide/show subtitles toggle works logically,
but the storage shape is necessarily different: JP Subs never touched the
original Japanese in the DOM at all — it painted English into a separate
overlay and toggling just hid or showed that overlay. In-place replacement
*replaces* the original text, so the toggle needs the original Chinese saved
somewhere (`el.dataset` on each paragraph node is the obvious place) before
the swap happens, and toggling means writing one or the other string back
in — closer to `reader.js`'s current `show-original` class toggle (§1
already built this once, for the fallback tab) than to JP Subs' show/hide.

---

## Milestone 4 — Chapter flow and caching

**Not built.** Design notes only.

- **Detect navigation to the next chapter.** `extractChapter()` already
  returns `nextChapterUrl`; Qidian chapter-to-chapter navigation is a normal
  page load (confirmed during §0.2 scouting — the "下一章" link is a plain
  `<a>`, not a client-side route), so this is likely a fresh content-script
  run on the next URL rather than an SPA-navigation listener. Worth
  confirming directly rather than assuming, the way §0.3's VIP behaviour was
  confirmed rather than assumed.
- **Cache finished chapters, local only.** Same reasoning as JP Subs' §4.2,
  and it matters more here given the Design principle stated at the top of
  this document: a shared cache would start turning "a translation overlay
  for the one person reading" into a redistribution question. `chrome.
  storage.local`'s 10 MB cap is the same constraint JP Subs hit; a novel
  chapter (§1.4's fixture: 54 paragraphs, a few thousand characters) is much
  smaller than a video's subtitle track, so the practical cap is likely
  "many more chapters" rather than "about twenty" — not yet measured.
- **Version the cache** the way JP Subs does, so a `prompt.js` or
  `pipeline.js` change invalidates chapters translated under the old rules
  rather than serving stale results silently.
- **No prefetch-ahead-of-reading by default.** This needs to be a deliberate
  decision, not a default, given the Design principle — see §Questions.

---

## Milestone 5 — Fallback polish, second site

**Half-built by accident.** `src/reader.html`/`reader.js`, built for
Milestone 1 as the *only* output (there was no in-place mode to fall back
from yet), already has the right shape for Milestone 5's fallback view: it
renders a chapter's paragraphs with an original/English toggle, independent
of any specific site. What's missing is the *decision logic* — something
that decides in-place replacement isn't safe on a given page (a Fanqie-style
obfuscated site, a raw pasted chapter, a site adapter that fails partway) and
routes to this view instead of trying and failing silently. That decision
point doesn't exist because Milestone 3 doesn't exist yet.

**Second site.** `src/site-adapters/index.js` is a two-line registry
specifically so this is additive — Fanqie is disqualified (§0.1) without a
deobfuscation subsystem, so the next real candidate is either Jinjiang
(same font-obfuscation family expected on VIP content, unverified) or a
second, less VIP-aggressive corner of Qidian's own catalog. Not started.

---

## Milestone 6 — Stretch: JP/KR

**Not started, deliberately** — same status JP Subs gave Chinese in its own
§8.8, for the same reason in reverse: nothing should be built to accommodate
a second language until there is a second language, because the coupling
mistakes JP Subs found in its own "general" code (§0.1 there — the
sentence-end class silently assumed Japanese, `segment()` silently assumed
no spaces) came from exactly that kind of speculative accommodation.

What *is* already shaped for it, because the shape was nearly free:
`core/prompt.js`'s `LANGUAGES` table takes a second language as a new key
with its own `rules` array, the same structure JP Subs used to add Korean in
1.8.0–1.10.0. `core/pipeline.js` and `core/chunk.js` have no Chinese-specific
logic in them at all — everything language-specific lives in `prompt.js`,
by construction. If this stretch goal is picked up, JP Subs' own §8 is the
playbook: test the premise on one real chapter before writing a prompt rule
for it, the way §8.1–§8.3 there found real, measured differences (punctuation
rate, speaker markers) before any code changed.

---

## Build Order

1. ✅ **Site scouting and adapter — Qidian.** `src/site-adapters/qidian.js`.
   Riskiest unknown resolved first, the way JP Subs put transcript
   acquisition before rendering: whether a site's DOM is usable at all gates
   everything downstream, so it was checked by hand against a live page
   before any pipeline code was written.
2. ✅ **Translation core, ported and adapted from JP Subs.** `src/core/
   {backends,chunk,prompt,pipeline}.js`. Proven once against a real captured
   chapter via `bin/translate.mjs` — §1.4.
3. ✅ **Glossary storage and merge rule.** `src/core/glossary.js`, tested
   independently of the extension (§2.1), rewritten once (§2.3).
4. ✅ **Extension shell.** Failed on first load, fixed, then translated a live
   chapter end to end (§1.5).
5. ✅ **Glossary editor and fixture export** in the popup (§2.2), plus the
   stale-compound warning found by measurement (§2.4).
6. ✅ **Two-chapter glossary run.** 九君齐天 ch. 1 → ch. 2: all 6 recurring
   terms held their chapter-1 rendering (§2.5). Milestone 2 closed.
7. ⬜ **Run state that survives the popup closing.** Found in first real use
   (2026-09-28): the popup "resets" every time it loses focus. Chrome destroys
   the popup page on close, and its "Translating…" status lived only there.
   The run itself lives in the service worker and finished fine; only the UI
   forgot it. Two consequences, the second worse: no progress is visible
   after reopening, and **nothing stops a second Translate click from
   starting a duplicate run** on the same GPU. JP Subs already solved this
   shape — per-tab run state held in the background (`runs` map /
   `setState`), a popup that reads it on open, a busy flag that refuses a
   second run, a Stop button, and an on-page progress box — so this is a port,
   not new design. Belongs with Milestone 3 at the latest, since in-place
   replacement makes progress visible on the page anyway.
8. ⬜ In-place replacement, with the Vue re-render risk (§3.2) checked
   early and cheaply before the rest of the milestone is built on top of it.
9. ⬜ Chapter navigation detection and local caching (§4).
10. ⬜ Fallback routing logic connecting Milestone 3's failure cases to the
   already-built `reader.html` (§5), plus a second site adapter.
11. Not planned yet: JP/KR (§6), prefetch-ahead-of-reading (open question
   below), a shared/hosted glossary or cache (ruled out by the Design
   principle, not merely undone).

---

## Questions — open

- **Does a logged-in, subscribed session see VIP paragraphs in the same DOM
  shape as free ones?** (§0.3) Structurally likely, not verified. Blocks
  nothing in Milestone 0–2, which only need free chapters; matters before
  claiming VIP support works.
- **Does Vue re-rendering actually threaten an in-place text swap?** (§3.2)
  The single largest technical risk in the next milestone, and cheap to
  check directly before building around an assumption either way.
- **Is the translation actually accurate, not merely fluent?** (§1.4) Open
  the same way JP Subs left it open across its whole project — every reading
  of §1.4's output so far has been by someone who cannot check it against
  the Chinese. Unlike JP Subs, there is no independent baseline translation
  (no equivalent of "YouTube's own auto-translation") to compare against
  here, so even the *weak*, self-scored kind of evaluation JP Subs managed
  in its §7 doesn't have an obvious starting point yet.
- **How much of the four §1.2 prediction rules actually change model
  behaviour?** None has been checked against a same-chapter run with the
  rule removed. Cheap to check once there's a reason to suspect one isn't
  earning its place in the prompt.
- **Should prefetching the next chapter ever be a default, or only an
  explicit per-novel opt-in?** The Design principle's "no bulk-fetching ahead
  of what's being read" argues for opt-in only; the brief leaves the door
  open ("how far ahead to translate" is listed as an open question there
  too). Decide this before Milestone 4's caching makes it an easy accidental
  default rather than a deliberate choice.
- **Bilingual stacked view vs. full swap, for Milestone 3's replacement
  style.** The brief raises this explicitly and leaves it open. `reader.js`'s
  toggle (show one or the other, not both at once) was the simplest thing
  that could be built for Milestone 1's reader tab and is not necessarily the
  right answer for in-place replacement, where a stacked view might read
  better mid-paragraph than a hide/show toggle does. Undecided.
