import { expect, test, type APIRequestContext } from "@playwright/test";
import { readFile } from "node:fs/promises";

const apiBaseUrl = process.env.TURNOCERTO_API_BASE_URL ?? "http://127.0.0.1:8787";
const webOrigin = new URL(process.env.TURNOCERTO_BASE_URL ?? "http://127.0.0.1:8788").origin;

test("editors and fixed-week readers can export a complete, redacted week and retry a failed export", async ({ page, request }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const browserSession = await page.context().newCDPSession(page);
  await browserSession.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  await page.addInitScript(() => {
    const canvas = HTMLCanvasElement.prototype;
    const originalToBlob = canvas.toBlob;
    let failFirstExport = true;
    canvas.toBlob = function (callback, type, quality) {
      if (failFirstExport) {
        failFirstExport = false;
        queueMicrotask(() => callback(null));
        return;
      }
      return originalToBlob.call(this, callback, type, quality);
    };
    const drawing = CanvasRenderingContext2D.prototype;
    const originalFillText = drawing.fillText;
    (window as typeof window & { __turnocertoExportText?: string[] }).__turnocertoExportText = [];
    drawing.fillText = function (text, ...args) {
      (window as typeof window & { __turnocertoExportText: string[] }).__turnocertoExportText.push(String(text));
      return originalFillText.call(this, text, ...args);
    };
  });

  const created = await createManagementSpace(request);
  const weekStart = mondayInTimeZone("America/Sao_Paulo");
  const endDate = addCalendarDays(weekStart, 6);
  const headers = { Origin: webOrigin, Authorization: `Bearer ${created.managementToken}` };
  const scheduleURL = `${apiBaseUrl}/api/management-spaces/${created.managementSpace.id}/schedules/${created.schedule.id}`;
  const participantIDs: string[] = [];

  for (let index = 1; index <= 100; index++) {
    const personResponse = await request.post(`${apiBaseUrl}/api/management-spaces/${created.managementSpace.id}/people`, {
      headers,
      data: { name: `Pessoa ${String(index).padStart(3, "0")}` },
    });
    expect(personResponse.status()).toBe(201);
    const person = (await personResponse.json() as { person: { id: string } }).person;
    const participationResponse = await request.post(`${scheduleURL}/participations`, {
      headers,
      data: {
        personId: person.id,
        startDate: weekStart,
        endDate,
        pattern: {
          effectiveFrom: weekStart,
          weekdays: Array.from({ length: 7 }, (_, day) => ({
            weekday: day + 1,
            state: day === 0 ? "work_period" : "undefined",
            ...(day === 0 ? { workPeriod: { startTime: "09:00", endTime: "17:00" } } : {}),
          })),
        },
      },
    });
    expect(participationResponse.status()).toBe(201);
    participantIDs.push((await participationResponse.json() as { participation: { id: string } }).participation.id);
  }

  await saveDateEdits(request, scheduleURL, headers, participantIDs[0], weekStart, [
    { date: weekStart, state: "medical_leave" },
    { date: addCalendarDays(weekStart, 1), state: "day_off" },
  ]);

  await page.goto(buildManagementLink(webOrigin, created.managementSpace.id, created.managementToken));
  await expect(page.getByRole("heading", { name: "Semana de" })).toBeVisible();
  await expect(page.locator(".person-week")).toHaveCount(100);
  const editorPng = page.getByRole("button", { name: "Exportar PNG" });
  await expect(editorPng).toBeVisible();
  await editorPng.click();
  await expect(page.getByRole("alert")).toContainText("Não definido");
  await page.getByRole("button", { name: "Continuar e exportar PNG" }).click();
  await expect(page.getByRole("alert")).toContainText("Tente novamente");
  await expect(page.getByRole("button", { name: "Tentar exportar PNG novamente" })).toBeVisible();
  const pngStartedAt = Date.now();
  const editorPngDownloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Tentar exportar PNG novamente" }).click();
  await expect(page.locator(".week-export-progress")).toContainText("de 100 pessoas");
  const editorPngDownload = await editorPngDownloadPromise;
  expect(Date.now() - pngStartedAt).toBeLessThan(15_000);
  expect(editorPngDownload.suggestedFilename()).toMatch(/\.png$/);
  const pngBytes = await readFile((await editorPngDownload.path())!);
  expect(pngBytes.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const pngWidth = pngBytes.readUInt32BE(16);
  const pngHeight = pngBytes.readUInt32BE(20);
  expect(pngWidth).toBeGreaterThan(900);
  expect(pngHeight).toBeGreaterThan(6_500);
  const editorPaintedText = await page.evaluate(() => (window as typeof window & { __turnocertoExportText: string[] }).__turnocertoExportText);
  expect(editorPaintedText).toContain("Pessoa 100");
  expect(editorPaintedText).toContain("Indisponível");
  expect(editorPaintedText).toContain("Não definido");
  expect(editorPaintedText).toContain("Jornada");
  expect(editorPaintedText).toContain("09:00–17:00");
  expect(editorPaintedText).toContain("Folga");
  expect(editorPaintedText).toContain("Exceção");
  expect(editorPaintedText).not.toContain("Atestado");
  expect(editorPaintedText).not.toContain("medical_leave");

  const editorPdfDownload = await startConfirmedExport(page, "PDF");
  expect(editorPdfDownload.suggestedFilename()).toMatch(/\.pdf$/);
  const pdfBytes = await readFile((await editorPdfDownload.path())!);
  expect(pdfBytes.subarray(0, 8).toString("ascii")).toMatch(/^%PDF-/);
  const pdfText = pdfBytes.toString("latin1");
  const pageCount = (pdfText.match(/\/Type \/Page\b/g) ?? []).length;
  expect(pageCount).toBeGreaterThan(1);
  expect(pageCount).toBeLessThanOrEqual(20);
  const xrefOffset = Number(pdfText.match(/startxref\n(\d+)/)?.[1]);
  expect(pdfText.slice(xrefOffset, xrefOffset + 5)).toBe("xref\n");
  const xrefLines = pdfText.slice(xrefOffset).split("\n");
  const objectCount = Number(xrefLines[1].split(" ")[1]);
  for (let objectID = 1; objectID < objectCount; objectID++) {
    const offset = Number(xrefLines[objectID + 2].slice(0, 10));
    expect(pdfText.slice(offset).startsWith(`${objectID} 0 obj\n`)).toBe(true);
  }

  const linkResponse = await request.post(`${scheduleURL}/read-links`, {
    headers: { ...headers, "Content-Type": "application/json" },
    data: { startWeek: weekStart, weekCount: 1 },
  });
  expect(linkResponse.status()).toBe(201);
  const linkResult = await linkResponse.json() as { readLink: { id: string; scheduleId: string; startWeek: string; weekCount: number }; readToken: string };
  const readLink = new URL("/", webOrigin);
  readLink.hash = new URLSearchParams({
    read_link_id: linkResult.readLink.id,
    read_schedule_id: linkResult.readLink.scheduleId,
    read_token: linkResult.readToken,
    read_start_week: linkResult.readLink.startWeek,
    read_week_count: String(linkResult.readLink.weekCount),
  }).toString();
  await page.goto(readLink.toString());
  await expect(page.getByRole("heading", { name: created.schedule.name })).toBeVisible();
  await expect(page.locator(".week-day-unavailable")).toContainText("Indisponível");
  expect((await page.locator(".week-day").allTextContents()).join(" ")).not.toContain("Atestado");
  await expect(page.getByRole("button", { name: "Próxima semana" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Exportar PDF" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Exportar PNG" })).toBeVisible();

  const readerPngDownload = await startConfirmedExport(page, "PNG");
  expect(readerPngDownload.suggestedFilename()).toMatch(/\.png$/);
  const readerPngBytes = await readFile((await readerPngDownload.path())!);
  expect(readerPngBytes.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  expect(readerPngBytes.readUInt32BE(20)).toBeGreaterThan(6_500);
  const readerPaintedText = await page.evaluate(() => (window as typeof window & { __turnocertoExportText: string[] }).__turnocertoExportText);
  expect(readerPaintedText).toContain("Pessoa 100");
  expect(readerPaintedText).toContain("Indisponível");
  expect(readerPaintedText).toContain("Não definido");
  expect(readerPaintedText).toContain("Folga");
  expect(readerPaintedText).not.toContain("Atestado");

  const readerPdfDownload = await startConfirmedExport(page, "PDF");
  expect(readerPdfDownload.suggestedFilename()).toMatch(/\.pdf$/);
  const readerPdfBytes = await readFile((await readerPdfDownload.path())!);
  expect(readerPdfBytes.subarray(0, 8).toString("ascii")).toMatch(/^%PDF-/);
  expect((readerPdfBytes.toString("latin1").match(/\/Type \/Page\b/g) ?? []).length).toBeGreaterThan(1);

  const forbiddenWeek = await request.get(`${apiBaseUrl}/api/read-links/${linkResult.readLink.id}/schedules/${created.schedule.id}/weeks/${addCalendarDays(weekStart, 7)}`, {
    headers: { Origin: webOrigin, Authorization: `Bearer ${linkResult.readToken}` },
  });
  expect(forbiddenWeek.status()).toBe(401);
});

async function createManagementSpace(request: APIRequestContext) {
  const response = await request.post(`${apiBaseUrl}/api/management-spaces`, {
    headers: { Origin: webOrigin, "CF-Connecting-IP": "198.51.100.73", "Content-Type": "application/json" },
    data: {
      spaceName: "Espaço de exportação",
      scheduleName: "Escala de exportação",
      turnstileToken: "XXXX.DUMMY.TOKEN.XXXX",
    },
  });
  expect(response.status()).toBe(201);
  return await response.json() as {
    managementSpace: { id: string };
    schedule: { id: string; name: string };
    managementToken: string;
  };
}

async function saveDateEdits(
  request: APIRequestContext,
  scheduleURL: string,
  headers: Record<string, string>,
  participationID: string,
  weekStart: string,
  dates: Array<{ date: string; state: "medical_leave" | "day_off" }>,
) {
  const current = await request.get(`${scheduleURL}?weekStart=${weekStart}`, { headers });
  expect(current.status()).toBe(200);
  const revision = (await current.json() as { week: { revision: string } }).week.revision;
  const response = await request.post(`${scheduleURL}/participations/${participationID}/edits`, {
    headers: { ...headers, "Content-Type": "application/json" },
    data: { revision, weekStart, mode: "once", dates },
  });
  expect(response.status()).toBe(200);
}

async function startConfirmedExport(page: import("@playwright/test").Page, format: "PDF" | "PNG") {
  await page.getByRole("button", { name: `Exportar ${format}` }).click();
  await expect(page.getByRole("alert")).toContainText("Não definido");
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: `Continuar e exportar ${format}` }).click();
  await expect(page.locator(".week-export-progress")).toContainText(format === "PDF" ? "páginas" : "pessoas");
  return await download;
}

function buildManagementLink(origin: string, spaceID: string, token: string): string {
  const link = new URL("/", origin);
  link.hash = new URLSearchParams({ management_space: spaceID, management_token: token }).toString();
  return link.toString();
}

function mondayInTimeZone(timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const part = (type: string) => parts.find((item) => item.type === type)?.value ?? "";
  const date = new Date(`${part("year")}-${part("month")}-${part("day")}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
  return date.toISOString().slice(0, 10);
}

function addCalendarDays(value: string, days: number): string {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}
