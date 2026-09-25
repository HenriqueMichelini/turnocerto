import { accessSync, constants, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { delimiter, join } from "node:path";

export function locateGoBinary() {
  const pathEntries = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  const candidates = [
    process.env.GO_BINARY,
    ...pathEntries.map((directory) => join(directory, "go")),
    "/usr/local/go/bin/go",
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      if (!existsSync(candidate)) continue;
      accessSync(candidate, constants.X_OK);
      const version = execFileSync(candidate, ["version"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
      const match = version.match(/go(\d+)\.(\d+)/);
      if (!match) continue;
      const [, major, minor] = match;
      if (Number(major) < 1 || (Number(major) === 1 && Number(minor) < 24)) continue;
      return candidate;
    } catch {
      // Try the next configured Go installation.
    }
  }

  throw new Error("Go 1.24 or newer is required.");
}
