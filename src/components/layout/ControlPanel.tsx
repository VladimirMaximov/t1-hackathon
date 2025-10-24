import { useEffect, useRef, useState } from "react";

export default function ControlPanel() {
    const [running, setRunning] = useState(false);
    const [opacity, setOpacity] = useState(100);   // 0..100
    const [feather, setFeather] = useState(0);     // 0..15
    const [bgSelected, setBgSelected] = useState<{ id: string; src: string } | null>(null);

    const fileInputRef = useRef<HTMLInputElement | null>(null);

    // узнаём от CameraPanel, выбран ли фон
    useEffect(() => {
        function onBg(ev: Event) {
            const detail = (ev as CustomEvent).detail as { id: string; src: string } | null;
            setBgSelected(detail ?? null);
        }
        window.addEventListener("bg:selected", onBg);
        return () => window.removeEventListener("bg:selected", onBg);
    }, []);

    // синхронизируемся, если CameraPanel сам сообщил о стопе/старте
    useEffect(() => {
        const onStarted = () => setRunning(true);
        const onStopped = () => setRunning(false);
        window.addEventListener("camera:started", onStarted);
        window.addEventListener("camera:stopped", onStopped);
        return () => {
            window.removeEventListener("camera:started", onStarted);
            window.removeEventListener("camera:stopped", onStopped);
        };
    }, []);

    function handleStartStop() {
        if (!running) {
            if (!bgSelected) {
                alert("Сначала выберите фон в верхнем блоке.");
                return;
            }
            window.dispatchEvent(new CustomEvent("camera:start"));
            setRunning(true);
        } else {
            window.dispatchEvent(new CustomEvent("camera:stop"));
            setRunning(false);
        }
    }

    function handlePickFile() {
        fileInputRef.current?.click();
    }

    function onFileChosen(e: React.ChangeEvent<HTMLInputElement>) {
        const file = e.target.files?.[0];
        if (!file) return;
        console.log("[JSON] выбран файл:", file.name, file.size, "bytes");
    }

    // уведомляем CameraPanel о непрозрачности (0..100)
    useEffect(() => {
        window.dispatchEvent(new CustomEvent("ui:opacity", { detail: opacity }));
    }, [opacity]);

    // уведомляем CameraPanel о сглаживании маски (0..15 px)
    useEffect(() => {
        window.dispatchEvent(new CustomEvent("ui:feather", { detail: feather }));
    }, [feather]);

    return (
        <section className="controls">
            <div className="pane-content">
                <div className="controls-content">
                    {/* Старт / Стоп */}
                    <button
                        className="confirm-btn"
                        onClick={handleStartStop}
                        disabled={!running && !bgSelected}
                    >
                        {running ? "Остановить камеру и вернуться" : "Зафиксировать выбор и запустить камеру"}
                    </button>

                    {/* Загрузка JSON */}
                    <button onClick={handlePickFile}>Загрузить JSON данные</button>
                    <input
                        ref={fileInputRef}
                        type="file"
                        accept="application/json"
                        onChange={onFileChosen}
                        style={{ display: "none" }}
                    />

                    {/* Слайдер непрозрачности фона */}
                    <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                        <span>0</span>
                        <input
                            type="range"
                            min={0}
                            max={100}
                            value={opacity}
                            onChange={(e) => setOpacity(parseInt(e.target.value, 10))}
                            title="Непрозрачность фона"
                        />
                        <span>100</span>
                        <span className="hint">
                            Непрозрачность фона: <b>{opacity}</b>
                        </span>
                    </div>

                    {/* Слайдер сглаживания маски */}
                    <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                        <span>0</span>
                        <input
                            type="range"
                            min={0}
                            max={15}
                            step={1}
                            value={feather}
                            onChange={(e) => setFeather(parseInt(e.target.value, 10))}
                            title="Сглаживание края маски (px)"
                        />
                        <span>15</span>
                        <span className="hint">
                            Сглаживание маски: <b>{feather}px</b>
                        </span>
                    </div>
                </div>
            </div>
        </section>
    );
}
