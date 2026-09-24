import { spawn, execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkDeploymentConfiguration } from "./check-deployment-config.mjs";

const targetEnvironment = process.argv[2];
const grepIndex = process.argv.indexOf("--grep");
const grep = grepIndex === -1 ? undefined : process.argv[grepIndex + 1];
if (!new Set(["preview", "production"]).has(targetEnvironment) || (grepIndex !== -1 && !grep)) {
  throw new Error('Usage: node scripts/run-browser-integration.mjs <preview|production> [--grep "test name"]');
}

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const config = JSON.parse(readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8"));
checkDeploymentConfiguration(config, targetEnvironment);

const database = config.env[targetEnvironment].d1_databases.find((binding) => binding.binding === "DB");
const stateDirectory = resolve(repositoryRoot, `.wrangler/e2e-${targetEnvironment}-state`);
const wranglerCli = resolve(repositoryRoot, "node_modules/wrangler/bin/wrangler.js");
const playwrightCli = resolve(repositoryRoot, "node_modules/@playwright/test/cli.js");
const localArgs = ["--env", targetEnvironment, "--local", "--persist-to", stateDirectory];
const runWrangler = (args) => execFileSync(process.execPath, [wranglerCli, ...args], { cwd: repositoryRoot, stdio: "inherit" });

await rm(stateDirectory, { recursive: true, force: true });
runWrangler(["d1", "migrations", "apply", "DB", ...localArgs]);
if (targetEnvironment === "preview") {
  runWrangler(["d1", "execute", "DB", ...localArgs, "--file=./db/seed-preview.sql"]);
}

const localUrl = "http://127.0.0.1:8788";
const server = spawn(
  process.execPath,
  [
    wranglerCli,
    "pages",
    "dev",
    "dist",
    "--ip",
    "127.0.0.1",
    "--port",
    "8788",
    "--persist-to",
    stateDirectory,
    "--d1",
    `DB=${database.database_id}`,
    "--binding",
    `APP_ENV=${targetEnvironment}`,
  ],
  { cwd: repositoryRoot, stdio: "inherit", env: process.env },
);
let serverError;
server.once("error", (error) => {
  serverError = error;
});

async function waitForServer() {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (serverError) throw serverError;
    if (server.exitCode !== null || server.signalCode !== null) {
      throw new Error(`Wrangler Pages exited with code ${server.exitCode ?? server.signalCode}.`);
    }
    try {
      const response = await fetch(localUrl);
      if (response.ok) return;
    } catch {
      // Wrangler is still binding the local server.
    }
    await delay(200);
  }
  throw new Error("Wrangler Pages did not become ready within 30 seconds.");
}

async function runPlaywright() {
  const args = [playwrightCli, "test"];
  if (grep) args.push("--grep", grep);
  const result = await new Promise((resolveResult, rejectResult) => {
    const testProcess = spawn(process.execPath, args, {
      cwd: repositoryRoot,
      stdio: "inherit",
      env: { ...process.env, TURNOCERTO_ENV: targetEnvironment },
    });
    testProcess.once("error", rejectResult);
    testProcess.once("close", (code, signal) => {
      if (code === 0) resolveResult(0);
      else rejectResult(new Error(`Playwright exited with ${signal ?? `code ${code}`}.`));
    });
  });
  return result;
}

try {
  await waitForServer();
  await runPlaywright();
} finally {
  if (server.exitCode === null && server.signalCode === null) {
    server.kill("SIGINT");
    await Promise.race([
      new Promise((resolveExit) => server.once("close", resolveExit)),
      delay(5_000).then(() => server.kill("SIGKILL")),
    ]);
  }
}
