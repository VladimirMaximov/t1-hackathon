import * as tf from '@tensorflow/tfjs-core';
import '@tensorflow/tfjs-converter';
import '@tensorflow/tfjs-backend-webgpu';
import '@tensorflow/tfjs-backend-webgl';
import '@tensorflow/tfjs-backend-wasm';
import { setWasmPaths } from '@tensorflow/tfjs-backend-wasm';

import * as bodySegmentation from '@tensorflow-models/body-segmentation';
import type { BodySegmenter } from '@tensorflow-models/body-segmentation';

export type TfjsBackend = 'webgpu' | 'wasm' | 'webgl';

export interface BackendOptions {
  preferBackends?: TfjsBackend[];
  wasmPath?: string;
}

export async function pickTfjsBackend(opts: BackendOptions = {}): Promise<TfjsBackend> {
  const prefer = opts.preferBackends ?? ['webgpu', 'wasm', 'webgl'];

  const g: any = globalThis as any;
  const wasmPath = opts.wasmPath ?? g?.__TFJS_WASM_PATH__;
  if (wasmPath) setWasmPaths(wasmPath);
  else setWasmPaths('https://cdn.jsdelivr.net/npm/@tensorflow/tfjs-backend-wasm/dist/');

  const trySet = async (name: TfjsBackend) => {
    try { await tf.setBackend(name); await tf.ready(); return true; } catch { return false; }
  };

  for (const b of prefer) {
    if (b === 'webgpu' && !('gpu' in navigator)) continue;
    if (await trySet(b)) return b;
  }
  await tf.setBackend('webgl'); await tf.ready(); return 'webgl';
}

export interface CreateSelfieTfjsOptions {
  modelType?: 'general' | 'landscape';
  modelUrl?: string;
  backend?: TfjsBackend;
}

export async function createSelfieSegmenterTFJS(
  opts: CreateSelfieTfjsOptions = {}
): Promise<{ segmenter: BodySegmenter; backendLabel: TfjsBackend }> {
  const model = bodySegmentation.SupportedModels.MediaPipeSelfieSegmentation;

  const be = opts.backend ?? await pickTfjsBackend();

  const g: any = globalThis as any;
  const cfg: any = {
    runtime: 'tfjs',
    modelType: opts.modelType ?? 'general',
  };

  const explicit = opts.modelUrl ?? g?.__SELFIE_TFJS_MODEL_URL__;
  if (explicit) cfg.modelUrl = explicit;

  const segmenter = await bodySegmentation.createSegmenter(model, cfg);
  return { segmenter, backendLabel: be };
}

export async function makeBinaryMask(
  segmentations: unknown[] | null | undefined,
  threshold: number,
  fallbackSize: { width: number; height: number }
): Promise<ImageData> {
  const makeClear = () => new ImageData(fallbackSize.width, fallbackSize.height);
  if (!segmentations || (Array.isArray(segmentations) && segmentations.length === 0)) return makeClear();

  const fg = { r: 255, g: 255, b: 255, a: 255 };
  const bg = { r: 0, g: 0, b: 0, a: 0 };

  try {
    const img: ImageData = await (bodySegmentation as any).toBinaryMask(
      segmentations as any, fg, bg, false, threshold
    );
    if (!img || !img.width || !img.height || !Number.isFinite(img.width) || !Number.isFinite(img.height)) {
      return makeClear();
    }
    return img;
  } catch {
    return makeClear();
  }
}

export function drawCover(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement,
  dstW: number,
  dstH: number
) {
  const iw = img.naturalWidth || img.width;
  const ih = img.naturalHeight || img.height;
  if (!iw || !ih) return;
  const scale = Math.max(dstW / iw, dstH / ih);
  const sw = iw * scale, sh = ih * scale;
  const dx = (dstW - sw) / 2, dy = (dstH - sh) / 2;
  ctx.drawImage(img, dx, dy, sw, sh);
}
