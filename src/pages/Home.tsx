import CameraPane from "@/components/layout/CameraPane";
import MetricsPanel from "@/components/layout/MetricsPanel";
import ControlsPanel from "@/components/layout/ControlsPanel";

export default function Home() {
    return (
        <div className="app-grid">
            <section className="pane camera"><CameraPane /></section>
            <aside className="pane metrics"><MetricsPanel /></aside>
            <footer className="pane controls"><ControlsPanel /></footer>
        </div>
    );
}
