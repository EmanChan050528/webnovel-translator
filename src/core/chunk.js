// Translation units -> request chunks.
//
// Ported unchanged from JP Subs' core/chunk.js: this file never referred to
// subtitles specifically, only to a `units` array sliced by index, so it
// applies to paragraphs with no edit. `after` is still the whole point of
// doing this off the live page: it is a request-shaped equivalent of what
// Milestone 1 buys by reading a chapter as a finished document instead of
// paragraph-by-paragraph as a reader scrolls.

export const DEFAULTS = {
  /** Paragraphs translated per request. Prose paragraphs run far longer than
   *  subtitle cues (JP Subs used 20 short cues/chunk), so this starts smaller
   *  — chosen, not measured. See translator-design.md §3.2. */
  size: 8,
  /** Paragraphs of preceding context, read-only. */
  contextBefore: 4,
  /** Paragraphs of following context, read-only. */
  contextAfter: 2,
};

export function chunk(units, options = {}) {
  const { size, contextBefore, contextAfter } = { ...DEFAULTS, ...options };
  const chunks = [];

  for (let start = 0; start < units.length; start += size) {
    const end = Math.min(start + size, units.length);
    chunks.push({
      index: chunks.length,
      firstUnit: start,
      before: units.slice(Math.max(0, start - contextBefore), start),
      target: units.slice(start, end),
      after: units.slice(end, Math.min(end + contextAfter, units.length)),
    });
  }

  return chunks;
}
