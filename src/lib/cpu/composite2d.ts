// Простой CPU-композитинг: фон (с непрозрачностью) + картинка с рабочей канвы.
// Без маски (если понадобится — добавите логику альфа-маттинга).

export type CpuBgState = {
    canvas: HTMLCanvasElement;
    ctx: CanvasRenderingContext2D;
    lastW: number;
    lastH: number;
    ready: boolean;
};

function drawCover(
    ctx: CanvasRenderingContext2D,
    img: HTMLCanvasElement | HTMLImageElement | ImageBitmap,
    w: number, h: number
) {
    const iw = (img as any).width ?? (img as any).naturalWidth;
    const ih = (img as any).height ?? (img as any).naturalHeight;
    if (!iw || !ih) return;
    const s = Math.max(w / iw, h / ih);
    const dw = Math.round(iw * s);
    const dh = Math.round(ih * s);
    const dx = Math.floor((w - dw) / 2);
    const dy = Math.floor((h - dh) / 2);
    ctx.drawImage(img as any, dx, dy, dw, dh);
}

export function composite2d(
    srcCtx: CanvasRenderingContext2D,
    dstCtx: CanvasRenderingContext2D,
    w: number,
    h: number,
    bg: CpuBgState | null,
    mask?: Uint8Array,       // не используется в этой упрощённой версии
    bgOpacity: number = 1.0, // 0..1
    _opts?: unknown
): void {
    // очистка
    dstCtx.save();
    dstCtx.clearRect(0, 0, w, h);

    // фон (подложка)
    if (bg?.ready) {
        dstCtx.globalAlpha = Math.max(0, Math.min(1, bgOpacity));
        drawCover(dstCtx, bg.canvas, w, h);
        dstCtx.globalAlpha = 1;
    }

    // верхний слой — содержимое рабочей канвы
    dstCtx.drawImage(srcCtx.canvas, 0, 0, w, h);
    dstCtx.restore();
}
