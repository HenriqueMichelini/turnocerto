import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { checkDeploymentConfiguration } from "../scripts/check-deployment-config.mjs";

const config = JSON.parse(readFileSync(new URL("../wrangler.api.jsonc", import.meta.url), "utf8"));

describe("Go API Worker D1 environment safety", () => {
  it("keeps measured quota variables aligned with the Go parser and remote deployment checker", () => {
    const goWorkerSource = readFileSync(new URL("../backend/cmd/api/main_js.go", import.meta.url), "utf8");
    const deploymentCheckerSource = readFileSync(new URL("../scripts/check-deployment-config.mjs", import.meta.url), "utf8");
    const expected = Object.keys(config.env.production.vars)
      .filter((name) => name.startsWith("FREE_QUOTA_") && name !== "FREE_QUOTA_MEASURED_AT_UTC")
      .sort();
    const goParserNames = [...goWorkerSource.matchAll(/read\("(FREE_QUOTA_[A-Z0-9_]+)"\)/g)]
      .map((match) => match[1])
      .sort();
    const deploymentCheckerNames = [...deploymentCheckerSource.matchAll(/^\s+"(FREE_QUOTA_[A-Z0-9_]+)",?$/gm)]
      .map((match) => match[1])
      .sort();

    assert.deepEqual(goParserNames, expected);
    assert.deepEqual(deploymentCheckerNames, expected);
  });

  it("keeps preview and production on isolated databases", () => {
    assert.match(checkDeploymentConfiguration(config, "preview"), /isolated D1/);
    assert.match(checkDeploymentConfiguration(config, "production"), /isolated D1/);
    for (const environment of [config.env.preview, config.env.production]) {
      const application = environment.d1_databases.find((database) => database.binding === "DB");
      const deletionLedger = environment.d1_databases.find((database) => database.binding === "DELETION_DB");
      assert.ok(application && deletionLedger);
      assert.notEqual(application.database_id, deletionLedger.database_id);
      assert.notEqual(application.database_name, deletionLedger.database_name);
    }
    assert.notEqual(
      config.env.preview.d1_databases.find((database) => database.binding === "DELETION_DB").database_id,
      config.env.production.d1_databases.find((database) => database.binding === "DELETION_DB").database_id,
    );
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

  it("blocks remote operations until the separate deletion ledger is provisioned", () => {
    assert.throws(
      () => checkDeploymentConfiguration(config, "preview", true),
      /Configure a real preview deletion-ledger D1 database ID/,
    );
    assert.throws(
      () => checkDeploymentConfiguration(config, "production", true),
      /Configure a real production deletion-ledger D1 database ID/,
    );
  });

  it("blocks remote operations until measured quota snapshots are populated", () => {
    const provisionedConfig = structuredClone(config);
    const realIDs = [
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
    ];
    provisionedConfig.d1_databases.find((database) => database.binding === "DELETION_DB").database_id = realIDs[0];
    provisionedConfig.env.production.d1_databases.find((database) => database.binding === "DELETION_DB").database_id = realIDs[0];
    provisionedConfig.env.preview.d1_databases.find((database) => database.binding === "DELETION_DB").database_id = realIDs[1];
    assert.throws(
      () => checkDeploymentConfiguration(provisionedConfig, "production", true),
      /Configure measured Cloudflare Free quota usage for the production environment/,
    );
  });

  it("accepts current measured usage and rejects stale remote quota snapshots", () => {
    const measuredConfig = structuredClone(config);
    const realIDs = [
      "33333333-3333-4333-8333-333333333333",
      "44444444-4444-4444-8444-444444444444",
    ];
    measuredConfig.d1_databases.find((database) => database.binding === "DELETION_DB").database_id = realIDs[0];
    measuredConfig.env.production.d1_databases.find((database) => database.binding === "DELETION_DB").database_id = realIDs[0];
    measuredConfig.env.preview.d1_databases.find((database) => database.binding === "DELETION_DB").database_id = realIDs[1];
    for (const environment of [measuredConfig, measuredConfig.env.preview, measuredConfig.env.production]) {
      environment.vars.FREE_QUOTA_MEASURED_AT_UTC = new Date().toISOString();
      for (const name of Object.keys(environment.vars).filter((key) => key.startsWith("FREE_QUOTA_") && key !== "FREE_QUOTA_MEASURED_AT_UTC")) {
        environment.vars[name] = "0";
      }
    }
    assert.match(checkDeploymentConfiguration(measuredConfig, "production", true), /isolated D1/);

    measuredConfig.env.production.vars.FREE_QUOTA_MEASURED_AT_UTC = new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString();
    assert.throws(
      () => checkDeploymentConfiguration(measuredConfig, "production", true),
      /current-day Cloudflare quota snapshot measured within three hours/,
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

  it("requires an explicit creation admission switch in every API environment", () => {
    const unsafeConfig = structuredClone(config);
    delete unsafeConfig.env.production.vars.SPACE_CREATION_PAUSED;

    assert.throws(
      () => checkDeploymentConfiguration(unsafeConfig, "production"),
      /SPACE_CREATION_PAUSED to true or false/,
    );
  });
});
