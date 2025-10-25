import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
    createSelfieSegmenterTFJS,
    makeBinaryMask,
    drawCover,
    type TfjsBackend
} from '../../lib/segmentation/tfjs/selfieSegmenter';
import type { BodySegmenter } from '@tensorflow-models/body-segmentation';

type BgItem = { id: string; label: string; src: string };
const BACKGROUNDS: BgItem[] = [
    { id: 'bg1', label: 'фон 1', src: '/backgrounds/12.png' },
    { id: 'bg2', label: 'фон 2', src: '/backgrounds/13.png' },
    { id: 'bg3', label: 'фон 3', src: '/backgrounds/14.png' },
    { id: 'bg4', label: 'фон 4', src: '/backgrounds/1.jpg' },
    { id: 'bg5', label: 'фон 5', src: '/backgrounds/2.jpg' },
    { id: 'bg6', label: 'фон 6', src: '/backgrounds/6.jpg' }
];

type OverlayData = {
    full_name: string;
    position: string;
    company: string;
    department: string;
    office_location: string;
    contact: { email: string; telegram: string };
    branding: {
        logo_url: string;
        corporate_colors: { primary: string; secondary: string };
        slogan: string;
    };
    privacy_level: "low" | "medium" | "high";
};

export default function CameraPanel() {
    const [selectedBg, setSelectedBg] = useState<string | null>(null);
    const [running, setRunning] = useState(false);

    const [vidSize, setVidSize] = useState<{ w: number; h: number } | null>(null);
    const wrapRef = useRef<HTMLDivElement | null>(null);

    const videoRef = useRef<HTMLVideoElement | null>(null);
    const outCanvasRef = useRef<HTMLCanvasElement | null>(null);

    const maskCanvasRef = useRef<HTMLCanvasElement | null>(null);
    const maskSmoothRef = useRef<HTMLCanvasElement | null>(null);
    const personCanvasRef = useRef<HTMLCanvasElement | null>(null);
    const workCanvasRef = useRef<HTMLCanvasElement | null>(null);

    const segRef = useRef<BodySegmenter | null>(null);
    const [backend, setBackend] = useState<TfjsBackend | '—'>('—');
    const backendRef = useRef<string>('—');

    const rafRef = useRef<number | null>(null);

    const [fps, setFps] = useState(0);
    const [latency, setLatency] = useState(0);
    const fpsRef = useRef(0);
    const latencyRef = useRef(0);
    const statusRef = useRef<'Камера запущена' | 'Камера остановлена'>('Камера остановлена');
    const fpsWin = useRef({ last: performance.now(), frames: 0 });
    const lastEmitRef = useRef(0);

    const [bgFileUrl, setBgFileUrl] = useState<string | null>(null);
    const [bgImage, setBgImage] = useState<HTMLImageElement | null>(null);
    const bgOpacityRef = useRef(1.0);
    const featherPxRef = useRef(0);

    const [overlay, setOverlay] = useState<OverlayData | null>(null);

    useEffect(() => {
        if (!bgFileUrl) { setBgImage(null); return; }
        const img = new Image();
        img.onload = () => setBgImage(img);
        img.onerror = () => setBgImage(null);
        img.src = bgFileUrl;
        return () => URL.revokeObjectURL(bgFileUrl);
    }, [bgFileUrl]);

    useEffect(() => {
        const payload = selectedBg
            ? { id: selectedBg, src: BACKGROUNDS.find(b => b.id === selectedBg)!.src }
            : null;
        window.dispatchEvent(new CustomEvent('bg:selected', { detail: payload }));

        const src = selectedBg ? BACKGROUNDS.find(b => b.id === selectedBg)?.src ?? null : null;
        setBgFileUrl(src ?? null);
    }, [selectedBg]);

    useEffect(() => {
        if (!vidSize || !wrapRef.current || !outCanvasRef.current) return;
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
            }
        });
        ro.observe(el);
        return () => ro.disconnect();
    }, [vidSize]);

    function ensureMaskCanvas(w: number, h: number) {
        if (!maskCanvasRef.current) maskCanvasRef.current = document.createElement('canvas');
        const c = maskCanvasRef.current!;
        if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
        return c;
    }
    function ensureMaskSmoothCanvas(w: number, h: number) {
        if (!maskSmoothRef.current) maskSmoothRef.current = document.createElement('canvas');
        const c = maskSmoothRef.current!;
        if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
        return c;
    }
    function ensurePersonCanvas(w: number, h: number) {
        if (!personCanvasRef.current) personCanvasRef.current = document.createElement('canvas');
        const c = personCanvasRef.current!;
        if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
        return c;
    }
    function ensureWorkCanvas(w: number, h: number) {
        if (!workCanvasRef.current) workCanvasRef.current = document.createElement('canvas');
        const c = workCanvasRef.current!;
        if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
        return c;
    }

    function getSmoothedMask(maskC: HTMLCanvasElement, outW: number, outH: number, featherOutPx: number) {
        const inW = maskC.width, inH = maskC.height;
        if (!inW || !inH || featherOutPx <= 0) return maskC;
        const scaleToOut = outW / inW;
        const blurPxMask = Math.max(0.25, featherOutPx / Math.max(1e-6, scaleToOut));
        const tmp = ensureMaskSmoothCanvas(inW, inH);
        const tctx = tmp.getContext('2d')!;
        tctx.clearRect(0, 0, inW, inH);
        tctx.filter = `blur(${blurPxMask}px)`;
        tctx.drawImage(maskC, 0, 0);
        tctx.filter = 'none';
        return tmp;
    }

    const ensureModel = useCallback(async () => {
        if (!segRef.current) {
            const { segmenter, backendLabel } = await createSelfieSegmenterTFJS({ modelType: 'general' });
            segRef.current = segmenter;
            setBackend(backendLabel);
            backendRef.current = backendLabel;
        }
        return segRef.current!;
    }, []);

    const emitMetrics = useCallback(() => {
        const now = performance.now();
        if (now - lastEmitRef.current < 250) return;
        lastEmitRef.current = now;
        window.dispatchEvent(new CustomEvent('metrics:update', {
            detail: {
                backend: backendRef.current,
                fps: fpsRef.current,
                latency: latencyRef.current,
                status: statusRef.current
            }
        }));
    }, []);

    useEffect(() => {
        const onOverlay = (e: Event) => {
            const data = (e as CustomEvent<OverlayData>).detail;
            setOverlay(data ?? null);
        };
        window.addEventListener("overlay:update", onOverlay as EventListener);
        return () => window.removeEventListener("overlay:update", onOverlay as EventListener);
    }, []);

    const renderFrame = useCallback(async () => {
        const video = videoRef.current!, canvas = outCanvasRef.current!;
        const ctx = canvas.getContext('2d', { alpha: true })!;

        const W = video.videoWidth | 0, H = video.videoHeight | 0;
        if (!W || !H) { rafRef.current = requestAnimationFrame(renderFrame); return; }
        if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }

        try {
            const seg = await ensureModel();

            const s = 0.75;
            const inW = Math.max(8, Math.round(W * s));
            const inH = Math.max(8, Math.round(H * s));
            const workC = ensureWorkCanvas(inW, inH);
            const wctx = workC.getContext('2d')!;
            wctx.clearRect(0, 0, inW, inH);
            wctx.drawImage(video, 0, 0, inW, inH);

            const t1 = performance.now();
            const people = await seg.segmentPeople(workC, { flipHorizontal: false, multiSegmentation: false, segmentBodyParts: false });
            const hasPerson = !!(people && people.length);

            let maskC: HTMLCanvasElement | null = null;
            if (hasPerson) {
                const maskImg = await makeBinaryMask(people, 0.7, { width: inW, height: inH });
                maskC = ensureMaskCanvas(maskImg.width, maskImg.height);
                maskC.getContext('2d')!.putImageData(maskImg, 0, 0);
                maskC = getSmoothedMask(maskC, W, H, featherPxRef.current);
            }
            const t2 = performance.now();
            const inferMs = Number((t2 - t1).toFixed(1));
            setLatency(inferMs);
            latencyRef.current = inferMs;

            const personC = ensurePersonCanvas(W, H);
            const pctx = personC.getContext('2d')!;
            pctx.save();
            pctx.clearRect(0, 0, W, H);
            if (hasPerson && maskC) {
                pctx.translate(W, 0); pctx.scale(-1, 1);
                pctx.drawImage(video, 0, 0, W, H);
                pctx.globalCompositeOperation = 'destination-in';
                pctx.drawImage(maskC, 0, 0, maskC.width, maskC.height, 0, 0, W, H);
            }
            pctx.restore();

            const effOpacity = hasPerson ? bgOpacityRef.current : 0.0;
            ctx.save();
            ctx.clearRect(0, 0, W, H);

            const realBgAlpha = 1 - effOpacity;
            if (realBgAlpha > 0) {
                ctx.globalAlpha = realBgAlpha;
                ctx.globalCompositeOperation = 'source-over';
                ctx.drawImage(video, 0, 0, W, H);
                if (hasPerson && maskC) {
                    ctx.globalCompositeOperation = 'destination-out';
                    ctx.drawImage(maskC, 0, 0, maskC.width, maskC.height, 0, 0, W, H);
                }
            }

            if (effOpacity > 0) {
                ctx.globalAlpha = effOpacity;
                ctx.globalCompositeOperation = 'source-over';
                if (bgImage) drawCover(ctx, bgImage, W, H);
                else { ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H); }
            }

            if (hasPerson) {
                ctx.globalAlpha = 1.0;
                ctx.globalCompositeOperation = 'source-over';
                ctx.drawImage(personC, 0, 0, W, H);
            }

            ctx.restore();
        } catch (e) {
            console.error('[CameraPanel] renderFrame error:', e);
        }

        const now = performance.now();
        fpsWin.current.frames += 1;
        const dt = now - fpsWin.current.last;
        if (dt >= 1000) {
            const fpsVal = Math.round((fpsWin.current.frames * 1000) / dt);
            setFps(fpsVal);
            fpsRef.current = fpsVal;
            fpsWin.current.frames = 0; fpsWin.current.last = now;
        }

        emitMetrics();
        rafRef.current = requestAnimationFrame(renderFrame);
    }, [ensureModel, bgImage, emitMetrics]);

    const startCamera = useCallback(async () => {
        if (running) return;
        try {
            if (!selectedBg) { alert('Сначала выберите фон.'); return; }

            const stream = await navigator.mediaDevices.getUserMedia({
                video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' },
                audio: false
            });
            const video = videoRef.current!;
            video.srcObject = stream;

            await new Promise<void>((res) => {
                video.onloadedmetadata = async () => { try { await video.play(); } catch { } res(); };
            });

            const vw = video.videoWidth || 1280;
            const vh = video.videoHeight || 720;
            setVidSize({ w: vw, h: vh });
            const canvas = outCanvasRef.current!;
            canvas.width = vw; canvas.height = vh;

            await ensureModel();
            setRunning(true);
            statusRef.current = 'Камера запущена';

            fpsRef.current = 0;
            latencyRef.current = 0;
            emitMetrics();

            if (rafRef.current) cancelAnimationFrame(rafRef.current);
            rafRef.current = requestAnimationFrame(renderFrame);
        } catch (e) {
            console.error('[CameraPanel] startCamera failed:', e);
        }
    }, [renderFrame, running, selectedBg, ensureModel, emitMetrics]);

    const stopCamera = useCallback(() => {
        if (rafRef.current) cancelAnimationFrame(rafRef.current);
        rafRef.current = null;

        const video = videoRef.current;
        if (video?.srcObject instanceof MediaStream) {
            video.srcObject.getTracks().forEach(t => t.stop());
            video.srcObject = null;
        }

        setRunning(false);
        statusRef.current = 'Камера остановлена';
        emitMetrics();

        const c = outCanvasRef.current!;
        c.getContext('2d')!.clearRect(0, 0, c.width, c.height);
    }, [emitMetrics]);

    // внешние события
    useEffect(() => {
        const onStart = () => startCamera();
        const onStop = () => stopCamera();
        const onOpacity = (e: Event) => {
            const v = Number((e as CustomEvent).detail); // 0..100
            bgOpacityRef.current = Math.max(0, Math.min(1, v / 100));
        };
        const onFeather = (e: Event) => {
            const v = Number((e as CustomEvent).detail); // 0..15
            featherPxRef.current = Math.max(0, Math.min(15, Math.round(v)));
        };
        window.addEventListener('camera:start', onStart);
        window.addEventListener('camera:stop', onStop);
        window.addEventListener('ui:opacity', onOpacity as EventListener);
        window.addEventListener('ui:feather', onFeather as EventListener);
        return () => {
            window.removeEventListener('camera:start', onStart);
            window.removeEventListener('camera:stop', onStop);
            window.removeEventListener('ui:opacity', onOpacity as EventListener);
            window.removeEventListener('ui:feather', onFeather as EventListener);
        };
    }, [startCamera, stopCamera]);

    const aspectStr = vidSize ? `${vidSize.w} / ${vidSize.h}` : '16 / 9';

    function renderOverlay() {
        if (!running || !overlay) return null;

        const lvl = overlay.privacy_level ?? "medium";
        const showLow = lvl === "low" || lvl === "medium" || lvl === "high";
        const showMed = lvl === "medium" || lvl === "high";
        const showHigh = lvl === "high";

        const primary = overlay.branding?.corporate_colors?.primary || "#0052CC";
        const secondary = overlay.branding?.corporate_colors?.secondary || "#00B8D9";

        return (
            <div
                style={{
                    position: "absolute",
                    top: 12,
                    right: 12,
                    maxWidth: 420,
                    color: "#fff",
                    padding: 12,
                    borderRadius: 12,
                    border: "1px solid rgba(255,255,255,0.18)",
                    background:
                        "linear-gradient(135deg, rgba(20,20,20,0.55), rgba(20,20,20,0.35))",
                    boxShadow: "0 6px 24px rgba(0,0,0,0.35)",
                    backdropFilter: "blur(6px)",
                    WebkitBackdropFilter: "blur(6px)",
                    pointerEvents: "none",
                    display: "grid",
                    gap: 10,
                }}
            >
                <div
                    style={{
                        height: 3,
                        width: "100%",
                        borderRadius: 2,
                        background: `linear-gradient(90deg, ${primary}, ${secondary})`,
                    }}
                />

                <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                    {overlay.branding?.logo_url && (
                        <img
                            src={overlay.branding.logo_url}
                            alt="logo"
                            style={{
                                width: 52,
                                height: 52,
                                objectFit: "contain",
                                borderRadius: 10,
                                background: "rgba(255,255,255,0.06)",
                                boxShadow: "0 2px 10px rgba(0,0,0,0.2)",
                                flexShrink: 0,
                            }}
                        />
                    )}

                    {showLow && (
                        <div style={{ display: "grid", gap: 4 }}>
                            <div style={{ fontSize: 18, fontWeight: 800, lineHeight: 1.1 }}>
                                {overlay.full_name}
                            </div>
                            {overlay.position && (
                                <div style={{ fontSize: 13, opacity: 0.95 }}>{overlay.position}</div>
                            )}
                        </div>
                    )}
                </div>

                {showMed && (
                    <div style={{ fontSize: 12, opacity: 0.92, display: "grid", gap: 4 }}>
                        {overlay.company && <div><b>Компания:</b> {overlay.company}</div>}
                        {overlay.department && <div><b>Отдел:</b> {overlay.department}</div>}
                        {overlay.office_location && <div><b>Локация:</b> {overlay.office_location}</div>}
                    </div>
                )}

                {showHigh && (overlay.contact?.email || overlay.contact?.telegram) && (
                    <div style={{ fontSize: 12, display: "grid", gap: 4 }}>
                        {overlay.contact.email && <div><b>Email:</b> {overlay.contact.email}</div>}
                        {overlay.contact.telegram && <div><b>Telegram:</b> {overlay.contact.telegram}</div>}
                    </div>
                )}
            </div>
        );
    }


    return (
        <section className="camera">
            <div className="pane-content">
                <div
                    ref={wrapRef}
                    style={{
                        width: '100%',
                        aspectRatio: aspectStr,
                        position: 'relative',
                        borderRadius: 12,
                        overflow: 'hidden',
                        background: '#000',
                        display: running ? 'block' : 'none'
                    }}
                    aria-hidden={!running}
                >
                    <canvas
                        ref={outCanvasRef}
                        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', display: 'block' }}
                    />
                    {renderOverlay()}
                </div>

                {!running && (
                    <>
                        <div className="bg-grid">
                            {BACKGROUNDS.map((bg) => (
                                <button
                                    key={bg.id}
                                    className={'bg-item' + (selectedBg === bg.id ? ' selected' : '')}
                                    onClick={() => setSelectedBg(bg.id)}
                                    aria-pressed={selectedBg === bg.id}
                                    title={bg.label}
                                    style={{
                                        backgroundImage: `url(${bg.src})`,
                                        backgroundSize: 'cover',
                                        backgroundPosition: 'center',
                                    }}
                                >
                                    <span className="bg-label">{bg.label}</span>
                                </button>
                            ))}
                        </div>
                        <div className="hint">Выберите фон, затем используйте кнопку снизу, чтобы запустить камеру.</div>
                    </>
                )}

                <video ref={videoRef} playsInline muted style={{ display: 'none' }} />
            </div>
        </section>
    );
}
