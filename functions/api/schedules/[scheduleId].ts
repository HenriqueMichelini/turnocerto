interface Environment {
  APP_ENV: string;
  DB: D1Database;
}

interface ScheduleRow {
  id: string;
  name: string;
  managementSpaceId: string;
  managementSpaceName: string;
}

interface ScheduleResponse {
  schedule: {
    id: string;
    name: string;
    managementSpace: {
      id: string;
      name: string;
    };
  };
}

const previewScheduleId = "preview-fixture";
const maximumNameLength = 80;

function jsonResponse(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: {
      "Cache-Control": "private, no-store, max-age=0",
      "Content-Type": "application/json; charset=utf-8",
      "Expires": "0",
      "Pragma": "no-cache",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "X-Robots-Tag": "noindex, nofollow, noarchive",
    },
  });
}

function notFound(): Response {
  return jsonResponse({ error: "not_found" }, 404);
}

async function getSchedule(database: D1Database, scheduleId: string): Promise<ScheduleResponse | null> {
  const row = await database
    .prepare(
      `SELECT schedules.id, schedules.name,
              management_spaces.id AS managementSpaceId,
              management_spaces.name AS managementSpaceName
       FROM schedules
       INNER JOIN management_spaces ON management_spaces.id = schedules.management_space_id
       WHERE schedules.id = ?`,
    )
    .bind(scheduleId)
    .first<ScheduleRow>();

  if (!row) return null;
  return {
    schedule: {
      id: row.id,
      name: row.name,
      managementSpace: {
        id: row.managementSpaceId,
        name: row.managementSpaceName,
      },
    },
  };
}

export const onRequest: PagesFunction<Environment, "scheduleId"> = async ({ request, env, params }) => {
  const scheduleId = params.scheduleId;
  if (env.APP_ENV !== "preview" || scheduleId !== previewScheduleId) {
    return notFound();
  }

  if (request.method === "GET") {
    try {
      const schedule = await getSchedule(env.DB, scheduleId);
      return schedule ? jsonResponse(schedule) : notFound();
    } catch {
      return jsonResponse({ error: "temporarily_unavailable" }, 503);
    }
  }

  if (request.method !== "PATCH") {
    return jsonResponse({ error: "method_not_allowed" }, 405);
  }

  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    return jsonResponse({ error: "unsupported_media_type" }, 415);
  }

  const contentLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > 1024) {
    return jsonResponse({ error: "invalid_schedule_name" }, 400);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "invalid_schedule_name" }, 400);
  }

  if (typeof body !== "object" || body === null || !("name" in body) || typeof body.name !== "string") {
    return jsonResponse({ error: "invalid_schedule_name" }, 400);
  }

  const name = body.name.trim();
  if (Array.from(name).length === 0 || Array.from(name).length > maximumNameLength) {
    return jsonResponse({ error: "invalid_schedule_name" }, 400);
  }

  try {
    const update = await env.DB.prepare(
      "UPDATE schedules SET name = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?",
    )
      .bind(name, scheduleId)
      .run();

    if (update.meta.changes !== 1) return notFound();
    const schedule = await getSchedule(env.DB, scheduleId);
    return schedule ? jsonResponse(schedule) : notFound();
  } catch {
    return jsonResponse({ error: "temporarily_unavailable" }, 503);
  }
};
