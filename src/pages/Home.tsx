import CameraPanel from "@/components/layout/CameraPanel";
import ControlPanel from "@/components/layout/ControlPanel";
import MetricsPanel from "@/components/layout/MetricsPanel";

export default function Home() {
    return (
        <div className="app-grid">
            <CameraPanel />
            <MetricsPanel />
            <ControlPanel />
        </div>
    );
}
