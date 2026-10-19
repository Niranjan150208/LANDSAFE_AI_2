import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
}

test("HTTP API supports scenarios, validation, and idempotent incident sync", async () => {
  const port = await freePort();
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "landsafe-api-"));
  const child = spawn(process.execPath, ["server.js"], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(port), DATA_DIR: dataDir },
    stdio: "ignore"
  });
  const base = `http://127.0.0.1:${port}`;
  try {
    let ready = false;
    for (let i = 0; i < 60; i++) {
      if (child.exitCode !== null) throw new Error("Server exited before becoming ready");
      try {
        const response = await fetch(base + "/api/health");
        if (response.ok) { ready = true; break; }
      } catch {}
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(ready, true, "server should become healthy");
    const health = await (await fetch(base + "/api/health")).json();
    assert.equal(health.status, "ONLINE");
    assert.equal(health.riskModel, "ILLUSTRATIVE_NOT_VALIDATED");

    const scenarioResponse = await fetch(base + "/api/demo/scenario", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ scenario: "HIGH_RISK" })
    });
    assert.equal(scenarioResponse.status, 200);
    const scenario = await scenarioResponse.json();
    assert.equal(scenario.risk.score, 81);
    assert.equal(scenario.risk.dataStatus, "SIMULATED");

    const badScenario = await fetch(base + "/api/demo/scenario", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ scenario: "UNKNOWN" })
    });
    assert.equal(badScenario.status, 400);

    const payload = {
      sector: "NH-10 test corridor", incidentType: "Rockfall",
      visualSeverity: "HIGH", description: "API integration test",
      clientReportId: "integration-test-report-001"
    };
    const first = await fetch(base + "/api/incidents/sync", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload)
    });
    assert.equal(first.status, 201);
    assert.equal((await first.json()).status, "PERSISTED");
    const duplicate = await fetch(base + "/api/incidents/sync", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload)
    });
    assert.equal(duplicate.status, 200);
    assert.equal((await duplicate.json()).status, "ALREADY_PERSISTED");
    const dashboard = await (await fetch(base + "/api/dashboard")).json();
    assert.equal(dashboard.incidentCount, 1);
    assert.equal(dashboard.alertCount, 1);
  } finally {
    child.kill("SIGTERM");
    await new Promise(resolve => child.once("exit", resolve).unref?.());
    await rm(dataDir, { recursive: true, force: true });
  }
});
