import React, { useEffect, useState } from 'react';

type Metrics = {
    backend: string;
    fps: number;
    latency: number;
    status: string;
};

export default function MetricsPanel() {
    const [m, setM] = useState<Metrics>({
        backend: '—',
        fps: 0,
        latency: 0,
        status: 'Камера остановлена',
    });

    useEffect(() => {
        const onMetrics = (e: Event) => {
            const d = (e as CustomEvent).detail as Partial<Metrics>;
            setM((prev) => ({ ...prev, ...d }));
        };
        const onStarted = () => setM((prev) => ({ ...prev, status: 'Камера запущена' }));
        const onStopped = () => setM((prev) => ({ ...prev, status: 'Камера остановлена' }));

        window.addEventListener('metrics:update', onMetrics as EventListener);
        window.addEventListener('camera:started', onStarted);
        window.addEventListener('camera:stopped', onStopped);
        return () => {
            window.removeEventListener('metrics:update', onMetrics as EventListener);
            window.removeEventListener('camera:started', onStarted);
            window.removeEventListener('camera:stopped', onStopped);
        };
    }, []);

    return (
        <section className="metrics">
            <h3 style={{ color: '#1f6feb', marginTop: 0 }}>Информация от системы</h3>
            <div
                style={{
                    whiteSpace: 'pre-wrap',
                    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
                    border: '1px solid #e5e7eb',
                    background: '#f7f8fb',
                    borderRadius: 10,
                    padding: 10,
                }}
            >
                Backend: {m.backend} | FPS: {m.fps} | Lat(ms): {m.latency || '—'} | Статус: {m.status}
            </div>
        </section>
    );
}
