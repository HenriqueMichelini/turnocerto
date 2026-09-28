/**
 * @typedef {Object} CapacityFixtureOptions
 * @property {string} apiBaseUrl
 * @property {string} webOrigin
 * @property {number} count
 * @property {string} [spaceName]
 * @property {string} [clientAddress]
 * @property {(index: number) => string} [personName]
 * @property {(url: string, options: RequestInit) => Promise<{status: number, json: () => Promise<any>}>} [send]
 */

/** @param {CapacityFixtureOptions} options */
export async function createSyntheticCapacityFixture(options) {
  const {
    apiBaseUrl,
    webOrigin,
    count,
    spaceName = `Synthetic capacity ${count} people`,
    clientAddress = "198.51.100.73",
    personName = (index) => `Person ${String(index).padStart(3, "0")}`,
    send = fetch,
  } = options;
  if (!Number.isInteger(count) || count < 1 || count > 100) throw new Error("Fixture size must be between 1 and 100 People.");

  const createResponse = await send(`${apiBaseUrl}/api/management-spaces`, {
    method: "POST",
    headers: {
      Origin: webOrigin,
      "CF-Connecting-IP": clientAddress,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      spaceName,
      scheduleName: "Synthetic weekly schedule",
      timeZone: "America/Sao_Paulo",
      turnstileToken: "XXXX.DUMMY.TOKEN.XXXX",
    }),
  });
  if (createResponse.status !== 201) {
    throw new Error(`Could not create the synthetic ${count}-person Management Space (${createResponse.status}).`);
  }

  const created = await createResponse.json();
  const headers = {
    Origin: webOrigin,
    Authorization: `Bearer ${created.managementToken}`,
    "Content-Type": "application/json",
  };
  const weekStart = currentMondayInSaoPaulo();
  const participationStart = addDays(weekStart, -28);
  const weekdays = Array.from({ length: 7 }, (_, index) => ({
    weekday: index + 1,
    state: "work_period",
    workPeriod: { startTime: "09:00", endTime: "17:00" },
  }));
  const participationIDs = [];

  for (let index = 1; index <= count; index++) {
    const personResponse = await send(`${apiBaseUrl}/api/management-spaces/${created.managementSpace.id}/people`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name: personName(index) }),
    });
    if (personResponse.status !== 201) {
      throw new Error(`Could not create synthetic Person ${index}/${count} (${personResponse.status}).`);
    }
    const { person } = await personResponse.json();
    const participationResponse = await send(`${apiBaseUrl}/api/management-spaces/${created.managementSpace.id}/schedules/${created.schedule.id}/participations`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        personId: person.id,
        startDate: participationStart,
        pattern: { effectiveFrom: participationStart, weekdays },
      }),
    });
    if (participationResponse.status !== 201) {
      throw new Error(`Could not create synthetic participation ${index}/${count} (${participationResponse.status}).`);
    }
    const { participation } = await participationResponse.json();
    participationIDs.push(participation.id);
  }

  const managementLink = new URL("/", webOrigin);
  managementLink.hash = new URLSearchParams({
    management_space: created.managementSpace.id,
    management_token: created.managementToken,
  }).toString();
  return {
    spaceID: created.managementSpace.id,
    scheduleID: created.schedule.id,
    participationIDs,
    weekStart,
    managementLink: managementLink.toString(),
  };
}

function currentMondayInSaoPaulo() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const date = new Date(Date.UTC(Number(values.year), Number(values.month) - 1, Number(values.day)));
  date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
  return date.toISOString().slice(0, 10);
}

function addDays(date, count) {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + count);
  return value.toISOString().slice(0, 10);
}
