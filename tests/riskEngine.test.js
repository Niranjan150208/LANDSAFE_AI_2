import test from "node:test";
import assert from "node:assert/strict";
import { evaluateRisk } from "../server.js";

test("low precipitation and dry conditions remain low risk", () => {
  const r = evaluateRisk({rain24:2,rain72:5,soilMoisture:18,slope:20,pga:0.005,simulated:true});
  assert.equal(r.score,5);
  assert.equal(r.dataStatus,"SIMULATED");
  assert.equal(r.missingFactors.length,0);
});
test("cloudburst scenario is classified for urgent attention", () => {
  const r = evaluateRisk({rain24:118.5,rain72:215,soilMoisture:44,slope:42,pga:0.11,simulated:true});
  assert.equal(r.score,81);
  assert.equal(r.category,"EVACUATE");
  assert.ok(Math.abs(Object.values(r.contributions).reduce((a,b)=>a+b,0)-80.9) < 0.2);
});
test("stale observations add an uncertainty penalty without reducing risk", () => {
  const base = {rain24:40,rain72:70,soilMoisture:30,slope:30,pga:0.02};
  const fresh = evaluateRisk(base);
  const stale = evaluateRisk({...base,observationAgeHours:36});
  assert.equal(stale.stalePenalty,5);
  assert.equal(stale.score,Math.min(100,fresh.score+5));
  assert.equal(stale.dataStatus,"STALE");
});
test("missing rainfall is reported and remaining weights are renormalized", () => {
  const r = evaluateRisk({rain24:null,rain72:null,soilMoisture:35,slope:35,pga:null});
  assert.deepEqual(r.missingFactors,["24h rainfall","72h antecedent rainfall","Ground acceleration"]);
  assert.ok(Number.isFinite(r.score));
  assert.ok(r.uncertaintyNote);
});
test("evaluation is deterministic for identical inputs", () => {
  const input = {rain24:40,rain72:70,soilMoisture:30,slope:30,pga:0.02};
  assert.equal(evaluateRisk(input).score,evaluateRisk(input).score);
});
test("invalid values and empty telemetry are rejected", () => {
  assert.throws(() => evaluateRisk({rain24:-1}),/Out-of-range/);
  assert.throws(() => evaluateRisk({}),/At least one sensor factor/);
});

test("normal-condition demo scenario matches the documented safe score", () => {
  const r = evaluateRisk({rain24:4.2,rain72:18,soilMoisture:21,slope:22,pga:0.008,simulated:true});
  assert.equal(r.score,10);
  assert.equal(r.category,"SAFE");
});
