import { useEffect, useRef, useState } from "react";
import type { ExportFormat, ExportProgress, WeekExportData, WeekExportDocument } from "./week-export";
import { downloadWeekFile, renderWeekPDF, renderWeekPNG, weekHasUndefinedDays } from "./week-export";

interface Props {
  scheduleName: string;
  week: WeekExportData;
}

export function WeekExportControls({ scheduleName, week }: Props) {
  const [pendingFormat, setPendingFormat] = useState<ExportFormat | null>(null);
  const [progress, setProgress] = useState<{ format: ExportFormat; current: ExportProgress } | null>(null);
  const [isExporting, setIsExporting] = useState(false);
  const [failureFormat, setFailureFormat] = useState<ExportFormat | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const busy = useRef(false);
  const hasUndefined = weekHasUndefinedDays(week);
  const exportDocument: WeekExportDocument = { scheduleName, week };

  useEffect(() => {
    setPendingFormat(null);
    setProgress(null);
    setIsExporting(false);
    setFailureFormat(null);
    setMessage("");
    setError("");
    busy.current = false;
  }, [scheduleName, week.weekStart]);

  function requestExport(format: ExportFormat) {
    if (busy.current) return;
    setMessage("");
    setError("");
    setFailureFormat(null);
    if (hasUndefined) {
      setPendingFormat(format);
      return;
    }
    void runExport(format);
  }

  async function runExport(format: ExportFormat) {
    if (busy.current) return;
    busy.current = true;
    setPendingFormat(null);
    setFailureFormat(null);
    setMessage("");
    setError("");
    setProgress(null);
    setIsExporting(true);
    const onProgress = (current: ExportProgress) => setProgress({ format, current });
    try {
      const file = format === "pdf"
        ? await renderWeekPDF(exportDocument, onProgress)
        : await renderWeekPNG(exportDocument, onProgress);
      downloadWeekFile(file, `${fileName(scheduleName)}-${week.weekStart}.${format}`);
      setMessage(`Download do ${format.toUpperCase()} iniciado.`);
    } catch {
      setFailureFormat(format);
      setError(`Não foi possível gerar o ${format.toUpperCase()}. Tente novamente.`);
    } finally {
      busy.current = false;
      setIsExporting(false);
    }
  }

  return (
    <div className="week-export" aria-label="Exportar semana">
      <div className="week-export-buttons">
        <button type="button" onClick={() => requestExport("pdf")} disabled={isExporting}>Exportar PDF</button>
        <button type="button" onClick={() => requestExport("png")} disabled={isExporting}>Exportar PNG</button>
      </div>

      {pendingFormat && (
        <div className="week-export-warning" role="alert">
          <p>
            Há {undefinedDayCount(week)} {undefinedDayCount(week) === 1 ? "dia sem programação definida" : "dias sem programação definida"} nesta semana. Esses dias continuarão como “Não definido” no arquivo.
          </p>
          <div className="week-export-actions">
            <button type="button" onClick={() => void runExport(pendingFormat)}>
              Continuar e exportar {pendingFormat.toUpperCase()}
            </button>
            <button type="button" className="week-export-cancel" onClick={() => setPendingFormat(null)}>Cancelar</button>
          </div>
        </div>
      )}

      {isExporting && progress && (
        <div className="week-export-progress" role="status" aria-live="polite">
          <p>Gerando {progress.format.toUpperCase()} · {progress.current.completed} de {progress.current.total} {progress.current.unit}</p>
          <progress aria-label={`Progresso da exportação ${progress.format.toUpperCase()}`} max={Math.max(progress.current.total, 1)} value={progress.current.completed} />
        </div>
      )}

      {message && <p className="week-export-message" role="status">{message}</p>}
      {error && (
        <div className="week-export-error" role="alert">
          <p>{error}</p>
          {failureFormat && (
            <button type="button" onClick={() => void runExport(failureFormat)} disabled={isExporting}>
              Tentar exportar {failureFormat.toUpperCase()} novamente
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function undefinedDayCount(week: WeekExportData): number {
  return week.people.reduce((total, person) => total + person.days.filter((day) => day.state === "undefined").length, 0);
}

function fileName(scheduleName: string): string {
  const normalized = scheduleName.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  return normalized.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "escala";
}
