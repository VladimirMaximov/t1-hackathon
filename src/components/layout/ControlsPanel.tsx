export default function ControlsPanel() {
    return (
        <div className="pane-content controls-content">
            <button>Старт камера</button>
            <button>Стоп</button>
            <select defaultValue="webgpu">
                <option value="webgpu">Бэкенд: WebGPU</option>
                <option value="wasm">Бэкенд: WASM</option>
            </select>
            <select defaultValue="none">
                <option value="none">Фон: нет</option>
                <option value="blur">Фон: размытие</option>
                <option value="brand">Фон: персональный</option>
            </select>
        </div>
    );
}
