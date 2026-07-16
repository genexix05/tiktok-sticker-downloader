(() => {
  const SELECTED = new Set();
  const PROCESSED = new WeakSet();
  let toolbar = null;

  function isStickerImg(img) {
    if (!(img instanceof HTMLImageElement)) return false;
    if (!img.src) return false;

    const alt = (img.alt || "").toLowerCase();
    const cls = img.className || "";
    const inStickerContainer = Boolean(
      img.closest('[class*="DivStickerContainer"], [class*="StickerContainer"]')
    );

    const looksLikeSticker =
      alt === "sticker" ||
      cls.includes("StickerImage") ||
      inStickerContainer;

    const looksLikeCdn =
      /tiktokcdn|ibyteimg|byteimg|tiktok-dm-sticker|gi79ffmtaw|dhq7zx4c1p/i.test(
        img.src
      );

    return looksLikeSticker && looksLikeCdn;
  }

  function filenameFromUrl(url, index = 0) {
    try {
      const path = new URL(url).pathname;
      const base = path.split("/").pop() || `sticker-${index}`;
      const clean = (base.split("~")[0] || base).replace(
        /\.(awebp|webp|png|jpe?g|gif)$/i,
        ""
      );
      const isAnimated = /\.awebp(\?|#|$)/i.test(url) || /\.awebp$/i.test(path);
      return `${clean || `sticker-${index}`}.${isAnimated ? "gif" : "webp"}`;
    } catch {
      return `tiktok-sticker-${Date.now()}-${index}.webp`;
    }
  }

  function u8ToBase64(u8) {
    let binary = "";
    const chunk = 0x8000;
    for (let i = 0; i < u8.length; i += chunk) {
      binary += String.fromCharCode.apply(null, u8.subarray(i, i + chunk));
    }
    return btoa(binary);
  }

  async function readBytesFromUrl(url) {
    const animated = /\.awebp(\?|#|$)/i.test(url);

    // 1) Fetch real bytes (necesario para animación)
    try {
      const res = await fetch(url, {
        credentials: "include",
        cache: "force-cache",
      });
      if (res.ok) {
        return {
          bytes: new Uint8Array(await res.arrayBuffer()),
          mime: res.headers.get("content-type") || "image/webp",
          animated,
        };
      }
    } catch (_) {
      /* continue */
    }

    try {
      const res = await fetch(url, { credentials: "omit", cache: "no-cache" });
      if (res.ok) {
        return {
          bytes: new Uint8Array(await res.arrayBuffer()),
          mime: res.headers.get("content-type") || "image/webp",
          animated,
        };
      }
    } catch (_) {
      /* continue */
    }

    // 2) Canvas SOLO para estáticos. Nunca para awebp (perdería la animación).
    if (animated) {
      return { bytes: null, mime: null, animated: true };
    }

    const img = [...document.images].find(
      (el) => (el.currentSrc || el.src) === url
    );
    if (img && img.naturalWidth) {
      try {
        const canvas = document.createElement("canvas");
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0);
        const dataUrl = canvas.toDataURL("image/png");
        const base64 = dataUrl.split(",")[1];
        const binary = atob(base64);
        const u8 = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) u8[i] = binary.charCodeAt(i);
        return { bytes: u8, mime: "image/png", animated: false };
      } catch (_) {
        /* tainted canvas */
      }
    }

    return null;
  }

  async function downloadUrls(urls) {
    const unique = [...new Set(urls)].filter(Boolean);
    if (!unique.length) return;

    flashToolbar("Preparando descarga…");

    const items = [];
    for (let i = 0; i < unique.length; i++) {
      const url = unique[i];
      const animated = /\.awebp(\?|#|$)/i.test(url);
      let filename = `tiktok-stickers/${filenameFromUrl(url, i)}`;
      const got = await readBytesFromUrl(url);

      // No renombrar animados a PNG
      if (got?.mime === "image/png" && !animated) {
        filename = filename.replace(/\.(gif|webp)$/i, ".png");
      }

      items.push({
        url,
        filename,
        mime: got?.mime,
        animated: animated || got?.animated || false,
        base64:
          got?.bytes && got.mime !== "image/png"
            ? u8ToBase64(got.bytes)
            : got?.bytes && !animated
              ? u8ToBase64(got.bytes)
              : undefined,
      });
    }

    chrome.runtime.sendMessage({ type: "DOWNLOAD_STICKERS", items }, (res) => {
      if (chrome.runtime.lastError) {
        flashToolbar(
          chrome.runtime.lastError.message ||
            "Error de extensión (recarga la extensión y la pestaña)"
        );
        return;
      }
      if (res?.ok) {
        flashToolbar(
          res.converted
            ? `Listo: ${res.converted} GIF animado(s)`
            : `Listo: ${res.started} descargado(s)`
        );
      } else {
        flashToolbar(res?.error || "Error al descargar");
      }
    });
  }

  function ensureToolbar() {
    if (toolbar) return toolbar;

    toolbar = document.createElement("div");
    toolbar.id = "tsd-toolbar";
    toolbar.innerHTML = `
      <div class="tsd-toolbar-inner">
        <span class="tsd-count">0 seleccionados</span>
        <button type="button" class="tsd-btn tsd-download-selected" disabled>Descargar</button>
        <button type="button" class="tsd-btn tsd-download-all">Descargar visibles</button>
        <button type="button" class="tsd-btn tsd-clear" disabled>Limpiar</button>
      </div>
      <div class="tsd-flash" hidden></div>
    `;
    document.documentElement.appendChild(toolbar);

    toolbar.querySelector(".tsd-download-selected").addEventListener("click", () => {
      downloadUrls([...SELECTED]);
    });

    toolbar.querySelector(".tsd-download-all").addEventListener("click", () => {
      downloadUrls(findStickerImages().map((img) => img.currentSrc || img.src));
    });

    toolbar.querySelector(".tsd-clear").addEventListener("click", () => {
      SELECTED.clear();
      document.querySelectorAll(".tsd-host.tsd-selected").forEach((el) => {
        el.classList.remove("tsd-selected");
        const cb = el.querySelector(".tsd-check");
        if (cb) cb.checked = false;
      });
      updateToolbar();
    });

    return toolbar;
  }

  function flashToolbar(message) {
    const flash = ensureToolbar().querySelector(".tsd-flash");
    flash.hidden = false;
    flash.textContent = message;
    clearTimeout(flash._timer);
    flash._timer = setTimeout(() => {
      flash.hidden = true;
    }, 3500);
  }

  function updateToolbar() {
    ensureToolbar();
    const n = SELECTED.size;
    toolbar.querySelector(".tsd-count").textContent =
      n === 1 ? "1 seleccionado" : `${n} seleccionados`;
    toolbar.querySelector(".tsd-download-selected").disabled = n === 0;
    toolbar.querySelector(".tsd-clear").disabled = n === 0;
    toolbar.classList.add("tsd-visible");
  }

  function findStickerImages() {
    return [
      ...document.querySelectorAll(
        'img[alt="sticker"], img[class*="StickerImage"], [class*="DivStickerContainer"] img'
      ),
    ].filter(isStickerImg);
  }

  function getHost(img) {
    return (
      img.closest('[class*="DivStickerContainer"], [class*="StickerContainer"]') ||
      img.parentElement
    );
  }

  function decorate(img) {
    if (PROCESSED.has(img) || !isStickerImg(img)) return;

    const host = getHost(img);
    if (!host) return;

    PROCESSED.add(img);

    if (host.querySelector(":scope > .tsd-overlay")) return;

    const style = getComputedStyle(host);
    if (style.position === "static") {
      host.style.position = "relative";
    }
    host.classList.add("tsd-host");

    const url = () => img.currentSrc || img.src;

    const overlay = document.createElement("div");
    overlay.className = "tsd-overlay";

    const check = document.createElement("input");
    check.type = "checkbox";
    check.className = "tsd-check";
    check.title = "Seleccionar sticker";
    check.checked = SELECTED.has(url());
    if (check.checked) host.classList.add("tsd-selected");

    check.addEventListener("click", (e) => e.stopPropagation());
    check.addEventListener("change", () => {
      const src = url();
      if (check.checked) {
        SELECTED.add(src);
        host.classList.add("tsd-selected");
      } else {
        SELECTED.delete(src);
        host.classList.remove("tsd-selected");
      }
      updateToolbar();
    });

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "tsd-dl";
    btn.title = "Descargar sticker";
    btn.setAttribute("aria-label", "Descargar sticker");
    btn.innerHTML = `
      <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
        <path fill="currentColor" d="M12 3a1 1 0 0 1 1 1v9.59l2.3-2.3a1 1 0 1 1 1.4 1.42l-4 4a1 1 0 0 1-1.4 0l-4-4a1 1 0 1 1 1.4-1.42L11 13.59V4a1 1 0 0 1 1-1Zm-7 14a1 1 0 0 1 1 1v1h12v-1a1 1 0 1 1 2 0v2a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-2a1 1 0 0 1 1-1Z"/>
      </svg>
    `;
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      downloadUrls([url()]);
    });

    overlay.appendChild(check);
    overlay.appendChild(btn);
    host.appendChild(overlay);
    updateToolbar();
  }

  function scan() {
    findStickerImages().forEach(decorate);
  }

  function start() {
    ensureToolbar();
    scan();

    const observer = new MutationObserver(() => scan());
    observer.observe(document.body, { childList: true, subtree: true });

    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if (msg?.type === "GET_STICKERS") {
        const stickers = findStickerImages().map((img, i) => {
          const src = img.currentSrc || img.src;
          return {
            url: src,
            filename: filenameFromUrl(src, i),
            selected: SELECTED.has(src),
          };
        });
        sendResponse({ stickers, selectedCount: SELECTED.size });
        return true;
      }
      if (msg?.type === "DOWNLOAD_VISIBLE") {
        const urls = findStickerImages().map((img) => img.currentSrc || img.src);
        downloadUrls(urls);
        sendResponse({ ok: true, count: urls.length });
        return true;
      }
      if (msg?.type === "DOWNLOAD_SELECTED") {
        downloadUrls([...SELECTED]);
        sendResponse({ ok: true, count: SELECTED.size });
        return true;
      }
      return false;
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
})();
