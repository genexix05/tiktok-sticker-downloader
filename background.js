import { isAnimatedStickerUrl, webpToGif } from "./lib/webp-to-gif.js";

function toGifFilename(filename) {
  if (!filename) return `tiktok-stickers/sticker-${Date.now()}.gif`;
  return filename
    .replace(/\.awebp$/i, ".gif")
    .replace(/\.webp$/i, ".gif")
    .replace(/\.(png|jpe?g)$/i, ".gif");
}

async function blobToObjectUrl(blob) {
  return URL.createObjectURL(blob);
}

async function downloadItem(item) {
  const url = item.url;
  const wantsGif = isAnimatedStickerUrl(url) || /\.gif$/i.test(item.filename || "");

  if (!wantsGif) {
    await chrome.downloads.download({
      url,
      filename: item.filename || undefined,
      saveAs: false,
      conflictAction: "uniquify",
    });
    return { converted: false };
  }

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  const buffer = await response.arrayBuffer();
  let blob;
  let filename = toGifFilename(item.filename);

  try {
    blob = await webpToGif(buffer);
  } catch (err) {
    console.warn("[TSD] conversión a GIF falló, descargo original", err);
    // Fallback: keep original bytes with .webp so it still opens
    blob = new Blob([buffer], { type: "image/webp" });
    filename = (item.filename || "sticker.webp")
      .replace(/\.awebp$/i, ".webp")
      .replace(/\.gif$/i, ".webp");
  }

  const objectUrl = await blobToObjectUrl(blob);
  try {
    await chrome.downloads.download({
      url: objectUrl,
      filename,
      saveAs: false,
      conflictAction: "uniquify",
    });
  } finally {
    setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
  }

  return { converted: blob.type === "image/gif" };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "DOWNLOAD_STICKERS") return false;

  const items = Array.isArray(message.items) ? message.items : [];
  if (!items.length) {
    sendResponse({ ok: false, error: "No hay stickers para descargar" });
    return true;
  }

  (async () => {
    let started = 0;
    let failed = 0;
    let converted = 0;

    for (const item of items) {
      try {
        const result = await downloadItem(item);
        started += 1;
        if (result.converted) converted += 1;
      } catch (err) {
        failed += 1;
        console.warn("[TSD] download failed", item.url, err);
      }
    }

    sendResponse({
      ok: started > 0,
      started,
      failed,
      converted,
      error: started === 0 ? "No se pudo iniciar ninguna descarga" : undefined,
    });
  })();

  return true;
});
