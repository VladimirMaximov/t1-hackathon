export type MorphMode = 'none' | 'dilate' | 'erode' | 'close';

export interface MaskRefineOptions {
    softThr: number; // 0..1
    softK: number;   // крутизна сигмоиды
    ema: number;     // 0..1 (вес пред. кадра)
    morphMode: MorphMode;
}

export class MaskRefiner {
    private work = document.createElement('canvas');
    private wctx = this.work.getContext('2d', { willReadFrequently: true })!;
    private prevAlpha?: Uint8ClampedArray;

    refine(
        maskSource: CanvasImageSource,
        w: number,
        h: number,
        opt: MaskRefineOptions
    ): HTMLCanvasElement {
        if (this.work.width !== w || this.work.height !== h) {
            this.work.width = w; this.work.height = h; this.prevAlpha = undefined;
        }
        this.wctx.save();
        this.wctx.clearRect(0, 0, w, h);
        this.wctx.drawImage(maskSource, 0, 0, w, h);

        const img = this.wctx.getImageData(0, 0, w, h);
        const data = img.data;

        // Берём интенсивность R-канала (маска градаций серого)
        let alpha = new Uint8ClampedArray(w * h);
        for (let i = 0, p = 0; i < data.length; i += 4, p++) alpha[p] = data[i];

        // Мягкий порог (сигмоида)
        softThresholdInPlace(alpha, opt.softThr, opt.softK);

        // EMA-сглаживание
        if (!this.prevAlpha || this.prevAlpha.length !== alpha.length) {
            this.prevAlpha = alpha.slice();
        } else {
            const s = opt.ema;
            for (let i = 0; i < alpha.length; i++) {
                alpha[i] = Math.round(s * this.prevAlpha[i] + (1 - s) * alpha[i]);
            }
            this.prevAlpha.set(alpha);
        }

        // Морфология
        if (opt.morphMode === 'dilate') alpha = dilate3x3(alpha, w, h);
        else if (opt.morphMode === 'erode') alpha = erode3x3(alpha, w, h);
        else if (opt.morphMode === 'close') { alpha = dilate3x3(alpha, w, h); alpha = erode3x3(alpha, w, h); }

        // Записываем альфу (RGB=0, A=alpha)
        for (let i = 0, p = 0; i < data.length; i += 4, p++) {
            data[i] = 0; data[i + 1] = 0; data[i + 2] = 0; data[i + 3] = alpha[p];
        }
        this.wctx.putImageData(img, 0, 0);
        this.wctx.restore();
        return this.work;
    }
}

export function softThresholdInPlace(alpha: Uint8ClampedArray, t: number, k = 6.0) {
    for (let i = 0; i < alpha.length; i++) {
        const a = alpha[i] / 255;
        const s = 1 / (1 + Math.exp(-k * (a - t)));
        alpha[i] = Math.round(s * 255);
    }
}

export function dilate3x3(a: Uint8ClampedArray, w: number, h: number) {
    const out = new Uint8ClampedArray(a.length);
    const idx = (x: number, y: number) => y * w + x;
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
        let m = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) m = Math.max(m, a[idx(x + dx, y + dy)]);
        out[idx(x, y)] = m;
    }
    return out;
}

export function erode3x3(a: Uint8ClampedArray, w: number, h: number) {
    const out = new Uint8ClampedArray(a.length);
    const idx = (x: number, y: number) => y * w + x;
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
        let m = 255;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) m = Math.min(m, a[idx(x + dx, y + dy)]);
        out[idx(x, y)] = m;
    }
    return out;
}
