importScripts("lib/webp-to-gif.js");

function safeFilename(name) {
  return String(name || "sticker.webp")
    .replace(/[<>:"|?*\\]/g, "_")
    .replace(/\s+/g, "_");
}

function u8ToBase64(u8) {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < u8.length; i += chunk) {
    binary += String.fromCharCode.apply(null, u8.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function base64ToU8(base64) {
  const binary = atob(base64);
  const u8 = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) u8[i] = binary.charCodeAt(i);
  return u8;
}

async function fetchStickerBytes(url) {
  const response = await fetch(url, {
    method: "GET",
    credentials: "omit",
    cache: "no-cache",
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} al pedir el sticker`);
  return new Uint8Array(await response.arrayBuffer());
}

async function downloadDataUrl(dataUrl, filename) {
  const id = await chrome.downloads.download({
    url: dataUrl,
    filename: safeFilename(filename),
    saveAs: false,
    conflictAction: "uniquify",
  });
  if (typeof id !== "number") throw new Error("Chrome no inició la descarga");
  return id;
}

function asBuffer(u8) {
  return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
}

async function downloadItem(item) {
  const url = item.url;
  if (!url && !item.base64) throw new Error("URL vacía");

  const animated = isAnimatedStickerUrl(url) || item.animated === true;

  let bytes = null;
  if (item.base64 && item.mime !== "image/png") {
    // Nunca aceptar PNG estático como fuente de un awebp
    bytes = base64ToU8(item.base64);
  } else if (url) {
    bytes = await fetchStickerBytes(url);
  } else {
    throw new Error("No hay bytes del sticker animado (evitado PNG estático)");
  }

  // Si el content script mandó PNG por error en un animado, refetch
  if (animated && item.mime === "image/png") {
    bytes = await fetchStickerBytes(url);
  }

  let filename = safeFilename(
    item.filename || `tiktok-stickers/sticker-${Date.now()}.webp`
  );
  let mime = "image/webp";

  if (animated || isWebpMagic(bytes)) {
    if (animated) {
      try {
        const gifBlob = await webpToGif(asBuffer(bytes));
        bytes = new Uint8Array(await gifBlob.arrayBuffer());
        mime = "image/gif";
        filename = filename
          .replace(/\.awebp$/i, ".gif")
          .replace(/\.webp$/i, ".gif")
          .replace(/\.png$/i, ".gif");
        if (!/\.gif$/i.test(filename)) filename += ".gif";
      } catch (err) {
        // Si solo hay 1 frame o falla el encoder: guardar WebP ANIMADO original
        // (no una foto). Chrome/Telegram/WhatsApp lo reproducen.
        console.warn("[TSD] GIF no disponible, guardo webp animado original", err);
        mime = "image/webp";
        filename = filename
          .replace(/\.gif$/i, ".webp")
          .replace(/\.awebp$/i, ".webp")
          .replace(/\.png$/i, ".webp");
        if (!/\.webp$/i.test(filename)) filename += ".webp";
      }
    } else {
      mime = "image/webp";
      if (!/\.(webp|png|jpe?g|gif)$/i.test(filename)) filename += ".webp";
    }
  } else if (/\.png$/i.test(filename) || item.mime === "image/png") {
    mime = "image/png";
  }

  await downloadDataUrl(`data:${mime};base64,${u8ToBase64(bytes)}`, filename);
  return { converted: mime === "image/gif", mime };
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
    const errors = [];

    for (const item of items) {
      try {
        const result = await downloadItem(item);
        started += 1;
        if (result.converted) converted += 1;
      } catch (err) {
        failed += 1;
        errors.push(err?.message || String(err));
        console.warn("[TSD] download failed", item.url, err);
      }
    }

    sendResponse({
      ok: started > 0,
      started,
      failed,
      converted,
      error:
        started === 0
          ? errors[0] || "No se pudo iniciar ninguna descarga"
          : failed
            ? `${started} ok, ${failed} fallaron`
            : undefined,
    });
  })();

  return true;
});
