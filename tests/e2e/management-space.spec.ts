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

async function createManagementSpace(request: APIRequestContext, name: string, clientIP?: string) {
  return request.post(creationUrl, {
    headers: {
      Origin: webOrigin,
      "Content-Type": "application/json",
      ...(clientIP ? { "CF-Connecting-IP": clientIP } : {}),
    },
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

test("the browser assigns one shared Person to overlapping Schedules and opens derived weeks in Brazilian Portuguese", async ({ page, request }) => {
  const created = await createManagementSpace(request, "Espaço de escala", "198.51.100.31");
  expect(created.status()).toBe(201);
  const initial = await created.json() as {
    managementSpace: { id: string };
    schedule: { id: string; timeZone: string; name: string };
    managementToken: string;
  };
  const managementLink = `${webOrigin}/#${new URLSearchParams({
    management_space: initial.managementSpace.id,
    management_token: initial.managementToken,
  }).toString()}`;

  await page.goto(managementLink);
  await expect(page.getByRole("heading", { name: "Pessoas e semanas" })).toBeVisible();
  await page.getByRole("textbox", { name: "Nome da pessoa" }).fill("Ana Ribeiro");
  await page.getByRole("button", { name: "Cadastrar pessoa" }).click();
  await expect(page.locator(".schedule-editor .notice.success")).toContainText("Pessoa cadastrada");

  const dates = await page.evaluate(() => {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Sao_Paulo",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(new Date());
    const part = (type: string) => parts.find((item) => item.type === type)?.value ?? "";
    const date = new Date(`${part("year")}-${part("month")}-${part("day")}T00:00:00Z`);
    const mondayOffset = (date.getUTCDay() + 6) % 7;
    date.setUTCDate(date.getUTCDate() - mondayOffset);
    const start = new Date(date);
    start.setUTCDate(start.getUTCDate() + 2);
    const end = new Date(date);
    end.setUTCDate(end.getUTCDate() + 13);
    return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
  });

  await page.getByRole("button", { name: "Semana anterior" }).click();
  await page.getByRole("button", { name: "Próxima semana" }).click();
  const weekStart = new Date(`${dates.start}T00:00:00Z`);
  weekStart.setUTCDate(weekStart.getUTCDate() - ((weekStart.getUTCDay() + 6) % 7));
  await page.getByLabel("Abrir semana").fill(weekStart.toISOString().slice(0, 10));
  const participationPanel = page.locator("details").filter({ hasText: "Incluir pessoa nesta escala" });
  if (!(await participationPanel.evaluate((element) => (element as HTMLDetailsElement).open))) {
    await participationPanel.locator("summary").click();
  }
  await page.getByLabel("Pessoa", { exact: true }).selectOption({ label: "Ana Ribeiro" });
  await page.getByLabel("Início da participação").fill(dates.start);
  await page.getByLabel("Fim da participação (opcional)").fill(dates.end);
  await page.getByLabel("Segunda").selectOption("day_off");
  await page.getByLabel("Terça").selectOption("undefined");
  await page.getByLabel("Quarta").selectOption("work_period");
  await page.getByLabel("Quinta").selectOption("day_off");
  await page.locator("#pattern-start-2").fill("22:00");
  await page.locator("#pattern-end-2").fill("06:00");
  await page.getByRole("button", { name: "Incluir pessoa e salvar padrão" }).click();
  await expect(page.locator(".schedule-editor .notice.success")).toContainText("padrão recorrente salvo");

  const firstScheduleWeek = page.locator(".person-week").filter({ hasText: "Ana Ribeiro" });
  await expect(firstScheduleWeek.locator(".week-day-outside_participation").first()).toContainText("Fora da participação");
  await expect(firstScheduleWeek.locator(".week-day-outside_participation").last()).toContainText("Fora da participação");
  await expect(firstScheduleWeek.locator(".week-day-work_period")).toContainText("22:00–06:00");
  await expect(firstScheduleWeek.locator(".week-day-day_off")).toContainText("Folga");
  await expect(firstScheduleWeek.locator(".week-day-undefined").first()).toContainText("Não definido");

  await firstScheduleWeek.getByRole("checkbox").nth(2).check();
  await firstScheduleWeek.getByLabel("Programação").selectOption("medical_leave");
  await firstScheduleWeek.getByRole("button", { name: "Salvar alteração pontual" }).click();
  await expect(page.locator(".schedule-editor .notice.success")).toContainText("Alteração salva somente para as datas selecionadas");
  await expect(firstScheduleWeek.locator(".week-day-medical_leave")).toContainText("Atestado");
  await firstScheduleWeek.getByRole("checkbox").nth(2).check();
  await firstScheduleWeek.getByLabel("Remover a exceção e usar o padrão semanal").check();
  await firstScheduleWeek.getByRole("button", { name: "Salvar alteração pontual" }).click();
  await expect(page.locator(".schedule-editor .notice.success")).toContainText("Exceção removida; o padrão recorrente voltou a valer nesta data.");
  await expect(firstScheduleWeek.locator(".week-day-work_period")).toContainText("22:00–06:00");
  await firstScheduleWeek.getByRole("checkbox").nth(2).check();
  await firstScheduleWeek.getByLabel("Programação").selectOption("absence");
  await firstScheduleWeek.getByRole("button", { name: "Salvar alteração pontual" }).click();
  await expect(page.locator(".schedule-editor .notice.success")).toContainText("Alteração salva somente para as datas selecionadas");
  await expect(firstScheduleWeek.locator(".week-day-absence")).toContainText("Ausência");

  await page.getByText("Criar outra escala", { exact: true }).click();
  await page.getByLabel("Nome da escala").last().fill("Equipe da tarde");
  await page.getByLabel("Fuso horário").last().fill("America/Los_Angeles");
  await page.getByRole("button", { name: "Criar escala" }).click();
  await expect(page.getByRole("heading", { name: "Equipe da tarde" })).toBeVisible();
  await expect(page.getByLabel("Fuso horário IANA")).toHaveValue("America/Los_Angeles");
  await page.getByLabel("Abrir semana").fill(weekStart.toISOString().slice(0, 10));

  if (!(await participationPanel.evaluate((element) => (element as HTMLDetailsElement).open))) {
    await participationPanel.locator("summary").click();
  }
  await page.getByLabel("Pessoa", { exact: true }).selectOption({ label: "Ana Ribeiro" });
  await page.getByLabel("Início da participação").fill(dates.start);
  await page.getByLabel("Quinta").selectOption("work_period");
  await page.getByRole("button", { name: "Incluir pessoa e salvar padrão" }).click();
  await expect(page.locator(".schedule-editor .notice.success")).toContainText("padrão recorrente salvo");

  const spaceURL = `${apiBaseUrl}/api/management-spaces/${initial.managementSpace.id}`;
  const viewResponse = await request.get(spaceURL, {
    headers: { Origin: webOrigin, Authorization: `Bearer ${initial.managementToken}` },
  });
  expect(viewResponse.status()).toBe(200);
  const view = await viewResponse.json() as {
    people: Array<{ id: string; name: string }>;
    schedules: Array<{ id: string; timeZone: string; participations: Array<{ id: string; person: { id: string }; startDate: string; endDate?: string; patternVersions: Array<{ effectiveFrom: string; weekdays: Array<{ weekday: number; state: string }> }>; dateExceptions?: Array<{ date: string; state: string }> }> }>;
  };
  expect(view.people).toHaveLength(1);
  expect(view.people[0].name).toBe("Ana Ribeiro");
  expect(view.schedules).toHaveLength(2);
  expect(view.schedules.find((calendar) => calendar.id === initial.schedule.id)?.timeZone).toBe("America/Sao_Paulo");
  expect(view.schedules.find((calendar) => calendar.id !== initial.schedule.id)?.timeZone).toBe("America/Los_Angeles");
  const firstSchedule = view.schedules.find((calendar) => calendar.id === initial.schedule.id)!;
  const secondSchedule = view.schedules.find((calendar) => calendar.id !== initial.schedule.id)!;
  for (const calendar of [firstSchedule, secondSchedule]) {
    expect(calendar.participations).toHaveLength(1);
    expect(calendar.participations[0].person.id).toBe(view.people[0].id);
    expect(calendar.participations[0].startDate).toBe(dates.start);
    expect(calendar.participations[0].patternVersions).toHaveLength(1);
  }
  expect(firstSchedule.participations[0].endDate).toBe(dates.end);
  expect(secondSchedule.participations[0].endDate).toBeUndefined();
  const openedWeekStart = weekStart.toISOString().slice(0, 10);
  const currentWednesday = new Date(`${openedWeekStart}T00:00:00Z`);
  currentWednesday.setUTCDate(currentWednesday.getUTCDate() + 2);
  const wednesdayDate = currentWednesday.toISOString().slice(0, 10);
  expect(firstSchedule.participations[0].dateExceptions).toEqual([{ date: wednesdayDate, state: "absence" }]);
  const patternBeforePointEdit = firstSchedule.participations[0].patternVersions;

  const thursday = new Date(`${openedWeekStart}T00:00:00Z`);
  thursday.setUTCDate(thursday.getUTCDate() + 3);
  const thursdayDate = thursday.toISOString().slice(0, 10);
  const editHeaders = { Origin: webOrigin, Authorization: `Bearer ${initial.managementToken}`, "Content-Type": "application/json" };
  const secondPersonResponse = await request.post(`${apiBaseUrl}/api/management-spaces/${initial.managementSpace.id}/people`, {
    headers: editHeaders,
    data: { name: "Bruna Ribeiro" },
  });
  expect(secondPersonResponse.status()).toBe(201);
  const secondPerson = await secondPersonResponse.json() as { person: { id: string } };
  const secondParticipationResponse = await request.post(`${apiBaseUrl}/api/management-spaces/${initial.managementSpace.id}/schedules/${firstSchedule.id}/participations`, {
    headers: editHeaders,
    data: {
      personId: secondPerson.person.id,
      startDate: dates.start,
      endDate: dates.end,
      pattern: {
        effectiveFrom: openedWeekStart,
        weekdays: Array.from({ length: 7 }, (_, index) => ({ weekday: index + 1, state: "undefined" })),
      },
    },
  });
  expect(secondParticipationResponse.status()).toBe(201);
  const secondParticipation = await secondParticipationResponse.json() as { participation: { id: string } };
  const openedWeekResponse = await request.get(`${apiBaseUrl}/api/management-spaces/${initial.managementSpace.id}/schedules/${firstSchedule.id}?weekStart=${openedWeekStart}`, { headers: editHeaders });
  const openedWeek = (await openedWeekResponse.json() as { week: { revision: string } }).week;
  const firstEditURL = `${apiBaseUrl}/api/management-spaces/${initial.managementSpace.id}/schedules/${firstSchedule.id}/participations/${firstSchedule.participations[0].id}/edits`;
  const pointEdit = await request.post(firstEditURL, {
    headers: editHeaders,
    data: {
      revision: openedWeek.revision,
      weekStart: openedWeekStart,
      mode: "once",
      dates: [{ date: thursdayDate, state: "vacation" }],
    },
  });
  expect(pointEdit.status()).toBe(200);
  const pointRevision = (await pointEdit.json() as { revision: string }).revision;
  const staleSecondPersonEdit = await request.post(`${apiBaseUrl}/api/management-spaces/${initial.managementSpace.id}/schedules/${firstSchedule.id}/participations/${secondParticipation.participation.id}/edits`, {
    headers: editHeaders,
    data: {
      revision: openedWeek.revision,
      weekStart: openedWeekStart,
      mode: "once",
      dates: [{ date: wednesdayDate, state: "absence" }],
    },
  });
  expect(staleSecondPersonEdit.status()).toBe(409);
  const afterStaleSecondPerson = await request.get(`${apiBaseUrl}/api/management-spaces/${initial.managementSpace.id}/schedules/${firstSchedule.id}?weekStart=${openedWeekStart}`, { headers: editHeaders });
  const afterStalePeople = (await afterStaleSecondPerson.json() as { week: { people: Array<{ person: { name: string }; days: Array<{ state: string; hasException: boolean }> }> } }).week.people;
  const brunaWeek = afterStalePeople.find((person) => person.person.name === "Bruna Ribeiro")!;
  expect(brunaWeek.days[2]).toEqual(expect.objectContaining({ state: "undefined", hasException: false }));
  const afterPointEdit = await request.get(spaceURL, { headers: editHeaders });
  const firstScheduleAfterPointEdit = (await afterPointEdit.json() as typeof view).schedules.find((calendar) => calendar.id === firstSchedule.id)!;
  expect(firstScheduleAfterPointEdit.participations[0].patternVersions).toEqual(patternBeforePointEdit);
  expect(firstScheduleAfterPointEdit.participations[0].dateExceptions?.find((exception) => exception.date === thursdayDate)).toEqual({ date: thursdayDate, state: "vacation" });
  const nextWeekWednesday = new Date(`${openedWeekStart}T00:00:00Z`);
  nextWeekWednesday.setUTCDate(nextWeekWednesday.getUTCDate() + 9);
  const nextWeekStartDate = new Date(`${openedWeekStart}T00:00:00Z`);
  nextWeekStartDate.setUTCDate(nextWeekStartDate.getUTCDate() + 7);
  const nextWeekStart = nextWeekStartDate.toISOString().slice(0, 10);
  const nextWeekWednesdayDate = nextWeekWednesday.toISOString().slice(0, 10);
  const futureException = await request.post(firstEditURL, {
    headers: editHeaders,
    data: {
      revision: pointRevision,
      weekStart: nextWeekStart,
      mode: "once",
      dates: [{ date: nextWeekWednesdayDate, state: "absence" }],
    },
  });
  expect(futureException.status()).toBe(200);
  const futureExceptionRevision = (await futureException.json() as { revision: string }).revision;
  const preservedPattern = await request.post(firstEditURL, {
    headers: editHeaders,
    data: {
      revision: futureExceptionRevision,
      weekStart: openedWeekStart,
      mode: "recurring",
      weekdays: [{ weekday: 3, state: "day_off" }],
    },
  });
  expect(preservedPattern.status()).toBe(200);
  const currentRevision = (await preservedPattern.json() as { revision: string }).revision;

  // A second editor with the same opened revision cannot change the pattern or remove exceptions.
  const stalePattern = await request.post(firstEditURL, {
    headers: editHeaders,
    data: {
      revision: pointRevision,
      weekStart: openedWeekStart,
      mode: "recurring",
      weekdays: [{ weekday: 4, state: "day_off" }],
      removeFutureExceptions: true,
    },
  });
  expect(stalePattern.status()).toBe(409);
  expect(await stalePattern.json()).toEqual({ error: "stale_schedule_edit" });
  const preservedWeek = await request.get(`${apiBaseUrl}/api/management-spaces/${initial.managementSpace.id}/schedules/${firstSchedule.id}?weekStart=${openedWeekStart}`, { headers: editHeaders });
  const preservedDays = (await preservedWeek.json() as { week: { people: Array<{ days: Array<{ state: string }> }> } }).week.people[0].days;
  expect(preservedDays[2].state).toBe("absence");
  expect(preservedDays[3].state).toBe("vacation");

  const removeAffected = await request.post(firstEditURL, {
    headers: editHeaders,
    data: {
      revision: currentRevision,
      weekStart: openedWeekStart,
      mode: "recurring",
      weekdays: [{ weekday: 3, state: "day_off" }],
      removeFutureExceptions: true,
    },
  });
  expect(removeAffected.status()).toBe(200);
  const updatedWeek = await request.get(`${apiBaseUrl}/api/management-spaces/${initial.managementSpace.id}/schedules/${firstSchedule.id}?weekStart=${openedWeekStart}`, { headers: editHeaders });
  const updatedDays = (await updatedWeek.json() as { week: { people: Array<{ days: Array<{ state: string }> }> } }).week.people[0].days;
  expect(updatedDays[2].state).toBe("absence");
  expect(updatedDays[3].state).toBe("vacation");
  const removedFutureWeek = await request.get(`${apiBaseUrl}/api/management-spaces/${initial.managementSpace.id}/schedules/${firstSchedule.id}?weekStart=${nextWeekStart}`, { headers: editHeaders });
  const removedFutureWednesday = (await removedFutureWeek.json() as { week: { people: Array<{ days: Array<{ state: string; hasException: boolean }> }> } }).week.people[0].days[2];
  expect(removedFutureWednesday).toEqual(expect.objectContaining({ state: "day_off", hasException: false }));

  const futurePatternMonday = new Date(`${dates.start}T00:00:00Z`);
  futurePatternMonday.setUTCDate(futurePatternMonday.getUTCDate() + 21);
  futurePatternMonday.setUTCDate(futurePatternMonday.getUTCDate() - ((futurePatternMonday.getUTCDay() + 6) % 7));
  const effectiveFrom = futurePatternMonday.toISOString().slice(0, 10);
  const secondScheduleWeek = await request.get(`${apiBaseUrl}/api/management-spaces/${initial.managementSpace.id}/schedules/${secondSchedule.id}?weekStart=${openedWeekStart}`, { headers: editHeaders });
  const secondScheduleRevision = (await secondScheduleWeek.json() as { week: { revision: string } }).week.revision;
  const addedPattern = await request.post(`${apiBaseUrl}/api/management-spaces/${initial.managementSpace.id}/schedules/${secondSchedule.id}/participations/${secondSchedule.participations[0].id}/edits`, {
    headers: editHeaders,
    data: {
      revision: secondScheduleRevision,
      weekStart: effectiveFrom,
      mode: "recurring",
      weekdays: [{ weekday: 1, state: "day_off" }],
    },
  });
  expect(addedPattern.status()).toBe(200);
  const futureWeek = await request.get(`${apiBaseUrl}/api/management-spaces/${initial.managementSpace.id}/schedules/${secondSchedule.id}?weekStart=${effectiveFrom}`, {
    headers: { Origin: webOrigin, Authorization: `Bearer ${initial.managementToken}` },
  });
  expect(futureWeek.status()).toBe(200);
  expect((await futureWeek.json() as { week: { people: Array<{ days: Array<{ state: string }> }> } }).week.people[0].days[0].state).toBe("day_off");
  const earlierWeek = await request.get(`${apiBaseUrl}/api/management-spaces/${initial.managementSpace.id}/schedules/${secondSchedule.id}?weekStart=${openedWeekStart}`, {
    headers: { Origin: webOrigin, Authorization: `Bearer ${initial.managementToken}` },
  });
  expect(earlierWeek.status()).toBe(200);
  expect((await earlierWeek.json() as { week: { people: Array<{ days: Array<{ state: string }> }> } }).week.people[0].days[2].state).toBe("undefined");
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

test("only the current Management Link can replace a credential and concurrent requests have one winner", async ({ request }) => {
  const created = await createManagementSpace(request, "Espaço com link substituível", "198.51.100.20");
  expect(created.status()).toBe(201);
  const initial = await created.json() as {
    managementSpace: { id: string };
    schedule: { id: string; name: string };
    managementToken: string;
  };
  const spaceURL = `${apiBaseUrl}/api/management-spaces/${initial.managementSpace.id}`;
  const replaceURL = `${spaceURL}/management-link`;
  const oldAuthorization = { Origin: webOrigin, Authorization: `Bearer ${initial.managementToken}` };

  const otherCreated = await createManagementSpace(request, "Outro Espaço", "198.51.100.22");
  expect(otherCreated.status()).toBe(201);
  const other = await otherCreated.json() as { managementSpace: { id: string }; managementToken: string };

  const wrongSpace = await request.post(`${apiBaseUrl}/api/management-spaces/${other.managementSpace.id}/management-link`, {
    headers: oldAuthorization,
  });
  expect(wrongSpace.status()).toBe(401);
  expect(await wrongSpace.text()).not.toContain(initial.managementToken);
  const otherSpaceRead = await request.get(`${apiBaseUrl}/api/management-spaces/${other.managementSpace.id}`, {
    headers: { Origin: webOrigin, Authorization: `Bearer ${other.managementToken}` },
  });
  expect(otherSpaceRead.status()).toBe(200);

  const attempts = await Promise.all([
    request.post(replaceURL, { headers: oldAuthorization }),
    request.post(replaceURL, { headers: oldAuthorization }),
  ]);
  expect(attempts.map((response) => response.status()).sort()).toEqual([200, 401]);
  const winningResponse = attempts.find((response) => response.status() === 200);
  expect(winningResponse).toBeDefined();
  const replacement = await winningResponse!.json() as { managementToken: string };
  expect(replacement.managementToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(replacement.managementToken).not.toBe(initial.managementToken);
  expect((await attempts.find((response) => response.status() === 401)!.text())).not.toContain(initial.managementToken);

  const staleRead = await request.get(spaceURL, { headers: oldAuthorization });
  expect(staleRead.status()).toBe(401);
  const staleWrite = await request.patch(`${spaceURL}/schedules/${initial.schedule.id}`, {
    headers: { ...oldAuthorization, "Content-Type": "application/json" },
    data: { name: "Edição antiga" },
  });
  expect(staleWrite.status()).toBe(401);

  const currentAuthorization = { Origin: webOrigin, Authorization: `Bearer ${replacement.managementToken}` };
  const currentRead = await request.get(spaceURL, { headers: currentAuthorization });
  expect(currentRead.status()).toBe(200);
  const currentSpace = await currentRead.json() as { managementSpace: { id: string }; schedules: Array<{ id: string; name: string }> };
  expect(currentSpace.managementSpace.id).toBe(initial.managementSpace.id);
  expect(currentSpace.schedules).toEqual([{ id: initial.schedule.id, name: initial.schedule.name, timeZone: "America/Sao_Paulo", managementSpace: { id: initial.managementSpace.id, name: "Espaço com link substituível" } }]);
});

test("the browser shows the replacement link and old and new links resolve correctly", async ({ page, context, request }) => {
  const created = await createManagementSpace(request, "Espaço de teste do link", "198.51.100.21");
  expect(created.status()).toBe(201);
  const initial = await created.json() as {
    managementSpace: { id: string };
    schedule: { name: string };
    managementToken: string;
  };
  const oldLink = `${webOrigin}/#${new URLSearchParams({
    management_space: initial.managementSpace.id,
    management_token: initial.managementToken,
  }).toString()}`;

  page.on("dialog", (dialog) => void dialog.accept());
  await page.goto(oldLink);
  await expect(page.getByRole("heading", { name: initial.schedule.name, exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Substituir link de gestão" }).click();
  await expect(page.locator(".notice.success")).toContainText("o link anterior foi invalidado");

  const newLink = await page.getByRole("textbox", { name: "Link privado de gestão" }).inputValue();
  const replacementToken = new URLSearchParams(new URL(newLink).hash.slice(1)).get("management_token");
  expect(replacementToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(replacementToken).not.toBe(initial.managementToken);

  const oldLinkPage = await context.newPage();
  await oldLinkPage.goto(oldLink);
  await expect(oldLinkPage.getByRole("alert")).toContainText("Este link de gestão não pode ser validado");
  await expect(oldLinkPage.getByRole("heading", { name: "Link de gestão indisponível", exact: true })).toBeVisible();

  const newLinkPage = await context.newPage();
  await newLinkPage.goto(newLink);
  await expect(newLinkPage.getByRole("heading", { name: initial.schedule.name, exact: true })).toBeVisible();
  await expect(newLinkPage.locator(".space-name")).toHaveText("Espaço de teste do link");
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
