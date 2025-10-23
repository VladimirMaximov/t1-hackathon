import { useEffect, useRef, useState } from "react";
import { identityProcessor } from "@/lib/framePipeline";

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

    const videoRef = useRef<HTMLVideoElement | null>(null);
    const outCanvasRef = useRef<HTMLCanvasElement | null>(null);
    const workCanvasRef = useRef<HTMLCanvasElement | null>(null);
    const rafRef = useRef<number | null>(null);

    // ⚙️ накопители метрик
    const fpsWinRef = useRef({ last: performance.now(), frames: 0 });
    const lastRafRef = useRef<number | null>(null);
    const cpuSamplesRef = useRef<number[]>([]);
    const gpuSamplesRef = useRef<number[]>([]);
    const MAX_SAMPLES = 120;

    async function startCamera() {
        const stream = await navigator.mediaDevices.getUserMedia({
            video: { width: 1280, height: 720 }
        });

        if (!videoRef.current) return;
        videoRef.current.srcObject = stream;

        await videoRef.current.play();
        await new Promise<void>((resolve) => {
            if (videoRef.current!.readyState >= 2) return resolve();
            videoRef.current!.addEventListener("loadedmetadata", () => resolve(), { once: true });
        });

        const vw = videoRef.current.videoWidth || 1280;
        const vh = videoRef.current.videoHeight || 720;

        const out = outCanvasRef.current!;
        out.width = vw; out.height = vh;

        const work = workCanvasRef.current!;
        work.width = vw; work.height = vh;

        const outCtx = out.getContext("2d", { willReadFrequently: true })!;
        const workCtx = work.getContext("2d", { willReadFrequently: true })!;

        const tick = () => {
            const now = performance.now();

            // ⚙️ «GPU-прокси»: перерасход времени кадра сверх бюджета 16.7мс
            if (lastRafRef.current != null) {
                const dt = now - lastRafRef.current;
                const over = Math.max(0, dt - 1000 / 60); // мс сверх 60 FPS
                gpuSamplesRef.current.push(over);
                if (gpuSamplesRef.current.length > MAX_SAMPLES) gpuSamplesRef.current.shift();
            }
            lastRafRef.current = now;

            // рисуем кадр на рабочий канвас (с антизеркалом, если нужно)
            workCtx.save();
            workCtx.translate(vw, 0);
            workCtx.scale(-1, 1);
            workCtx.drawImage(videoRef.current!, 0, 0, vw, vh);
            workCtx.restore();

            // ⚙️ CPU-время: обработчик кадра
            const t0 = performance.now();
            identityProcessor(workCtx, outCtx, vw, vh);
            const t1 = performance.now();
            const cpuMs = t1 - t0;
            cpuSamplesRef.current.push(cpuMs);
            if (cpuSamplesRef.current.length > MAX_SAMPLES) cpuSamplesRef.current.shift();

            // ⚙️ FPS (раз в ~секунду отправляем события с метриками)
            fpsWinRef.current.frames += 1;
            const winDt = now - fpsWinRef.current.last;
            if (winDt >= 1000) {
                const fps = Math.round((fpsWinRef.current.frames * 1000) / winDt);
                fpsWinRef.current.frames = 0;
                fpsWinRef.current.last = now;

                const avg = (arr: number[]) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0);
                const peak = (arr: number[]) => (arr.length ? Math.max(...arr) : 0);

                const payload = {
                    fps,
                    cpuAvg: avg(cpuSamplesRef.current),
                    cpuPeak: peak(cpuSamplesRef.current),
                    gpuAvg: avg(gpuSamplesRef.current),
                    gpuPeak: peak(gpuSamplesRef.current),
                };
                window.dispatchEvent(new CustomEvent("metrics:update", { detail: payload }));
            }

            rafRef.current = requestAnimationFrame(tick);
        };
        rafRef.current = requestAnimationFrame(tick);
    }

    function stopCamera() {
        if (rafRef.current) cancelAnimationFrame(rafRef.current);
        rafRef.current = null;

        if (videoRef.current?.srcObject instanceof MediaStream) {
            videoRef.current.srcObject.getTracks().forEach(t => t.stop());
            videoRef.current.srcObject = null;
        }
    }

    useEffect(() => {
        return () => stopCamera();
    }, []);

    async function handleConfirm() {
        if (!selectedBg) { alert("Сначала выбери фон."); return; }
        setMode("live");
        try { await startCamera(); }
        catch (e) { console.error(e); alert("Не удалось включить камеру. Проверь разрешения."); setMode("pick"); }
    }

    if (mode === "pick") {
        return (
            <div className="pane-content">
                <div className="bg-grid">
                    {BACKGROUNDS.map(bg => (
                        <button
                            key={bg.id}
                            className={"bg-item" + (selectedBg === bg.id ? " selected" : "")}
                            onClick={() => setSelectedBg(bg.id)}
                            aria-label={`Выбрать ${bg.label}`}
                            title={bg.label}
                        >
                            <img src={bg.src} alt={bg.label}
                                onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }} />
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

    // live
    return (
        <div className="pane-content center">
            <canvas ref={outCanvasRef} style={{ width: "100%", maxHeight: 460, borderRadius: 12, background: "#000" }} />
            <video ref={videoRef} playsInline muted style={{ display: "none" }} />
            <canvas ref={workCanvasRef} style={{ display: "none" }} />
        </div>
    );
}
