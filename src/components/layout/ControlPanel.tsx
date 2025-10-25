import { useEffect, useRef, useState } from "react";

type EmployeeJSON = {
    employee?: {
        full_name?: string;
        position?: string;
        company?: string;
        department?: string;
        office_location?: string;
        contact?: { email?: string; telegram?: string };
        branding?: {
            logo_url?: string;
            corporate_colors?: { primary?: string; secondary?: string };
            slogan?: string;
        };
        privacy_level?: "low" | "medium" | "high";
    };
};

export default function ControlPanel() {
    const [running, setRunning] = useState(false);
    const [opacity, setOpacity] = useState(100);
    const [feather, setFeather] = useState(0);
    const [bgSelected, setBgSelected] = useState<{ id: string; src: string } | null>(null);
    const [fileName, setFileName] = useState<string>("");

    const fileInputRef = useRef<HTMLInputElement | null>(null);

    useEffect(() => {
        function onBg(ev: Event) {
            const detail = (ev as CustomEvent).detail as { id: string; src: string } | null;
            setBgSelected(detail ?? null);
        }
        window.addEventListener("bg:selected", onBg);
        return () => window.removeEventListener("bg:selected", onBg);
    }, []);

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

    function sanitize(obj: EmployeeJSON["employee"] | undefined) {
        const e = obj ?? {};
        const lvl = (e.privacy_level ?? "medium") as "low" | "medium" | "high";
        return {
            full_name: e.full_name ?? "",
            position: e.position ?? "",
            company: e.company ?? "",
            department: e.department ?? "",
            office_location: e.office_location ?? "",
            contact: {
                email: e.contact?.email ?? "",
                telegram: e.contact?.telegram ?? ""
            },
            branding: {
                logo_url: e.branding?.logo_url ?? "",
                corporate_colors: {
                    primary: e.branding?.corporate_colors?.primary ?? "#0052CC",
                    secondary: e.branding?.corporate_colors?.secondary ?? "#00B8D9"
                },
                slogan: e.branding?.slogan ?? ""
            },
            privacy_level: lvl
        };
    }

    async function onFileChosen(e: React.ChangeEvent<HTMLInputElement>) {
        const file = e.target.files?.[0];
        if (!file) return;
        setFileName(file.name);
        try {
            const text = await file.text();
            const json = JSON.parse(text) as EmployeeJSON;
            const data = sanitize(json.employee);
            window.dispatchEvent(new CustomEvent("overlay:update", { detail: data }));
        } catch (err) {
            console.error("[JSON] parse error:", err);
            alert("Не удалось прочитать JSON. Проверьте формат.");
        } finally {
            e.target.value = "";
        }
    }

    useEffect(() => {
        window.dispatchEvent(new CustomEvent("ui:opacity", { detail: opacity }));
    }, [opacity]);

    useEffect(() => {
        window.dispatchEvent(new CustomEvent("ui:feather", { detail: feather }));
    }, [feather]);

    return (
        <section className="controls">
            <div className="pane-content">
                <div className="controls-content" style={{ display: "grid", gap: 12 }}>

                    <button
                        className="confirm-btn"
                        onClick={handleStartStop}
                        disabled={!running && !bgSelected}
                    >
                        {running ? "Завершить" : "Зафиксировать фон и начать"}
                    </button>

                    <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
                        <button className="confirm-btn" onClick={handlePickFile}>
                            Загрузить JSON данные
                        </button>
                        {fileName && <span className="hint">Файл: <b>{fileName}</b></span>}
                        <input
                            ref={fileInputRef}
                            type="file"
                            accept="application/json"
                            onChange={onFileChosen}
                            style={{ display: "none" }}
                        />
                    </div>

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
                            Непрозрачность: <b>{opacity}</b>
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
                            Сглаживание: <b>{feather}px</b>
                        </span>
                    </div>
                </div>
            </div>
        </section>
    );
}
