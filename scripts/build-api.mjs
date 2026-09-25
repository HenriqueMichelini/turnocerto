import { copyFile, mkdir } from "node:fs/promises";
import { existsSync, realpathSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { locateGoBinary } from "./go-binary.mjs";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const outputDirectory = resolve(repositoryRoot, "worker/generated");
const go = locateGoBinary();
const goRoot = process.env.GOROOT ?? resolve(dirname(realpathSync(go)), "..");
const wasmRuntime = resolve(goRoot, "lib/wasm/wasm_exec.js");
if (!existsSync(wasmRuntime)) {
  throw new Error(`Go's WebAssembly runtime was not found under ${dirname(wasmRuntime)}.`);
}

await mkdir(outputDirectory, { recursive: true });
execFileSync(
  go,
  [
    "build",
    "-trimpath",
    "-ldflags=-s -w",
    "-o",
    resolve(outputDirectory, "turnocerto.wasm"),
    "./backend/cmd/api",
  ],
  {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      GOOS: "js",
      GOARCH: "wasm",
      CGO_ENABLED: "0",
      GOCACHE: process.env.GOCACHE ?? resolve(tmpdir(), "turnocerto-go-build"),
      GOMODCACHE: process.env.GOMODCACHE ?? resolve(tmpdir(), "turnocerto-go-mod"),
    },
    stdio: "inherit",
  },
);
await copyFile(wasmRuntime, resolve(outputDirectory, "wasm_exec.js"));
