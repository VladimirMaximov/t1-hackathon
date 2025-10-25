import { useEffect, useState } from "react";

type Metrics = {
    backend: string;
    fps: number;
    latency: number;
    status: string;
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

    const fmtFps = (x?: number) => (x == null ? "—" : `${x}`);
    const fmtMs = (x?: number) => (x == null ? "—" : `${x.toFixed(1)}`);

    return (
        <section className="metrics">
            <div className="pane-content">
                <h3>Информация о системе</h3>
                <ul className="metrics-list" style={{ listStyle: "none", margin: 0, padding: 0, lineHeight: 1.6 }}>
                    <li><b>Backend:</b> {m?.backend ?? "—"}</li>
                    <li><b>FPS:</b> {fmtFps(m?.fps)}</li>
                    <li><b>Lat(ms):</b> {fmtMs(m?.latency)}</li>
                </ul>
            </div>
        </section>
    );
}
