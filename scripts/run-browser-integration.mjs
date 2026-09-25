import { spawn, execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
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
const previewToken = targetEnvironment === "preview" ? randomBytes(32).toString("base64url") : "";
const previewTokenHash = previewToken ? createHash("sha256").update(previewToken).digest("hex") : "";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const apiConfigPath = resolve(repositoryRoot, "wrangler.api.jsonc");
const viteCli = resolve(repositoryRoot, "node_modules/vite/bin/vite.js");
const wranglerCli = resolve(repositoryRoot, "node_modules/wrangler/bin/wrangler.js");
const playwrightCli = resolve(repositoryRoot, "node_modules/@playwright/test/cli.js");
const apiUrl = "http://127.0.0.1:8787";
const frontendUrl = "http://127.0.0.1:8788";
const turnstileTestSiteKey = "1x00000000000000000000AA";
const turnstileTestSecretKey = "1x0000000000000000000000000000000AA";
const stateDirectory = resolve(repositoryRoot, `.wrangler/e2e-${targetEnvironment}-state`);
const localArgs = ["--config", apiConfigPath, "--env", targetEnvironment, "--local", "--persist-to", stateDirectory];
const runWrangler = (args) =>
  execFileSync(process.execPath, [wranglerCli, ...args], { cwd: repositoryRoot, stdio: "inherit" });

checkDeploymentConfiguration(JSON.parse(await readFile(apiConfigPath, "utf8")), targetEnvironment);
await rm(stateDirectory, { recursive: true, force: true });
runWrangler(["d1", "migrations", "apply", "DB", ...localArgs]);
if (targetEnvironment === "preview") {
  runWrangler(["d1", "execute", "DB", ...localArgs, "--file=./db/seed-preview.sql"]);
}

execFileSync(process.execPath, [resolve(repositoryRoot, "scripts/build-api.mjs")], {
  cwd: repositoryRoot,
  stdio: "inherit",
});
execFileSync("npm", ["run", "build"], {
  cwd: repositoryRoot,
  stdio: "inherit",
  env: {
    ...process.env,
    VITE_API_BASE_URL: apiUrl,
    VITE_TURNSTILE_SITE_KEY: turnstileTestSiteKey,
  },
});

const processes = [];
function start(args, env = process.env) {
  const child = spawn(process.execPath, args, { cwd: repositoryRoot, stdio: "inherit", env });
  child.once("error", (error) => {
    child.startError = error;
  });
  processes.push(child);
  return child;
}

const apiServer = start([
  wranglerCli,
  "dev",
  "--config",
  apiConfigPath,
  "--env",
  targetEnvironment,
  "--ip",
  "127.0.0.1",
  "--port",
  "8787",
  "--persist-to",
  stateDirectory,
  "--var",
  "WEB_ORIGIN:http://127.0.0.1:8788",
  "--var",
  `TURNSTILE_SECRET_KEY:${turnstileTestSecretKey}`,
  "--var",
  "TURNSTILE_ALLOWED_HOSTNAME:example.com",
  ...(previewTokenHash ? ["--var", `PREVIEW_TOKEN_HASH:${previewTokenHash}`] : []),
]);
const frontendServer = start([viteCli, "preview", "--host", "127.0.0.1", "--port", "8788", "--strictPort"]);

async function waitForServer(child, url) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.startError) throw child.startError;
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Local server exited with ${child.exitCode ?? child.signalCode}.`);
    }
    try {
      await fetch(url);
      return;
    } catch {
      await delay(200);
    }
  }
  throw new Error(`Local server at ${url} did not become ready within 30 seconds.`);
}

async function runPlaywright() {
  const args = [playwrightCli, "test"];
  if (grep) args.push("--grep", grep);
  await new Promise((resolveResult, rejectResult) => {
    const testProcess = spawn(process.execPath, args, {
      cwd: repositoryRoot,
      stdio: "inherit",
      env: {
        ...process.env,
        TURNOCERTO_API_BASE_URL: apiUrl,
        TURNOCERTO_ENV: targetEnvironment,
        TURNOCERTO_PREVIEW_TOKEN: previewToken,
        TURNOCERTO_PREVIEW_LINK_FRAGMENT: targetEnvironment === "preview" ? "true" : "false",
      },
    });
    testProcess.once("error", rejectResult);
    testProcess.once("close", (code, signal) => {
      if (code === 0) resolveResult(0);
      else rejectResult(new Error(`Playwright exited with ${signal ?? `code ${code}`}.`));
    });
  });
}

try {
  await Promise.all([waitForServer(apiServer, `${apiUrl}/api/schedules/preview-fixture`), waitForServer(frontendServer, frontendUrl)]);
  await runPlaywright();
} finally {
  await Promise.all(
    processes.map(async (child) => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill("SIGINT");
      await Promise.race([
        new Promise((resolveExit) => child.once("close", resolveExit)),
        delay(5_000).then(() => child.kill("SIGKILL")),
      ]);
    }),
  );
}
