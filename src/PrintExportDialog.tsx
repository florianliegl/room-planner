import { useEffect, useMemo, useRef, useState } from "react";
import { Download, Printer, X } from "lucide-react";
import { calculatePrintLayout } from "./metricPlan";
import { defaultPrintOptions, type MetricPlan, type PrintExportOptions } from "./plannerTypes";

const storageKey = "room-planner-print-options-v1";
const bedPresets = [
  { label: "180 × 180 mm", width: 180, depth: 180 },
  { label: "220 × 220 mm", width: 220, depth: 220 },
  { label: "256 × 256 mm", width: 256, depth: 256 },
  { label: "300 × 300 mm", width: 300, depth: 300 },
  { label: "350 × 350 mm", width: 350, depth: 350 },
];

type Props = {
  plan: MetricPlan;
  calibrated: boolean;
  onClose: () => void;
};

function loadOptions() {
  try {
    return { ...defaultPrintOptions, ...JSON.parse(localStorage.getItem(storageKey) ?? "{}") } as PrintExportOptions;
  } catch {
    return defaultPrintOptions;
  }
}

export default function PrintExportDialog({ plan, calibrated, onClose }: Props) {
  const [options, setOptions] = useState<PrintExportOptions>(loadOptions);
  const [progress, setProgress] = useState(0);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const workerRef = useRef<Worker | null>(null);
  const layout = useMemo(() => calculatePrintLayout(plan, options), [plan, options]);
  const canExport = calibrated && plan.outlineM.length >= 3 && plan.walls.length >= 3 && !status;

  useEffect(() => {
    localStorage.setItem(storageKey, JSON.stringify(options));
  }, [options]);

  useEffect(() => () => workerRef.current?.terminate(), []);

  const patch = <K extends keyof PrintExportOptions>(key: K, value: PrintExportOptions[K]) =>
    setOptions((current) => ({ ...current, [key]: value }));

  const startExport = () => {
    setError("");
    setProgress(1);
    setStatus("Preparing geometry");
    const worker = new Worker(new URL("./printWorker.ts", import.meta.url), { type: "module" });
    workerRef.current = worker;
    worker.onmessage = (event) => {
      if (event.data.type === "progress") {
        setProgress(event.data.progress);
        setStatus(event.data.status);
      } else if (event.data.type === "complete") {
        const blob = new Blob([event.data.buffer], { type: event.data.mimeType });
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = event.data.filename;
        link.click();
        URL.revokeObjectURL(url);
        worker.terminate();
        workerRef.current = null;
        setProgress(100);
        setStatus("");
      } else if (event.data.type === "error") {
        setError(event.data.message);
        worker.terminate();
        workerRef.current = null;
        setStatus("");
      }
    };
    worker.onerror = (event) => {
      setError(event.message || "Could not generate the print file.");
      worker.terminate();
      workerRef.current = null;
      setStatus("");
    };
    worker.postMessage({ plan, options, layout });
  };

  const cancel = () => {
    workerRef.current?.terminate();
    workerRef.current = null;
    setStatus("");
    setProgress(0);
  };

  const selectedPreset = bedPresets.find((preset) => preset.width === options.bedWidthMm && preset.depth === options.bedDepthMm);

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && !status && onClose()}>
      <div className="print-dialog" role="dialog" aria-modal="true" aria-labelledby="print-title">
        <header>
          <div>
            <span className="eyebrow">Manufacturing export</span>
            <h2 id="print-title"><Printer size={21} /> 3D Print</h2>
          </div>
          <button className="icon-button" onClick={onClose} disabled={Boolean(status)} aria-label="Close print export"><X /></button>
        </header>

        <div className="print-dialog-body">
          <section className="print-preview">
            <div className={`print-bed ${layout.rotated ? "rotated" : ""}`} style={{ aspectRatio: `${options.bedWidthMm} / ${options.bedDepthMm}` }}>
              {Array.from({ length: layout.partCount }, (_, index) => {
                const column = index % layout.columns;
                const row = Math.floor(index / layout.columns);
                return (
                  <div
                    key={index}
                    className="print-part"
                    style={{
                      left: `${(column / layout.columns) * 100}%`,
                      top: `${(row / layout.rows) * 100}%`,
                      width: `${100 / layout.columns}%`,
                      height: `${100 / layout.rows}%`,
                    }}
                  >
                    R{row + 1}C{column + 1}
                  </div>
                );
              })}
            </div>
            <div className="print-summary-grid">
              <div><span>Scale</span><strong>1:{layout.denominator.toFixed(layout.denominator < 10 ? 1 : 0)}</strong></div>
              <div><span>Size</span><strong>{layout.widthMm.toFixed(1)} × {layout.depthMm.toFixed(1)} mm</strong></div>
              <div><span>Height</span><strong>{layout.heightMm.toFixed(1)} mm</strong></div>
              <div><span>Objects</span><strong>{layout.partCount} room part{layout.partCount === 1 ? "" : "s"}</strong></div>
            </div>
            {layout.rotated && <p className="info-note">The model is rotated 90° to use the bed more efficiently.</p>}
            {layout.partCount > 1 && options.format === "3mf" && (
              <p className="info-note">All numbered pieces are stored as named objects in one 3MF. Isolate and center each piece in your slicer before printing.</p>
            )}
            {!calibrated && <p className="warning-note">Calibrate the plan scale before creating a print file.</p>}
            {plan.outlineM.length < 3 && <p className="warning-note">Close the flat outline before creating a print file.</p>}
            {layout.warnings.map((warning) => <p className="warning-note" key={warning}>{warning}</p>)}
          </section>

          <section className="print-settings">
            <div className="setting-group">
              <h3>Output</h3>
              <div className="segmented">
                <button className={options.format === "3mf" ? "active" : ""} onClick={() => patch("format", "3mf")}>3MF</button>
                <button className={options.format === "stl" ? "active" : ""} onClick={() => patch("format", "stl")}>STL</button>
              </div>
            </div>

            <div className="setting-group">
              <h3>Model height</h3>
              <div className="segmented">
                <button className={options.heightMode === "scaled" ? "active" : ""} onClick={() => patch("heightMode", "scaled")}>Scaled walls</button>
                <button className={options.heightMode === "low" ? "active" : ""} onClick={() => patch("heightMode", "low")}>Low profile</button>
              </div>
              {options.heightMode === "low" && <NumberField label="Wall height mm" value={options.lowProfileHeightMm} min={2} step={1} onChange={(value) => patch("lowProfileHeightMm", value)} />}
            </div>

            <div className="setting-group">
              <h3>Wall thickness</h3>
              <div className="segmented">
                <button className={options.thicknessMode === "real" ? "active" : ""} onClick={() => patch("thicknessMode", "real")}>Real scaled</button>
                <button className={options.thicknessMode === "slim" ? "active" : ""} onClick={() => patch("thicknessMode", "slim")}>Material saver</button>
              </div>
              {options.thicknessMode === "slim" && <NumberField label="Wall thickness mm" value={options.slimWallThicknessMm} min={0.4} step={0.1} onChange={(value) => patch("slimWallThicknessMm", value)} />}
            </div>

            <div className="setting-group compact-grid">
              <label className="check-row"><input type="checkbox" checked={options.includeFloor} onChange={(event) => patch("includeFloor", event.target.checked)} /> Include floor</label>
              {options.includeFloor && <NumberField label="Floor mm" value={options.floorThicknessMm} min={0.4} step={0.2} onChange={(value) => patch("floorThicknessMm", value)} />}
            </div>

            <div className="setting-group">
              <h3>Furniture</h3>
              <select value={options.furnitureMode} onChange={(event) => patch("furnitureMode", event.target.value as PrintExportOptions["furnitureMode"])}>
                <option value="none">Do not export furniture</option>
                <option value="loose">Separate loose scale models</option>
                <option value="fused">Fuse furniture into room</option>
              </select>
            </div>

            <div className="setting-group">
              <h3>Print bed</h3>
              <select
                value={selectedPreset ? `${selectedPreset.width}x${selectedPreset.depth}` : "custom"}
                onChange={(event) => {
                  const preset = bedPresets.find((item) => `${item.width}x${item.depth}` === event.target.value);
                  if (preset) setOptions((current) => ({ ...current, bedWidthMm: preset.width, bedDepthMm: preset.depth }));
                }}
              >
                {bedPresets.map((preset) => <option key={preset.label} value={`${preset.width}x${preset.depth}`}>{preset.label}</option>)}
                <option value="custom">Custom</option>
              </select>
              <div className="three-col">
                <NumberField label="Width mm" value={options.bedWidthMm} min={50} step={1} onChange={(value) => patch("bedWidthMm", value)} />
                <NumberField label="Depth mm" value={options.bedDepthMm} min={50} step={1} onChange={(value) => patch("bedDepthMm", value)} />
                <NumberField label="Margin mm" value={options.bedMarginMm} min={0} step={1} onChange={(value) => patch("bedMarginMm", value)} />
              </div>
            </div>

            <div className="setting-group">
              <h3>Scale</h3>
              <div className="segmented">
                <button className={options.scaleMode === "fit" ? "active" : ""} onClick={() => patch("scaleMode", "fit")}>Fill one bed</button>
                <button className={options.scaleMode === "manual" ? "active" : ""} onClick={() => patch("scaleMode", "manual")}>Manual scale</button>
              </div>
              {options.scaleMode === "manual" && <NumberField label="Scale 1 :" value={options.scaleDenominator} min={1} step={1} onChange={(value) => patch("scaleDenominator", value)} />}
              <label className="check-row"><input type="checkbox" checked={options.autoRotate} onChange={(event) => patch("autoRotate", event.target.checked)} /> Auto-rotate for best fit</label>
            </div>

            {layout.partCount > 1 && (
              <div className="setting-group">
                <h3>Friction connectors</h3>
                <NumberField label="Clearance mm" value={options.connectorClearanceMm} min={0} step={0.05} onChange={(value) => patch("connectorClearanceMm", value)} />
              </div>
            )}
          </section>
        </div>

        <footer>
          {error && <p className="export-error">{error}</p>}
          {status ? (
            <div className="export-progress">
              <div><span style={{ width: `${progress}%` }} /></div>
              <strong>{status} · {progress}%</strong>
              <button onClick={cancel}>Cancel</button>
            </div>
          ) : (
            <>
              <button onClick={onClose}>Cancel</button>
              <button className="primary-button" disabled={!canExport} onClick={startExport}><Download size={17} /> Create {options.format.toUpperCase()}</button>
            </>
          )}
        </footer>
      </div>
    </div>
  );
}

function NumberField({ label, value, min, step, onChange }: { label: string; value: number; min: number; step: number; onChange: (value: number) => void }) {
  return (
    <label className="field">
      <span>{label}</span>
      <input type="number" min={min} step={step} value={value} onChange={(event) => onChange(Math.max(min, Number(event.target.value) || min))} />
    </label>
  );
}
