// GIF89a encoder + WebP animado → GIF (service worker / OffscreenCanvas)

function nearestColor(r, g, b, palette) {
  let best = 0;
  let bestDist = Infinity;
  for (let i = 0; i < palette.length; i++) {
    const pr = palette[i][0];
    const pg = palette[i][1];
    const pb = palette[i][2];
    const dr = r - pr;
    const dg = g - pg;
    const db = b - pb;
    const d = dr * dr + dg * dg + db * db;
    if (d < bestDist) {
      bestDist = d;
      best = i;
      if (d === 0) break;
    }
  }
  return best;
}

function quantizeRGBA(rgba, maxColors) {
  // Octree-ish via median cut on opaque pixels
  const points = [];
  for (let i = 0; i < rgba.length; i += 4) {
    if (rgba[i + 3] < 128) continue;
    points.push([rgba[i], rgba[i + 1], rgba[i + 2]]);
  }

  if (!points.length) {
    return { palette: [[0, 0, 0]], transparentIndex: 0 };
  }

  // Reserve 1 slot for transparency
  const colorLimit = Math.max(2, Math.min(255, maxColors));
  let boxes = [points];

  while (boxes.length < colorLimit) {
    boxes.sort((a, b) => b.length - a.length);
    const box = boxes.shift();
    if (!box || box.length < 2) {
      if (box) boxes.unshift(box);
      break;
    }

    let r0 = 255, r1 = 0, g0 = 255, g1 = 0, b0 = 255, b1 = 0;
    for (const [r, g, b] of box) {
      if (r < r0) r0 = r;
      if (r > r1) r1 = r;
      if (g < g0) g0 = g;
      if (g > g1) g1 = g;
      if (b < b0) b0 = b;
      if (b > b1) b1 = b;
    }

    const rr = r1 - r0;
    const gr = g1 - g0;
    const br = b1 - b0;
    const ch = rr >= gr && rr >= br ? 0 : gr >= br ? 1 : 2;
    box.sort((a, b) => a[ch] - b[ch]);
    const mid = (box.length / 2) | 0;
    boxes.push(box.slice(0, mid), box.slice(mid));
  }

  const palette = boxes.map((box) => {
    let r = 0, g = 0, b = 0;
    for (const p of box) {
      r += p[0];
      g += p[1];
      b += p[2];
    }
    const n = box.length;
    return [(r / n) | 0, (g / n) | 0, (b / n) | 0];
  });

  const transparentIndex = palette.length;
  palette.push([0, 0, 0]);
  return { palette, transparentIndex };
}

function indexWithTransparency(rgba, palette, transparentIndex) {
  const out = new Uint8Array(rgba.length / 4);
  for (let i = 0, p = 0; i < rgba.length; i += 4, p++) {
    if (rgba[i + 3] < 128) {
      out[p] = transparentIndex;
    } else {
      out[p] = nearestColor(rgba[i], rgba[i + 1], rgba[i + 2], palette);
    }
  }
  return out;
}

function padPalettePowerOfTwo(palette) {
  const n = Math.max(2, 2 ** Math.ceil(Math.log2(Math.max(2, palette.length))));
  const out = palette.slice();
  while (out.length < n) out.push([0, 0, 0]);
  return out;
}

// LZW based on the GIF89a spec (bit-packing little-endian within bytes)
function lzw(indexPixels, minCodeSize) {
  const clear = 1 << minCodeSize;
  const eoi = clear + 1;
  const output = [];

  let codeSize = minCodeSize + 1;
  let nextCode = eoi + 1;
  let prefix = -1;

  let cur = 0;
  let curBits = 0;

  const emit = (code) => {
    cur |= code << curBits;
    curBits += codeSize;
    while (curBits >= 8) {
      output.push(cur & 255);
      cur >>= 8;
      curBits -= 8;
    }
  };

  const reset = () => {
    // Map is rebuilt implicitly by clearing; we use a Map of "prefix,k" -> code
  };

  let table = new Map();
  const clearTable = () => {
    table = new Map();
    codeSize = minCodeSize + 1;
    nextCode = eoi + 1;
  };

  clearTable();
  emit(clear);

  for (let i = 0; i < indexPixels.length; i++) {
    const k = indexPixels[i];
    if (prefix < 0) {
      prefix = k;
      continue;
    }
    const key = prefix * 4096 + k;
    if (table.has(key)) {
      prefix = table.get(key);
      continue;
    }

    emit(prefix);

    if (nextCode < 4096) {
      table.set(key, nextCode);
      if (nextCode === (1 << codeSize) && codeSize < 12) {
        codeSize += 1;
      }
      nextCode += 1;
    } else {
      emit(clear);
      clearTable();
    }
    prefix = k;
  }

  if (prefix >= 0) emit(prefix);
  emit(eoi);
  if (curBits > 0) output.push(cur & 255);
  return Uint8Array.from(output);
}

function writeGif(frames, width, height) {
  const bytes = [];
  const w8 = (v) => bytes.push(v & 255);
  const w16 = (v) => {
    bytes.push(v & 255, (v >> 8) & 255);
  };
  const wstr = (s) => {
    for (let i = 0; i < s.length; i++) bytes.push(s.charCodeAt(i));
  };

  // First frame defines global palette
  const firstQ = quantizeRGBA(frames[0].rgba, 255);
  const gPalette = padPalettePowerOfTwo(firstQ.palette);
  const gctSize = Math.log2(gPalette.length) - 1;

  wstr("GIF89a");
  w16(width);
  w16(height);
  w8(0x80 | gctSize); // GCT
  w8(firstQ.transparentIndex & 255); // bg = transparent
  w8(0);

  for (let i = 0; i < gPalette.length; i++) {
    const c = gPalette[i] || [0, 0, 0];
    w8(c[0]);
    w8(c[1]);
    w8(c[2]);
  }

  // Netscape loop forever
  w8(0x21);
  w8(0xff);
  w8(0x0b);
  wstr("NETSCAPE2.0");
  w8(3);
  w8(1);
  w16(0);
  w8(0);

  for (let f = 0; f < frames.length; f++) {
    const frame = frames[f];
    // Per-frame palette for better quality on stickers
    const q = f === 0 ? firstQ : quantizeRGBA(frame.rgba, 255);
    const palette = padPalettePowerOfTwo(q.palette);
    const transparentIndex = q.transparentIndex;
    const indexed = indexWithTransparency(frame.rgba, palette, transparentIndex);
    const delayCs = Math.max(2, Math.round((frame.delayMs || 100) / 10));

    // Graphic Control
    w8(0x21);
    w8(0xf9);
    w8(4);
    // disposal=2 (restore bg), transparency on
    w8(0x08 | 0x01);
    w16(delayCs);
    w8(transparentIndex & 255);
    w8(0);

    // Image descriptor + local color table
    w8(0x2c);
    w16(0);
    w16(0);
    w16(width);
    w16(height);
    const lctSize = Math.log2(palette.length) - 1;
    w8(0x80 | lctSize);

    for (let i = 0; i < palette.length; i++) {
      const c = palette[i] || [0, 0, 0];
      w8(c[0]);
      w8(c[1]);
      w8(c[2]);
    }

    const minCodeSize = Math.max(2, Math.ceil(Math.log2(palette.length)));
    w8(minCodeSize);
    const compressed = lzw(indexed, minCodeSize);
    for (let i = 0; i < compressed.length; ) {
      const size = Math.min(255, compressed.length - i);
      w8(size);
      for (let j = 0; j < size; j++) w8(compressed[i + j]);
      i += size;
    }
    w8(0);
  }

  w8(0x3b);
  return new Uint8Array(bytes);
}

function isAnimatedStickerUrl(url) {
  return /\.awebp(\?|#|$)/i.test(url || "");
}

function isWebpMagic(bytes) {
  return (
    bytes &&
    bytes.length > 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45
  );
}

async function decodeWebpFrames(arrayBuffer) {
  if (typeof ImageDecoder === "undefined") {
    throw new Error("ImageDecoder no disponible");
  }

  const decoder = new ImageDecoder({
    data: arrayBuffer,
    type: "image/webp",
  });

  // Crucial: without this, frameCount often stays at 1 → “foto fija”
  await decoder.tracks.ready;
  try {
    await decoder.completed;
  } catch (_) {
    /* algunos builds no exponen completed */
  }

  const track = decoder.tracks.selectedTrack;
  let frameCount = track?.frameCount || 1;

  // Si aún reporta 1, intentar leer frames hasta que falle
  const frames = [];
  let width = 0;
  let height = 0;

  // Canvas acumulativo por si algún frame es diferencial
  let baseCtx = null;

  const maxFrames = Math.max(frameCount, 1);
  let i = 0;
  while (i < Math.max(maxFrames, 500)) {
    let image;
    try {
      ({ image } = await decoder.decode({ frameIndex: i }));
    } catch (err) {
      if (i === 0) throw err;
      break;
    }

    width = image.displayWidth || image.codedWidth || width;
    height = image.displayHeight || image.codedHeight || height;

    if (!baseCtx) {
      const canvas = new OffscreenCanvas(width, height);
      baseCtx = canvas.getContext("2d", { willReadFrequently: true, alpha: true });
    }

    // Limpiar y dibujar el frame decodificado (ImageDecoder ya compone en la mayoría de casos)
    baseCtx.clearRect(0, 0, width, height);
    baseCtx.drawImage(image, 0, 0);

    const { data } = baseCtx.getImageData(0, 0, width, height);
    // duration en microsegundos
    const delayMs = image.duration ? Math.max(20, image.duration / 1000) : 80;
    frames.push({ rgba: new Uint8ClampedArray(data), delayMs });
    image.close();
    i += 1;

    // Si track decía N y ya los tenemos, paramos
    if (frameCount > 1 && i >= frameCount) break;
  }

  decoder.close();
  return { frames, width, height };
}

async function webpToGif(arrayBuffer) {
  const { frames, width, height } = await decodeWebpFrames(arrayBuffer);
  if (!frames.length) throw new Error("Sin frames");
  if (frames.length < 2) {
    const err = new Error("WEBP_SINGLE_FRAME");
    err.frameCount = 1;
    throw err;
  }
  const bytes = writeGif(frames, width, height);
  return new Blob([bytes], { type: "image/gif" });
}
