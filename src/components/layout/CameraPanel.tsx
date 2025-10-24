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
    { id: 'bg1', label: 'фон 1', src: '/backgrounds/bg1.jpg' },
    { id: 'bg2', label: 'фон 2', src: '/backgrounds/bg2.jpg' },
    { id: 'bg3', label: 'фон 3', src: '/backgrounds/bg3.jpg' },
    { id: 'bg4', label: 'фон 4', src: '/backgrounds/bg4.jpg' },
    { id: 'bg5', label: 'фон 5', src: '/backgrounds/bg5.jpg' },
    { id: 'bg6', label: 'фон 6', src: '/backgrounds/bg6.jpg' }
];

export default function CameraPanel() {
    // UI
    const [selectedBg, setSelectedBg] = useState<string | null>(null);
    const [running, setRunning] = useState(false);

    // размеры блока камеры
    const [vidSize, setVidSize] = useState<{ w: number; h: number } | null>(null);
    const wrapRef = useRef<HTMLDivElement | null>(null);

    // DOM
    const videoRef = useRef<HTMLVideoElement | null>(null);
    const outCanvasRef = useRef<HTMLCanvasElement | null>(null);

    // оффскрины
    const maskCanvasRef = useRef<HTMLCanvasElement | null>(null);   // маска (входной размер)
    const personCanvasRef = useRef<HTMLCanvasElement | null>(null); // зеркальный человек (выходной размер)
    const workCanvasRef = useRef<HTMLCanvasElement | null>(null);   // стабильный вход для модели

    // сегментер (TFJS) и бэкенд
    const segRef = useRef<BodySegmenter | null>(null);
    const [backend, setBackend] = useState<TfjsBackend | '—'>('—');

    // цикл
    const rafRef = useRef<number | null>(null);

    // метрики
    const [fps, setFps] = useState(0);
    const [latency, setLatency] = useState(0);
    const statusRef = useRef<'Камера запущена' | 'Камера остановлена'>('Камера остановлена');
    const fpsWin = useRef({ last: performance.now(), frames: 0 });

    // фон
    const [bgFileUrl, setBgFileUrl] = useState<string | null>(null);
    const [bgImage, setBgImage] = useState<HTMLImageElement | null>(null);
    const bgOpacityRef = useRef(1.0); // 0..1 — непрозрачность картинок-фона (OVERLAY над реальным фоном)

    // загрузка изображения фона
    useEffect(() => {
        if (!bgFileUrl) { setBgImage(null); return; }
        const img = new Image();
        img.onload = () => setBgImage(img);
        img.onerror = () => setBgImage(null);
        img.src = bgFileUrl;
        return () => URL.revokeObjectURL(bgFileUrl);
    }, [bgFileUrl]);

    // селект фона → уведомляем ControlPanel и подгружаем превью
    useEffect(() => {
        const payload = selectedBg
            ? { id: selectedBg, src: BACKGROUNDS.find(b => b.id === selectedBg)!.src }
            : null;
        window.dispatchEvent(new CustomEvent('bg:selected', { detail: payload }));

        const src = selectedBg ? BACKGROUNDS.find(b => b.id === selectedBg)?.src ?? null : null;
        setBgFileUrl(src ?? null);
    }, [selectedBg]);

    // адаптация outCanvas под контейнер
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

    // оффскрины
    function ensureMaskCanvas(w: number, h: number) {
        if (!maskCanvasRef.current) maskCanvasRef.current = document.createElement('canvas');
        const c = maskCanvasRef.current!;
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

    // === TFJS-сегментер
    const ensureModel = useCallback(async () => {
        if (!segRef.current) {
            const { segmenter, backendLabel } = await createSelfieSegmenterTFJS({
                modelType: 'general',
                // modelUrl: можно НЕ указывать — возьмётся дефолтный CDN от либы.
            });
            segRef.current = segmenter;
            setBackend(backendLabel); // 'webgpu' | 'wasm' | 'webgl'
        }
        return segRef.current!;
    }, []);

    // композиция кадра
    const renderFrame = useCallback(async () => {
        const video = videoRef.current!, canvas = outCanvasRef.current!;
        const ctx = canvas.getContext('2d', { alpha: true })!;

        const W = video.videoWidth | 0, H = video.videoHeight | 0;
        if (!W || !H) { rafRef.current = requestAnimationFrame(renderFrame); return; }
        if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }

        try {
            const seg = await ensureModel();

            // Стабильный вход для модели (как в твоём HTML): уменьшаем кадр и подаём canvas
            const s = 0.75; // масштаб входа (можно тюнить)
            const inW = Math.max(8, Math.round(W * s));
            const inH = Math.max(8, Math.round(H * s));
            const workC = ensureWorkCanvas(inW, inH);
            const wctx = workC.getContext('2d')!;
            wctx.clearRect(0, 0, inW, inH);
            wctx.drawImage(video, 0, 0, inW, inH);

            // 1) сегментация workCanvas
            const t1 = performance.now();
            const people = await seg.segmentPeople(workC, { flipHorizontal: false, multiSegmentation: false, segmentBodyParts: false });
            const hasPerson = !!(people && people.length);
            // 2) маска только если есть человек
            let maskC: HTMLCanvasElement | null = null;
            if (hasPerson) {
                const maskImg = await makeBinaryMask(people, 0.7, { width: inW, height: inH });
                maskC = ensureMaskCanvas(maskImg.width, maskImg.height);
                maskC.getContext('2d')!.putImageData(maskImg, 0, 0);
            }
            const t2 = performance.now();
            setLatency(Number((t2 - t1).toFixed(1)));

            // 3) слой «зеркальный человек»
            const personC = ensurePersonCanvas(W, H);
            const pctx = personC.getContext('2d')!;
            pctx.save();
            pctx.clearRect(0, 0, W, H);
            if (hasPerson && maskC) {
                pctx.translate(W, 0); pctx.scale(-1, 1);   // зеркалим только человека
                pctx.drawImage(video, 0, 0, W, H);
                pctx.globalCompositeOperation = 'destination-in';
                pctx.drawImage(maskC, 0, 0, maskC.width, maskC.height, 0, 0, W, H); // масштабируем маску
            }
            pctx.restore();

            // 4) композиция: реальный фон (с вырезом) + картинка-фон (opacity) + человек
            const effOpacity = hasPerson ? bgOpacityRef.current : 0.0;

            ctx.save();
            ctx.clearRect(0, 0, W, H);

            // a) реальный фон (НЕ зеркалим), вырезаем человека
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

            // b) картинка-фон (как cover) с альфой effOpacity
            if (effOpacity > 0) {
                ctx.globalAlpha = effOpacity;
                ctx.globalCompositeOperation = 'source-over';
                if (bgImage) drawCover(ctx, bgImage, W, H);
                else { ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H); }
            }

            // c) человек поверх
            if (hasPerson) {
                ctx.globalAlpha = 1.0;
                ctx.globalCompositeOperation = 'source-over';
                ctx.drawImage(personC, 0, 0, W, H);
            }

            ctx.restore();
        } catch (e) {
            console.error('[CameraPanel] renderFrame error:', e);
        }

        // FPS
        const now = performance.now();
        fpsWin.current.frames += 1;
        const dt = now - fpsWin.current.last;
        if (dt >= 1000) {
            const fpsVal = Math.round((fpsWin.current.frames * 1000) / dt);
            setFps(fpsVal);
            fpsWin.current.frames = 0; fpsWin.current.last = now;
        }

        rafRef.current = requestAnimationFrame(renderFrame);
    }, [ensureModel, bgImage]);

    // старт / стоп (события от ControlPanel)
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
            window.dispatchEvent(new CustomEvent('camera:started', { detail: { backend } }));

            fpsWin.current = { last: performance.now(), frames: 0 };
            if (rafRef.current) cancelAnimationFrame(rafRef.current);
            rafRef.current = requestAnimationFrame(renderFrame);
        } catch (e) {
            console.error('[CameraPanel] startCamera failed:', e);
        }
    }, [renderFrame, running, selectedBg, ensureModel, backend]);

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
        window.dispatchEvent(new Event('camera:stopped'));
        const c = outCanvasRef.current!;
        c.getContext('2d')!.clearRect(0, 0, c.width, c.height);
    }, []);

    // внешние события
    useEffect(() => {
        const onStart = () => startCamera();
        const onStop = () => stopCamera();
        const onOpacity = (e: Event) => {
            const v = Number((e as CustomEvent).detail); // 0..100 — непрозрачность фон-картинки
            bgOpacityRef.current = Math.max(0, Math.min(1, v / 100));
        };
        window.addEventListener('camera:start', onStart);
        window.addEventListener('camera:stop', onStop);
        window.addEventListener('ui:opacity', onOpacity as EventListener);
        return () => {
            window.removeEventListener('camera:start', onStart);
            window.removeEventListener('camera:stop', onStop);
            window.removeEventListener('ui:opacity', onOpacity as EventListener);
        };
    }, [startCamera, stopCamera]);

    // метрики → MetricsPanel
    useEffect(() => {
        const id = window.setInterval(() => {
            window.dispatchEvent(new CustomEvent('metrics:update', {
                detail: { backend, fps, latency, status: statusRef.current }
            }));
        }, 500);
        return () => window.clearInterval(id);
    }, [backend, fps, latency]);

    const aspectStr = vidSize ? `${vidSize.w} / ${vidSize.h}` : '16 / 9';

    return (
        <section className="camera">
            <div className="pane-content">
                {/* Вывод */}
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
                </div>

                {/* Экран выбора фона — пока камера не запущена */}
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

                {/* скрытые элементы */}
                <video ref={videoRef} playsInline muted style={{ display: 'none' }} />
            </div>
        </section>
    );
}
