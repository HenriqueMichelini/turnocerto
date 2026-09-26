import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

const apiBaseUrl = process.env.TURNOCERTO_API_BASE_URL ?? "http://127.0.0.1:8787";
const webOrigin = new URL(process.env.TURNOCERTO_BASE_URL ?? "http://127.0.0.1:8788").origin;
const repositoryRoot = process.cwd();
const environment = process.env.TURNOCERTO_ENV ?? "preview";
const localState = resolve(repositoryRoot, `.wrangler/e2e-${environment}-state`);
const wranglerCLI = resolve(repositoryRoot, "node_modules/wrangler/bin/wrangler.js");
const validChallengeToken = "XXXX.DUMMY.TOKEN.XXXX";

interface CreatedSpace {
  managementSpace: { id: string; name: string };
  schedule: { id: string; name: string };
  managementToken: string;
}

async function createManagementSpace(request: APIRequestContext, name: string): Promise<CreatedSpace> {
  const response = await request.post(`${apiBaseUrl}/api/management-spaces`, {
    headers: { Origin: webOrigin, "Content-Type": "application/json", "CF-Connecting-IP": "198.51.100.89" },
    data: { spaceName: name, scheduleName: "Escala principal", turnstileToken: validChallengeToken },
  });
  expect(response.status()).toBe(201);
  return await response.json() as CreatedSpace;
}

async function createSchedule(request: APIRequestContext, created: CreatedSpace, name: string) {
  const response = await request.post(`${apiBaseUrl}/api/management-spaces/${created.managementSpace.id}/schedules`, {
    headers: managementHeaders(created.managementToken),
    data: { name, timeZone: "America/Sao_Paulo" },
  });
  expect(response.status()).toBe(201);
  return (await response.json() as { schedule: { id: string; name: string } }).schedule;
}

async function createPerson(request: APIRequestContext, created: CreatedSpace) {
  const response = await request.post(`${apiBaseUrl}/api/management-spaces/${created.managementSpace.id}/people`, {
    headers: managementHeaders(created.managementToken),
    data: { name: "Pessoa compartilhada" },
  });
  expect(response.status()).toBe(201);
  return (await response.json() as { person: { id: string; name: string } }).person;
}

async function createReadLink(request: APIRequestContext, created: CreatedSpace, scheduleID: string) {
  const response = await request.post(`${apiBaseUrl}/api/management-spaces/${created.managementSpace.id}/schedules/${scheduleID}/read-links`, {
    headers: managementHeaders(created.managementToken),
    data: { startWeek: currentWeekStart(), weekCount: 1 },
  });
  expect(response.status()).toBe(201);
  return await response.json() as { readLink: { id: string }; readToken: string };
}

function managementHeaders(token: string) {
  return { Origin: webOrigin, Authorization: `Bearer ${token}` };
}

function managementLink(created: CreatedSpace) {
  return `${webOrigin}/#${new URLSearchParams({
    management_space: created.managementSpace.id,
    management_token: created.managementToken,
  }).toString()}`;
}

function readLinkURL(linkID: string, scheduleID: string) {
  return `${apiBaseUrl}/api/read-links/${linkID}/schedules/${scheduleID}/weeks/${currentWeekStart()}`;
}

function currentWeekStart() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const value = (kind: string) => parts.find((part) => part.type === kind)?.value ?? "";
  const today = new Date(`${value("year")}-${value("month")}-${value("day")}T00:00:00Z`);
  today.setUTCDate(today.getUTCDate() - (today.getUTCDay() + 6) % 7);
  return today.toISOString().slice(0, 10);
}

async function confirmDeletion(page: Page, expectedText: string) {
  page.once("dialog", async (dialog) => {
    expect(dialog.type()).toBe("confirm");
    expect(dialog.message()).toContain(expectedText);
    await dialog.accept();
  });
}

function executeLocalD1SQL(database: "DB" | "DELETION_DB", sql: string) {
  const output = execFileSync(process.execPath, [
    wranglerCLI,
    "d1",
    "execute",
    database,
    "--config",
    resolve(repositoryRoot, "wrangler.api.jsonc"),
    "--env",
    environment,
    "--local",
    "--persist-to",
    localState,
    "--command",
    sql,
    "--json",
  ], { cwd: repositoryRoot, encoding: "utf8", stdio: "pipe" });
  return JSON.parse(output) as Array<{ results?: Array<Record<string, number>> }>;
}

function queryD1Row(database: "DB" | "DELETION_DB", sql: string) {
  const firstRow = executeLocalD1SQL(database, sql)[0]?.results?.[0];
  expect(firstRow).toBeDefined();
  return firstRow!;
}

test("deleting one Schedule removes only its active data and Read Links, with explicit confirmation", async ({ page, request }) => {
  test.skip(environment !== "preview", "Destructive browser fixtures run only against local preview D1.");
  const created = await createManagementSpace(request, `Exclusão de escala ${Date.now()}`);
  const secondSchedule = await createSchedule(request, created, "Escala preservada");
  const unrelated = await createManagementSpace(request, `Outro Espaço ${Date.now()}`);
  const person = await createPerson(request, created);
  const removedLink = await createReadLink(request, created, created.schedule.id);
  const preservedLink = await createReadLink(request, created, secondSchedule.id);

  expect((await request.get(readLinkURL(removedLink.readLink.id, created.schedule.id), {
    headers: managementHeaders(removedLink.readToken),
  })).status()).toBe(200);
  expect((await request.get(readLinkURL(preservedLink.readLink.id, secondSchedule.id), {
    headers: managementHeaders(preservedLink.readToken),
  })).status()).toBe(200);
  const participationResponse = await request.post(
    `${apiBaseUrl}/api/management-spaces/${created.managementSpace.id}/schedules/${created.schedule.id}/participations`,
    {
      headers: managementHeaders(created.managementToken),
      data: {
        personId: person.id,
        startDate: currentWeekStart(),
        pattern: {
          effectiveFrom: currentWeekStart(),
          weekdays: Array.from({ length: 7 }, (_, index) => ({
            weekday: index + 1,
            state: index === 0 ? "work_period" : "undefined",
            ...(index === 0 ? { workPeriod: { startTime: "09:00", endTime: "17:00" } } : {}),
          })),
        },
      },
    },
  );
  expect(participationResponse.status()).toBe(201);

  const wrongSpaceDelete = await request.delete(`${apiBaseUrl}/api/management-spaces/${unrelated.managementSpace.id}/schedules/${unrelated.schedule.id}`, {
    headers: { ...managementHeaders(created.managementToken), "Content-Type": "application/json" },
    data: { confirmed: true },
  });
  expect([401, 404]).toContain(wrongSpaceDelete.status());
  expect(await wrongSpaceDelete.text()).not.toContain(unrelated.schedule.name);
  expect((await request.get(`${apiBaseUrl}/api/management-spaces/${unrelated.managementSpace.id}`, {
    headers: managementHeaders(unrelated.managementToken),
  })).status()).toBe(200);

  await page.goto(managementLink(created));
  await expect(page.getByRole("heading", { name: "Pessoas e semanas" })).toBeVisible();
  await confirmDeletion(page, "Excluir a escala");
  await page.getByRole("button", { name: "Excluir esta escala" }).click();
  await expect(page.locator(".notice.success")).toContainText("links de leitura dela foram invalidados");
  await expect(page.getByRole("combobox", { name: "Escala selecionada" })).toHaveValue(secondSchedule.id);

  const spaceResponse = await request.get(`${apiBaseUrl}/api/management-spaces/${created.managementSpace.id}`, {
    headers: managementHeaders(created.managementToken),
  });
  expect(spaceResponse.status()).toBe(200);
  const remaining = await spaceResponse.json() as { schedules: Array<{ id: string }>; people: Array<{ name: string }> };
  expect(remaining.schedules.map((calendar) => calendar.id)).toEqual([secondSchedule.id]);
  expect(remaining.people.map((person) => person.name)).toContain("Pessoa compartilhada");

  expect((await request.get(readLinkURL(removedLink.readLink.id, created.schedule.id), {
    headers: managementHeaders(removedLink.readToken),
  })).status()).toBe(401);
  expect((await request.get(readLinkURL(preservedLink.readLink.id, secondSchedule.id), {
    headers: managementHeaders(preservedLink.readToken),
  })).status()).toBe(200);
  const removedData = queryD1Row("DB", `SELECT
    (SELECT COUNT(*) FROM schedules WHERE id = '${created.schedule.id}') AS schedules,
    (SELECT COUNT(*) FROM participations WHERE schedule_id = '${created.schedule.id}') AS participations,
    (SELECT COUNT(*) FROM weekly_patterns WHERE participation_id IN (SELECT id FROM participations WHERE schedule_id = '${created.schedule.id}')) AS patterns,
    (SELECT COUNT(*) FROM weekly_pattern_days WHERE weekly_pattern_id IN (SELECT id FROM weekly_patterns WHERE participation_id IN (SELECT id FROM participations WHERE schedule_id = '${created.schedule.id}'))) AS pattern_days,
    (SELECT COUNT(*) FROM participation_date_exceptions WHERE participation_id IN (SELECT id FROM participations WHERE schedule_id = '${created.schedule.id}')) AS exceptions,
    (SELECT COUNT(*) FROM schedule_revisions WHERE schedule_id = '${created.schedule.id}') AS revisions,
    (SELECT COUNT(*) FROM read_links WHERE schedule_id = '${created.schedule.id}') AS read_links,
    (SELECT COUNT(*) FROM people WHERE management_space_id = '${created.managementSpace.id}') AS people;`);
  expect(removedData).toEqual({ schedules: 0, participations: 0, patterns: 0, pattern_days: 0, exceptions: 0, revisions: 0, read_links: 0, people: 1 });

  const repeat = await request.delete(`${apiBaseUrl}/api/management-spaces/${created.managementSpace.id}/schedules/${created.schedule.id}`, {
    headers: { ...managementHeaders(created.managementToken), "Content-Type": "application/json" },
    data: { confirmed: true },
  });
  expect(repeat.status()).toBe(404);
  expect((await request.get(`${apiBaseUrl}/api/management-spaces/${created.managementSpace.id}`, {
    headers: managementHeaders(created.managementToken),
  })).status()).toBe(200);
});

test("a deletion ledger failure preserves the Schedule and a retry completes safely", async ({ page, request }) => {
  test.skip(environment !== "preview", "Fault injection uses the local preview deletion ledger only.");
  const created = await createManagementSpace(request, `Falha no registro ${Date.now()}`);
  const trigger = `CREATE TRIGGER fail_test_deletion_record BEFORE INSERT ON deletion_records WHEN NEW.space_id = '${created.managementSpace.id}' BEGIN SELECT RAISE(ABORT, 'injected ledger failure'); END;`;
  executeLocalD1SQL("DELETION_DB", trigger);

  try {
    await page.goto(managementLink(created));
    await expect(page.getByRole("heading", { name: "Pessoas e semanas" })).toBeVisible();
    await confirmDeletion(page, "Excluir a escala");
    await page.getByRole("button", { name: "Excluir esta escala" }).click();
    await expect(page.getByRole("alert")).toContainText("Não foi possível registrar a exclusão");
    const afterFailure = await request.get(`${apiBaseUrl}/api/management-spaces/${created.managementSpace.id}`, {
      headers: managementHeaders(created.managementToken),
    });
    expect(afterFailure.status()).toBe(200);
    expect((await afterFailure.json() as { schedules: Array<{ id: string }> }).schedules.map((calendar) => calendar.id)).toEqual([created.schedule.id]);
  } finally {
    executeLocalD1SQL("DELETION_DB", "DROP TRIGGER IF EXISTS fail_test_deletion_record;");
  }

  await confirmDeletion(page, "Excluir a escala");
  await page.getByRole("button", { name: "Excluir esta escala" }).click();
  await expect(page.getByRole("heading", { name: "Este Espaço ainda não tem escalas" })).toBeVisible();
  const afterRetry = await request.get(`${apiBaseUrl}/api/management-spaces/${created.managementSpace.id}`, {
    headers: managementHeaders(created.managementToken),
  });
  expect(afterRetry.status()).toBe(200);
  expect((await afterRetry.json() as { schedules: Array<unknown> }).schedules).toEqual([]);
});

test("an app D1 failure retains the external deletion record and retries idempotently", async ({ page, request }) => {
  test.skip(environment !== "preview", "Fault injection uses the local preview application and deletion databases only.");
  const created = await createManagementSpace(request, `Falha no Espaço ativo ${Date.now()}`);
  const trigger = `CREATE TRIGGER fail_test_schedule_delete BEFORE DELETE ON schedules WHEN OLD.id = '${created.schedule.id}' BEGIN SELECT RAISE(ABORT, 'injected application deletion failure'); END;`;
  executeLocalD1SQL("DB", trigger);

  try {
    await page.goto(managementLink(created));
    await expect(page.getByRole("heading", { name: "Pessoas e semanas" })).toBeVisible();
    await confirmDeletion(page, "Excluir a escala");
    await page.getByRole("button", { name: "Excluir esta escala" }).click();
    await expect(page.getByRole("alert")).toContainText("Não foi possível confirmar a exclusão");
    const afterFailure = await request.get(`${apiBaseUrl}/api/management-spaces/${created.managementSpace.id}`, {
      headers: managementHeaders(created.managementToken),
    });
    expect(afterFailure.status()).toBe(200);
    expect((await afterFailure.json() as { schedules: Array<{ id: string }> }).schedules.map((calendar) => calendar.id)).toEqual([created.schedule.id]);
    expect(queryD1Row("DELETION_DB", `SELECT COUNT(*) AS records FROM deletion_records WHERE scope = 'schedule' AND space_id = '${created.managementSpace.id}' AND schedule_id = '${created.schedule.id}';`).records).toBe(1);
  } finally {
    executeLocalD1SQL("DB", "DROP TRIGGER IF EXISTS fail_test_schedule_delete;");
  }

  await confirmDeletion(page, "Excluir a escala");
  await page.getByRole("button", { name: "Excluir esta escala" }).click();
  await expect(page.getByRole("heading", { name: "Este Espaço ainda não tem escalas" })).toBeVisible();
  expect(queryD1Row("DELETION_DB", `SELECT COUNT(*) AS records FROM deletion_records WHERE scope = 'schedule' AND space_id = '${created.managementSpace.id}' AND schedule_id = '${created.schedule.id}';`).records).toBe(1);
  expect(queryD1Row("DB", `SELECT COUNT(*) AS schedules FROM schedules WHERE id = '${created.schedule.id}';`).schedules).toBe(0);
});

test("deleting a Space removes its data and links and invalidates its Management Link", async ({ page, request }) => {
  test.skip(environment !== "preview", "Destructive browser fixtures run only against local preview D1.");
  const created = await createManagementSpace(request, `Exclusão de Espaço ${Date.now()}`);
  const extraSchedule = await createSchedule(request, created, "Escala extra");
  await createPerson(request, created);
  const readLink = await createReadLink(request, created, created.schedule.id);
  const unrelated = await createManagementSpace(request, `Espaço preservado ${Date.now()}`);

  await page.goto(managementLink(created));
  await expect(page.getByRole("heading", { name: "Pessoas e semanas" })).toBeVisible();
  await confirmDeletion(page, "Excluir o Espaço de gestão");
  await page.getByRole("button", { name: "Excluir Espaço de gestão" }).click();
  await expect(page.locator(".notice.success")).toContainText("Espaço de gestão excluído");
  await expect(page.getByRole("button", { name: "Criar Espaço e escala" })).toBeVisible();
  const removedSpaceData = queryD1Row("DB", `SELECT
    (SELECT COUNT(*) FROM management_spaces WHERE id = '${created.managementSpace.id}') AS management_spaces,
    (SELECT COUNT(*) FROM schedules WHERE management_space_id = '${created.managementSpace.id}') AS schedules,
    (SELECT COUNT(*) FROM people WHERE management_space_id = '${created.managementSpace.id}') AS people,
    (SELECT COUNT(*) FROM schedule_revisions WHERE schedule_id IN ('${created.schedule.id}', '${extraSchedule.id}')) AS revisions,
    (SELECT COUNT(*) FROM read_links WHERE schedule_id IN ('${created.schedule.id}', '${extraSchedule.id}')) AS read_links;`);
  expect(removedSpaceData).toEqual({ management_spaces: 0, schedules: 0, people: 0, revisions: 0, read_links: 0 });

  const oldManagementRequest = await request.get(`${apiBaseUrl}/api/management-spaces/${created.managementSpace.id}`, {
    headers: managementHeaders(created.managementToken),
  });
  expect([401, 404]).toContain(oldManagementRequest.status());
  expect(await oldManagementRequest.text()).not.toContain(created.managementSpace.name);
  const oldReadLink = await request.get(readLinkURL(readLink.readLink.id, created.schedule.id), {
    headers: managementHeaders(readLink.readToken),
  });
  expect(oldReadLink.status()).toBe(401);

  const repeat = await request.delete(`${apiBaseUrl}/api/management-spaces/${created.managementSpace.id}`, {
    headers: { ...managementHeaders(created.managementToken), "Content-Type": "application/json" },
    data: { confirmed: true },
  });
  expect([401, 404]).toContain(repeat.status());
  expect(await repeat.text()).not.toContain(created.managementSpace.name);

  const otherSpaceResponse = await request.get(`${apiBaseUrl}/api/management-spaces/${unrelated.managementSpace.id}`, {
    headers: managementHeaders(unrelated.managementToken),
  });
  expect(otherSpaceResponse.status()).toBe(200);
  expect((await otherSpaceResponse.json() as { schedules: Array<{ id: string }> }).schedules.map((calendar) => calendar.id)).toEqual([unrelated.schedule.id]);
  expect(extraSchedule.id).not.toBe(created.schedule.id);
});
