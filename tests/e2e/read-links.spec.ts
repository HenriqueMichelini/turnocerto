import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

const apiBaseUrl = process.env.TURNOCERTO_API_BASE_URL ?? "http://127.0.0.1:8787";
const webOrigin = new URL(process.env.TURNOCERTO_BASE_URL ?? "http://127.0.0.1:8788").origin;
const validChallengeToken = "XXXX.DUMMY.TOKEN.XXXX";

async function createManagementSpace(request: APIRequestContext) {
  const response = await request.post(`${apiBaseUrl}/api/management-spaces`, {
    headers: {
      Origin: webOrigin,
      "CF-Connecting-IP": "198.51.100.46",
      "Content-Type": "application/json",
    },
    data: {
      spaceName: `Read Link Space ${Date.now()}`,
      scheduleName: "Escala compartilhada",
      turnstileToken: validChallengeToken,
    },
  });
  expect(response.status()).toBe(201);
  return await response.json() as {
    managementSpace: { id: string };
    schedule: { id: string; name: string };
    managementToken: string;
  };
}

test("read links issue fixed scoped weeks, reflect edits, redact certificates, and revoke immediately", async ({ page, request }) => {
  const created = await createManagementSpace(request);
  const weekStart = mondayInTimeZone("America/Sao_Paulo");
  const endDate = addCalendarDays(weekStart, 13);
  const managementHeaders = { Origin: webOrigin, Authorization: `Bearer ${created.managementToken}` };
  const peopleResponse = await request.post(`${apiBaseUrl}/api/management-spaces/${created.managementSpace.id}/people`, {
    headers: managementHeaders,
    data: { name: "Ana Ribeiro" },
  });
  expect(peopleResponse.status()).toBe(201);
  const person = (await peopleResponse.json() as { person: { id: string } }).person;

  const weekdays = Array.from({ length: 7 }, (_, index) => ({
    weekday: index + 1,
    state: index === 0 ? "work_period" : "undefined",
    ...(index === 0 ? { workPeriod: { startTime: "09:00", endTime: "17:00" } } : {}),
  }));
  const participationResponse = await request.post(
    `${apiBaseUrl}/api/management-spaces/${created.managementSpace.id}/schedules/${created.schedule.id}/participations`,
    { headers: managementHeaders, data: { personId: person.id, startDate: weekStart, endDate, pattern: { effectiveFrom: weekStart, weekdays } } },
  );
  expect(participationResponse.status()).toBe(201);
  const participation = (await participationResponse.json() as { participation: { id: string } }).participation;

  await saveDateEdit(request, created, managementHeaders, participation.id, weekStart, {
    date: weekStart,
    state: "medical_leave",
  });

  await page.goto(buildManagementLink(webOrigin, created.managementSpace.id, created.managementToken));
  await expect(page.getByRole("heading", { name: "Links de leitura" })).toBeVisible();
  await page.getByLabel("Data inicial da primeira semana").fill(weekStart);
  await page.getByLabel("Semanas consecutivas").selectOption("2");
  await page.getByRole("button", { name: "Criar link de leitura" }).click();
  const generatedLink = page.getByRole("textbox", { name: "Link de leitura criado" });
  await expect(generatedLink).toBeVisible();
  const readLink = await generatedLink.inputValue();
  const fragment = new URLSearchParams(new URL(readLink).hash.slice(1));
  const linkID = fragment.get("read_link_id") ?? "";
  const scheduleID = fragment.get("read_schedule_id") ?? "";
  const readToken = fragment.get("read_token") ?? "";
  expect(linkID).toMatch(/^[0-9a-f-]{36}$/i);
  expect(scheduleID).toBe(created.schedule.id);
  expect(readToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(fragment.get("read_start_week")).toBe(weekStart);
  expect(fragment.get("read_week_count")).toBe("2");

  const handoffPage = await page.context().newPage();
  await handoffPage.goto(readLink);
  await expect(handoffPage.getByRole("heading", { name: created.schedule.name })).toBeVisible();
  const managementLink = buildManagementLink(webOrigin, created.managementSpace.id, created.managementToken);
  await handoffPage.evaluate((hash) => { window.location.hash = hash; }, new URL(managementLink).hash);
  await expect(handoffPage.getByRole("heading", { name: "Links de leitura" })).toBeVisible();
  await expect(handoffPage.getByRole("button", { name: "Criar link de leitura" })).toBeVisible();
  await handoffPage.close();

  const readerPage = await page.context().newPage();
  const readerRequests: Array<{ url: string; authorization?: string; referrer?: string }> = [];
  readerPage.on("request", async (browserRequest) => {
    if (browserRequest.url().includes("/api/read-links/")) {
      const headers = await browserRequest.allHeaders();
      readerRequests.push({ url: browserRequest.url(), authorization: headers.authorization, referrer: headers.referer });
    }
  });
  let documentURL = "";
  readerPage.on("request", (browserRequest) => {
    if (browserRequest.resourceType() === "document") documentURL = browserRequest.url();
  });
  await readerPage.goto(readLink);
  await expect(readerPage.getByRole("heading", { name: created.schedule.name })).toBeVisible();
  await expect(readerPage.getByRole("heading", { level: 2, name: `Semana de ${formatDate(weekStart)}` })).toBeVisible();
  await readerPage.getByRole("button", { name: "Próxima semana" }).click();
  await expect(readerPage.getByRole("heading", { level: 2, name: `Semana de ${formatDate(addCalendarDays(weekStart, 7))}` })).toBeVisible();
  await expect(readerPage.getByRole("button", { name: "Próxima semana" })).toBeDisabled();
  await readerPage.getByRole("button", { name: "Semana anterior" }).click();
  await expect(readerPage.getByRole("heading", { level: 2, name: `Semana de ${formatDate(weekStart)}` })).toBeVisible();
  await expect(readerPage.locator(".week-day-unavailable")).toContainText("Indisponível");
  expect(await readerPage.locator(".week-day").allTextContents()).not.toContain("Atestado");
  await expect(readerPage.getByRole("button", { name: "Criar link de leitura" })).toHaveCount(0);
  await expect(readerPage.locator("form")).toHaveCount(0);
  await expect.poll(() => readerPage.evaluate(() => window.location.hash)).toBe("");
  expect(documentURL).not.toContain(readToken);
  await expect.poll(() => readerRequests.length).toBeGreaterThan(0);
  for (const browserRequest of readerRequests) {
    expect(browserRequest.url).not.toContain(readToken);
    expect(browserRequest.authorization).toBe(`Bearer ${readToken}`);
    expect(browserRequest.referrer).toBeUndefined();
  }

  const readWeekURL = `${apiBaseUrl}/api/read-links/${linkID}/schedules/${scheduleID}/weeks/${weekStart}`;
  const readResponse = await request.get(readWeekURL, { headers: { Origin: webOrigin, Authorization: `Bearer ${readToken}` } });
  expect(readResponse.status()).toBe(200);
  expect(readResponse.headers()["cache-control"]).toContain("no-store");
  expect(readResponse.headers()["x-robots-tag"]).toContain("noindex");
  expect(readResponse.headers()["referrer-policy"]).toBe("no-referrer");
  expect(await readResponse.text()).not.toContain("medical_leave");

  const otherScheduleResponse = await request.post(`${apiBaseUrl}/api/management-spaces/${created.managementSpace.id}/schedules`, {
    headers: managementHeaders,
    data: { name: "Outra escala", timeZone: "America/Sao_Paulo" },
  });
  expect(otherScheduleResponse.status()).toBe(201);
  const otherScheduleID = (await otherScheduleResponse.json() as { schedule: { id: string } }).schedule.id;
  const wrongSchedule = await request.get(`${apiBaseUrl}/api/read-links/${linkID}/schedules/${otherScheduleID}/weeks/${weekStart}`, {
    headers: { Origin: webOrigin, Authorization: `Bearer ${readToken}` },
  });
  expect(wrongSchedule.status()).toBe(401);
  expect(await wrongSchedule.text()).not.toContain(created.schedule.name);
  const outOfRange = await request.get(`${apiBaseUrl}/api/read-links/${linkID}/schedules/${scheduleID}/weeks/${addCalendarDays(weekStart, 14)}`, {
    headers: { Origin: webOrigin, Authorization: `Bearer ${readToken}` },
  });
  expect(outOfRange.status()).toBe(401);
  expect(await outOfRange.text()).not.toContain(created.schedule.name);

  await saveDateEdit(request, created, managementHeaders, participation.id, weekStart, {
    date: addCalendarDays(weekStart, 1),
    state: "day_off",
  });
  await readerPage.reload();
  await expect(readerPage.locator(".week-day-day_off")).toContainText("Folga");

  await page.getByRole("button", { name: "Revogar", exact: true }).click();
  await expect(page.locator(".read-links-panel [role=status]")).toContainText("Link de leitura revogado");
  const revoked = await request.get(readWeekURL, { headers: { Origin: webOrigin, Authorization: `Bearer ${readToken}` } });
  expect(revoked.status()).toBe(401);
  expect(await revoked.text()).not.toContain(created.schedule.name);
  await readerPage.reload();
  await expect(readerPage.getByRole("alert")).toContainText("foi revogado");
});

async function saveDateEdit(
  request: APIRequestContext,
  created: Awaited<ReturnType<typeof createManagementSpace>>,
  headers: Record<string, string>,
  participationID: string,
  weekStart: string,
  dateEdit: { date: string; state: "medical_leave" | "day_off" },
) {
  const scheduleURL = `${apiBaseUrl}/api/management-spaces/${created.managementSpace.id}/schedules/${created.schedule.id}`;
  const current = await request.get(`${scheduleURL}?weekStart=${weekStart}`, { headers });
  expect(current.status()).toBe(200);
  const revision = (await current.json() as { week: { revision: string } }).week.revision;
  const response = await request.post(`${scheduleURL}/participations/${participationID}/edits`, {
    headers,
    data: { revision, weekStart, mode: "once", dates: [dateEdit] },
  });
  expect(response.status()).toBe(200);
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

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "2-digit", timeZone: "UTC" }).format(new Date(`${value}T12:00:00Z`));
}
