// The model seam. One function, talking to local Ollama — ported near-verbatim
// from JP Subs' core/backends.js, which already made no assumption specific to
// subtitles. No cloud fallback: the whole point of this project, same as JP
// Subs, is that nothing is uploaded and nothing costs per chapter.
//
// A backend is: async (prompt, {json}) => string

// Shared by a future Node CLI and the extension's service worker, so nothing
// here may assume `process` exists.
const env = (key) =>
  (typeof process !== "undefined" && process.env && process.env[key]) || undefined;

const DEFAULT_OLLAMA_HOST = env("OLLAMA_HOST") || "http://localhost:11434";

/**
 * Local Qwen (or any Ollama model).
 *
 * Two settings carried over from JP Subs because they were learned the hard
 * way there and nothing about prose changes them:
 *
 * num_ctx — Ollama defaults to a small context that silently truncates a
 * chunk carrying context paragraphs, producing quietly worse output rather
 * than an error. Chapter chunks are prose paragraphs, not subtitle cues, so
 * this may need to be larger than JP Subs' 16384 — unmeasured here, see
 * translator-design.md Stage 3.
 *
 * think — Qwen3.5 is a reasoning model. Left on, it emits its reasoning into
 * a separate `thinking` field that consumes the whole num_predict budget
 * before any answer is produced, and `content` comes back EMPTY.
 */
export function ollamaBackend({
  model = "qwen3.5:9b",
  numCtx = 16384,
  numPredict = 8192,
  temperature = 0.2,
  think = false,
  host = DEFAULT_OLLAMA_HOST,
  /** Aborts the in-flight request — this is what makes Stop work mid-request. */
  signal = null,
  /** A single request has no progress of its own, so cap how long it may hang. */
  timeoutMs = 15 * 60 * 1000,
} = {}) {
  return async function ollama(prompt, { json = false } = {}) {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
    const forward = () => controller.abort();
    if (signal) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener("abort", forward, { once: true });
    }

    let res;
    try {
      res = await fetch(`${host}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          model,
          stream: false,
          think,
          format: json ? "json" : undefined,
          options: { temperature, num_ctx: numCtx, num_predict: numPredict },
          messages: [{ role: "user", content: prompt }],
        }),
      });
    } catch (err) {
      if (timedOut) {
        throw new Error(
          `${model} did not answer within ${Math.round(timeoutMs / 60000)} minutes. ` +
          `On a slower machine this usually means the model is too large — try a ` +
          `smaller one (e.g. qwen3.5:4b) in Settings. Check "ollama ps" to see ` +
          `whether it is loaded and running on GPU or CPU.`
        );
      }
      if (controller.signal.aborted) throw new Error("Stopped.");
      throw new Error(
        `Cannot reach Ollama at ${host}. Is it running? ` +
        `Start it with "ollama serve", then "ollama pull ${model}". (${err.message})`
      );
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener?.("abort", forward);
    }

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      if (res.status === 404) {
        throw new Error(
          `Ollama has no model "${model}". Pull it first: ollama pull ${model}`
        );
      }
      // Ollama rejects unknown origins outright. From a browser extension this
      // is the default state, and the message it returns says nothing useful.
      if (res.status === 403) {
        throw new Error(
          `Ollama refused the request (403). It only accepts requests from ` +
          `origins in OLLAMA_ORIGINS, which does not include browser ` +
          `extensions by default. Set it and restart Ollama:\n` +
          `  setx OLLAMA_ORIGINS "chrome-extension://*"`
        );
      }
      throw new Error(`Ollama returned HTTP ${res.status}: ${body.slice(0, 300)}`);
    }

    const data = await res.json();
    const text = data?.message?.content;

    if (!text) {
      const thinking = data?.message?.thinking || "";
      if (thinking) {
        throw new Error(
          `${model} produced ${thinking.length} characters of reasoning but no ` +
          `answer — it ran out of output budget while thinking. Raise ` +
          `numPredict (currently ${numPredict}) or keep think:false.`
        );
      }
      throw new Error(
        `Ollama returned an empty message (done_reason: ${data?.done_reason || "unknown"}).`
      );
    }
    return text;
  };
}

export function makeBackend(name, options = {}) {
  if (name === "ollama") return ollamaBackend(options);
  throw new Error(`Unknown backend "${name}". Only "ollama" is supported — see translator-design.md §0.4.`);
}

/**
 * Models wrap JSON in prose or code fences no matter how firmly you ask them
 * not to. Recover the object rather than failing the whole chunk.
 */
export function parseJson(text, what = "response") {
  const attempts = [
    text,
    text.replace(/^[\s\S]*?```(?:json)?\s*/i, "").replace(/```[\s\S]*$/, ""),
  ];

  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first !== -1 && last > first) attempts.push(text.slice(first, last + 1));

  for (const candidate of attempts) {
    try {
      return JSON.parse(candidate.trim());
    } catch { /* try the next shape */ }
  }

  // Show the TAIL, not the head. These failures are nearly always a reply that
  // ran out of output budget, and the head looks perfectly healthy — it is the
  // end that reveals the cut.
  throw new Error(
    `Could not parse JSON from the ${what} (${text.length} chars). ` +
    `Last 200 characters:\n…${text.slice(-200)}`
  );
}
