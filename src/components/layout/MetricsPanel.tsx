import { useEffect, useState } from "react";

type Metrics = {
    fps: number;
    cpuAvg: number;
    cpuPeak: number;
    gpuAvg: number;
    gpuPeak: number;
};

export default function MetricsPanel() {
    const [m, setM] = useState<Metrics | null>(null);

    useEffect(() => {
        const handler = (e: Event) => {
            const detail = (e as CustomEvent<Metrics>).detail;
            setM(detail);
        };
        window.addEventListener("metrics:update", handler as EventListener);
        return () => window.removeEventListener("metrics:update", handler as EventListener);
    }, []);

    const fmtMs = (x?: number) => (x == null ? "—" : `${x.toFixed(1)} мс`);
    const fmtFps = (x?: number) => (x == null ? "—" : `${x}`);

    return (
        <div className="pane-content">
            <h3>Информация от системы</h3>
            <ul className="metrics-list">
                <li>FPS: {fmtFps(m?.fps)}</li>
                <li>CPU: средняя {fmtMs(m?.cpuAvg)}; пик {fmtMs(m?.cpuPeak)};</li>
                <li>GPU: средняя {fmtMs(m?.gpuAvg)}; пик {fmtMs(m?.gpuPeak)};</li>
            </ul>
        </div>
    );
}
