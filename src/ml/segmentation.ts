// src/ml/segmentation.ts
import * as ort from "onnxruntime-web";

export type SegConfig = {
    modelUrl: string;
    inputWidth: number; inputHeight: number;
    inputName?: string; outputName?: string;
    normalize?: { mean: number[]; std: number[] };
    applySigmoid?: boolean; threshold?: number;
    providers?: ("webgpu" | "wasm")[];
};

export class Segmenter {
    private session!: ort.InferenceSession;
    private cfg: Required<SegConfig>;
    private prepCanvas: HTMLCanvasElement;
    private prepCtx: CanvasRenderingContext2D;

    constructor(cfg: SegConfig) {
        this.cfg = {
            inputName: cfg.inputName ?? "",
            outputName: cfg.outputName ?? "",
            normalize: cfg.normalize ?? { mean: [0.5, 0.5, 0.5], std: [0.5, 0.5, 0.5] },
            applySigmoid: cfg.applySigmoid ?? true,
            threshold: cfg.threshold ?? 0.5,
            providers: cfg.providers ?? (("gpu" in navigator) ? ["webgpu", "wasm"] : ["wasm"]),
            ...cfg
        };
        this.prepCanvas = document.createElement("canvas");
        this.prepCanvas.width = this.cfg.inputWidth;
        this.prepCanvas.height = this.cfg.inputHeight;
        const ctx = this.prepCanvas.getContext("2d", { willReadFrequently: true });
        if (!ctx) throw new Error("2D ctx unavailable");
        this.prepCtx = ctx;
    }

    async init() {
        this.session = await ort.InferenceSession.create(this.cfg.modelUrl, {
            executionProviders: this.cfg.providers as any,
        });
        if (!this.cfg.inputName) this.cfg.inputName = this.session.inputNames[0];
        if (!this.cfg.outputName) this.cfg.outputName = this.session.outputNames[0];
    }

    async segment(video: HTMLVideoElement): Promise<{ mask: Uint8Array; w: number; h: number }> {
        // препроцесс
        this.prepCtx.drawImage(video, 0, 0, this.cfg.inputWidth, this.cfg.inputHeight);
        const { data } = this.prepCtx.getImageData(0, 0, this.cfg.inputWidth, this.cfg.inputHeight);

        const H = this.cfg.inputHeight, W = this.cfg.inputWidth;
        const chw = new Float32Array(1 * 3 * H * W);
        const { mean, std } = this.cfg.normalize;
        const stride = W * H; let i = 0;
        for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
            const idx = (y * W + x) * 4;
            const r = data[idx] / 255, g = data[idx + 1] / 255, b = data[idx + 2] / 255;
            chw[0 * stride + i] = (r - mean[0]) / std[0];
            chw[1 * stride + i] = (g - mean[1]) / std[1];
            chw[2 * stride + i] = (b - mean[2]) / std[2];
            i++;
        }

        const feeds: Record<string, ort.Tensor> = {
            [this.cfg.inputName]: new ort.Tensor("float32", chw, [1, 3, H, W])
        };
        const out = await this.session.run(feeds);
        const outT = out[this.cfg.outputName];
        if (!outT) throw new Error("Model output not found");

        // берём [N,1,H,W] / [N,H,W] / [H,W]
        let logits = outT.data as Float32Array;
        let oh = H, ow = W;
        if (outT.dims.length === 4) { oh = outT.dims[2]; ow = outT.dims[3]; }
        if (outT.dims.length === 3) { oh = outT.dims[1]; ow = outT.dims[2]; }
        if (outT.dims.length === 2) { oh = outT.dims[0]; ow = outT.dims[1]; }

        const applySigmoid = this.cfg.applySigmoid;
        const u8 = new Uint8Array(ow * oh);
        for (let k = 0; k < u8.length; k++) {
            let p = logits[k];
            if (applySigmoid) p = 1 / (1 + Math.exp(-p));
            u8[k] = (p * 255) | 0; // оставляем «серую» маску (лучше для краёв)
        }
        return { mask: u8, w: ow, h: oh };
    }
}
