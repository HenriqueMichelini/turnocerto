import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import type { ReadLink, ReadLinkWeekResponse, Schedule } from "./schedule-types";

const weekdayNames = ["Segunda", "Terça", "Quarta", "Quinta", "Sexta", "Sábado", "Domingo"];
const stateLabels: Record<string, string> = {
  outside_participation: "Fora da participação",
  undefined: "Não definido",
  day_off: "Folga",
  work_period: "Jornada",
  vacation: "Férias",
  absence: "Ausência",
  unavailable: "Indisponível",
};

export interface ReadLinkCredentials {
  linkID: string;
  scheduleID: string;
  token: string;
  startWeek: string;
  weekCount: number;
}

interface ManagerProps {
  apiBaseUrl: string;
  spaceID: string;
  schedule: Schedule;
  managementToken: string;
}

interface CreateReadLinkResponse {
  readLink: ReadLink;
  readToken: string;
}

export function ReadLinksManager({ apiBaseUrl, spaceID, schedule, managementToken }: ManagerProps) {
  const endpoint = `${apiBaseUrl}/api/management-spaces/${encodeURIComponent(spaceID)}/schedules/${encodeURIComponent(schedule.id)}/read-links`;
  const [links, setLinks] = useState<ReadLink[]>([]);
  const [startWeek, setStartWeek] = useState(() => currentMonday(schedule.timeZone));
  const [weekCount, setWeekCount] = useState(1);
  const [issuedLink, setIssuedLink] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [isCreating, setIsCreating] = useState(false);
  const [revokingLinkID, setRevokingLinkID] = useState("");
  const [isCopying, setIsCopying] = useState(false);

  useEffect(() => {
    let active = true;
    async function loadReadLinks() {
      setIsLoading(true);
      setError("");
      setIssuedLink("");
      try {
        const response = await fetch(endpoint, {
          headers: managementHeaders(managementToken),
          cache: "no-store",
          referrerPolicy: "no-referrer",
        });
        if (!response.ok) throw new Error("read_links_load_failed");
        const result = await response.json() as { readLinks: ReadLink[] };
        if (active) setLinks(result.readLinks);
      } catch {
        if (active) setError("Não foi possível carregar os links de leitura. Tente novamente.");
      } finally {
        if (active) setIsLoading(false);
      }
    }
    void loadReadLinks();
    return () => { active = false; };
  }, [endpoint, managementToken]);

  async function createReadLink(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isCreating) return;
    if (!isMonday(startWeek)) {
      setError("Escolha uma segunda-feira para iniciar o período.");
      return;
    }
    setIsCreating(true);
    setMessage("");
    setError("");
    setIssuedLink("");
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: managementHeaders(managementToken, true),
        body: JSON.stringify({ startWeek, weekCount }),
        cache: "no-store",
        referrerPolicy: "no-referrer",
      });
      if (!response.ok) {
        if (response.status === 400) {
          setError("Escolha uma segunda-feira e um período de uma a quatro semanas.");
          return;
        }
        throw new Error("read_link_create_failed");
      }
      const result = await response.json() as CreateReadLinkResponse;
      setLinks((current) => [result.readLink, ...current]);
      setIssuedLink(buildReadLink(result.readLink, result.readToken));
      setMessage("Link de leitura criado. Copie e guarde o link; o token não poderá ser exibido novamente.");
    } catch {
      setError("Não foi possível criar o link de leitura. Tente novamente.");
    } finally {
      setIsCreating(false);
    }
  }

  async function revokeReadLink(link: ReadLink) {
    if (link.revoked || revokingLinkID) return;
    setRevokingLinkID(link.id);
    setMessage("");
    setError("");
    try {
      const response = await fetch(`${endpoint}/${encodeURIComponent(link.id)}`, {
        method: "DELETE",
        headers: managementHeaders(managementToken),
        cache: "no-store",
        referrerPolicy: "no-referrer",
      });
      if (!response.ok) throw new Error("read_link_revoke_failed");
      setLinks((current) => current.map((item) => item.id === link.id ? { ...item, revoked: true } : item));
      if (issuedLink.includes(link.id)) setIssuedLink("");
      setMessage("Link de leitura revogado. O acesso foi encerrado.");
    } catch {
      setError("Não foi possível revogar o link de leitura. Tente novamente.");
    } finally {
      setRevokingLinkID("");
    }
  }

  async function copyReadLink() {
    if (!issuedLink) return;
    setIsCopying(true);
    setError("");
    try {
      await navigator.clipboard.writeText(issuedLink);
      setMessage("Link de leitura copiado.");
    } catch {
      setError("Não foi possível copiar automaticamente. Selecione e copie o link exibido.");
    } finally {
      setIsCopying(false);
    }
  }

  return (
    <section className="editor-panel read-links-panel" aria-labelledby="read-links-title">
      <h3 id="read-links-title">Links de leitura</h3>
      <p>Compartilhe até quatro semanas fixas desta escala. Quem receber o link poderá consultar as alterações posteriores e não poderá editar.</p>
      <form className="read-link-form" onSubmit={(event) => void createReadLink(event)}>
        <label htmlFor="read-link-start-week">Data inicial da primeira semana</label>
        <input id="read-link-start-week" type="date" aria-describedby="read-link-start-week-hint" value={startWeek} onChange={(event) => setStartWeek(event.target.value)} required />
        <p id="read-link-start-week-hint" className="form-hint">A semana começa na segunda-feira.</p>
        <label htmlFor="read-link-week-count">Semanas consecutivas</label>
        <select id="read-link-week-count" value={weekCount} onChange={(event) => setWeekCount(Number(event.target.value))}>
          {[1, 2, 3, 4].map((count) => <option key={count} value={count}>{count} {count === 1 ? "semana" : "semanas"}</option>)}
        </select>
        <button type="submit" disabled={isCreating}>{isCreating ? "Criando link…" : "Criar link de leitura"}</button>
      </form>

      {issuedLink && (
        <div className="read-link-issued">
          <label htmlFor="issued-read-link">Link criado</label>
          <div className="input-row">
            <input id="issued-read-link" aria-label="Link de leitura criado" readOnly value={issuedLink} onFocus={(event) => event.currentTarget.select()} />
            <button type="button" onClick={() => void copyReadLink()} disabled={isCopying}>{isCopying ? "Copiando…" : "Copiar link"}</button>
          </div>
          <p>Guarde o link agora. Por segurança, o token só aparece nesta criação.</p>
        </div>
      )}

      {isLoading ? <p className="editor-empty" role="status">Carregando links de leitura…</p> : links.length === 0 ? (
        <p className="editor-empty">Nenhum link de leitura foi criado para esta escala.</p>
      ) : (
        <ul className="read-link-list" aria-label="Links de leitura desta escala">
          {links.map((link) => (
            <li key={link.id}>
              <div>
                <strong>{formatDate(link.startWeek)} · {link.weekCount} {link.weekCount === 1 ? "semana" : "semanas"}</strong>
                <span>{link.revoked ? "Revogado" : "Ativo"}</span>
              </div>
              {!link.revoked && (
                <button type="button" className="text-button" onClick={() => void revokeReadLink(link)} disabled={Boolean(revokingLinkID)}>
                  {revokingLinkID === link.id ? "Revogando…" : "Revogar"}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {message && <p className="notice success" role="status">{message}</p>}
      {error && <p className="notice error" role="alert">{error}</p>}
    </section>
  );
}

interface ReaderProps {
  apiBaseUrl: string;
  credentials: ReadLinkCredentials;
}

export function ReadLinkReaderApp({ apiBaseUrl, credentials }: ReaderProps) {
  const [weekStart, setWeekStart] = useState(credentials.startWeek);
  const [result, setResult] = useState<ReadLinkWeekResponse | null>(null);
  const [error, setError] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const validCredentials = isUUID(credentials.linkID) && isUUID(credentials.scheduleID)
    && credentials.token.length >= 32 && credentials.token.length <= 128
    && isMonday(credentials.startWeek) && credentials.weekCount >= 1 && credentials.weekCount <= 4;

  useEffect(() => {
    if (!validCredentials) {
      setError("Este link de leitura está indisponível.");
      setIsLoading(false);
      return;
    }
    let active = true;
    const controller = new AbortController();
    async function loadWeek() {
      setIsLoading(true);
      setError("");
      try {
        const url = `${apiBaseUrl}/api/read-links/${encodeURIComponent(credentials.linkID)}/schedules/${encodeURIComponent(credentials.scheduleID)}/weeks/${encodeURIComponent(weekStart)}`;
        const response = await fetch(url, {
          headers: {
            Accept: "application/json",
            Authorization: `Bearer ${credentials.token}`,
          },
          cache: "no-store",
          referrerPolicy: "no-referrer",
          signal: controller.signal,
        });
        if (!response.ok) throw new Error("read_link_unavailable");
        const data = await response.json() as ReadLinkWeekResponse;
        if (active) setResult(data);
      } catch {
        if (active) {
          setResult(null);
          setError("Este link de leitura foi revogado ou não dá acesso a esta semana.");
        }
      } finally {
        if (active) setIsLoading(false);
      }
    }
    void loadWeek();
    return () => {
      active = false;
      controller.abort();
    };
  }, [apiBaseUrl, credentials, validCredentials, weekStart]);

  const scopeStart = result?.startWeek ?? credentials.startWeek;
  const scopeCount = result?.weekCount ?? credentials.weekCount;
  const lastWeek = addCalendarDays(scopeStart, (scopeCount - 1) * 7);
  const canGoBack = weekStart > scopeStart;
  const canGoForward = weekStart < lastWeek;

  return (
    <main className="page-shell">
      <header className="topbar">
        <div className="brand" aria-label="TurnoCerto"><span className="brand-mark" aria-hidden="true">T</span><span>TurnoCerto</span></div>
        <span className="preview-label">Link de leitura</span>
      </header>
      <section className="workspace schedule-reader" aria-labelledby="read-link-title">
        <div className="eyebrow"><span className="status-dot" /> CONSULTA COMPARTILHADA</div>
        <p className="section-label">ESCALA</p>
        <h1 id="read-link-title">{result?.schedule.name ?? (isLoading ? "Carregando escala…" : "Escala indisponível")}</h1>
        {isLoading ? <div className="loading-card" role="status">Abrindo a semana…</div> : error ? (
          <p className="notice error" role="alert">{error}</p>
        ) : result ? (
          <section className="editor-panel week-panel" aria-label="Programação semanal">
            <div className="week-toolbar">
              <div>
                <h2>Semana de {formatDate(result.week.weekStart)}</h2>
                <p>Este link permite consultar {scopeCount} {scopeCount === 1 ? "semana fixa" : "semanas fixas"} desta escala.</p>
              </div>
              <div className="week-controls">
                <button type="button" aria-label="Semana anterior" disabled={!canGoBack || isLoading} onClick={() => setWeekStart(addCalendarDays(weekStart, -7))}>←</button>
                <span>{formatDate(result.week.weekStart)} a {formatDate(result.week.weekEnd)}</span>
                <button type="button" aria-label="Próxima semana" disabled={!canGoForward || isLoading} onClick={() => setWeekStart(addCalendarDays(weekStart, 7))}>→</button>
              </div>
            </div>
            {result.week.people.length === 0 ? <p className="editor-empty">Não há pessoas com participação nesta semana.</p> : (
              <div className="calendar-scroll" aria-label="Programação da semana">
                <div className="week-grid week-header">
                  {result.week.people[0].days.map((day, index) => <div key={day.date}>{weekdayNames[index]}<span>{formatDate(day.date)}</span></div>)}
                </div>
                {result.week.people.map((personWeek) => (
                  <section className="person-week" key={personWeek.person.id} aria-label={`Semana de ${personWeek.person.name}`}>
                    <h3>{personWeek.person.name}</h3>
                    <div className="week-grid">
                      {personWeek.days.map((day) => (
                        <div className={`week-day week-day-${day.state}`} key={day.date}>
                          <span>{stateLabels[day.state] ?? "Indisponível"}</span>
                          {day.workPeriod && <small>{day.workPeriod.startTime}–{day.workPeriod.endTime}</small>}
                        </div>
                      ))}
                    </div>
                  </section>
                ))}
              </div>
            )}
          </section>
        ) : null}
        <footer className="privacy-note">
          <span className="lock-icon" aria-hidden="true">◇</span>
          <p>Este link permite apenas consultar as semanas definidas. Os dados exibidos acompanham as alterações feitas na escala.</p>
        </footer>
      </section>
    </main>
  );
}

export function readCredentialsFromFragment(useStoredCredentials = true): ReadLinkCredentials | null {
  const fragment = new URLSearchParams(window.location.hash.slice(1));
  if (fragment.has("management_token")) {
    clearPersistedReadCredentials();
    return null;
  }
  const linkID = fragment.get("read_link_id");
  const scheduleID = fragment.get("read_schedule_id");
  const token = fragment.get("read_token");
  const startWeek = fragment.get("read_start_week");
  const weekCount = Number(fragment.get("read_week_count"));
  if (linkID && scheduleID && token && startWeek && Number.isInteger(weekCount)) {
    const credentials = { linkID, scheduleID, token, startWeek, weekCount };
    persistReadCredentials(credentials);
    clearFragment();
    return credentials;
  }
  if (useStoredCredentials) {
    try {
      const saved = window.sessionStorage.getItem("turnocerto-read-link");
      return saved ? JSON.parse(saved) as ReadLinkCredentials : null;
    } catch {
      return null;
    }
  }
  return null;
}

export function buildReadLink(link: ReadLink, token: string): string {
  const url = new URL("/", window.location.origin);
  url.hash = new URLSearchParams({
    read_link_id: link.id,
    read_schedule_id: link.scheduleId,
    read_token: token,
    read_start_week: link.startWeek,
    read_week_count: String(link.weekCount),
  }).toString();
  return url.toString();
}

export function persistReadCredentials(credentials: ReadLinkCredentials) {
  try {
    window.sessionStorage.setItem("turnocerto-read-link", JSON.stringify(credentials));
  } catch {
    // Keep the current page usable when session storage is unavailable.
  }
}

function clearPersistedReadCredentials() {
  try {
    window.sessionStorage.removeItem("turnocerto-read-link");
  } catch {
    // Continue to the management link even when browser storage is unavailable.
  }
}

export function clearFragment() {
  try {
    window.history.replaceState(window.history.state, "", `${window.location.pathname}${window.location.search}`);
  } catch {
    // The fragment is never sent with the initial request; keep the in-memory credential if cleanup fails.
  }
}

function managementHeaders(token: string, json = false): HeadersInit {
  return {
    Accept: "application/json",
    Authorization: `Bearer ${token}`,
    ...(json ? { "Content-Type": "application/json" } : {}),
  };
}

function currentMonday(timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const part = (type: string) => parts.find((item) => item.type === type)?.value ?? "";
  return mondayForDate(`${part("year")}-${part("month")}-${part("day")}`);
}

function mondayForDate(value: string): string {
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return "";
  date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
  return date.toISOString().slice(0, 10);
}

function isMonday(value: string): boolean {
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value && date.getUTCDay() === 1;
}

function addCalendarDays(value: string, days: number): string {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "2-digit", timeZone: "UTC" }).format(new Date(`${value}T12:00:00Z`));
}

function isUUID(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
