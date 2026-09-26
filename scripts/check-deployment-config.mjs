import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const placeholderDatabaseIds = new Set([
  "00000000-0000-4000-8000-000000000001",
  "00000000-0000-4000-8000-000000000002",
  "00000000-0000-4000-8000-000000000003",
  "00000000-0000-4000-8000-000000000004",
]);
const freeQuotaUsageVariables = [
  "FREE_QUOTA_WORKER_REQUESTS_PER_DAY",
  "FREE_QUOTA_WORKER_HIGH_QUANTILE_CPU_MS",
  "FREE_QUOTA_WORKER_COUNT",
  "FREE_QUOTA_PAGES_BUILDS_PER_MONTH",
  "FREE_QUOTA_PAGES_ASSET_FILES",
  "FREE_QUOTA_PAGES_PROJECT_COUNT",
  "FREE_QUOTA_D1_ROWS_READ_PER_DAY",
  "FREE_QUOTA_D1_ROWS_WRITTEN_PER_DAY",
  "FREE_QUOTA_D1_LARGEST_DATABASE_BYTES",
  "FREE_QUOTA_D1_ACCOUNT_STORAGE_BYTES",
  "FREE_QUOTA_D1_DATABASE_COUNT",
];

export function checkDeploymentConfiguration(config, targetEnvironment, requireRealId = false) {
  if (!new Set(["preview", "production"]).has(targetEnvironment)) {
    throw new Error("Target environment must be preview or production.");
  }

  const environments = config.env ?? {};
  const preview = environments.preview;
  const production = environments.production;
  const previewDatabase = preview?.d1_databases?.find((database) => database.binding === "DB");
  const productionDatabase = production?.d1_databases?.find((database) => database.binding === "DB");
  const defaultDatabase = config.d1_databases?.find((database) => database.binding === "DB");
  const previewDeletionDatabase = preview?.d1_databases?.find((database) => database.binding === "DELETION_DB");
  const productionDeletionDatabase = production?.d1_databases?.find((database) => database.binding === "DELETION_DB");
  const defaultDeletionDatabase = config.d1_databases?.find((database) => database.binding === "DELETION_DB");
  const previewRateLimit = preview?.ratelimits?.find((binding) => binding.name === "CREATION_RATE_LIMITER");
  const productionRateLimit = production?.ratelimits?.find((binding) => binding.name === "CREATION_RATE_LIMITER");
  const defaultRateLimit = config.ratelimits?.find((binding) => binding.name === "CREATION_RATE_LIMITER");

  if (!previewDatabase || !productionDatabase || !defaultDatabase || !previewDeletionDatabase || !productionDeletionDatabase || !defaultDeletionDatabase) {
    throw new Error("The default, preview, and production environments must define separate DB and DELETION_DB bindings.");
  }
  if (!previewRateLimit || !productionRateLimit || !defaultRateLimit) {
    throw new Error("The default, preview, and production environments must define CREATION_RATE_LIMITER.");
  }
  if (
    previewRateLimit.namespace_id === productionRateLimit.namespace_id ||
    defaultRateLimit.namespace_id !== productionRateLimit.namespace_id
  ) {
    throw new Error("Preview and production must use different rate-limit namespaces, and the default must match production.");
  }
  for (const rateLimit of [previewRateLimit, productionRateLimit, defaultRateLimit]) {
    if (
      !Number.isSafeInteger(rateLimit.simple?.limit) ||
      rateLimit.simple.limit < 1 ||
      ![10, 60].includes(rateLimit.simple.period)
    ) {
      throw new Error("CREATION_RATE_LIMITER must define a positive limit and a 10- or 60-second period.");
    }
  }
  if (previewDatabase.database_id === productionDatabase.database_id) {
    throw new Error("Preview and production must use different D1 database IDs.");
  }
  if (previewDatabase.database_name === productionDatabase.database_name) {
    throw new Error("Preview and production must use different D1 database names.");
  }
  if (previewDeletionDatabase.database_id === productionDeletionDatabase.database_id) {
    throw new Error("Preview and production must use different deletion-ledger D1 database IDs.");
  }
  if (previewDeletionDatabase.database_name === productionDeletionDatabase.database_name) {
    throw new Error("Preview and production must use different deletion-ledger D1 database names.");
  }
  if (
    previewDatabase.database_id === previewDeletionDatabase.database_id ||
    productionDatabase.database_id === productionDeletionDatabase.database_id
  ) {
    throw new Error("Each deletion ledger must use a D1 database separate from its application database.");
  }
  if (
    previewDatabase.database_name === previewDeletionDatabase.database_name ||
    productionDatabase.database_name === productionDeletionDatabase.database_name
  ) {
    throw new Error("Each deletion ledger must use a D1 database name separate from its application database.");
  }
  const environmentDatabaseIDs = [
    previewDatabase.database_id,
    previewDeletionDatabase.database_id,
    productionDatabase.database_id,
    productionDeletionDatabase.database_id,
  ];
  const environmentDatabaseNames = [
    previewDatabase.database_name,
    previewDeletionDatabase.database_name,
    productionDatabase.database_name,
    productionDeletionDatabase.database_name,
  ];
  if (new Set(environmentDatabaseIDs).size !== environmentDatabaseIDs.length) {
    throw new Error("Preview and production application and deletion-ledger databases must all have different D1 database IDs.");
  }
  if (new Set(environmentDatabaseNames).size !== environmentDatabaseNames.length) {
    throw new Error("Preview and production application and deletion-ledger databases must all have different D1 database names.");
  }
  if (
    defaultDatabase.database_id !== productionDatabase.database_id ||
    defaultDatabase.database_name !== productionDatabase.database_name
  ) {
    throw new Error("The default API Worker environment must target the production D1 database.");
  }
  if (
    defaultDeletionDatabase.database_id !== productionDeletionDatabase.database_id ||
    defaultDeletionDatabase.database_name !== productionDeletionDatabase.database_name
  ) {
    throw new Error("The default API Worker environment must target the production deletion-ledger D1 database.");
  }
  if (config.vars?.WEB_ORIGIN !== production.vars?.WEB_ORIGIN) {
    throw new Error("The default API Worker environment must target the production Pages origin.");
  }
  if (preview.vars?.APP_ENV !== "preview" || production.vars?.APP_ENV !== "production") {
    throw new Error("APP_ENV must match each Wrangler environment.");
  }
  for (const environment of [preview, production, config]) {
    const webOrigin = environment.vars?.WEB_ORIGIN;
    const challengeHostname = environment.vars?.TURNSTILE_ALLOWED_HOSTNAME;
    const creationPaused = environment.vars?.SPACE_CREATION_PAUSED;
    const quotaMeasuredAt = environment.vars?.FREE_QUOTA_MEASURED_AT_UTC;
    if (!new Set(["true", "false"]).has(creationPaused)) {
      throw new Error("Every API Worker environment must set SPACE_CREATION_PAUSED to true or false.");
    }
    for (const name of freeQuotaUsageVariables) {
      const value = environment.vars?.[name];
      if (typeof value !== "string" || (value !== "" && !/^\d+$/.test(value))) {
        throw new Error(`Every API Worker environment must set ${name} to a non-negative measured value or an empty string.`);
      }
    }
    if (
      typeof quotaMeasuredAt !== "string" ||
      (quotaMeasuredAt !== "" && (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(quotaMeasuredAt) || !Number.isFinite(Date.parse(quotaMeasuredAt))))
    ) {
      throw new Error("Every API Worker environment must set FREE_QUOTA_MEASURED_AT_UTC to a UTC timestamp or an empty string.");
    }
    let parsedOrigin;
    try {
      parsedOrigin = new URL(webOrigin);
    } catch {
      throw new Error("Every API Worker environment must set WEB_ORIGIN to an HTTPS site origin.");
    }
    if (
      parsedOrigin.protocol !== "https:" ||
      parsedOrigin.pathname !== "/" ||
      parsedOrigin.search ||
      parsedOrigin.hash
    ) {
      throw new Error("Every API Worker environment must set WEB_ORIGIN to an HTTPS site origin.");
    }
    if (challengeHostname !== parsedOrigin.hostname) {
      throw new Error("TURNSTILE_ALLOWED_HOSTNAME must match the exact WEB_ORIGIN hostname.");
    }
  }
  if (config.vars?.APP_ENV !== "production") {
    throw new Error("The default API Worker environment must be marked as production.");
  }

  const selectedDatabase = targetEnvironment === "preview" ? previewDatabase : productionDatabase;
  if (requireRealId && placeholderDatabaseIds.has(selectedDatabase.database_id)) {
    throw new Error(`Configure a real ${targetEnvironment} D1 database ID before a remote operation.`);
  }
  const selectedDeletionDatabase = targetEnvironment === "preview" ? previewDeletionDatabase : productionDeletionDatabase;
  if (requireRealId && placeholderDatabaseIds.has(selectedDeletionDatabase.database_id)) {
    throw new Error(`Configure a real ${targetEnvironment} deletion-ledger D1 database ID before a remote operation.`);
  }
  const selectedEnvironment = targetEnvironment === "preview" ? preview : production;
  if (requireRealId && selectedEnvironment.vars.WEB_ORIGIN.includes("replace-me")) {
    throw new Error(`Configure the ${targetEnvironment} Pages origin before a remote operation.`);
  }
  if (requireRealId && freeQuotaUsageVariables.some((name) => selectedEnvironment.vars[name] === "")) {
    throw new Error(`Configure measured Cloudflare Free quota usage for the ${targetEnvironment} environment before a remote operation.`);
  }
  if (requireRealId) {
    const measuredAt = selectedEnvironment.vars.FREE_QUOTA_MEASURED_AT_UTC;
    const measuredAtMilliseconds = Date.parse(measuredAt);
    const ageMilliseconds = Date.now() - measuredAtMilliseconds;
    if (
      !measuredAt ||
      ageMilliseconds < 0 ||
      ageMilliseconds > 3 * 60 * 60 * 1000 ||
      new Date(measuredAtMilliseconds).toISOString().slice(0, 10) !== new Date().toISOString().slice(0, 10)
    ) {
      throw new Error(`Configure a current-day Cloudflare quota snapshot measured within three hours for the ${targetEnvironment} environment before a remote operation.`);
    }
  }

  return `${targetEnvironment} is configured with an isolated D1 application database and an isolated D1 deletion ledger.`;
}

function run() {
  const targetEnvironment = process.argv[2];
  const requireRealId = process.argv.includes("--require-real-id");
  const config = JSON.parse(readFileSync(new URL("../wrangler.api.jsonc", import.meta.url), "utf8"));
  process.stdout.write(`${checkDeploymentConfiguration(config, targetEnvironment, requireRealId)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    run();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "Invalid deployment configuration."}\n`);
    process.exitCode = 1;
  }
}
