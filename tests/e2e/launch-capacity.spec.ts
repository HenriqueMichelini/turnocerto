import { expect, test, type APIRequestContext, type Browser } from "@playwright/test";
import { stat } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { createSyntheticCapacityFixture } from "./capacity-fixture.mjs";

const apiBaseUrl = process.env.TURNOCERTO_API_BASE_URL ?? "http://127.0.0.1:8787";
const webOrigin = new URL(process.env.TURNOCERTO_BASE_URL ?? "http://127.0.0.1:8788").origin;
const peopleCount = 20;

test("issue 11 launch capacity: emulated 4G opens a four-week, 20-person Space", async ({ browser, request }) => {
  test.setTimeout(300_000);
  const fixture = await createFixture(request, peopleCount);
  const samplesMilliseconds: number[] = [];

  for (let sampleIndex = 0; sampleIndex < 20; sampleIndex++) {
    const { context, page } = await createMobile4GPage(browser);
    const startedAt = performance.now();
    await page.goto(fixture.managementLink, { waitUntil: "domcontentloaded" });
    await expect(page.locator(".person-week")).toHaveCount(peopleCount, { timeout: 30_000 });
    await expect(page.getByRole("button", { name: "Exportar PDF" })).toBeEnabled();
    await expect(page.getByRole("button", { name: "Exportar PNG" })).toBeEnabled();
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    samplesMilliseconds.push(performance.now() - startedAt);
    await context.close();
  }

  const sorted = [...samplesMilliseconds].sort((left, right) => left - right);
  const p75Milliseconds = nearestRank(sorted, 0.75);
  console.log(`[launch-capacity] ${JSON.stringify({
    scenario: "20-person weekly view, four-week participation history",
    browser: `Chromium ${browser.version()}`,
    emulation: { device: "Pixel 7a viewport profile", viewport: "412x915 CSS px", deviceScaleFactor: 2.625, cpuSlowdown: "4x", network: "4G, 100 ms RTT, 10 Mbps down, 3 Mbps up" },
    samples: samplesMilliseconds.length,
    p50Milliseconds: nearestRank(sorted, 0.5),
    p75Milliseconds,
    maximumMilliseconds: sorted.at(-1),
    usableWithinThreeSeconds: p75Milliseconds <= 3000,
  })}`);
  expect(p75Milliseconds, "20-Person usable-view p75").toBeLessThanOrEqual(3000);
});

test("issue 11 launch capacity: 100-person schedule edits and exports with progress and retry", async ({ browser, request }) => {
  test.setTimeout(600_000);
  const fixture = await createFixture(request, 100);
  const { context, page } = await createMobile4GPage(browser);
  const openedAt = performance.now();
  await page.goto(fixture.managementLink, { waitUntil: "domcontentloaded" });
  await expect(page.locator(".person-week")).toHaveCount(100, { timeout: 30_000 });
  await expect(page.getByRole("button", { name: "Exportar PDF" })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Exportar PNG" })).toBeEnabled();
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  const viewMilliseconds = performance.now() - openedAt;

  const firstPerson = page.locator(".person-week").first();
  await firstPerson.locator('input[type="checkbox"]').first().check();
  await firstPerson.getByLabel("Programação").selectOption("day_off");
  const editStartedAt = performance.now();
  await firstPerson.getByRole("button", { name: "Salvar alteração pontual" }).click();
  await expect(page.getByText("Alteração salva somente para as datas selecionadas.")).toBeVisible();
  await expect(firstPerson.locator(".week-day").first()).toHaveClass(/week-day-day_off/);
  const editMilliseconds = performance.now() - editStartedAt;

  await page.evaluate(() => {
    const windowWithProgress = window as typeof window & { __launchProgressSeen: boolean };
    windowWithProgress.__launchProgressSeen = false;
    new MutationObserver(() => {
      if (document.querySelector(".week-export-progress")) windowWithProgress.__launchProgressSeen = true;
    }).observe(document.documentElement, { childList: true, subtree: true });
  });

  const retryWasVisible = await verifyExportRetry(page);
  const pdfMilliseconds = await collectExportSamples(page, "PDF", 20);
  const pngMilliseconds = await collectExportSamples(page, "PNG", 20);
  const progressSeen = await page.evaluate(() => (window as typeof window & { __launchProgressSeen: boolean }).__launchProgressSeen);

  const pdfSorted = [...pdfMilliseconds].sort((left, right) => left - right);
  const pngSorted = [...pngMilliseconds].sort((left, right) => left - right);
  console.log(`[launch-capacity] ${JSON.stringify({
    scenario: "100-person weekly schedule, browser edit, PDF and PNG export",
    browser: `Chromium ${browser.version()}`,
    emulation: { device: "Pixel 7a viewport profile", viewport: "412x915 CSS px", deviceScaleFactor: 2.625, cpuSlowdown: "4x", network: "4G, 100 ms RTT, 10 Mbps down, 3 Mbps up" },
    scheduleVisiblePeople: 100,
    viewMilliseconds: Math.round(viewMilliseconds),
    editAndRefreshMilliseconds: Math.round(editMilliseconds),
    exportSamplesPerFormat: 20,
    pdfP50Milliseconds: nearestRank(pdfSorted, 0.5),
    pdfP75Milliseconds: nearestRank(pdfSorted, 0.75),
    pdfMaximumMilliseconds: pdfSorted.at(-1),
    pngP50Milliseconds: nearestRank(pngSorted, 0.5),
    pngP75Milliseconds: nearestRank(pngSorted, 0.75),
    pngMaximumMilliseconds: pngSorted.at(-1),
    visibleProgressObserved: progressSeen,
    failureWasVisibleAndRetrySucceeded: retryWasVisible,
  })}`);

  expect(viewMilliseconds, "100-Person view").toBeLessThanOrEqual(15_000);
  expect(editMilliseconds, "100-Person edit and refresh").toBeLessThanOrEqual(15_000);
  expect(nearestRank(pdfSorted, 0.75), "PDF generation p75").toBeLessThanOrEqual(15_000);
  expect(pdfSorted.at(-1), "maximum PDF generation sample").toBeLessThanOrEqual(15_000);
  expect(nearestRank(pngSorted, 0.75), "PNG generation p75").toBeLessThanOrEqual(15_000);
  expect(pngSorted.at(-1), "maximum PNG generation sample").toBeLessThanOrEqual(15_000);
  expect(progressSeen, "export progress").toBe(true);
  expect(retryWasVisible, "visible failed export with successful retry").toBe(true);

  await context.close();
});

async function createFixture(request: APIRequestContext, count: number) {
  return createSyntheticCapacityFixture({
    apiBaseUrl,
    webOrigin,
    count,
    spaceName: `Benchmark ${count} people`,
    personName: (index) => `Person ${String(index).padStart(3, "0")}`,
    send: async (url, options) => {
      const response = await request.fetch(url, {
        method: options.method,
        headers: options.headers,
        data: options.body,
      });
      return { status: response.status(), json: () => response.json() };
    },
  });
}

export async function createMobile4GPage(browser: Browser) {
  const context = await browser.newContext({
    viewport: { width: 412, height: 915 },
    deviceScaleFactor: 2.625,
    isMobile: true,
    hasTouch: true,
    userAgent: `Mozilla/5.0 (Linux; Android 14; Pixel 7a) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${browser.version().split(".")[0]}.0.0.0 Mobile Safari/537.36`,
  });
  const page = await context.newPage();
  const devtools = await context.newCDPSession(page);
  await devtools.send("Network.enable");
  await devtools.send("Network.emulateNetworkConditions", {
    offline: false,
    latency: 100,
    downloadThroughput: 10_000_000 / 8,
    uploadThroughput: 3_000_000 / 8,
    connectionType: "cellular4g",
  });
  await devtools.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  return { context, page };
}

function nearestRank(sorted: number[], percentile: number): number {
  return sorted[Math.max(0, Math.ceil(percentile * sorted.length) - 1)];
}

async function collectExportSamples(page: import("@playwright/test").Page, format: "PDF" | "PNG", count: number): Promise<number[]> {
  const samples: number[] = [];
  for (let index = 0; index < count; index++) {
    await page.evaluate(() => {
      (window as typeof window & { __launchProgressSeen: boolean }).__launchProgressSeen = false;
    });
    const startedAt = performance.now();
    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("button", { name: `Exportar ${format}` }).click();
    await page.locator(".week-export-progress").waitFor({ state: "visible", timeout: 30_000 });
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(format === "PDF" ? /\.pdf$/ : /\.png$/);
    const completedFile = await download.path();
    expect(completedFile).not.toBeNull();
    expect((await stat(completedFile!)).size).toBeGreaterThan(0);
    await expect.poll(() => page.evaluate(() => (window as typeof window & { __launchProgressSeen: boolean }).__launchProgressSeen)).toBe(true);
    samples.push(performance.now() - startedAt);
  }
  return samples;
}

async function verifyExportRetry(page: import("@playwright/test").Page): Promise<boolean> {
  await page.evaluate(() => {
    const prototype = HTMLCanvasElement.prototype as unknown as { getContext: (...args: unknown[]) => unknown };
    const original = prototype.getContext;
    let failOnce = true;
    prototype.getContext = function (...args: unknown[]) {
      if (failOnce && args[0] === "2d") {
        failOnce = false;
        return null;
      }
      return Reflect.apply(original, this, args);
    };
  });
  await page.getByRole("button", { name: "Exportar PNG" }).click();
  await expect(page.getByRole("button", { name: "Tentar exportar PNG novamente" })).toBeVisible();
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Tentar exportar PNG novamente" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/\.png$/);
  const completedFile = await download.path();
  expect(completedFile).not.toBeNull();
  expect((await stat(completedFile!)).size).toBeGreaterThan(0);
  return true;
}
