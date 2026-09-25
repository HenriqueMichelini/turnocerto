import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { locateGoBinary } from "./go-binary.mjs";

const go = locateGoBinary();
execFileSync(go, ["test", "./..."], {
  stdio: "inherit",
  env: {
    ...process.env,
    GOCACHE: process.env.GOCACHE ?? resolve(tmpdir(), "turnocerto-go-build"),
    GOMODCACHE: process.env.GOMODCACHE ?? resolve(tmpdir(), "turnocerto-go-mod"),
  },
});
