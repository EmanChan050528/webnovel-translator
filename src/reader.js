// The fallback reader view (Milestone 1's only output; becomes the
// Milestone 5 fallback for pages where in-place replacement isn't safe).

const params = new URLSearchParams(location.search);
const resultId = params.get("result");
const content = document.getElementById("content");

function paragraphEl(zh, en) {
  const p = document.createElement("p");
  p.className = "paragraph" + (en ? "" : " missing");
  const zhLine = document.createElement("div");
  zhLine.className = "zh";
  zhLine.textContent = zh;
  const enLine = document.createElement("div");
  enLine.className = "en";
  enLine.textContent = en || "[translation missing]";
  p.append(zhLine, enLine);
  return p;
}

async function load() {
  if (!resultId) {
    content.innerHTML = '<p class="empty">No result specified.</p>';
    return;
  }
  const key = `result:${resultId}`;
  const stored = (await chrome.storage.session.get(key))[key];
  if (!stored) {
    content.innerHTML = '<p class="empty">This result is no longer available — results are not kept across browser restarts yet (Milestone 4 adds a persistent cache).</p>';
    return;
  }

  const { chapter, translations, failures, translated, total } = stored;
  document.title = `${chapter.chapterTitle || "Chapter"} — Webnovel Translator`;
  document.getElementById("novelTitle").textContent = chapter.novelTitle || "";
  document.getElementById("chapterTitle").textContent = chapter.chapterTitle || "";
  document.getElementById("info").textContent = `${translated}/${total} paragraphs translated`;

  content.innerHTML = "";
  chapter.paragraphs.forEach((p, i) => {
    content.appendChild(paragraphEl(p.zh, translations[i]));
  });

  if (failures?.length) {
    const box = document.createElement("div");
    box.className = "failures";
    box.textContent = "Some paragraphs failed to translate:\n" + failures.join("\n");
    content.appendChild(box);
  }
}

document.getElementById("toggleOriginal").addEventListener("click", (e) => {
  const showing = document.body.classList.toggle("show-original");
  e.target.textContent = showing ? "Hide original" : "Show original";
});

load();
