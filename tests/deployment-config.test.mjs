import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { checkDeploymentConfiguration } from "../scripts/check-deployment-config.mjs";

const config = JSON.parse(readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8"));

describe("D1 environment safety", () => {
  it("keeps preview and production on isolated databases", () => {
    assert.match(checkDeploymentConfiguration(config, "preview"), /isolated D1/);
    assert.match(checkDeploymentConfiguration(config, "production"), /isolated D1/);
  });

  it("rejects a preview configuration that points at production", () => {
    const unsafeConfig = structuredClone(config);
    unsafeConfig.env.preview.d1_databases[0] = { ...unsafeConfig.env.production.d1_databases[0] };

    assert.throws(
      () => checkDeploymentConfiguration(unsafeConfig, "preview"),
      /different D1 database IDs/,
    );
  });

  it("rejects a default Pages environment marked as preview", () => {
    const unsafeConfig = structuredClone(config);
    unsafeConfig.vars.APP_ENV = "preview";

    assert.throws(
      () => checkDeploymentConfiguration(unsafeConfig, "preview"),
      /default Pages environment must be marked as production/,
    );
  });

  it("blocks remote operations while example IDs remain", () => {
    assert.throws(
      () => checkDeploymentConfiguration(config, "preview", true),
      /Configure a real preview D1 database ID/,
    );
    assert.throws(
      () => checkDeploymentConfiguration(config, "production", true),
      /Configure a real production D1 database ID/,
    );
  });
});
