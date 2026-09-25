import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

const apiBaseUrl = process.env.TURNOCERTO_API_BASE_URL ?? "http://127.0.0.1:8787";
const webOrigin = new URL(process.env.TURNOCERTO_BASE_URL ?? "http://127.0.0.1:8788").origin;
const creationUrl = `${apiBaseUrl}/api/management-spaces`;
const validChallengeToken = "XXXX.DUMMY.TOKEN.XXXX";

async function useTestTurnstile(page: Page, token = validChallengeToken) {
  await page.addInitScript((challengeToken) => {
    (window as typeof window & { __turnstileToken: string }).__turnstileToken = challengeToken;
  }, token);
  await page.route("https://challenges.cloudflare.com/turnstile/v0/api.js**", (route) =>
    route.fulfill({
      contentType: "text/javascript",
      body: `window.turnstile = {
        render: function (container, options) {
          container.innerHTML = '<div aria-label="Test verification complete">Verification ready</div>';
          options.callback(window.__turnstileToken);
          return 'local-test-widget';
        },
        reset: function () {},
        remove: function () {}
      };`,
    }),
  );
}

async function createManagementSpace(request: APIRequestContext, name: string) {
  return request.post(creationUrl, {
    headers: { Origin: webOrigin, "Content-Type": "application/json" },
    data: { spaceName: name, scheduleName: "Primeira escala", turnstileToken: validChallengeToken },
  });
}

test("a visitor creates a Space and can reopen and edit both names from the Management Link", async ({ page }) => {
  await useTestTurnstile(page);
  const privateRequests: Array<{ url: string; authorization?: string }> = [];
  await page.route(/\/api\/management-spaces\//, async (route) => {
    privateRequests.push({
      url: route.request().url(),
      authorization: (await route.request().allHeaders()).authorization,
    });
    await route.continue();
  });

  await page.goto("/");
  await page.getByRole("textbox", { name: "Nome do Espaço de gestão" }).fill("Clínica Aurora");
  await page.getByRole("textbox", { name: "Nome da primeira escala" }).fill("Equipe da manhã");
  await expect(page.getByRole("button", { name: "Criar Espaço e escala" })).toBeEnabled();
  await page.getByRole("button", { name: "Criar Espaço e escala" }).click();
  await expect(page.getByRole("heading", { name: "Equipe da manhã" })).toBeVisible();

  const link = await page.getByRole("textbox", { name: "Link privado de gestão" }).inputValue();
  const fragment = new URLSearchParams(new URL(link).hash.slice(1));
  const token = fragment.get("management_token");
  const spaceID = fragment.get("management_space");
  expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(spaceID).toMatch(/^[0-9a-f-]{36}$/i);
  expect(page.url()).not.toContain(token);

  await page.reload();
  await expect(page.getByRole("heading", { name: "Equipe da manhã" })).toBeVisible();
  await page.getByRole("textbox", { name: "Nome da escala" }).fill("Equipe atualizada");
  await page.getByRole("button", { name: "Salvar nome", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Equipe atualizada" })).toBeVisible();
  await page.getByRole("textbox", { name: "Nome do Espaço de gestão" }).fill("Clínica Horizonte");
  await page.getByRole("button", { name: "Salvar nome do Espaço" }).click();
  await expect(page.locator(".space-name")).toHaveText("Clínica Horizonte");
  await page.reload();
  await expect(page.locator(".space-name")).toHaveText("Clínica Horizonte");
  await expect(page.getByRole("heading", { name: "Equipe atualizada" })).toBeVisible();

  const linkPage = await page.context().newPage();
  await linkPage.route(/\/api\/management-spaces\//, async (route) => {
    privateRequests.push({
      url: route.request().url(),
      authorization: (await route.request().allHeaders()).authorization,
    });
    await route.continue();
  });
  let initialDocumentURL = "";
  linkPage.on("request", (request) => {
    if (request.resourceType() === "document") initialDocumentURL = request.url();
  });
  await linkPage.goto(link);
  expect(initialDocumentURL).toBe(`${webOrigin}/`);
  expect(initialDocumentURL).not.toContain(token);
  await expect(linkPage.locator(".space-name")).toHaveText("Clínica Horizonte");
  await expect(linkPage.getByRole("heading", { name: "Equipe atualizada" })).toBeVisible();
  await expect.poll(() => linkPage.evaluate(() => window.location.hash)).toBe("");

  // Pasting the link into an already open app does not trigger a document load.
  await page.goto(link);
  await expect(page.locator(".space-name")).toHaveText("Clínica Horizonte");
  await expect(page.getByRole("heading", { name: "Equipe atualizada" })).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.location.hash)).toBe("");
  await linkPage.close();

  expect(privateRequests.length).toBeGreaterThan(0);
  for (const request of privateRequests) {
    expect(request.url).not.toContain(token);
    expect(request.authorization).toBe(`Bearer ${token}`);
  }
});

test("private Space requests reject missing, incorrect, and out-of-scope credentials", async ({ request }) => {
  const created = await createManagementSpace(request, "Espaço autorizado");
  expect(created.status()).toBe(201);
  const result = await created.json() as {
    managementSpace: { id: string };
    schedule: { id: string };
    managementToken: string;
  };
  const spaceURL = `${apiBaseUrl}/api/management-spaces/${result.managementSpace.id}`;

  const missing = await request.get(spaceURL, { headers: { Origin: webOrigin } });
  expect(missing.status()).toBe(401);
  const incorrect = await request.get(spaceURL, { headers: { Origin: webOrigin, Authorization: "Bearer incorrect-credential" } });
  expect(incorrect.status()).toBe(401);
  expect(await incorrect.text()).not.toContain("incorrect-credential");

  const valid = await request.get(spaceURL, { headers: { Origin: webOrigin, Authorization: `Bearer ${result.managementToken}` } });
  expect(valid.status()).toBe(200);
  const otherSpace = await request.get(`${apiBaseUrl}/api/management-spaces/90ac6a4e-f314-47c5-913e-7312396c402a`, {
    headers: { Origin: webOrigin, Authorization: `Bearer ${result.managementToken}` },
  });
  expect(otherSpace.status()).toBe(401);
  const otherSpaceRename = await request.patch(`${apiBaseUrl}/api/management-spaces/90ac6a4e-f314-47c5-913e-7312396c402a`, {
    headers: { Origin: webOrigin, Authorization: `Bearer ${result.managementToken}`, "Content-Type": "application/json" },
    data: { name: "Fora do escopo" },
  });
  expect(otherSpaceRename.status()).toBe(401);

  const otherSchedule = await request.patch(`${spaceURL}/schedules/90ac6a4e-f314-47c5-913e-7312396c402a`, {
    headers: { Origin: webOrigin, Authorization: `Bearer ${result.managementToken}`, "Content-Type": "application/json" },
    data: { name: "Fora do escopo" },
  });
  expect(otherSchedule.status()).toBe(404);
  expect(await otherSchedule.text()).not.toContain(result.managementToken);
});

test("the browser reports challenge rejection without exposing the token", async ({ page }) => {
  const challengeToken = "expired-or-replayed-token";
  await useTestTurnstile(page, challengeToken);
  await page.route(creationUrl, (route) => route.fulfill({
    status: 400,
    contentType: "application/json",
    body: JSON.stringify({ error: "challenge_failed" }),
  }));
  await page.goto("/");
  await page.getByRole("textbox", { name: "Nome do Espaço de gestão" }).fill("Não criar");
  await page.getByRole("button", { name: "Criar Espaço e escala" }).click();
  await expect(page.getByRole("alert")).toContainText("A verificação expirou ou não foi aprovada");
  expect(page.url()).not.toContain(challengeToken);
});

test("anonymous creation has a clear rate-limit refusal", async ({ page, request }) => {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const response = await createManagementSpace(request, `Tentativa ${attempt + 1}`);
    expect(response.status(), `creation attempt ${attempt + 1}`).toBe(201);
  }

  await useTestTurnstile(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Criar Espaço e escala" }).click();
  await expect(page.getByRole("alert")).toContainText("Muitas tentativas de criação. Aguarde um minuto");
});
