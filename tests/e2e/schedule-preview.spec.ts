import { expect, test, type Page } from "@playwright/test";

const apiBaseUrl = process.env.TURNOCERTO_API_BASE_URL ?? "http://127.0.0.1:8787";
const webOrigin = new URL(process.env.TURNOCERTO_BASE_URL ?? "http://127.0.0.1:8788").origin;
const scheduleApiUrl = `${apiBaseUrl}/api/schedules/preview-fixture`;
const previewToken = process.env.TURNOCERTO_PREVIEW_TOKEN ?? "";
const useLinkFragment = previewToken !== "" && process.env.TURNOCERTO_PREVIEW_LINK_FRAGMENT === "true";
const authorizationHeaders = previewToken ? { Authorization: `Bearer ${previewToken}` } : {};

async function openPreview(page: Page) {
  if (previewToken && !useLinkFragment) {
    await page.addInitScript(({ key, token }) => sessionStorage.setItem(key, token), {
      key: "turnocerto-preview-token",
      token: previewToken,
    });
  }
  const path = useLinkFragment ? `/#preview_token=${encodeURIComponent(previewToken)}` : "/";
  await page.goto(path);
  if (useLinkFragment) {
    await expect.poll(() => page.evaluate(() => window.location.hash)).toBe("");
  }
}

test("a teammate can rename the preview schedule and see the saved name after reload", async ({ page }) => {
  await openPreview(page);

  const title = page.getByRole("heading", { level: 1 });
  await expect(title).toBeVisible();
  const originalName = (await title.innerText()).trim();
  expect(originalName).not.toBe("Escala indisponível");
  await expect(page.getByText("Espaço de demonstração")).toBeVisible();

  const name = page.getByRole("textbox", { name: "Nome da escala" });
  const renamed = `Plantão de sábado ${Date.now()}`;
  await name.fill(renamed);
  await page.getByRole("button", { name: "Salvar nome" }).click();
  await expect(page.getByRole("heading", { name: renamed })).toBeVisible();
  await expect(page.getByRole("status")).toHaveText("Nome salvo.");

  await page.reload();
  await expect(page.getByRole("heading", { name: renamed })).toBeVisible();

  await name.fill(originalName);
  await page.getByRole("button", { name: "Salvar nome" }).click();
  await expect(title).toHaveText(originalName);
});

test("schedule responses are private and excluded from shared caches and search indexes", async ({ request }) => {
  const response = await request.get(scheduleApiUrl, { headers: { Origin: webOrigin, ...authorizationHeaders } });

  expect(response.ok()).toBeTruthy();
  expect(response.headers()["cache-control"]).toContain("no-store");
  expect(response.headers()["x-robots-tag"]).toContain("noindex");
  expect(response.headers()["referrer-policy"]).toBe("no-referrer");
  expect(response.headers()["access-control-allow-origin"]).toBe(webOrigin);
});

test("the API rejects a request from an unconfigured web origin", async ({ request }) => {
  const response = await request.get(scheduleApiUrl, {
    headers: { Origin: "https://untrusted.example" },
  });

  expect(response.status()).toBe(403);
  expect(response.headers()["access-control-allow-origin"]).toBeUndefined();
});

test("the preview fixture rejects missing and incorrect bearer tokens", async ({ request }) => {
  test.skip(process.env.TURNOCERTO_ENV === "production", "The preview fixture is disabled in production.");

  const missing = await request.get(scheduleApiUrl, { headers: { Origin: webOrigin } });
  expect(missing.status()).toBe(401);

  const incorrect = await request.get(scheduleApiUrl, {
    headers: { Origin: webOrigin, Authorization: "Bearer incorrect-token" },
  });
  expect(incorrect.status()).toBe(401);
  expect(await incorrect.text()).not.toContain("incorrect-token");
});

test("the preview fixture is available only in the preview environment", async ({ request }) => {
  const response = await request.get(scheduleApiUrl, { headers: { Origin: webOrigin, ...authorizationHeaders } });

  if (process.env.TURNOCERTO_ENV === "production") {
    expect(response.status()).toBe(404);
  } else {
    expect(response.ok()).toBeTruthy();
  }
  expect(response.headers()["cache-control"]).toContain("no-store");
  expect(response.headers()["access-control-allow-origin"]).toBe(webOrigin);
});

test("the rename form stays usable at a phone viewport", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openPreview(page);

  const name = page.getByRole("textbox", { name: "Nome da escala" });
  const saveButton = page.getByRole("button", { name: "Salvar nome" });
  await expect(name).toBeVisible();
  await expect(saveButton).toBeVisible();

  const buttonBounds = await saveButton.boundingBox();
  expect(buttonBounds).not.toBeNull();
  expect(buttonBounds!.x + buttonBounds!.width).toBeLessThanOrEqual(390);
});
