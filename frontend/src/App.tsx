import { useEffect, useRef, useState } from "react";
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

interface ManagementSpaceView {
  managementSpace: Schedule["managementSpace"];
  schedules: Schedule[];
}

interface ManagementSpaceResponse {
  managementSpace: Schedule["managementSpace"];
  schedule: Schedule;
  managementToken: string;
}

class ManagementRequestError extends Error {
  constructor(readonly status: number) {
    super("Management request failed");
  }
}

interface TurnstileWidget {
  render(
    container: HTMLElement,
    options: {
      sitekey: string;
      callback(token: string): void;
      "error-callback"(): void;
      "expired-callback"(): void;
    },
  ): string;
  reset(widgetId?: string): void;
  remove(widgetId: string): void;
}

declare global {
  interface Window {
    turnstile?: TurnstileWidget;
  }
}

const previewTokenStorageKey = "turnocerto-preview-token";
const managementSpaceStorageKey = "turnocerto-management-space";
const managementTokenStoragePrefix = "turnocerto-management-token:";

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

function readManagementCredentials(): { spaceID: string; token: string } | null {
  const fragment = new URLSearchParams(window.location.hash.slice(1));
  const fragmentSpaceID = fragment.get("management_space");
  const fragmentToken = fragment.get("management_token");
  if (fragmentSpaceID && fragmentToken) {
    try {
      window.sessionStorage.removeItem(previewTokenStorageKey);
      window.sessionStorage.setItem(managementSpaceStorageKey, fragmentSpaceID);
      window.sessionStorage.setItem(`${managementTokenStoragePrefix}${fragmentSpaceID}`, fragmentToken);
    } catch {
      // The current page can still use the credential held in memory.
    }
    try {
      window.history.replaceState(window.history.state, "", `${window.location.pathname}${window.location.search}`);
    } catch {
      // The fragment is never sent with the initial request; keeping it is only a browser fallback.
    }
    return { spaceID: fragmentSpaceID, token: fragmentToken };
  }

  try {
    const spaceID = window.sessionStorage.getItem(managementSpaceStorageKey) ?? "";
    const token = spaceID ? window.sessionStorage.getItem(`${managementTokenStoragePrefix}${spaceID}`) ?? "" : "";
    return spaceID && token ? { spaceID, token } : null;
  } catch {
    return null;
  }
}

const apiBaseUrl = import.meta.env.VITE_API_BASE_URL?.replace(/\/$/, "") ?? "";
const scheduleUrl = `${apiBaseUrl}/api/schedules/preview-fixture`;
const managementApiUrl = `${apiBaseUrl}/api/management-spaces`;
const turnstileSiteKey = import.meta.env.VITE_TURNSTILE_SITE_KEY ?? "";
const managementCredentials = readManagementCredentials();
const previewToken = readPreviewToken();

function requestHeaders(headers: HeadersInit): Headers {
  const result = new Headers(headers);
  if (previewToken) result.set("Authorization", `Bearer ${previewToken}`);
  return result;
}

function PreviewScheduleApp() {
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

export function App() {
  return previewToken ? <PreviewScheduleApp /> : <ManagementSpaceApp />;
}

function ManagementSpaceApp() {
  const [spaceID, setSpaceID] = useState(managementCredentials?.spaceID ?? "");
  const [managementToken, setManagementToken] = useState(managementCredentials?.token ?? "");
  const [space, setSpace] = useState<Schedule["managementSpace"] | null>(null);
  const [schedule, setSchedule] = useState<Schedule | null>(null);
  const [spaceName, setSpaceName] = useState("Meu Espaço de gestão");
  const [scheduleName, setScheduleName] = useState("Minha primeira escala");
  const [challengeToken, setChallengeToken] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [isLoading, setIsLoading] = useState(Boolean(managementCredentials));
  const [managementLoadVersion, setManagementLoadVersion] = useState(0);
  const [isCreating, setIsCreating] = useState(false);
  const [isSavingSpace, setIsSavingSpace] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isCopying, setIsCopying] = useState(false);
  const [managementLink, setManagementLink] = useState(
    managementCredentials ? buildManagementLink(managementCredentials.spaceID, managementCredentials.token) : "",
  );
  const challengeContainer = useRef<HTMLDivElement | null>(null);
  const widgetID = useRef<string | undefined>(undefined);

  useEffect(() => {
    function readManagementLinkFromFragment() {
      if (!new URLSearchParams(window.location.hash.slice(1)).has("management_token")) return;
      const credentials = readManagementCredentials();
      if (!credentials) return;
      setSpaceID(credentials.spaceID);
      setManagementToken(credentials.token);
      setSpace(null);
      setSchedule(null);
      setIsLoading(true);
      setError("");
      setManagementLoadVersion((version) => version + 1);
    }

    window.addEventListener("hashchange", readManagementLinkFromFragment);
    return () => window.removeEventListener("hashchange", readManagementLinkFromFragment);
  }, []);

  useEffect(() => {
    if (!spaceID || !managementToken) {
      setIsLoading(false);
      return;
    }

    let active = true;
    async function loadManagementSpace() {
      setIsLoading(true);
      setError("");
      try {
        const response = await fetch(`${managementApiUrl}/${encodeURIComponent(spaceID)}`, {
          headers: managementRequestHeaders(managementToken, { Accept: "application/json" }),
        });
        if (response.status === 401) {
          if (active) setError("Este link de gestão não pode ser validado. Use o link original para abrir o Espaço.");
          return;
        }
        if (!response.ok) throw new Error("load_failed");
        const result = (await response.json()) as ManagementSpaceView;
        if (!active) return;
        setSpace(result.managementSpace);
        setSchedule(result.schedules[0] ?? null);
        setSpaceName(result.managementSpace.name);
        setScheduleName(result.schedules[0]?.name ?? "");
        setManagementLink(buildManagementLink(spaceID, managementToken));
      } catch {
        if (active) setError("Não foi possível abrir este Espaço agora. Tente novamente.");
      } finally {
        if (active) setIsLoading(false);
      }
    }

    void loadManagementSpace();
    return () => {
      active = false;
    };
  }, [spaceID, managementToken, managementLoadVersion]);

  useEffect(() => {
    if (spaceID || managementToken) return;
    if (!turnstileSiteKey) {
      setError("A verificação de segurança está indisponível. Tente novamente mais tarde.");
      return;
    }

    const container = challengeContainer.current;
    if (!container) return;
    let active = true;
    const script = document.createElement("script");
    script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    script.async = true;
    script.defer = true;
    script.onload = () => {
      if (!active || !window.turnstile) return;
      widgetID.current = window.turnstile.render(container, {
        sitekey: turnstileSiteKey,
        callback: (token) => {
          setChallengeToken(token);
          setError("");
        },
        "error-callback": () => {
          setChallengeToken("");
          setError("Não foi possível concluir a verificação. Tente novamente.");
        },
        "expired-callback": () => {
          setChallengeToken("");
          setError("A verificação expirou. Faça o desafio novamente.");
        },
      });
    };
    script.onerror = () => {
      if (active) setError("Não foi possível carregar a verificação de segurança. Tente novamente.");
    };
    document.head.appendChild(script);

    return () => {
      active = false;
      if (widgetID.current) window.turnstile?.remove(widgetID.current);
      widgetID.current = undefined;
      script.remove();
    };
  }, [spaceID, managementToken]);

  async function createManagementSpace(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isCreating || !challengeToken) return;

    setIsCreating(true);
    setError("");
    setMessage("");
    try {
      const response = await fetch(managementApiUrl, {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({ spaceName, scheduleName, turnstileToken: challengeToken }),
      });
      if (!response.ok) {
        const failure = await response.json().catch(() => ({})) as { error?: string };
        switch (failure.error) {
          case "challenge_failed":
            setError("A verificação expirou ou não foi aprovada. Faça o desafio novamente.");
            break;
          case "challenge_unavailable":
            setError("Não foi possível confirmar a verificação agora. Tente novamente em instantes.");
            break;
          case "creation_rate_limited":
            setError("Muitas tentativas de criação. Aguarde um minuto e tente novamente.");
            break;
          default:
            setError("Não foi possível criar o Espaço agora. Tente novamente.");
        }
        setChallengeToken("");
        if (widgetID.current) window.turnstile?.reset(widgetID.current);
        return;
      }

      const result = (await response.json()) as ManagementSpaceResponse;
      persistManagementCredentials(result.managementSpace.id, result.managementToken);
      setSpaceID(result.managementSpace.id);
      setManagementToken(result.managementToken);
      setSpace(result.managementSpace);
      setSchedule(result.schedule);
      setManagementLink(buildManagementLink(result.managementSpace.id, result.managementToken));
      setMessage("Espaço criado. Guarde o link de gestão para abrir e editar depois.");
    } catch {
      setError("Não foi possível criar o Espaço agora. Tente novamente.");
      setChallengeToken("");
      if (widgetID.current) window.turnstile?.reset(widgetID.current);
    } finally {
      setIsCreating(false);
    }
  }

  async function saveScheduleName(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!space || !schedule || isSaving) return;

    setIsSaving(true);
    setMessage("");
    setError("");
    try {
      const result = await patchManagementName<ScheduleResponse>(
        `${managementApiUrl}/${encodeURIComponent(space.id)}/schedules/${encodeURIComponent(schedule.id)}`,
        managementToken,
        scheduleName,
      );
      setSchedule(result.schedule);
      setScheduleName(result.schedule.name);
      setMessage("Nome salvo.");
    } catch (error) {
      setError(managementNameSaveError(error, "o nome"));
    } finally {
      setIsSaving(false);
    }
  }

  async function saveManagementSpaceName(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!space || isSavingSpace) return;

    setIsSavingSpace(true);
    setMessage("");
    setError("");
    try {
      const result = await patchManagementName<{ managementSpace: Schedule["managementSpace"] }>(
        `${managementApiUrl}/${encodeURIComponent(space.id)}`,
        managementToken,
        spaceName,
      );
      setSpace(result.managementSpace);
      setSpaceName(result.managementSpace.name);
      setMessage("Nome do Espaço salvo.");
    } catch (error) {
      setError(managementNameSaveError(error, "o nome do Espaço"));
    } finally {
      setIsSavingSpace(false);
    }
  }

  async function copyManagementLink() {
    if (!managementLink) return;
    setIsCopying(true);
    try {
      await navigator.clipboard.writeText(managementLink);
      setMessage("Link de gestão copiado.");
    } catch {
      setError("Não foi possível copiar automaticamente. Selecione e copie o link exibido.");
    } finally {
      setIsCopying(false);
    }
  }

  function startAnotherSpace() {
    if (spaceID) {
      try {
        window.sessionStorage.removeItem(`${managementTokenStoragePrefix}${spaceID}`);
        window.sessionStorage.removeItem(managementSpaceStorageKey);
      } catch {
        // Keep the current page usable when browser storage is unavailable.
      }
    }
    setSpaceID("");
    setManagementToken("");
    setSpace(null);
    setSchedule(null);
    setManagementLink("");
    setIsLoading(false);
    setError("");
    setMessage("");
  }

  const isCreatingSpace = !spaceID && !managementToken;

  return (
    <main className="page-shell">
      <header className="topbar">
        <a className="brand" href="/" aria-label="TurnoCerto, início">
          <span className="brand-mark" aria-hidden="true">T</span>
          <span>TurnoCerto</span>
        </a>
        <span className="preview-label">Sem cadastro</span>
      </header>

      <section className="workspace" aria-labelledby="page-title">
        <div className="eyebrow"><span className="status-dot" /> ESPAÇO DE GESTÃO</div>
        <p className="space-name">{space?.name ?? "Crie seu espaço para começar"}</p>
        <div className="heading-row">
          <div>
            <p className="section-label">SUA ESCALA</p>
            <h1 id="page-title">{isLoading ? "Abrindo espaço…" : schedule?.name ?? (isCreatingSpace ? "Organize sua primeira escala" : "Link de gestão indisponível")}</h1>
          </div>
          <span className="calendar-icon" aria-hidden="true">▦</span>
        </div>

        {isLoading ? (
          <div className="loading-card" role="status">Abrindo seu Espaço de gestão…</div>
        ) : isCreatingSpace ? (
          <section className="schedule-card" aria-label="Criar Espaço de gestão">
            <div className="card-heading">
              <div className="calendar-tile" aria-hidden="true">▦</div>
              <div>
                <h2>Seu Espaço começa aqui</h2>
                <p>Sem cadastro: crie o Espaço de gestão e a primeira escala.</p>
              </div>
            </div>
            <form className="rename-form" onSubmit={createManagementSpace}>
              <label htmlFor="management-space-name">Nome do Espaço de gestão</label>
              <div className="field-stack">
                <input
                  id="management-space-name"
                  name="management-space-name"
                  value={spaceName}
                  onChange={(event) => setSpaceName(event.target.value)}
                  maxLength={80}
                  required
                  disabled={isCreating}
                />
              </div>
              <label htmlFor="first-schedule-name">Nome da primeira escala</label>
              <div className="field-stack">
                <input
                  id="first-schedule-name"
                  name="first-schedule-name"
                  value={scheduleName}
                  onChange={(event) => setScheduleName(event.target.value)}
                  maxLength={80}
                  required
                  disabled={isCreating}
                />
              </div>
              <div className="turnstile-slot" ref={challengeContainer} aria-label="Verificação de segurança" />
              <button className="primary-button" type="submit" disabled={isCreating || !challengeToken || !turnstileSiteKey}>
                {isCreating ? "Criando Espaço…" : "Criar Espaço e escala"}
              </button>
              <p className="form-hint">Depois, guarde o link de gestão. Perder o link significa perder o acesso de edição; não há recuperação por e-mail nesta versão.</p>
            </form>
          </section>
        ) : space && schedule ? (
          <section className="schedule-card" aria-label="Detalhes da escala">
            <div className="card-heading">
              <div className="calendar-tile" aria-hidden="true">▦</div>
              <div>
                <h2>Edite sua primeira escala</h2>
                <p>O link de gestão permite abrir este Espaço novamente.</p>
              </div>
            </div>
            <form className="rename-form" onSubmit={saveScheduleName}>
              <label htmlFor="management-schedule-name">Nome da escala</label>
              <div className="input-row">
                <input
                  id="management-schedule-name"
                  name="management-schedule-name"
                  value={scheduleName}
                  onChange={(event) => setScheduleName(event.target.value)}
                  maxLength={80}
                  required
                  disabled={isSaving}
                />
                <button type="submit" disabled={isSaving || scheduleName.trim() === schedule.name}>
                  {isSaving ? "Salvando…" : "Salvar nome"}
                </button>
              </div>
              <p className="form-hint">Você pode alterar o nome quando quiser.</p>
            </form>
            <form className="rename-form" onSubmit={saveManagementSpaceName}>
              <label htmlFor="management-space-name">Nome do Espaço de gestão</label>
              <div className="input-row">
                <input
                  id="management-space-name"
                  name="management-space-name"
                  value={spaceName}
                  onChange={(event) => setSpaceName(event.target.value)}
                  maxLength={80}
                  required
                  disabled={isSavingSpace}
                />
                <button type="submit" disabled={isSavingSpace || spaceName.trim() === space.name}>
                  {isSavingSpace ? "Salvando…" : "Salvar nome do Espaço"}
                </button>
              </div>
            </form>
            <div className="management-link-panel">
              <label htmlFor="management-link">Link privado de gestão</label>
              <div className="input-row">
                <input id="management-link" aria-label="Link privado de gestão" readOnly value={managementLink} onFocus={(event) => event.currentTarget.select()} />
                <button type="button" onClick={() => void copyManagementLink()} disabled={isCopying}>
                  {isCopying ? "Copiando…" : "Copiar link"}
                </button>
              </div>
              <p className="form-hint">Qualquer pessoa com este link pode editar o Espaço de gestão. Guarde-o em local seguro.</p>
            </div>
            <button className="text-button" type="button" onClick={startAnotherSpace}>Criar outro Espaço de gestão</button>
          </section>
        ) : (
          <section className="schedule-card">
            <p className="empty-state">Abra o link privado de gestão que você guardou para recuperar o acesso de edição.</p>
            <button className="primary-button" type="button" onClick={startAnotherSpace}>Criar outro Espaço de gestão</button>
          </section>
        )}

        {message && <p className="notice success" role="status">{message}</p>}
        {error && <p className="notice error" role="alert">{error}</p>}

        <footer className="privacy-note">
          <span className="lock-icon" aria-hidden="true">◇</span>
          <p>O link de gestão é privado. Guarde-o: perder o link implica perder o acesso de edição; não há recuperação por e-mail nesta versão.</p>
        </footer>
      </section>
    </main>
  );
}

function managementRequestHeaders(token: string, headers: HeadersInit): Headers {
  const result = new Headers(headers);
  if (token) result.set("Authorization", `Bearer ${token}`);
  return result;
}

async function patchManagementName<T>(url: string, token: string, name: string): Promise<T> {
  const response = await fetch(url, {
    method: "PATCH",
    headers: managementRequestHeaders(token, { Accept: "application/json", "Content-Type": "application/json" }),
    body: JSON.stringify({ name }),
  });
  if (!response.ok) throw new ManagementRequestError(response.status);
  return await response.json() as T;
}

function managementNameSaveError(error: unknown, target: string): string {
  if (error instanceof ManagementRequestError && error.status === 400) {
    return "Informe um nome com até 80 caracteres.";
  }
  return `Não foi possível salvar ${target}. Tente novamente.`;
}

function persistManagementCredentials(spaceID: string, token: string) {
  try {
    window.sessionStorage.setItem(managementSpaceStorageKey, spaceID);
    window.sessionStorage.setItem(`${managementTokenStoragePrefix}${spaceID}`, token);
  } catch {
    // Keep this page usable when browser storage is unavailable.
  }
}

function buildManagementLink(spaceID: string, token: string): string {
  const link = new URL("/", window.location.origin);
  link.hash = new URLSearchParams({ management_space: spaceID, management_token: token }).toString();
  return link.toString();
}
