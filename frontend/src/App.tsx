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

const scheduleUrl = "/api/schedules/preview-fixture";

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
      const response = await fetch(scheduleUrl, { headers: { Accept: "application/json" } });
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
        headers: { Accept: "application/json", "Content-Type": "application/json" },
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
        <span className="preview-label">Prévia privada</span>
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
