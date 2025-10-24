import { useEffect, useRef, useState, useCallback } from "react";
import { WebGPUFramePipeline } from "@/lib/gpu/framePipelineWebGPU";
import { composite2d, type CpuBgState } from "@/lib/cpu/composite2d";

type Backend = "webgpu" | "cpu";

const BACKGROUNDS = [
    { id: "bg1", label: "фон 1", src: "/backgrounds/bg1.jpg" },
    { id: "bg2", label: "фон 2", src: "/backgrounds/bg2.jpg" },
    { id: "bg3", label: "фон 3", src: "/backgrounds/bg3.jpg" },
    { id: "bg4", label: "фон 4", src: "/backgrounds/bg4.jpg" },
    { id: "bg5", label: "фон 5", src: "/backgrounds/bg5.jpg" },
    { id: "bg6", label: "фон 6", src: "/backgrounds/bg6.jpg" }
];

export default function CameraPanel() {
    // UI
    const [selectedBg, setSelectedBg] = useState<string | null>(null);
    const [running, setRunning] = useState(false);

    // динамическая геометрия канваса
    const [vidSize, setVidSize] = useState<{ w: number; h: number } | null>(null);
    const wrapRef = useRef<HTMLDivElement | null>(null);

    // DOM
    const videoRef = useRef<HTMLVideoElement | null>(null);
    const outCanvasRef = useRef<HTMLCanvasElement | null>(null);
    const workCanvasRef = useRef<HTMLCanvasElement | null>(null);

    // GPU/CPU
    const wgpuRef = useRef<WebGPUFramePipeline | null>(null);
    const useWGPURef = useRef(false);
    const cpuOutCtxRef = useRef<CanvasRenderingContext2D | null>(null);
    const cpuWorkCtxRef = useRef<CanvasRenderingContext2D | null>(null);

    // цикл
    const rafRef = useRef<number | null>(null);

    // метрики
    const lastRafRef = useRef<number | null>(null);
    const cpuSamplesRef = useRef<number[]>([]);
    const gpuSamplesRef = useRef<number[]>([]);
    const fpsWinRef = useRef({ last: performance.now(), frames: 0 });
    const MAX_SAMPLES = 120;

    // тех. флаги
    const startedRef = useRef(false);

    // ---- фон ----
    const [bgOpacity, setBgOpacity] = useState<number>(100);
    const bgImgRef = useRef<HTMLImageElement | null>(null);
    const bgBitmapRef = useRef<ImageBitmap | null>(null);
    const bgCpuRef = useRef<CpuBgState | null>(null);

    const getBgSrcById = (id: string | null) =>
        id ? BACKGROUNDS.find(b => b.id === id)?.src ?? null : null;

    function buildCpuBgFromSource(src: HTMLImageElement | ImageBitmap) {
        const cnv = document.createElement("canvas");
        const ctx = cnv.getContext("2d")!;
        const w = "naturalWidth" in src ? (src as HTMLImageElement).naturalWidth : (src as ImageBitmap).width;
        const h = "naturalHeight" in src ? (src as HTMLImageElement).naturalHeight : (src as ImageBitmap).height;
        cnv.width = Math.max(1, w);
        cnv.height = Math.max(1, h);
        ctx.drawImage(src as unknown as CanvasImageSource, 0, 0, cnv.width, cnv.height);
        bgCpuRef.current = { canvas: cnv, ctx, lastW: 0, lastH: 0, ready: true };
    }

    async function loadBg(src: string): Promise<void> {
        const img = new Image();
        img.crossOrigin = "anonymous";
        img.decoding = "async";
        img.src = src;
        await img.decode();
        bgImgRef.current = img;
        buildCpuBgFromSource(img);
        try {
            bgBitmapRef.current = await createImageBitmap(img);
        } catch {
            bgBitmapRef.current = null;
        }
        if (useWGPURef.current && wgpuRef.current) {
            const p: any = wgpuRef.current;
            if (typeof p.setBackground === "function") await p.setBackground(bgBitmapRef.current ?? img);
            else if (typeof p.setBgTexture === "function") await p.setBgTexture(bgBitmapRef.current ?? img);
            if (typeof p.setUseBackground === "function") p.setUseBackground(true);
            if (typeof p.setBgOpacity === "function") p.setBgOpacity(bgOpacity / 100);
        }
    }

    // непрозрачность из ControlPanel
    useEffect(() => {
        const onOpacity = (e: Event) => {
            const v = (e as CustomEvent<number>).detail;
            setBgOpacity(typeof v === "number" ? v : 100);
            if (useWGPURef.current && wgpuRef.current) {
                const p: any = wgpuRef.current;
                if (typeof p.setBgOpacity === "function") p.setBgOpacity((v ?? 100) / 100);
                else if (typeof p.updateUniforms === "function") p.updateUniforms({ bgOpacity: (v ?? 100) / 100 });
            }
        };
        window.addEventListener("ui:opacity", onOpacity as EventListener);
        return () => window.removeEventListener("ui:opacity", onOpacity as EventListener);
    }, []);

    // выбор фона
    useEffect(() => {
        const payload = selectedBg
            ? { id: selectedBg, src: BACKGROUNDS.find(b => b.id === selectedBg)!.src }
            : null;
        window.dispatchEvent(new CustomEvent("bg:selected", { detail: payload }));

        const src = getBgSrcById(selectedBg);
        if (src) {
            loadBg(src).catch(err => console.error("[CameraPanel] bg load failed:", err));
        } else {
            bgImgRef.current = null;
            bgBitmapRef.current = null;
            bgCpuRef.current = null;
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [selectedBg]);

    // команды от ControlPanel
    useEffect(() => {
        function onStart(ev: Event) {
            const detail = (ev as CustomEvent).detail as { backend: Backend; opacity: number };
            if (!selectedBg) {
                alert("Сначала выберите фон.");
                return;
            }
            const src = getBgSrcById(selectedBg);
            const run = async () => {
                if (src && !bgImgRef.current) await loadBg(src);
                await startCamera(detail.backend);
            };
            run().catch(err => {
                console.error("[CameraPanel] startCamera failed:", err);
                window.dispatchEvent(new CustomEvent("camera:stopped"));
            });
        }
        function onStop() {
            stopCamera();
            window.dispatchEvent(new CustomEvent("camera:stopped"));
        }
        window.addEventListener("camera:start", onStart);
        window.addEventListener("camera:stop", onStop);
        return () => {
            window.removeEventListener("camera:start", onStart);
            window.removeEventListener("camera:stop", onStop);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [selectedBg]);

    // респонсив под контейнер
    useEffect(() => {
        if (!vidSize || !wrapRef.current || !outCanvasRef.current || !workCanvasRef.current) return;
        const aspect = vidSize.w / vidSize.h;
        const el = wrapRef.current;

        const ro = new ResizeObserver(() => {
            const cssW = el.clientWidth;
            const cssH = cssW / aspect;
            const dpr = Math.max(1, window.devicePixelRatio || 1);
            const pxW = Math.max(1, Math.round(cssW * dpr));
            const pxH = Math.max(1, Math.round(cssH * dpr));
            if (outCanvasRef.current!.width !== pxW || outCanvasRef.current!.height !== pxH) {
                outCanvasRef.current!.width = pxW; outCanvasRef.current!.height = pxH;
                workCanvasRef.current!.width = pxW; workCanvasRef.current!.height = pxH;
            }
        });
        ro.observe(el);
        return () => ro.disconnect();
    }, [vidSize]);

    // ждём, пока все нужные ref реально в DOM
    const ensureRefsReady = useCallback(async (timeoutMs = 2000) => {
        const t0 = performance.now();
        while (true) {
            const v = videoRef.current;
            const out = outCanvasRef.current;
            const work = workCanvasRef.current;
            if (v && out && work && out.isConnected && work.isConnected) return;
            if (performance.now() - t0 > timeoutMs) throw new Error("DOM refs not ready");
            await new Promise(r => requestAnimationFrame(r));
        }
    }, []);

    // старт/стоп
    async function startCamera(backend: Backend) {
        if (startedRef.current) return;
        startedRef.current = true;

        await ensureRefsReady();

        // камера
        const stream = await navigator.mediaDevices.getUserMedia({
            video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: "user" },
            audio: false
        });
        const video = videoRef.current!;
        video.srcObject = stream;
        await new Promise<void>((resolve) => {
            const onMeta = () => { video.removeEventListener("loadedmetadata", onMeta); resolve(); };
            if (video.readyState >= 1) resolve(); else video.addEventListener("loadedmetadata", onMeta, { once: true });
        });
        video.muted = true;
        try { await video.play(); } catch { }

        const vw = video.videoWidth || 1280;
        const vh = video.videoHeight || 720;
        setVidSize({ w: vw, h: vh });

        outCanvasRef.current!.width = vw; outCanvasRef.current!.height = vh;
        workCanvasRef.current!.width = vw; workCanvasRef.current!.height = vh;

        // WebGPU/CPU
        const preferWebGPU = backend === "webgpu";
        try {
            if (preferWebGPU && "gpu" in navigator) {
                wgpuRef.current = await WebGPUFramePipeline.create(outCanvasRef.current!, vw, vh);
                useWGPURef.current = true;

                if (bgImgRef.current || bgBitmapRef.current) {
                    const p: any = wgpuRef.current;
                    if (typeof p.setBackground === "function") await p.setBackground(bgBitmapRef.current ?? bgImgRef.current!);
                    else if (typeof p.setBgTexture === "function") await p.setBgTexture(bgBitmapRef.current ?? bgImgRef.current!);
                    if (typeof p.setUseBackground === "function") p.setUseBackground(true);
                    if (typeof p.setBgOpacity === "function") p.setBgOpacity(bgOpacity / 100);
                }
            } else {
                throw new Error("Use CPU path");
            }
        } catch {
            useWGPURef.current = false;
            cpuOutCtxRef.current = outCanvasRef.current!.getContext("2d", { willReadFrequently: true })!;
            cpuWorkCtxRef.current = workCanvasRef.current!.getContext("2d", { willReadFrequently: true })!;
        }

        // рендер-цикл
        const tick = () => {
            const now = performance.now();
            if (lastRafRef.current != null) {
                const dt = now - lastRafRef.current;
                const over = Math.max(0, dt - 1000 / 60);
                (useWGPURef.current ? gpuSamplesRef.current : cpuSamplesRef.current).push(over);
                if (cpuSamplesRef.current.length > MAX_SAMPLES) cpuSamplesRef.current.shift();
                if (gpuSamplesRef.current.length > MAX_SAMPLES) gpuSamplesRef.current.shift();
            }
            lastRafRef.current = now;

            if (useWGPURef.current) {
                try {
                    (wgpuRef.current as any)?.render(video, /*useBg*/ true);
                } catch (err) {
                    console.warn("[CameraPanel] WebGPU render error, switching to CPU", err);
                    useWGPURef.current = false;
                    cpuOutCtxRef.current = outCanvasRef.current!.getContext("2d", { willReadFrequently: true })!;
                    cpuWorkCtxRef.current = workCanvasRef.current!.getContext("2d", { willReadFrequently: true })!;
                }
            } else {
                const workCtx = cpuWorkCtxRef.current!;
                const outCtx = cpuOutCtxRef.current!;
                const cw = outCanvasRef.current!.width;
                const ch = outCanvasRef.current!.height;

                // зеркалим
                workCtx.save();
                workCtx.translate(cw, 0);
                workCtx.scale(-1, 1);
                workCtx.drawImage(video, 0, 0, cw, ch);
                workCtx.restore();

                composite2d(workCtx, outCtx, cw, ch, bgCpuRef.current, undefined, bgOpacity / 100, undefined);
            }

            // метрики
            fpsWinRef.current.frames += 1;
            const winDt = now - fpsWinRef.current.last;
            if (winDt >= 1000) {
                const fps = Math.round((fpsWinRef.current.frames * 1000) / winDt);
                fpsWinRef.current.frames = 0;
                fpsWinRef.current.last = now;
                const avg = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
                const peak = (a: number[]) => (a.length ? Math.max(...a) : 0);
                const cpuAvg = avg(cpuSamplesRef.current);
                const cpuPeak = peak(cpuSamplesRef.current);
                const gpuAvg = avg(gpuSamplesRef.current);
                const gpuPeak = peak(gpuSamplesRef.current);
                window.dispatchEvent(new CustomEvent("metrics:update", {
                    detail: { fps, cpuAvg, cpuPeak, gpuAvg, gpuPeak }
                }));
            }

            rafRef.current = requestAnimationFrame(tick);
        };
        rafRef.current = requestAnimationFrame(tick);

        setRunning(true);
        window.dispatchEvent(new CustomEvent("camera:started"));
    }

    function stopCamera() {
        if (rafRef.current) cancelAnimationFrame(rafRef.current);
        rafRef.current = null;

        const video = videoRef.current;
        if (video?.srcObject instanceof MediaStream) {
            video.srcObject.getTracks().forEach(t => t.stop());
            video.srcObject = null;
        }

        wgpuRef.current = null; useWGPURef.current = false;
        cpuOutCtxRef.current = null; cpuWorkCtxRef.current = null;
        startedRef.current = false;
        setRunning(false);
    }

    // чистка
    useEffect(() => () => stopCamera(), []);

    const aspectStr = vidSize ? `${vidSize.w} / ${vidSize.h}` : "16 / 9";

    return (
        <section className="camera">
            <div className="pane-content">
                <div
                    ref={wrapRef}
                    style={{
                        width: "100%",
                        aspectRatio: aspectStr,
                        position: "relative",
                        borderRadius: 12,
                        overflow: "hidden",
                        background: "#000",
                        display: running ? "block" : "none"
                    }}
                    aria-hidden={!running}
                >
                    <canvas
                        ref={outCanvasRef}
                        style={{
                            position: "absolute",
                            inset: 0,
                            width: "100%",
                            height: "100%",
                            display: "block"
                        }}
                    />
                </div>

                {/* Экран выбора фона — просто скрываем его, когда идёт рендер */}
                {!running && (
                    <>
                        <div className="bg-grid">
                            {BACKGROUNDS.map((bg) => (
                                <button
                                    key={bg.id}
                                    className={"bg-item" + (selectedBg === bg.id ? " selected" : "")}
                                    onClick={() => setSelectedBg(bg.id)}
                                    aria-pressed={selectedBg === bg.id}
                                    title={bg.label}
                                    style={{
                                        backgroundImage: `url(${bg.src})`,
                                        backgroundSize: "cover",
                                        backgroundPosition: "center",
                                    }}
                                >
                                    <span className="bg-label">{bg.label}</span>
                                </button>
                            ))}
                        </div>
                        <div className="hint">Выберите фон, затем используйте кнопку снизу, чтобы запустить камеру.</div>
                    </>
                )}

                {/* скрытые элементы для пайплайна — всегда в DOM */}
                <video ref={videoRef} playsInline muted style={{ display: "none" }} />
                <canvas ref={workCanvasRef} style={{ display: "none" }} />
            </div>
        </section>
    );
}
