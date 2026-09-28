// Is this chapter's text actually readable, or scrambled by an anti-copy font?
//
// Font obfuscation (Fanqie site-wide, and paid chapters on Qidian and
// Jinjiang — design doc §0.1) serves text whose code points are not the
// characters shown on screen: a custom font draws private-use code points as
// real glyphs. The DOM text is then useless, and so is copying it — which
// means the reader-tab fallback cannot help either. The only honest outcome
// is to say so, instead of translating garbage.

const PUA = /[-]/gu;
const COUNTED = /[^\s　\p{P}]/gu; // ignore whitespace and punctuation

/** Share of meaningful characters that are private-use code points. */
export function scrambledShare(paragraphs) {
  const text = paragraphs.map((p) => p.zh).join("");
  const total = (text.match(COUNTED) || []).length;
  if (!total) return 0;
  return (text.match(PUA) || []).length / total;
}

/** 2%: a real chapter has essentially none; an obfuscated one has many. */
export function looksScrambled(paragraphs, threshold = 0.02) {
  return scrambledShare(paragraphs) > threshold;
}
