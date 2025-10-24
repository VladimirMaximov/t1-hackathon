// TFJS runtime only (без mediapipe).
// Автовыбор backend: webgpu → wasm → webgl.
// Опционально: локальный modelUrl и локальный wasmPath через window-переменные.
//
// (необязательно) До инициализации можно указать:
//   (window as any).__SELFIE_TFJS_MODEL_URL__ = '/models/selfie/tfjs/general/model.json'
//   (window as any).__TFJS_WASM_PATH__        = '/tfjs/wasm/'   // если кладёшь *.wasm локально

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
  preferBackends?: TfjsBackend[];   // по умолчанию ['webgpu','wasm','webgl']
  wasmPath?: string;                 // путь к *.wasm (если хочешь локально)
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
  modelType?: 'general' | 'landscape'; // по умолчанию 'general'
  /** Абсолютный или относительный URL до model.json (локально в /public или CDN). */
  modelUrl?: string;
  backend?: TfjsBackend;               // если хочешь жёстко зафиксировать
}

/** Создание сегментера Selfie Segmentation в runtime 'tfjs'. */
export async function createSelfieSegmenterTFJS(
  opts: CreateSelfieTfjsOptions = {}
): Promise<{ segmenter: BodySegmenter; backendLabel: TfjsBackend }> {
  const model = bodySegmentation.SupportedModels.MediaPipeSelfieSegmentation;

  // 1) выбираем/включаем TFJS-бэкенд
  const be = opts.backend ?? await pickTfjsBackend();

  // 2) конфиг сегментера
  const g: any = globalThis as any;
  const cfg: any = {
    runtime: 'tfjs',
    modelType: opts.modelType ?? 'general',
  };

  // приоритет: явный opts.modelUrl → window.__SELFIE_TFJS_MODEL_URL__ → дефолтный CDN-путь либы
  const explicit = opts.modelUrl ?? g?.__SELFIE_TFJS_MODEL_URL__;
  if (explicit) cfg.modelUrl = explicit;

  const segmenter = await bodySegmentation.createSegmenter(model, cfg);
  return { segmenter, backendLabel: be };
}

/**
 * Безопасная бинарная маска.
 * Любые сбои/некорректные размеры → прозрачная маска fallback-размера.
 */
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

/** Рисует картинку «как cover». */
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
