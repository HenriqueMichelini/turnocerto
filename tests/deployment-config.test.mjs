import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { checkDeploymentConfiguration } from "../scripts/check-deployment-config.mjs";

const config = JSON.parse(readFileSync(new URL("../wrangler.api.jsonc", import.meta.url), "utf8"));

describe("Go API Worker D1 environment safety", () => {
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

  it("rejects a default API Worker environment marked as preview", () => {
    const unsafeConfig = structuredClone(config);
    unsafeConfig.vars.APP_ENV = "preview";

    assert.throws(
      () => checkDeploymentConfiguration(unsafeConfig, "preview"),
      /default API Worker environment must be marked as production/,
    );
  });

  it("keeps the default API Worker on the production site origin", () => {
    const unsafeConfig = structuredClone(config);
    unsafeConfig.vars.WEB_ORIGIN = "https://preview.turnocerto.pages.dev";

    assert.throws(
      () => checkDeploymentConfiguration(unsafeConfig, "preview"),
      /default API Worker environment must target the production Pages origin/,
    );
  });

  it("blocks remote operations while example IDs remain", () => {
    const exampleConfig = structuredClone(config);
    const productionDatabaseId = "00000000-0000-4000-8000-000000000001";
    const previewDatabaseId = "00000000-0000-4000-8000-000000000002";
    exampleConfig.d1_databases[0].database_id = productionDatabaseId;
    exampleConfig.env.production.d1_databases[0].database_id = productionDatabaseId;
    exampleConfig.env.preview.d1_databases[0].database_id = previewDatabaseId;

    assert.throws(
      () => checkDeploymentConfiguration(exampleConfig, "preview", true),
      /Configure a real preview D1 database ID/,
    );
    assert.throws(
      () => checkDeploymentConfiguration(exampleConfig, "production", true),
      /Configure a real production D1 database ID/,
    );
  });

  it("requires HTTPS site origins for the browser API", () => {
    const unsafeConfig = structuredClone(config);
    unsafeConfig.env.preview.vars.WEB_ORIGIN = "http://preview.turnocerto.pages.dev";

    assert.throws(
      () => checkDeploymentConfiguration(unsafeConfig, "preview"),
      /WEB_ORIGIN to an HTTPS site origin/,
    );
  });

  it("uses separate rate-limit namespaces for preview and production", () => {
    const previewLimit = config.env.preview.ratelimits?.find((binding) => binding.name === "CREATION_RATE_LIMITER");
    const productionLimit = config.env.production.ratelimits?.find((binding) => binding.name === "CREATION_RATE_LIMITER");
    const defaultLimit = config.ratelimits?.find((binding) => binding.name === "CREATION_RATE_LIMITER");

    assert.ok(previewLimit && productionLimit && defaultLimit);
    assert.notEqual(previewLimit.namespace_id, productionLimit.namespace_id);
    assert.equal(defaultLimit.namespace_id, productionLimit.namespace_id);
    assert.equal(previewLimit.simple.limit, 10);
    assert.equal(previewLimit.simple.period, 60);
    assert.match(checkDeploymentConfiguration(config, "preview"), /isolated D1/);
  });

  it("rejects a missing or shared anonymous-creation rate-limit binding", () => {
    const withoutPreviewLimit = structuredClone(config);
    withoutPreviewLimit.env.preview.ratelimits = [];
    assert.throws(() => checkDeploymentConfiguration(withoutPreviewLimit, "preview"), /CREATION_RATE_LIMITER/);

    const sharedNamespace = structuredClone(config);
    sharedNamespace.env.preview.ratelimits[0].namespace_id = sharedNamespace.env.production.ratelimits[0].namespace_id;
    assert.throws(() => checkDeploymentConfiguration(sharedNamespace, "preview"), /different rate-limit namespaces/);
  });

  it("requires Turnstile validation to match each exact site hostname", () => {
    const unsafeConfig = structuredClone(config);
    unsafeConfig.env.preview.vars.TURNSTILE_ALLOWED_HOSTNAME = "example.com";

    assert.throws(
      () => checkDeploymentConfiguration(unsafeConfig, "preview"),
      /TURNSTILE_ALLOWED_HOSTNAME must match/,
    );
  });
});
