async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function setStatus(text) {
  const el = document.getElementById("status");
  el.hidden = !text;
  el.textContent = text || "";
}

async function refresh() {
  const tab = await getActiveTab();
  const visible = document.getElementById("visible-count");
  const selected = document.getElementById("selected-count");
  const btnSelected = document.getElementById("download-selected");
  const btnVisible = document.getElementById("download-visible");

  if (!tab?.id || !tab.url || !/tiktok\.com/i.test(tab.url)) {
    visible.textContent = "0";
    selected.textContent = "0";
    btnSelected.disabled = true;
    btnVisible.disabled = true;
    setStatus("Abre un chat de TikTok para usar la extensión.");
    return;
  }

  try {
    const res = await chrome.tabs.sendMessage(tab.id, { type: "GET_STICKERS" });
    const count = res?.stickers?.length || 0;
    const selectedCount = res?.selectedCount || 0;

    visible.textContent = String(count);
    selected.textContent = String(selectedCount);
    btnVisible.disabled = count === 0;
    btnSelected.disabled = selectedCount === 0;
    setStatus(count === 0 ? "No se detectaron stickers en esta vista." : "");
  } catch {
    visible.textContent = "0";
    selected.textContent = "0";
    btnSelected.disabled = true;
    btnVisible.disabled = true;
    setStatus("Recarga la página de TikTok e inténtalo de nuevo.");
  }
}

document.getElementById("refresh").addEventListener("click", refresh);

document.getElementById("download-visible").addEventListener("click", async () => {
  const tab = await getActiveTab();
  if (!tab?.id) return;
  const res = await chrome.tabs.sendMessage(tab.id, { type: "DOWNLOAD_VISIBLE" });
  setStatus(`Descargando ${res?.count || 0} sticker(s)…`);
  refresh();
});

document.getElementById("download-selected").addEventListener("click", async () => {
  const tab = await getActiveTab();
  if (!tab?.id) return;
  const res = await chrome.tabs.sendMessage(tab.id, { type: "DOWNLOAD_SELECTED" });
  setStatus(`Descargando ${res?.count || 0} seleccionado(s)…`);
  refresh();
});

refresh();
