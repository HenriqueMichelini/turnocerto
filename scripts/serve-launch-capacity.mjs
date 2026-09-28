import { spawn, execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { isIP } from "node:net";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkDeploymentConfiguration } from "./check-deployment-config.mjs";
import { createSyntheticCapacityFixture } from "../tests/e2e/capacity-fixture.mjs";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const apiConfigPath = resolve(repositoryRoot, "wrangler.api.jsonc");
const viteCli = resolve(repositoryRoot, "node_modules/vite/bin/vite.js");
const wranglerCli = resolve(repositoryRoot, "node_modules/wrangler/bin/wrangler.js");
const lanAddress = process.env.TURNOCERTO_CAPACITY_HOST?.trim() || "127.0.0.1";
const apiUrl = `http://${lanAddress}:8787`;
const frontendUrl = `http://${lanAddress}:8788`;
const bindAddress = lanAddress === "127.0.0.1" ? lanAddress : "0.0.0.0";
const targetEnvironment = "preview";
const turnstileTestSiteKey = "1x00000000000000000000AA";
const turnstileTestSecretKey = "1x0000000000000000000000000000000AA";
const stateDirectory = resolve(repositoryRoot, `.wrangler/launch-capacity-${randomBytes(8).toString("hex")}`);
const managementLinksPath = resolve(stateDirectory, "management-links.txt");
const wranglerLogPath = resolve(repositoryRoot, `.wrangler/launch-capacity-${randomBytes(8).toString("hex")}.log`);
const wranglerEnvironment = { ...process.env, WRANGLER_LOG_PATH: wranglerLogPath };
const previewToken = randomBytes(32).toString("base64url");

if (isIP(lanAddress) !== 4) {
  throw new Error("TURNOCERTO_CAPACITY_HOST must be the phone-reachable IPv4 address of this host.");
}

const apiConfig = JSON.parse(await readFile(apiConfigPath, "utf8"));
const localQuotaUsageNames = Object.keys(apiConfig.env.preview.vars).filter(
  (name) => name.startsWith("FREE_QUOTA_") && name !== "FREE_QUOTA_MEASURED_AT_UTC",
);
checkDeploymentConfiguration(apiConfig, targetEnvironment);

function run(command, args, env = process.env) {
  execFileSync(command, args, { cwd: repositoryRoot, stdio: "inherit", env });
}

await rm(stateDirectory, { recursive: true, force: true });
await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
run(process.execPath, [wranglerCli, "d1", "migrations", "apply", "DB", "--config", apiConfigPath, "--env", targetEnvironment, "--local", "--persist-to", stateDirectory], wranglerEnvironment);
run(process.execPath, [wranglerCli, "d1", "migrations", "apply", "DELETION_DB", "--config", apiConfigPath, "--env", targetEnvironment, "--local", "--persist-to", stateDirectory], wranglerEnvironment);
run(process.execPath, [wranglerCli, "d1", "execute", "DB", "--config", apiConfigPath, "--env", targetEnvironment, "--local", "--persist-to", stateDirectory, "--file=./db/seed-preview.sql"], wranglerEnvironment);
run(process.execPath, [resolve(repositoryRoot, "scripts/build-api.mjs")], wranglerEnvironment);
run("npm", ["run", "build"], {
  ...wranglerEnvironment,
  VITE_API_BASE_URL: apiUrl,
  VITE_TURNSTILE_SITE_KEY: turnstileTestSiteKey,
  VITE_CAPACITY_BENCHMARK: "true",
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
  "--local",
  "--ip",
  bindAddress,
  "--port",
  "8787",
  "--persist-to",
  stateDirectory,
  "--var",
  `WEB_ORIGIN:${frontendUrl}`,
  "--var",
  `TURNSTILE_SECRET_KEY:${turnstileTestSecretKey}`,
  "--var",
  "TURNSTILE_ALLOWED_HOSTNAME:example.com",
  "--var",
  `FREE_QUOTA_MEASURED_AT_UTC:${new Date().toISOString()}`,
  ...localQuotaUsageNames.flatMap((name) => ["--var", `${name}:0`]),
  "--var",
  `PREVIEW_TOKEN_HASH:${await hashPreviewToken(previewToken)}`,
], wranglerEnvironment);
const frontendServer = start([viteCli, "preview", "--host", bindAddress, "--port", "8788", "--strictPort"], wranglerEnvironment);

async function waitForServer(child, url) {
  const deadline = Date.now() + 45_000;
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
  throw new Error(`Local server at ${url} did not become ready within 45 seconds.`);
}

async function createFixture(count) {
  const fixture = await createSyntheticCapacityFixture({
    apiBaseUrl: apiUrl,
    webOrigin: frontendUrl,
    count,
    spaceName: `Teste de capacidade ${count} pessoas`,
    personName: (index) => `Teste ${String(index).padStart(3, "0")}`,
    clientAddress: count === 20 ? "198.51.100.73" : "198.51.100.74",
  });
  const managementLink = new URL("/", frontendUrl);
  managementLink.searchParams.set("capacity-benchmark", "1");
  managementLink.searchParams.set("people", String(count));
  managementLink.searchParams.set("samples", count === 20 ? "20" : "1");
  managementLink.hash = new URL(fixture.managementLink).hash;
  return managementLink.toString();
}

async function hashPreviewToken(token) {
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(token).digest("hex");
}

async function stop() {
  await Promise.all(processes.map(async (child) => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill("SIGINT");
    await Promise.race([
      new Promise((resolveExit) => child.once("close", resolveExit)),
      delay(5_000).then(() => child.kill("SIGKILL")),
    ]);
  }));
}

try {
  await Promise.all([waitForServer(apiServer, `${apiUrl}/api/schedules/preview-fixture`), waitForServer(frontendServer, frontendUrl)]);
  const twentyPersonLink = await createFixture(20);
  const hundredPersonLink = await createFixture(100);
  await writeFile(managementLinksPath, `20 People (four weeks): ${twentyPersonLink}\n100 People: ${hundredPersonLink}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  await chmod(managementLinksPath, 0o600);
  console.log("\nSynthetic launch-capacity fixtures are ready. Both use local D1 data only.");
  console.log(`Management Links are in this local mode-0600 file: ${managementLinksPath}`);
  console.log("The measurement panel records view, edit, and export timings. Save its JSON evidence before stopping this runner.");
  console.log("Press Ctrl+C to stop both LAN servers and end the test session.\n");
  await new Promise((resolveExit) => {
    process.once("SIGINT", resolveExit);
    process.once("SIGTERM", resolveExit);
  });
} finally {
  await stop();
  await Promise.all([
    rm(stateDirectory, { recursive: true, force: true }),
    rm(wranglerLogPath, { force: true }),
  ]);
}
