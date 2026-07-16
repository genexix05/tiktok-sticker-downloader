// Minimal GIF89a encoder for animated stickers (Chrome SW + OffscreenCanvas).

function colorDistance(a, b) {
  const dr = a[0] - b[0];
  const dg = a[1] - b[1];
  const db = a[2] - b[2];
  return dr * dr + dg * dg + db * db;
}

function quantize(rgba, maxColors = 255) {
  const pixels = [];
  for (let i = 0; i < rgba.length; i += 4) {
    if (rgba[i + 3] < 128) continue;
    pixels.push([rgba[i], rgba[i + 1], rgba[i + 2]]);
  }

  if (!pixels.length) {
    return { palette: [[0, 0, 0], [0, 0, 0]], transparentIndex: 1 };
  }

  let buckets = [pixels];
  while (buckets.length < maxColors) {
    buckets.sort((a, b) => b.length - a.length);
    const bucket = buckets.shift();
    if (!bucket || bucket.length < 2) {
      if (bucket) buckets.unshift(bucket);
      break;
    }

    let rMin = 255,
      rMax = 0,
      gMin = 255,
      gMax = 0,
      bMin = 255,
      bMax = 0;
    for (const [r, g, b] of bucket) {
      if (r < rMin) rMin = r;
      if (r > rMax) rMax = r;
      if (g < gMin) gMin = g;
      if (g > gMax) gMax = g;
      if (b < bMin) bMin = b;
      if (b > bMax) bMax = b;
    }

    const rRange = rMax - rMin;
    const gRange = gMax - gMin;
    const bRange = bMax - bMin;
    const channel =
      rRange >= gRange && rRange >= bRange ? 0 : gRange >= bRange ? 1 : 2;

    bucket.sort((a, b) => a[channel] - b[channel]);
    const mid = Math.floor(bucket.length / 2);
    buckets.push(bucket.slice(0, mid), bucket.slice(mid));
  }

  const palette = buckets.map((bucket) => {
    let r = 0,
      g = 0,
      b = 0;
    for (const p of bucket) {
      r += p[0];
      g += p[1];
      b += p[2];
    }
    const n = bucket.length || 1;
    return [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
  });

  const transparentIndex = palette.length;
  palette.push([0, 0, 0]);
  return { palette, transparentIndex };
}

function applyPalette(rgba, palette, transparentIndex) {
  const index = new Uint8Array(rgba.length / 4);
  for (let i = 0, p = 0; i < rgba.length; i += 4, p++) {
    if (rgba[i + 3] < 128) {
      index[p] = transparentIndex;
      continue;
    }
    const pixel = [rgba[i], rgba[i + 1], rgba[i + 2]];
    let best = 0;
    let bestDist = Infinity;
    for (let c = 0; c < palette.length; c++) {
      if (c === transparentIndex) continue;
      const d = colorDistance(pixel, palette[c]);
      if (d < bestDist) {
        bestDist = d;
        best = c;
        if (d === 0) break;
      }
    }
    index[p] = best;
  }
  return index;
}

function lzwEncode(indexStream, minCodeSize) {
  const clearCode = 1 << minCodeSize;
  const eoiCode = clearCode + 1;

  const out = [];
  let codeSize = minCodeSize + 1;
  let nextCode = eoiCode + 1;
  let bitBuffer = 0;
  let bitCount = 0;

  const writeCode = (code) => {
    bitBuffer |= code << bitCount;
    bitCount += codeSize;
    while (bitCount >= 8) {
      out.push(bitBuffer & 0xff);
      bitBuffer >>= 8;
      bitCount -= 8;
    }
  };

  const makeDict = () => {
    const dict = new Map();
    for (let i = 0; i < clearCode; i++) dict.set(String.fromCharCode(i), i);
    return dict;
  };

  let dict = makeDict();
  writeCode(clearCode);

  let w = String.fromCharCode(indexStream[0]);
  for (let i = 1; i < indexStream.length; i++) {
    const k = String.fromCharCode(indexStream[i]);
    const wk = w + k;
    if (dict.has(wk)) {
      w = wk;
      continue;
    }

    writeCode(dict.get(w));

    if (nextCode < 4096) {
      dict.set(wk, nextCode);
      if (nextCode === 1 << codeSize && codeSize < 12) codeSize += 1;
      nextCode += 1;
    } else {
      writeCode(clearCode);
      dict = makeDict();
      codeSize = minCodeSize + 1;
      nextCode = eoiCode + 1;
    }
    w = k;
  }

  writeCode(dict.get(w));
  writeCode(eoiCode);
  if (bitCount > 0) out.push(bitBuffer & 0xff);
  return Uint8Array.from(out);
}

function buildGif(frames, width, height) {
  // Sample colors from every frame so animation keeps a good palette
  const sample = [];
  for (let f = 0; f < frames.length; f += 1) {
    const rgba = frames[f].rgba;
    // subsample pixels for speed
    for (let i = 0; i < rgba.length; i += 4 * 2) {
      sample.push(rgba[i], rgba[i + 1], rgba[i + 2], rgba[i + 3]);
    }
  }
  const { palette, transparentIndex } = quantize(Uint8ClampedArray.from(sample), 255);
  const colorCount = Math.max(2, 2 ** Math.ceil(Math.log2(Math.max(2, palette.length))));
  while (palette.length < colorCount) palette.push([0, 0, 0]);

  const gctSize = Math.log2(colorCount) - 1;
  const bytes = [];
  const pushStr = (s) => {
    for (let i = 0; i < s.length; i++) bytes.push(s.charCodeAt(i));
  };
  const push16 = (n) => {
    bytes.push(n & 0xff, (n >> 8) & 0xff);
  };

  pushStr("GIF89a");
  push16(width);
  push16(height);
  bytes.push(0x80 | (gctSize & 7));
  bytes.push(0);
  bytes.push(0);

  for (let i = 0; i < colorCount; i++) {
    const c = palette[i] || [0, 0, 0];
    bytes.push(c[0], c[1], c[2]);
  }

  // Loop forever
  bytes.push(0x21, 0xff, 0x0b);
  pushStr("NETSCAPE2.0");
  bytes.push(0x03, 0x01, 0x00, 0x00, 0x00);

  const minCodeSize = Math.max(2, Math.ceil(Math.log2(colorCount)));

  for (const frame of frames) {
    const delayCs = Math.max(2, Math.round((frame.delayMs || 100) / 10));
    const index = applyPalette(frame.rgba, palette, transparentIndex);

    bytes.push(0x21, 0xf9, 0x04);
    bytes.push(0x09); // dispose to background + transparency
    push16(delayCs);
    bytes.push(transparentIndex & 0xff);
    bytes.push(0x00);

    bytes.push(0x2c);
    push16(0);
    push16(0);
    push16(width);
    push16(height);
    bytes.push(0x00);

    bytes.push(minCodeSize);
    const compressed = lzwEncode(index, minCodeSize);
    for (let i = 0; i < compressed.length; i += 255) {
      const chunk = compressed.subarray(i, Math.min(i + 255, compressed.length));
      bytes.push(chunk.length);
      for (let j = 0; j < chunk.length; j++) bytes.push(chunk[j]);
    }
    bytes.push(0x00);
  }

  bytes.push(0x3b);
  return new Uint8Array(bytes);
}

export function isAnimatedStickerUrl(url) {
  return /\.awebp(\?|#|$)/i.test(url);
}

export async function webpToGif(arrayBuffer) {
  if (typeof ImageDecoder === "undefined") {
    throw new Error("ImageDecoder no disponible en este Chrome");
  }

  const decoder = new ImageDecoder({ data: arrayBuffer, type: "image/webp" });
  await decoder.decode({ frameIndex: 0 });
  const frameCount = decoder.tracks.selectedTrack?.frameCount || 1;

  const frames = [];
  let width = 0;
  let height = 0;

  for (let i = 0; i < frameCount; i++) {
    const { image } = await decoder.decode({ frameIndex: i });
    width = image.displayWidth || image.codedWidth;
    height = image.displayHeight || image.codedHeight;

    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.clearRect(0, 0, width, height);
    ctx.drawImage(image, 0, 0);
    const { data } = ctx.getImageData(0, 0, width, height);

    const delayMs = image.duration ? image.duration / 1000 : 100;
    frames.push({ rgba: new Uint8ClampedArray(data), delayMs });
    image.close();
  }

  decoder.close();
  if (!frames.length) throw new Error("Sin frames");

  return new Blob([buildGif(frames, width, height)], { type: "image/gif" });
}
