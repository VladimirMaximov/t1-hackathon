// src/ml/seg_yolo.ts
import * as ort from "onnxruntime-web";

export type YoloSegConfig = {
    modelUrl: string;            // "/models/yolo11n-seg.onnx"
    inputW: number;              // 320 или 384/512/640 — чем больше, тем точнее, но медленнее
    inputH: number;
    personClassIndex?: number;   // в COCO это 0
    confThreshold?: number;      // порог для person (obj * cls), например 0.25
    providers?: ("webgpu" | "wasm")[];
};

export class YoloSeg {
    private session!: ort.InferenceSession;
    private cfg: Required<YoloSegConfig>;
    private prep: HTMLCanvasElement;
    private pctx: CanvasRenderingContext2D;

    constructor(cfg: YoloSegConfig) {
        this.cfg = {
            personClassIndex: cfg.personClassIndex ?? 0,
            confThreshold: cfg.confThreshold ?? 0.25,
            providers: cfg.providers ?? (("gpu" in navigator) ? ["webgpu", "wasm"] : ["wasm"]),
            ...cfg
        };
        this.prep = document.createElement("canvas");
        this.prep.width = this.cfg.inputW;
        this.prep.height = this.cfg.inputH;
        const ctx = this.prep.getContext("2d", { willReadFrequently: true });
        if (!ctx) throw new Error("2D context unavailable");
        this.pctx = ctx;
    }

    async init() {
        // === ВАЖНО: настроить окружение до create(...) ===
        // 1) грузим wasm из CDN (правильный MIME, ничего из public импортировать не нужно)
        ort.env.wasm.wasmPaths = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.23.0/dist/";

        // 2) отключаем прокси и потоки, чтобы ORT НЕ импортировал *.jsep.mjs
        ort.env.wasm.proxy = false;     // без web worker-прокси
        ort.env.wasm.numThreads = 1;    // один поток (без threaded .mjs)
        ort.env.wasm.simd = true;       // SIMD оставить включённым

        this.session = await ort.InferenceSession.create(this.cfg.modelUrl, {
            executionProviders: this.cfg.providers ? [...this.cfg.providers] : ["wasm"],
        });
    }

    /** Возвращает маску 0..255 размера [inputH,inputW] */
    async segment(videoEl: HTMLVideoElement): Promise<{ mask: Uint8Array; w: number; h: number }> {
        // 1) препроцесс (простое resize, без letterbox)
        const { inputW: W, inputH: H } = this.cfg;
        this.pctx.drawImage(videoEl, 0, 0, W, H);
        const { data } = this.pctx.getImageData(0, 0, W, H);

        // 2) RGBA -> float NCHW [1,3,H,W] в [0..1]
        const chw = new Float32Array(1 * 3 * H * W);
        let i = 0, stride = W * H;
        for (let y = 0; y < H; y++) {
            for (let x = 0; x < W; x++) {
                const idx = (y * W + x) * 4;
                const r = data[idx] / 255, g = data[idx + 1] / 255, b = data[idx + 2] / 255;
                chw[0 * stride + i] = r;
                chw[1 * stride + i] = g;
                chw[2 * stride + i] = b;
                i++;
            }
        }
        const feeds: Record<string, ort.Tensor> = {};
        // имена входа/выходов — возьмём по порядку
        const inputName = this.session.inputNames[0];
        feeds[inputName] = new ort.Tensor("float32", chw, [1, 3, H, W]);

        // 3) инференс
        const outputs = await this.session.run(feeds);

        // найдём предсказания и прототипы
        // pred: [1, N, K], proto: [1, M, Ph, Pw]
        let predName = "";
        let protoName = "";
        for (const name of this.session.outputNames) {
            const t = outputs[name];
            const dims = t.dims;
            if (dims.length === 3) predName = name;
            else if (dims.length === 4) protoName = name;
        }
        if (!predName || !protoName) {
            throw new Error("Unexpected model outputs (need [1,N,K] and [1,M,Ph,Pw])");
        }

        const pred = outputs[predName];  // Float32Array
        const proto = outputs[protoName]; // Float32Array
        const P = proto.data as Float32Array;
        const [, M, Ph, Pw] = proto.dims;         // numMasks, protoH, protoW
        const [, N, K] = pred.dims;               // N rows, K features/row

        // Считаем, что K = 4 (xywh) + 1 (obj) + C (classes) + M (mask coeffs)
        const Mcoef = M;
        const C = K - 5 - Mcoef; // 4 box, 1 obj
        if (C < 1) {
            console.warn("Cannot infer classes count, got C<1. K=", K, "M=", Mcoef);
        }

        const PERSON = this.cfg.personClassIndex;
        const confThr = this.cfg.confThreshold;

        const predData = pred.data as Float32Array;

        // 4) Рабочие буферы
        // maskProto: [M, Ph*Pw] для удобства суммирования
        const mpLen = Ph * Pw;
        const maskProto = new Float32Array(Mcoef * mpLen);
        // перенесём прототипы так, чтобы k-тый канал был в своём отрезке
        // P: [1, M, Ph, Pw] в порядке (M major, затем H, затем W)
        {
            let dst = 0;
            for (let m = 0; m < Mcoef; m++) {
                const base = m * Ph * Pw;
                for (let y = 0; y < Ph; y++) {
                    for (let x = 0; x < Pw; x++) {
                        maskProto[dst++] = P[base + y * Pw + x];
                    }
                }
            }
        }

        // выходная суммарная маска (input HxW), 0..255
        const outU8 = new Uint8Array(W * H);

        // вспомогательная функция: bilinear resize из proto (Ph×Pw) → (H×W)
        function upsampleMaskFloatToOut(maskSmall: Float32Array, out: Uint8Array) {
            // maskSmall длиной Ph*Pw, значения — до сигмоиды/после — неважно (ниже применим)
            for (let y = 0; y < H; y++) {
                const gy = (y + 0.5) * (Ph / H) - 0.5;
                const y0 = Math.max(0, Math.floor(gy));
                const y1 = Math.min(Ph - 1, y0 + 1);
                const ty = gy - y0;
                for (let x = 0; x < W; x++) {
                    const gx = (x + 0.5) * (Pw / W) - 0.5;
                    const x0 = Math.max(0, Math.floor(gx));
                    const x1 = Math.min(Pw - 1, x0 + 1);
                    const tx = gx - x0;

                    const i00 = y0 * Pw + x0;
                    const i10 = y0 * Pw + x1;
                    const i01 = y1 * Pw + x0;
                    const i11 = y1 * Pw + x1;

                    const m00 = maskSmall[i00];
                    const m10 = maskSmall[i10];
                    const m01 = maskSmall[i01];
                    const m11 = maskSmall[i11];

                    const m0 = m00 * (1 - tx) + m10 * tx;
                    const m1 = m01 * (1 - tx) + m11 * tx;
                    const m = m0 * (1 - ty) + m1 * ty;

                    // сигмоида + к 0..255
                    const s = 1 / (1 + Math.exp(-m));
                    const v = (s * 255) | 0;

                    // объединяем с уже имеющимся (максимум по инстансам)
                    const oi = y * W + x;
                    if (v > out[oi]) out[oi] = v;
                }
            }
        }

        // 5) Обходим все предсказания, оставляем только класс person
        for (let iRow = 0; iRow < N; iRow++) {
            const base = iRow * K;
            const x = predData[base + 0];
            const y = predData[base + 1];
            const w = predData[base + 2];
            const h = predData[base + 3];
            const obj = predData[base + 4];

            // классы
            let cls = 0, clsIdx = -1;
            for (let c = 0; c < C; c++) {
                const score = predData[base + 5 + c];
                if (score > cls) { cls = score; clsIdx = c; }
            }
            const conf = obj * cls;
            if (clsIdx !== PERSON || conf < confThr) continue;

            // масочные коэффициенты
            const coeffStart = base + 5 + C;
            const coeff = predData.subarray(coeffStart, coeffStart + Mcoef);

            // соберём маску в разрешении прототипов: sum_k coeff[k] * proto[k]
            const small = new Float32Array(mpLen);
            for (let m = 0; m < Mcoef; m++) {
                const w_m = coeff[m];
                const off = m * mpLen;
                for (let p = 0; p < mpLen; p++) {
                    small[p] += w_m * maskProto[off + p];
                }
            }

            // (упростим) не будем дополнительно вырезать по bbox — достаточно объединить
            upsampleMaskFloatToOut(small, outU8);
        }

        return { mask: outU8, w: W, h: H };
    }
}
