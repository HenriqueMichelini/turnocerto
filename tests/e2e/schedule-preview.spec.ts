import { expect, test } from "@playwright/test";

test("a teammate can rename the preview schedule and see the saved name after reload", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "Escala de demonstração" })).toBeVisible();
  await expect(page.getByText("Espaço de demonstração")).toBeVisible();

  const name = page.getByRole("textbox", { name: "Nome da escala" });
  await name.fill("Plantão de sábado");
  await page.getByRole("button", { name: "Salvar nome" }).click();
  await expect(page.getByRole("heading", { name: "Plantão de sábado" })).toBeVisible();
  await expect(page.getByRole("status")).toHaveText("Nome salvo.");

  await page.reload();
  await expect(page.getByRole("heading", { name: "Plantão de sábado" })).toBeVisible();
});

test("schedule responses are private and excluded from shared caches and search indexes", async ({ request }) => {
  const response = await request.get("/api/schedules/preview-fixture");

  expect(response.ok()).toBeTruthy();
  expect(response.headers()["cache-control"]).toContain("no-store");
  expect(response.headers()["x-robots-tag"]).toContain("noindex");
  expect(response.headers()["referrer-policy"]).toBe("no-referrer");
});

test("the preview fixture is available only in the preview environment", async ({ request }) => {
  const response = await request.get("/api/schedules/preview-fixture");

  if (process.env.TURNOCERTO_ENV === "production") {
    expect(response.status()).toBe(404);
  } else {
    expect(response.ok()).toBeTruthy();
  }
  expect(response.headers()["cache-control"]).toContain("no-store");
});

test("the rename form stays usable at a phone viewport", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");

  const name = page.getByRole("textbox", { name: "Nome da escala" });
  const saveButton = page.getByRole("button", { name: "Salvar nome" });
  await expect(name).toBeVisible();
  await expect(saveButton).toBeVisible();

  const buttonBounds = await saveButton.boundingBox();
  expect(buttonBounds).not.toBeNull();
  expect(buttonBounds!.x + buttonBounds!.width).toBeLessThanOrEqual(390);
});
