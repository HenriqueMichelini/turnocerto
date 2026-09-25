import { useEffect, useState } from "react";
import type { FormEvent } from "react";

interface Schedule {
  id: string;
  name: string;
  managementSpace: {
    id: string;
    name: string;
  };
}

interface ScheduleResponse {
  schedule: Schedule;
}

const previewTokenStorageKey = "turnocerto-preview-token";

function readPreviewToken(): string {
  const tokenFromFragment = new URLSearchParams(window.location.hash.slice(1)).get("preview_token");
  if (tokenFromFragment) {
    try {
      window.sessionStorage.setItem(previewTokenStorageKey, tokenFromFragment);
    } catch {
      // Keep the current page usable when browser storage is unavailable.
    }
    try {
      window.history.replaceState(window.history.state, "", `${window.location.pathname}${window.location.search}`);
    } catch {
      // The fragment is never sent with the initial request; keeping it is only a browser fallback.
    }
    return tokenFromFragment;
  }

  try {
    return window.sessionStorage.getItem(previewTokenStorageKey) ?? "";
  } catch {
    return "";
  }
}

const apiBaseUrl = import.meta.env.VITE_API_BASE_URL?.replace(/\/$/, "") ?? "";
const scheduleUrl = `${apiBaseUrl}/api/schedules/preview-fixture`;
const previewToken = readPreviewToken();

function requestHeaders(headers: HeadersInit): Headers {
  const result = new Headers(headers);
  if (previewToken) result.set("Authorization", `Bearer ${previewToken}`);
  return result;
}

export function App() {
  const [schedule, setSchedule] = useState<Schedule | null>(null);
  const [name, setName] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);

  async function loadSchedule() {
    setIsLoading(true);
    setError("");
    try {
      const response = await fetch(scheduleUrl, { headers: requestHeaders({ Accept: "application/json" }) });
      if (response.status === 401) {
        setError("Abra o link de convite recebido para acessar esta prévia.");
        return;
      }
      if (!response.ok) throw new Error("Não foi possível abrir esta escala.");
      const result = (await response.json()) as ScheduleResponse;
      setSchedule(result.schedule);
      setName(result.schedule.name);
    } catch {
      setError("Não foi possível abrir a escala. Atualize a página para tentar novamente.");
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    void loadSchedule();
  }, []);

  async function saveName(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!schedule || isSaving) return;

    setIsSaving(true);
    setMessage("");
    setError("");
    try {
      const response = await fetch(scheduleUrl, {
        method: "PATCH",
        headers: requestHeaders({ Accept: "application/json", "Content-Type": "application/json" }),
        body: JSON.stringify({ name }),
      });
      if (!response.ok) {
        if (response.status === 400) {
          setError("Informe um nome com até 80 caracteres.");
          return;
        }
        throw new Error("Não foi possível salvar o nome.");
      }

      const result = (await response.json()) as ScheduleResponse;
      setSchedule(result.schedule);
      setName(result.schedule.name);
      setMessage("Nome salvo.");
    } catch {
      setError("Não foi possível salvar o nome. Tente novamente.");
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <main className="page-shell">
      <header className="topbar">
        <a className="brand" href="/" aria-label="TurnoCerto, início">
          <span className="brand-mark" aria-hidden="true">T</span>
          <span>TurnoCerto</span>
        </a>
        <span className="preview-label">Acesso por convite</span>
      </header>

      <section className="workspace" aria-labelledby="page-title">
        <div className="eyebrow"><span className="status-dot" /> ESPAÇO DE GESTÃO</div>
        <p className="space-name">{schedule?.managementSpace.name ?? "Carregando espaço…"}</p>
        <div className="heading-row">
          <div>
            <p className="section-label">SUA ESCALA</p>
            <h1 id="page-title">{isLoading ? "Carregando escala…" : schedule?.name ?? "Escala indisponível"}</h1>
          </div>
          <span className="calendar-icon" aria-hidden="true">▦</span>
        </div>

        {isLoading ? (
          <div className="loading-card" role="status">Abrindo a escala…</div>
        ) : schedule ? (
          <section className="schedule-card" aria-label="Detalhes da escala">
            <div className="card-heading">
              <div className="calendar-tile" aria-hidden="true">▦</div>
              <div>
                <h2>Detalhes da escala</h2>
                <p>Atualize o nome para identificar este grupo.</p>
              </div>
            </div>
            <form className="rename-form" onSubmit={saveName}>
              <label htmlFor="schedule-name">Nome da escala</label>
              <div className="input-row">
                <input
                  id="schedule-name"
                  name="schedule-name"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  maxLength={80}
                  required
                  disabled={isSaving}
                />
                <button type="submit" disabled={isSaving || name.trim() === schedule.name}>
                  {isSaving ? "Salvando…" : "Salvar nome"}
                </button>
              </div>
              <p className="form-hint">Você pode alterar o nome quando quiser.</p>
            </form>
          </section>
        ) : null}

        {message && <p className="notice success" role="status">{message}</p>}
        {error && <p className="notice error" role="alert">{error}</p>}

        <footer className="privacy-note">
          <span className="lock-icon" aria-hidden="true">◇</span>
          <p>Esta prévia usa dados de demonstração em um banco separado de produção.</p>
        </footer>
      </section>
    </main>
  );
}
