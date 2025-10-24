// src/components/layout/CameraPane.tsx
import { useEffect, useRef, useState } from "react";
import { WebGPUFramePipeline } from "@/lib/gpu/framePipelineWebGPU";
import { Segmenter } from "@/ml/segmentation";
import { loadBgForCpu, composite2d, CpuBgState } from "@/lib/cpu/composite2d";

// Доступные фоны (картинки лежат в /public/backgrounds/)
const BACKGROUNDS = [
    { id: "bg1", label: "фон 1", src: "/backgrounds/bg1.jpg" },
    { id: "bg2", label: "фон 2", src: "/backgrounds/bg2.jpg" },
    { id: "bg3", label: "фон 3", src: "/backgrounds/bg3.jpg" },
    { id: "bg4", label: "фон 4", src: "/backgrounds/bg4.jpg" },
    { id: "bg5", label: "фон 5", src: "/backgrounds/bg5.jpg" },
    { id: "bg6", label: "фон 6", src: "/backgrounds/bg6.jpg" }
];

type Mode = "pick" | "live";

export default function CameraPane() {
    const [mode, setMode] = useState<Mode>("pick");
    const [selectedBg, setSelectedBg] = useState<string | null>(null);

    // Зафиксированный пользователем фон (после кнопки)
    const lockedBgRef = useRef<{ id: string; src: string } | null>(null);

    // Видео и канвасы
    const videoRef = useRef<HTMLVideoElement | null>(null);
    const outCanvasRef = useRef<HTMLCanvasElement | null>(null);
    const workCanvasRef = useRef<HTMLCanvasElement | null>(null);

    // Идентификаторы циклов
    const rafRef = useRef<number | null>(null);

    // WebGPU путь
    const wgpuRef = useRef<WebGPUFramePipeline | null>(null);
    const useWGPURef = useRef(false);

    // CPU путь
    const cpuOutCtxRef = useRef<CanvasRenderingContext2D | null>(null);
    const cpuWorkCtxRef = useRef<CanvasRenderingContext2D | null>(null);
    const cpuBgRef = useRef<CpuBgState | null>(null);
    const lastMaskRef = useRef<{ data: Uint8Array; w: number; h: number } | null>(null);

    // Сегментация
    const segRef = useRef<Segmenter | null>(null);
    const segLoopOnRef = useRef(false);

    // Метрики
    const fpsWinRef = useRef({ last: performance.now(), frames: 0 });
    const lastRafRef = useRef<number | null>(null);
    const cpuSamplesRef = useRef<number[]>([]);
    const gpuSamplesRef = useRef<number[]>([]);
    const MAX_SAMPLES = 120;

    async function startCamera() {
        // 1) Камера
        const stream = await navigator.mediaDevices.getUserMedia({ video: { width: 1280, height: 720 } });
        if (!videoRef.current) return;
        videoRef.current.srcObject = stream;

        await videoRef.current.play();
        await new Promise<void>((resolve) => {
            if (videoRef.current!.readyState >= 2) return resolve();
            videoRef.current!.addEventListener("loadedmetadata", () => resolve(), { once: true });
        });

        // 2) Размеры
        const vw = videoRef.current.videoWidth || 1280;
        const vh = videoRef.current.videoHeight || 720;

        const out = outCanvasRef.current!;
        out.width = vw; out.height = vh;

        const work = workCanvasRef.current!;
        work.width = vw; work.height = vh;

        // 3) Попытка WebGPU → иначе CPU
        try {
            wgpuRef.current = await WebGPUFramePipeline.create(out, vw, vh);
            useWGPURef.current = true;
            console.log("WebGPU enabled");
            if (lockedBgRef.current) {
                await wgpuRef.current.setBackgroundFromURL(lockedBgRef.current.src);
            }
        } catch (e) {
            console.warn("WebGPU unavailable, using CPU fallback:", e);
            useWGPURef.current = false;
            cpuOutCtxRef.current = out.getContext("2d", { willReadFrequently: true })!;
            cpuWorkCtxRef.current = work.getContext("2d", { willReadFrequently: true })!;
            if (lockedBgRef.current) {
                cpuBgRef.current = await loadBgForCpu(lockedBgRef.current.src, vw, vh);
            }
        }

        // 4) Инициализация сегментации — НЕ БЛОКИРУЕМ старт камеры
        try {
            segRef.current = new Segmenter({
                modelUrl: "/models/seg.onnx",         // положите модель в public/models/seg.onnx
                inputWidth: 256, inputHeight: 256,    // подстройте под вашу модель
                applySigmoid: true,
                // Порядок EP: если есть WebGPU — пробуем webgpu→wasm, иначе только wasm
                providers: ("gpu" in navigator) ? ["webgpu", "wasm"] as const : ["wasm"] as const
            });
            await segRef.current.init();

            // Инференс-петля (работает независимо от рисования кадров)
            segLoopOnRef.current = true;
            const segLoop = async () => {
                if (!segLoopOnRef.current) return;
                try {
                    const { mask, w, h } = await segRef.current!.segment(videoRef.current!);
                    if (useWGPURef.current) {
                        wgpuRef.current?.updateMaskFromArray(mask, w, h);
                    } else {
                        lastMaskRef.current = { data: mask, w, h };
                    }
                } catch (err) {
                    console.warn("Segmentation step error:", err);
                } finally {
                    setTimeout(segLoop, 80); // ~12–15 Гц
                }
            };
            segLoop();
        } catch (e) {
            console.warn("Segmentation init failed — continue without mask/bg replace:", e);
            // Ничего не делаем: видео уже показывает, композита просто не будет.
        }

        // 5) Кадровой цикл
        const tick = () => {
            const now = performance.now();
            if (lastRafRef.current != null) {
                const dt = now - lastRafRef.current;
                const over = Math.max(0, dt - 1000 / 60);
                gpuSamplesRef.current.push(over);
                if (gpuSamplesRef.current.length > MAX_SAMPLES) gpuSamplesRef.current.shift();
            }
            lastRafRef.current = now;

            if (useWGPURef.current) {
                const t0 = performance.now();
                wgpuRef.current!.render(videoRef.current!, /*flipX*/ true);
                const t1 = performance.now();
                cpuSamplesRef.current.push(t1 - t0);
                if (cpuSamplesRef.current.length > MAX_SAMPLES) cpuSamplesRef.current.shift();
            } else {
                // CPU: сначала кладём кадр в рабочий канвас с антизеркалом
                const workCtx = cpuWorkCtxRef.current!;
                const outCtx = cpuOutCtxRef.current!;
                workCtx.save();
                workCtx.translate(vw, 0); workCtx.scale(-1, 1);
                workCtx.drawImage(videoRef.current!, 0, 0, vw, vh);
                workCtx.restore();

                // Если есть маска и фон — композитим, иначе просто копия кадра
                const m = lastMaskRef.current;
                composite2d(workCtx, outCtx, vw, vh, cpuBgRef.current, m?.data, m?.w, m?.h);
            }

            // Метрики (раз в ~секунду)
            fpsWinRef.current.frames += 1;
            const winDt = now - fpsWinRef.current.last;
            if (winDt >= 1000) {
                const fps = Math.round((fpsWinRef.current.frames * 1000) / winDt);
                fpsWinRef.current.frames = 0;
                fpsWinRef.current.last = now;
                const avg = (a: number[]) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
                const peak = (a: number[]) => a.length ? Math.max(...a) : 0;
                window.dispatchEvent(new CustomEvent("metrics:update", {
                    detail: {
                        fps,
                        cpuAvg: avg(cpuSamplesRef.current),
                        cpuPeak: peak(cpuSamplesRef.current),
                        gpuAvg: avg(gpuSamplesRef.current),
                        gpuPeak: peak(gpuSamplesRef.current),
                    }
                }));
            }

            rafRef.current = requestAnimationFrame(tick);
        };
        rafRef.current = requestAnimationFrame(tick);
    }

    function stopCamera() {
        if (rafRef.current) cancelAnimationFrame(rafRef.current);
        rafRef.current = null;

        if (videoRef.current?.srcObject instanceof MediaStream) {
            videoRef.current.srcObject.getTracks().forEach((t) => t.stop());
            videoRef.current.srcObject = null;
        }

        segLoopOnRef.current = false;
        segRef.current = null;

        wgpuRef.current = null; useWGPURef.current = false;
        cpuOutCtxRef.current = null; cpuWorkCtxRef.current = null;
        cpuBgRef.current = null; lastMaskRef.current = null;
    }

    useEffect(() => () => stopCamera(), []);

    async function handleConfirm() {
        if (!selectedBg) {
            alert("Сначала выбери фон.");
            return;
        }
        // Фиксируем фон
        const chosen = BACKGROUNDS.find((b) => b.id === selectedBg)!;
        lockedBgRef.current = { id: chosen.id, src: chosen.src };

        setMode("live");
        try {
            await startCamera();
        } catch (e) {
            console.error(e);
            alert("Не удалось включить камеру. Проверь разрешения.");
            setMode("pick");
        }
    }

    if (mode === "pick") {
        return (
            <div className="pane-content">
                <div className="bg-grid">
                    {BACKGROUNDS.map((bg) => (
                        <button
                            key={bg.id}
                            className={"bg-item" + (selectedBg === bg.id ? " selected" : "")}
                            onClick={() => setSelectedBg(bg.id)}
                            aria-label={`Выбрать ${bg.label}`}
                            title={bg.label}
                        >
                            <img
                                src={bg.src}
                                alt={bg.label}
                                onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }}
                            />
                            <span className="bg-label">{bg.label}</span>
                        </button>
                    ))}
                </div>
                <div className="confirm-row">
                    <button className="confirm-btn" onClick={handleConfirm} disabled={!selectedBg}>
                        Зафиксировать выбор
                    </button>
                </div>
            </div>
        );
    }

    return (
        <div className="pane-content center">
            <canvas
                ref={outCanvasRef}
                style={{ width: "100%", maxHeight: 460, borderRadius: 12, background: "#000" }}
            />
            {/* скрытые элементы для работы */}
            <video ref={videoRef} playsInline muted style={{ display: "none" }} />
            <canvas ref={workCanvasRef} style={{ display: "none" }} />
        </div>
    );
}
