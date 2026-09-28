const $ = (id) => document.getElementById(id);
const status = $("status");

function setStatus(text, isError = false) {
  status.textContent = text;
  status.className = isError ? "error" : "";
}

$("translate").addEventListener("click", async () => {
  $("translate").disabled = true;
  setStatus("Extracting chapter and translating — this can take a minute or two on a full chapter…");

  const model = $("model").value.trim() || undefined;
  const res = await chrome.runtime.sendMessage({ type: "translate-active-tab", options: { model } });

  $("translate").disabled = false;
  if (!res?.ok) {
    setStatus(res?.error || "Something went wrong.", true);
    return;
  }
  setStatus("Opened in a new tab.");
});
