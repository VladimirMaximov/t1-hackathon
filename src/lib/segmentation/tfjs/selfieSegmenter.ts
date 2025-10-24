// MediaPipe Selfie Segmentation (runtime: 'mediapipe') — «как в чистом файле».
// Никакого TFJS-графа/GraphModel: только mediapipe-ассеты.
// Если нужен локальный путь — задай до инициализации:
//   (window as any).__MP_SOLUTION_PATH__ = '/mediapipe/selfie_segmentation';
//
// Экспорт:
//   - createSelfieSegmenterMP(): Promise<{ segmenter, backendLabel: 'mediapipe' }>
//   - makeBinaryMask(...): безопасная бинарная маска с fallback
//   - drawCover(ctx, img, w, h): отрисовка фон-картинки как CSS background-size: cover

import * as bodySegmentation from '@tensorflow-models/body-segmentation';
import type { BodySegmenter } from '@tensorflow-models/body-segmentation';

/** Создать сегментер на runtime 'mediapipe' с явным solutionPath. */
export async function createSelfieSegmenterMP(): Promise<{
  segmenter: BodySegmenter;
  backendLabel: 'mediapipe';
}> {
  const model = bodySegmentation.SupportedModels.MediaPipeSelfieSegmentation;

  const globalAny = globalThis as any;
  const solutionPath: string =
    (globalAny && globalAny.__MP_SOLUTION_PATH__) ||
    'https://cdn.jsdelivr.net/npm/@mediapipe/selfie_segmentation';

  // В разных версиях типы немного расходятся — используем any для конфига,
  // но значения корректны для mediapipe-runtime.
  const cfg: any = {
    runtime: 'mediapipe',
    modelType: 'general',
    solutionPath,
  };

  const segmenter = await bodySegmentation.createSegmenter(model, cfg);
  return { segmenter, backendLabel: 'mediapipe' as const };
}

/**
 * Безопасная генерация бинарной маски.
 * Любые сбои/некорректные размеры → прозрачная маска fallback-размера.
 */
export async function makeBinaryMask(
  segmentations: unknown[] | null | undefined,
  threshold: number,
  fallbackSize: { width: number; height: number }
): Promise<ImageData> {
  const makeClear = () => new ImageData(fallbackSize.width, fallbackSize.height);

  if (!segmentations || (Array.isArray(segmentations) && segmentations.length === 0)) {
    return makeClear();
  }

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

/** Рисует картинку «как cover» во весь прямоугольник (без искажений, с обрезкой). */
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
