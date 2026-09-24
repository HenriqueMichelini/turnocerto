import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const placeholderDatabaseIds = new Set([
  "00000000-0000-4000-8000-000000000001",
  "00000000-0000-4000-8000-000000000002",
]);

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

  if (!previewDatabase || !productionDatabase || !defaultDatabase) {
    throw new Error("The default, preview, and production environments must define the DB binding.");
  }
  if (previewDatabase.database_id === productionDatabase.database_id) {
    throw new Error("Preview and production must use different D1 database IDs.");
  }
  if (previewDatabase.database_name === productionDatabase.database_name) {
    throw new Error("Preview and production must use different D1 database names.");
  }
  if (
    defaultDatabase.database_id !== productionDatabase.database_id ||
    defaultDatabase.database_name !== productionDatabase.database_name
  ) {
    throw new Error("The default Pages environment must target the production D1 database.");
  }
  if (preview.vars?.APP_ENV !== "preview" || production.vars?.APP_ENV !== "production") {
    throw new Error("APP_ENV must match each Wrangler environment.");
  }
  if (config.vars?.APP_ENV !== "production") {
    throw new Error("The default Pages environment must be marked as production.");
  }

  const selectedDatabase = targetEnvironment === "preview" ? previewDatabase : productionDatabase;
  if (requireRealId && placeholderDatabaseIds.has(selectedDatabase.database_id)) {
    throw new Error(`Configure a real ${targetEnvironment} D1 database ID before a remote operation.`);
  }

  return `${targetEnvironment} is configured with an isolated D1 database.`;
}

function run() {
  const targetEnvironment = process.argv[2];
  const requireRealId = process.argv.includes("--require-real-id");
  const config = JSON.parse(readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8"));
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
