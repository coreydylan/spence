/**
 * Client-side image resize helper.
 *
 * Uses an offscreen canvas (or a regular `<canvas>` if `OffscreenCanvas` is
 * unavailable) to downscale a captured photo before upload. Keeps the brigade
 * upload tight — vision doesn't need 12MP.
 *
 * Returns a fresh `Blob` with the requested mime + quality. Falls back to the
 * original file if anything goes wrong (better to upload a big photo than to
 * lose the moment).
 */
"use client";

export interface ResizeOptions {
  /** Hard cap on the longest edge in pixels. Default 1024. */
  maxEdge?: number;
  /** JPEG quality (0..1). Default 0.82. Ignored for PNG. */
  quality?: number;
  /** Output mime. Default "image/jpeg". */
  mime?: "image/jpeg" | "image/webp" | "image/png";
}

const DEFAULTS: Required<ResizeOptions> = {
  maxEdge: 1024,
  quality: 0.82,
  mime: "image/jpeg",
};

export async function resizeImage(
  file: File | Blob,
  options: ResizeOptions = {},
): Promise<Blob> {
  const opts = { ...DEFAULTS, ...options };
  try {
    const bitmap = await loadBitmap(file);
    const { width, height } = fitWithin(bitmap.width, bitmap.height, opts.maxEdge);
    if (width === bitmap.width && height === bitmap.height && file.size < 256_000) {
      // Already small; skip the round-trip.
      bitmap.close?.();
      return file;
    }
    const canvas = makeCanvas(width, height);
    const ctx = canvas.getContext("2d") as
      | CanvasRenderingContext2D
      | OffscreenCanvasRenderingContext2D
      | null;
    if (!ctx) {
      bitmap.close?.();
      return file;
    }
    ctx.drawImage(bitmap, 0, 0, width, height);
    bitmap.close?.();
    return await canvasToBlob(canvas, opts.mime, opts.quality);
  } catch {
    return file; // fail open
  }
}

async function loadBitmap(file: File | Blob): Promise<ImageBitmap> {
  // ImageBitmap is broadly supported on iOS Safari 15+ and all modern
  // Chromium / Firefox builds. Fall back to <img> + canvas otherwise.
  if (typeof createImageBitmap === "function") {
    try {
      return await createImageBitmap(file);
    } catch {
      // fall through
    }
  }
  return await loadViaImage(file);
}

function loadViaImage(file: File | Blob): Promise<ImageBitmap> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      // Fake an ImageBitmap-like with the fields we need.
      resolve({
        width: img.naturalWidth,
        height: img.naturalHeight,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        close() {},
        // The canvas accepts <img> directly via drawImage.
        // We exploit structural typing here.
        ...(img as unknown as object),
      } as unknown as ImageBitmap);
    };
    img.onerror = (err) => {
      URL.revokeObjectURL(url);
      reject(err);
    };
    img.src = url;
  });
}

function fitWithin(
  w: number,
  h: number,
  max: number,
): { width: number; height: number } {
  const longest = Math.max(w, h);
  if (longest <= max) return { width: w, height: h };
  const scale = max / longest;
  return {
    width: Math.round(w * scale),
    height: Math.round(h * scale),
  };
}

function makeCanvas(
  width: number,
  height: number,
): HTMLCanvasElement | OffscreenCanvas {
  if (typeof OffscreenCanvas !== "undefined") {
    return new OffscreenCanvas(width, height);
  }
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

async function canvasToBlob(
  canvas: HTMLCanvasElement | OffscreenCanvas,
  mime: string,
  quality: number,
): Promise<Blob> {
  if ("convertToBlob" in canvas) {
    return await canvas.convertToBlob({ type: mime, quality });
  }
  return await new Promise((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("canvas_to_blob_null"))),
      mime,
      quality,
    );
  });
}
