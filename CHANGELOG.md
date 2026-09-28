# Changelog

Each `0.x` version is the one its commit's `manifest.json` recorded, so the
tags match what the extension reported about itself at the time. `1.0.0` is
the first release: Milestones 0–5 of the brief, done and confirmed in real
use. Milestone 6 (Japanese and Korean novels) and Milestone 7 (UI redesign)
are not part of it.

Tags are annotated, so `git show 1.0.0` explains why each one is where it is.
The reasoning behind every change is in [translator-design.md](translator-design.md);
section numbers below point into it.

---

## 1.0.0 — first release

The same extension as 0.5.0, released. What it does:

- **Translates Chinese web novel chapters in place** on Qidian and Jinjiang
  (free chapters), paragraph by paragraph as each chunk finishes, with a
  local model through Ollama. Nothing is uploaded; nothing costs per chapter.
- **Keeps names and terms consistent across chapters** with a per-novel
  glossary that builds itself as you read and that you can edit. Your edits
  and deletions always win.
- **Makes a re-read instant** with a local chapter cache, and can translate
  each new chapter of a chosen novel as soon as you open it.
- **Falls back honestly:** a reader tab when a page can't be rewritten
  cleanly, a paste tab for any other site, and a plain refusal when a page's
  text is scrambled by an anti-copy font.

---

## 0.5.0 — second site, fallbacks

- **Jinjiang** (jjwxc.net free chapters). Its paragraphs are loose text
  between `<br>`s, not elements, which exposed Qidian assumptions in the
  content script. The adapter contract now hands over text nodes and a
  content root (§5.2).
- **Reader-tab fallback** when a page can't be rewritten cleanly — formatting
  inside a paragraph, or the page rearranging its paragraphs mid-run. The
  original text is restored first (§5.1).
- **Scrambled-text refusal.** Anti-copy fonts serve private-use characters;
  a chapter over 2% is refused with the reason. Measured on Fanqie: 69.5%.
- **Paste tab** for any other site, optionally using a novel's glossary.

## 0.4.1 — chapter cache and translate on arrival

- **Chapter cache**, ported from JP Subs: local only, 7 MB budget (about
  370–400 real chapters), least-recently-read eviction, versioned, and
  fingerprinted so an author's edit to a chapter is not served a stale
  translation (§4.2).
- **Translate on arrival**, opt-in per novel. No prefetching of chapters you
  haven't opened (§4.1).
- **Glossary renames rewrite cached chapters**, longest rendering first, so
  "Dou Qi Spiral" is not half-renamed by a "Dou Qi" edit (§4.3).
- **Model dropdown** listing installed Ollama models. The choice is stored,
  so automatic translations use it too — before this they always used the
  default.
- Fixed: a page read while still rendering could delete a good cache entry.
  The popup now says why a chapter was or wasn't cached.

## 0.3.0 — in-place replacement

- **Paragraphs replaced on the page** as each chunk finishes, changing only
  text-node values so Qidian's Vue DOM stays intact (§3.1).
- **Original/English toggle** and an on-page progress bar with Stop.
- **Re-render guard**: anything the page redraws over a translation is
  re-applied and counted in the popup. Checked first: scrolling, night mode
  and idle cause no page changes at all (§3.2).
- **Run state moved to the background**: the popup no longer forgets a
  running translation, a second run can't start on the same tab, and Stop
  cancels mid-request.
- Fixed before release: the guard stripped Qidian's paragraph indentation
  from every untranslated paragraph.

## 0.2.0 — per-novel glossary

- **Glossary per novel**, seeded by each chapter's first pass. Stored entries
  always win over new proposals; hand edits and deletions stick (§2.1).
- **Popup editor** in a plain `term = English` format, with a warning when a
  rename leaves a related entry using the old name (§2.2, §2.4).
- **Chapter export** for local test fixtures, and `--glossary` for the CLI.
- Fixed: glossary keys came back in pinyin rather than Chinese, which
  silently disabled the "stored entries win" rule (§2.3).
- Measured across two real chapters: every recurring name and term kept its
  chapter-1 rendering (§2.5).

## 0.1.1 — first working version

- **Qidian site adapter**, after Fanqie was tested and rejected for its
  font-scrambled text (§0).
- **Two-pass translation core** ported from JP Subs: a glossary pass, then
  chunked translation with each paragraph's source echoed back to catch
  shifted lines (§1).
- **Reader tab** showing the translated chapter, and a CLI for testing the
  core without a browser.
- Fixed in the same version: the content script used static imports, which
  content scripts can't, so the first load failed (§1.5).
