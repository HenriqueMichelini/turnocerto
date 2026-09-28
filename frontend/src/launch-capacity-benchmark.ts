interface CapacityResults {
  schemaVersion: 2;
  runId: string;
  startedAt: string;
  expectedPeople: number;
  lookbackWeeks: 4;
  requestedOpenSamples: number;
  openAttempts: { durationMilliseconds: number; outcome: "usable" | "timeout" }[];
  editSamplesMilliseconds: number[];
  exportSamplesMilliseconds: { pdf: number[]; png: number[] };
  progressObserved: { pdf: number; png: number };
  retryExercise: "not-run" | "failed-once" | "retry-succeeded";
  confirmedDownloads: number;
  environment: {
    userAgent: string;
    viewport: string;
    devicePixelRatio: number;
    effectiveType: string | null;
    downlinkMbps: number | null;
    rttMilliseconds: number | null;
    connectionSelfReport: "local-wifi-lan";
    frontendOrigin: string;
    deviceLabel: string;
  };
}

interface NetworkInformation extends EventTarget {
  effectiveType?: string;
  downlink?: number;
  rtt?: number;
}

const stateStorageKey = "turnocerto-launch-capacity-results-v2";
const completedEditMessage = "Alteração salva somente para as datas selecionadas.";

export function startLaunchCapacityBenchmark(): void {
  const parameters = new URLSearchParams(window.location.search);
  if (parameters.get("capacity-benchmark") !== "1") return;

  const expectedPeople = Number(parameters.get("people"));
  const requestedOpenSamples = Number(parameters.get("samples"));
  if (![20, 100].includes(expectedPeople) || !Number.isInteger(requestedOpenSamples) || requestedOpenSamples < 1 || requestedOpenSamples > 30) {
    return;
  }

  let results = loadResults(expectedPeople, requestedOpenSamples);
  const panel = document.createElement("aside");
  panel.className = "capacity-benchmark-panel";
  panel.setAttribute("aria-label", "Medição temporária de capacidade");
  panel.innerHTML = `
    <div class="capacity-benchmark-header">
      <strong>Medição de capacidade</strong>
      <button type="button" data-action="collapse" aria-label="Recolher medição">−</button>
    </div>
    <p data-role="summary"></p>
    <div data-role="open-summary" class="capacity-benchmark-section"></div>
    <label class="capacity-benchmark-device">Aparelho
      <input data-role="device" autocomplete="off" placeholder="Ex.: Samsung A54" />
    </label>
    <div class="capacity-benchmark-actions">
      <button type="button" data-action="edit">Iniciar edição</button>
      <button type="button" data-action="pdf">Iniciar PDF</button>
      <button type="button" data-action="png">Iniciar PNG</button>
      <button type="button" data-action="retry">Testar falha e nova tentativa do PNG</button>
      <button type="button" data-action="confirm-download" hidden>Confirmar download da escala</button>
      <button type="button" data-action="download">Baixar evidência JSON</button>
      <button type="button" data-action="reset">Zerar resultados</button>
    </div>
    <p data-role="status" role="status" aria-live="polite"></p>
  `;
  document.body.append(panel);
  const style = document.createElement("style");
  style.textContent = `
    .capacity-benchmark-panel { position: fixed; z-index: 99999; inset: auto 8px 8px; max-height: 52vh; overflow: auto; padding: 12px; border: 1px solid #c4d3c9; border-radius: 12px; background: #fff; color: #203b2b; box-shadow: 0 5px 28px #10261855; font: 14px/1.4 system-ui, sans-serif; }
    .capacity-benchmark-header { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
    .capacity-benchmark-header button, .capacity-benchmark-actions button { min-height: 42px; padding: 8px 11px; border: 1px solid #789184; border-radius: 8px; background: #f5f8f5; color: #203b2b; font: inherit; }
    .capacity-benchmark-panel p { margin: 8px 0; }
    .capacity-benchmark-device { display: grid; gap: 4px; margin: 8px 0; }
    .capacity-benchmark-device input { min-height: 36px; padding: 4px 8px; border: 1px solid #9cab9f; border-radius: 6px; font: inherit; }
    .capacity-benchmark-actions { display: flex; flex-wrap: wrap; gap: 6px; }
    .capacity-benchmark-panel button[hidden] { display: none; }
    .capacity-benchmark-collapsed { max-height: 58px; overflow: hidden; }
    .capacity-benchmark-collapsed > :not(.capacity-benchmark-header) { display: none; }
    @media (min-width: 680px) { .capacity-benchmark-panel { right: 16px; left: auto; width: 360px; } }
  `;
  document.head.append(style);

  const statusElement = panel.querySelector<HTMLElement>('[data-role="status"]')!;
  const summaryElement = panel.querySelector<HTMLElement>('[data-role="summary"]')!;
  const openSummaryElement = panel.querySelector<HTMLElement>('[data-role="open-summary"]')!;
  const collapseButton = panel.querySelector<HTMLButtonElement>('[data-action="collapse"]')!;
  const confirmDownloadButton = panel.querySelector<HTMLButtonElement>('[data-action="confirm-download"]')!;
  const deviceInput = panel.querySelector<HTMLInputElement>('[data-role="device"]')!;
  let pendingExport: {
    format: "pdf" | "png";
    startedAt: number;
    progressSeen: boolean;
    previousMessage: HTMLElement | null;
    previousMessageText: string;
    previousError: HTMLElement | null;
    previousErrorText: string;
  } | null = null;
  let unconfirmedDownload = false;
  let failPngOnce = false;
  let retryFailureSeen = false;
  let collapseWhenIdle = false;

  function save() {
    try {
      sessionStorage.setItem(stateStorageKey, JSON.stringify(results));
    } catch {
      statusElement.textContent = "O navegador não permitiu salvar as medições nesta aba.";
    }
    updateSummary();
  }

  function updateSummary() {
    summaryElement.textContent = `${results.expectedPeople} Pessoas · Wi-Fi local · ${results.openAttempts.length}/${results.requestedOpenSamples} tentativas`;
    const openP75 = percentile75(results.openAttempts.map((attempt) => attempt.durationMilliseconds));
    openSummaryElement.textContent = openP75 === null
      ? "Aguardando o carregamento da semana completa…"
      : `Abertura p75 incluindo timeouts: ${openP75} ms (n=${results.openAttempts.length}; utilizáveis ${results.openAttempts.filter((attempt) => attempt.outcome === "usable").length}; timeouts ${results.openAttempts.filter((attempt) => attempt.outcome === "timeout").length})`;
    confirmDownloadButton.hidden = !unconfirmedDownload;
  }

  function collapse() {
    panel.classList.toggle("capacity-benchmark-collapsed");
    collapseButton.textContent = panel.classList.contains("capacity-benchmark-collapsed") ? "+" : "−";
    collapseButton.setAttribute("aria-label", panel.classList.contains("capacity-benchmark-collapsed") ? "Abrir medição" : "Recolher medição");
  }

  function startOpenMeasurement() {
    if (results.openAttempts.length >= results.requestedOpenSamples) {
      statusElement.textContent = "A amostra de abertura já terminou. Use Zerar resultados para repetir.";
      return;
    }
    try {
      sessionStorage.setItem(stateStorageKey, JSON.stringify(results));
    } catch {
      statusElement.textContent = "O navegador não permitiu continuar as medições após recarregar.";
      return;
    }
    location.reload();
  }

  function onDocumentClick(event: MouseEvent) {
    const target = event.target instanceof Element ? event.target.closest("button") : null;
    if (!target || panel.contains(target)) return;
    const buttonText = target.textContent?.trim() ?? "";
    const format = buttonText === "Exportar PDF" ? "pdf" : buttonText === "Exportar PNG" ? "png" : null;
    if (format) {
      pendingExport = beginExportMeasurement(format);
      retryFailureSeen = format === "png" && results.retryExercise === "failed-once";
      statusElement.textContent = `${format.toUpperCase()}: aguardando progresso e geração do arquivo…`;
    }

    if (buttonText.startsWith("Salvar alteração")) {
      const editStartedAt = performance.now();
      waitForCondition(() => document.body.innerText.includes(completedEditMessage), 60_000).then((completed) => {
        if (!completed) {
          statusElement.textContent = "A edição não chegou à confirmação antes do limite de 60 s.";
          return;
        }
        results.editSamplesMilliseconds.push(Math.round(performance.now() - editStartedAt));
        save();
        statusElement.textContent = `Edição salva e semana atualizada em ${results.editSamplesMilliseconds.at(-1)} ms.`;
      });
    }

    if (buttonText.startsWith("Tentar exportar PNG novamente") && results.retryExercise === "failed-once") {
      retryFailureSeen = true;
      pendingExport = beginExportMeasurement("png");
    }
  }

  function beginExportMeasurement(format: "pdf" | "png") {
    const previousMessage = document.querySelector<HTMLElement>(".week-export-message");
    const previousError = document.querySelector<HTMLElement>(".week-export-error");
    return {
      format,
      startedAt: performance.now(),
      progressSeen: false,
      previousMessage,
      previousMessageText: previousMessage?.textContent?.trim() ?? "",
      previousError,
      previousErrorText: previousError?.textContent?.trim() ?? "",
    };
  }

  function onProgressChange() {
    if (!pendingExport) return;
    const progress = document.querySelector<HTMLElement>(".week-export-progress");
    if (progress && progress.getClientRects().length > 0 && !pendingExport.progressSeen) {
      pendingExport.progressSeen = true;
      results.progressObserved[pendingExport.format] += 1;
      save();
    }
    const failure = document.querySelector<HTMLElement>(".week-export-error");
    const failureText = failure?.textContent?.trim() ?? "";
    if (
      pendingExport.format === "png"
      && failure
      && failure.getClientRects().length > 0
      && (failure !== pendingExport.previousError || failureText !== pendingExport.previousErrorText)
      && results.retryExercise === "not-run"
    ) {
      results.retryExercise = "failed-once";
      failPngOnce = false;
      pendingExport = null;
      save();
      statusElement.textContent = "A falha apareceu. Toque em “Tentar exportar PNG novamente” no painel da escala.";
      return;
    }
    const message = document.querySelector<HTMLElement>(".week-export-message");
    const messageText = message?.textContent?.trim() ?? "";
    const expectedMessage = `Download do ${pendingExport.format.toUpperCase()} iniciado.`;
    if (
      !message
      || messageText !== expectedMessage
      || (message === pendingExport.previousMessage && messageText === pendingExport.previousMessageText)
    ) return;
    if (pendingExport.format === "png" && results.retryExercise === "failed-once" && retryFailureSeen) {
      results.retryExercise = "retry-succeeded";
    }
    const elapsedMilliseconds = Math.round(performance.now() - pendingExport.startedAt);
    results.exportSamplesMilliseconds[pendingExport.format].push(elapsedMilliseconds);
    unconfirmedDownload = true;
    pendingExport = null;
    save();
    statusElement.textContent = `${messageText} Tempo de geração: ${elapsedMilliseconds} ms. Confirme visualmente que o arquivo chegou aos downloads.`;
    if (collapseWhenIdle) collapse();
  }

  function patchOnePngFailure() {
    const prototype = HTMLCanvasElement.prototype as unknown as { getContext: (...args: unknown[]) => unknown };
    const original = prototype.getContext;
    failPngOnce = true;
    results.retryExercise = "not-run";
    retryFailureSeen = false;
    prototype.getContext = function (...args: unknown[]) {
      if (failPngOnce && args[0] === "2d") {
        failPngOnce = false;
        prototype.getContext = original;
        return null;
      }
      return Reflect.apply(original, this, args);
    };
    statusElement.textContent = "Falha armada. Toque em Exportar PNG e depois na opção de nova tentativa do aplicativo.";
  }

  function downloadResults() {
    const payload = new Blob([JSON.stringify(results, null, 2)], { type: "application/json" });
    const address = URL.createObjectURL(payload);
    const anchor = document.createElement("a");
    anchor.href = address;
    anchor.download = `turnocerto-launch-capacity-${results.expectedPeople}-people.json`;
    anchor.click();
    URL.revokeObjectURL(address);
  }

  function onAction(event: MouseEvent) {
    const button = event.target instanceof Element ? event.target.closest<HTMLButtonElement>("button[data-action]") : null;
    if (!button) return;
    switch (button.dataset.action) {
      case "collapse": collapse(); break;
      case "edit": statusElement.textContent = "Escolha qualquer dia de trabalho da escala, marque-o, selecione Folga e salve a alteração pontual."; break;
      case "pdf": statusElement.textContent = "Toque em Exportar PDF na escala para medir a geração."; break;
      case "png": statusElement.textContent = "Toque em Exportar PNG na escala para medir a geração."; break;
      case "retry": patchOnePngFailure(); break;
      case "confirm-download":
        results.confirmedDownloads += 1;
        unconfirmedDownload = false;
        save();
        statusElement.textContent = "Download confirmado visualmente no aparelho.";
        break;
      case "download": downloadResults(); break;
      case "reset":
        results = createResults(expectedPeople, requestedOpenSamples);
        save();
        statusElement.textContent = "Resultados zerados. Recarregando para iniciar uma nova amostra de abertura.";
        window.setTimeout(startOpenMeasurement, 500);
        break;
    }
  }

  async function measurePageOpen() {
    if (results.openAttempts.length >= results.requestedOpenSamples) return;
    const navigationStartedAt = performance.getEntriesByType("navigation")[0]?.startTime ?? 0;
    const ready = await waitForCondition(() => {
      const people = document.querySelectorAll(".person-week");
      const exports = [...document.querySelectorAll<HTMLButtonElement>(".week-export-buttons button")];
      return people.length === expectedPeople && exports.length === 2 && exports.every((button) => !button.disabled);
    }, 90_000);
    const elapsedMilliseconds = Math.round(performance.now() - navigationStartedAt);
    results.openAttempts.push({
      durationMilliseconds: elapsedMilliseconds,
      outcome: ready ? "usable" : "timeout",
    });
    save();
    if (!ready) {
      statusElement.textContent = `A semana completa não ficou pronta em 90 s. O timeout de ${elapsedMilliseconds} ms foi mantido na amostra.`;
    }
    if (results.openAttempts.length < results.requestedOpenSamples) {
      statusElement.textContent = `${results.openAttempts.length}/${results.requestedOpenSamples} tentativas registradas; recarregando para coletar a próxima.`;
      window.setTimeout(startOpenMeasurement, 600);
    } else {
      const usable = results.openAttempts.filter((attempt) => attempt.outcome === "usable").length;
      const timeouts = results.openAttempts.length - usable;
      statusElement.textContent = `Amostra concluída. p75 incluindo timeouts: ${percentile75(results.openAttempts.map((attempt) => attempt.durationMilliseconds))} ms (${usable} utilizáveis, ${timeouts} timeouts).`;
      if (results.expectedPeople === 20) {
        collapseWhenIdle = true;
        window.setTimeout(collapse, 1_500);
      }
    }
  }

  panel.addEventListener("click", onAction);
  document.addEventListener("click", onDocumentClick, true);
  const observer = new MutationObserver(onProgressChange);
  observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
  window.addEventListener("pagehide", () => {
    observer.disconnect();
    document.removeEventListener("click", onDocumentClick, true);
  }, { once: true });

  results.environment = collectEnvironment();
  deviceInput.value = results.environment.deviceLabel;
  deviceInput.addEventListener("input", () => {
    results.environment.deviceLabel = deviceInput.value.trim();
    save();
  });
  save();
  measurePageOpen();
  updateSummary();
}

function loadResults(expectedPeople: number, requestedOpenSamples: number): CapacityResults {
  try {
    const stored = sessionStorage.getItem(stateStorageKey);
    if (stored) {
      const parsed = JSON.parse(stored) as CapacityResults;
      if (
        parsed.schemaVersion === 2
        && Array.isArray(parsed.openAttempts)
        && parsed.expectedPeople === expectedPeople
        && parsed.requestedOpenSamples === requestedOpenSamples
      ) return parsed;
    }
  } catch {
    // Start with a clean in-memory result when session storage is unavailable.
  }
  return createResults(expectedPeople, requestedOpenSamples);
}

function createResults(expectedPeople: number, requestedOpenSamples: number): CapacityResults {
  return {
    schemaVersion: 1,
    runId: `run-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    startedAt: new Date().toISOString(),
    expectedPeople,
    lookbackWeeks: 4,
    requestedOpenSamples,
    openAttempts: [],
    editSamplesMilliseconds: [],
    exportSamplesMilliseconds: { pdf: [], png: [] },
    progressObserved: { pdf: 0, png: 0 },
    retryExercise: "not-run",
    confirmedDownloads: 0,
    environment: collectEnvironment(),
  };
}

function collectEnvironment(): CapacityResults["environment"] {
  const connection = (navigator as Navigator & { connection?: NetworkInformation }).connection;
  let deviceLabel = "";
  try {
    const stored = sessionStorage.getItem(stateStorageKey);
    if (stored) deviceLabel = (JSON.parse(stored) as CapacityResults).environment.deviceLabel ?? "";
  } catch {
    // Device model remains optional if storage is unavailable.
  }
  return {
    userAgent: navigator.userAgent,
    viewport: `${window.innerWidth}x${window.innerHeight} CSS px`,
    devicePixelRatio: window.devicePixelRatio,
    effectiveType: connection?.effectiveType ?? null,
    downlinkMbps: connection?.downlink ?? null,
    rttMilliseconds: connection?.rtt ?? null,
    connectionSelfReport: "local-wifi-lan",
    frontendOrigin: window.location.origin,
    deviceLabel,
  };
}

function percentile75(samples: number[]): number | null {
  if (samples.length === 0) return null;
  const sorted = [...samples].sort((left, right) => left - right);
  return sorted[Math.ceil(sorted.length * 0.75) - 1];
}

async function waitForCondition(condition: () => boolean, timeoutMilliseconds: number): Promise<boolean> {
  const deadline = performance.now() + timeoutMilliseconds;
  while (performance.now() < deadline) {
    if (condition()) return true;
    await new Promise((resolve) => window.setTimeout(resolve, 100));
  }
  return condition();
}
