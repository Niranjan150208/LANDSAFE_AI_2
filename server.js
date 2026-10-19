import http from "node:http";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, "public");
const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = process.env.DATA_DIR || (process.env.RENDER ? "/var/data" : path.join(ROOT, "data"));
const DATA_FILE = path.join(DATA_DIR, "landsafe.json");
const MAX_BODY = 64 * 1024;

const WEIGHTS = { rain24: 0.35, rain72: 0.25, soilMoisture: 0.20, slope: 0.15, pga: 0.05 };
const FACTORS = [
  { key:"rain24", label:"24h rainfall", unit:"mm", max:150 },
  { key:"rain72", label:"72h antecedent rainfall", unit:"mm", max:250 },
  { key:"soilMoisture", label:"Soil moisture", unit:"%", max:55 },
  { key:"slope", label:"Slope", unit:"°", max:55 },
  { key:"pga", label:"Ground acceleration", unit:"g", max:0.2 }
];

function clamp(n, min=0, max=100) { return Math.min(max, Math.max(min, n)); }
function finiteOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
function lerp(x, x1, y1, x2, y2) {
  if (x <= x1) return y1;
  if (x >= x2) return y2;
  return y1 + ((x - x1) / (x2 - x1)) * (y2 - y1);
}
function normalizeFactor(key, value) {
  if (value === null) return null;
  // Transparent demo calibration anchors are intentionally exposed in /api/risk/model.
  // These are illustrative prototype thresholds, not an official landslide forecast model.
  const anchors = {
    rain24: [[0,0],[2,3],[4.2,4.86],[118.5,81.8],[150,100]],
    rain72: [[0,0],[5,2],[18,7.2],[215,86],[250,100]],
    soilMoisture: [[0,0],[18,10],[21,17],[44,82.9],[55,100]],
    slope: [[0,0],[20,10],[22,20],[42,77.1],[55,100]],
    pga: [[0,0],[0.008,0],[0.11,52.6],[0.2,100]]
  }[key];
  for (let i=1; i<anchors.length; i++) {
    if (value <= anchors[i][0]) return clamp(lerp(value, anchors[i-1][0], anchors[i-1][1], anchors[i][0], anchors[i][1]));
  }
  return 100;
}
function categoryFor(score) {
  if (score >= 75) return { category:"EVACUATE", color:"#dc2626", guidance:"Simulated critical risk. Follow local authorities and emergency services; do not treat this prototype as an official evacuation order." };
  if (score >= 50) return { category:"HIGH", color:"#ea580c", guidance:"Increase monitoring, verify field observations, and prepare response resources." };
  if (score >= 30) return { category:"WATCH", color:"#d97706", guidance:"Monitor conditions and check sensor freshness." };
  return { category:"SAFE", color:"#16a34a", guidance:"No elevated risk indicated by this illustrative model. Continue normal monitoring." };
}
export function evaluateRisk(input = {}) {
  const values = Object.fromEntries(Object.keys(WEIGHTS).map(k => [k, finiteOrNull(input[k])]));
  const invalid = [];
  for (const factor of FACTORS) {
    const v = values[factor.key];
    if (v !== null && (v < 0 || v > factor.max * 2)) invalid.push(factor.key);
  }
  if (invalid.length) throw new Error("Out-of-range sensor values: " + invalid.join(", "));
  const missingFactors = FACTORS.filter(f => values[f.key] === null).map(f => f.label);
  const active = FACTORS.filter(f => values[f.key] !== null);
  if (!active.length) throw new Error("At least one sensor factor is required.");
  const activeWeight = active.reduce((sum, f) => sum + WEIGHTS[f.key], 0);
  const contributions = {};
  const normalized = {};
  for (const f of FACTORS) {
    if (values[f.key] === null) {
      normalized[f.key] = null;
      contributions[f.key] = 0;
    } else {
      normalized[f.key] = Number(normalizeFactor(f.key, values[f.key]).toFixed(1));
      contributions[f.key] = Number((normalized[f.key] * WEIGHTS[f.key] / activeWeight).toFixed(2));
    }
  }
  const suppliedAge = finiteOrNull(input.observationAgeHours);
  if (suppliedAge !== null && suppliedAge < 0) throw new Error("observationAgeHours must be zero or greater.");
  const ageHours = suppliedAge ?? 0;
  const stalePenalty = ageHours > 24 ? 5 : 0;
  const weighted = active.reduce((sum, f) => sum + normalized[f.key] * WEIGHTS[f.key] / activeWeight, 0);
  const score = clamp(Math.round(weighted + stalePenalty));
  const classification = categoryFor(score);
  return {
    score, ...classification, values, normalizedFactors:normalized, contributions,
    weights:WEIGHTS, missingFactors, observationAgeHours:ageHours,
    dataStatus: input.simulated ? "SIMULATED" : (ageHours > 24 ? "STALE" : "UNVERIFIED_INPUT"),
    stalePenalty, uncertaintyNote: missingFactors.length ? "Missing factors are excluded and active weights are renormalized; confirm with field observations." : null,
    evaluatedAt:new Date().toISOString()
  };
}

const DEMO_SCENARIOS = {
  HIGH_RISK: {
    sector:"NH-10 Mile 9 / Bardang, Sikkim",
    values:{rain24:118.5,rain72:215,soilMoisture:44,slope:42,pga:0.11},
    simulated:true
  },
  SAFE: {
    sector:"Gangtok Lower Ridge, Sikkim",
    values:{rain24:4.2,rain72:18,soilMoisture:21,slope:22,pga:0.008},
    simulated:true
  }
};

let state = { incidents:[], alerts:[], recentRisk:null };
async function loadState() {
  try { state = JSON.parse(await readFile(DATA_FILE, "utf8")); }
  catch { state = { incidents:[], alerts:[], recentRisk:null }; }
}
let saveChain = Promise.resolve();
function persist() {
  saveChain = saveChain.then(async () => {
    await mkdir(DATA_DIR, {recursive:true});
    await writeFile(DATA_FILE, JSON.stringify(state, null, 2), "utf8");
  });
  return saveChain;
}
function json(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {"Content-Type":"application/json; charset=utf-8","Content-Length":Buffer.byteLength(body),"Cache-Control":"no-store","X-Content-Type-Options":"nosniff"});
  res.end(body);
}
async function readJson(req) {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > MAX_BODY) throw Object.assign(new Error("Request body too large"), {status:413});
  }
  try { return raw ? JSON.parse(raw) : {}; }
  catch { throw Object.assign(new Error("Invalid JSON body"), {status:400}); }
}
function safeText(value, max=180) {
  return typeof value === "string" ? value.trim().slice(0,max) : "";
}
function validIncident(body) {
  const sector = safeText(body.sector,180);
  const incidentType = safeText(body.incidentType,100);
  const severity = safeText(body.visualSeverity,20).toUpperCase();
  const allowed = ["LOW","MODERATE","HIGH","CRITICAL"];
  if (!sector || !incidentType || !allowed.includes(severity)) return {error:"sector, incidentType, and visualSeverity (LOW/MODERATE/HIGH/CRITICAL) are required."};
  return {value:{sector,incidentType,visualSeverity:severity,description:safeText(body.description,1000),reporterRole:safeText(body.reporterRole,30)||"Resident",clientReportId:safeText(body.clientReportId,100)||randomUUID(),source:body.source==="OFFLINE_SYNC"?"OFFLINE_SYNC":"WEB"}};
}
async function handle(req,res) {
  const url = new URL(req.url, "http://localhost");
  if (req.method === "OPTIONS") { res.writeHead(204, {"Access-Control-Allow-Methods":"GET,POST,OPTIONS","Access-Control-Allow-Headers":"Content-Type"}); return res.end(); }
  if (url.pathname.startsWith("/api/")) {
    if (req.method === "GET" && url.pathname === "/api/health") {
      return json(res,200,{status:"ONLINE",service:"LANDSAFE AI Operational Decision Hub",uptimeSeconds:Math.floor(process.uptime()),timestamp:new Date().toISOString(),activeMonitoredSectors:4,upstreamProvider:"SIMULATED / prototype data",storage:"JSON file persistence (ephemeral unless DATA_DIR is persistent)",mode:"DEMO",riskModel:"ILLUSTRATIVE_NOT_VALIDATED"});
    }
    if (req.method === "GET" && url.pathname === "/api/risk/model") {
      return json(res,200,{weights:WEIGHTS,factors:FACTORS,thresholds:{SAFE:"0–29",WATCH:"30–49",HIGH:"50–74",EVACUATE:"75–100"},calibration:"Illustrative demo anchors; not an official operational forecast model."});
    }
    if (req.method === "GET" && url.pathname === "/api/dashboard") {
      return json(res,200,{incidents:state.incidents.slice(0,30),alerts:state.alerts.slice(0,20),recentRisk:state.recentRisk,incidentCount:state.incidents.length,alertCount:state.alerts.length});
    }
    if (req.method === "POST" && url.pathname === "/api/risk/evaluate") {
      const body = await readJson(req);
      try {
        const result = evaluateRisk(body);
        state.recentRisk = result;
        if (result.score >= 75) {
          state.alerts.unshift({id:"ALT-"+Date.now(),sector:safeText(body.sector,180)||"Unspecified sector",score:result.score,category:result.category,status:"SIMULATED",createdAt:new Date().toISOString(),message:result.guidance});
          state.alerts = state.alerts.slice(0,100);
        }
        await persist();
        return json(res,200,result);
      } catch (e) { return json(res,400,{error:e.message}); }
    }
    if (req.method === "POST" && url.pathname === "/api/demo/scenario") {
      const body = await readJson(req);
      const name = safeText(body.scenario,30).toUpperCase();
      const scenario = DEMO_SCENARIOS[name];
      if (!scenario) return json(res,400,{error:"scenario must be HIGH_RISK or SAFE"});
      const result = evaluateRisk({...scenario.values,simulated:true});
      result.sector = scenario.sector;
      result.scenario = name;
      state.recentRisk = result;
      if (name === "HIGH_RISK") {
        state.alerts.unshift({id:"ALT-"+randomUUID().slice(0,8),sector:scenario.sector,score:result.score,category:result.category,status:"SIMULATED",createdAt:new Date().toISOString(),message:result.guidance});
        state.alerts = state.alerts.slice(0,100);
      }
      await persist();
      return json(res,200,{scenario:name,risk:result,alerts:state.alerts.slice(0,20)});
    }
    if (req.method === "GET" && url.pathname === "/api/incidents") return json(res,200,{incidents:state.incidents});
    if (req.method === "POST" && (url.pathname === "/api/incidents" || url.pathname === "/api/incidents/sync")) {
      const body = await readJson(req);
      const checked = validIncident(body);
      if (checked.error) return json(res,400,{error:checked.error});
      const duplicate = state.incidents.find(i => i.clientReportId === checked.value.clientReportId);
      if (duplicate) return json(res,200,{success:true,status:"ALREADY_PERSISTED",incident:duplicate});
      const incident = {id:"INC-"+randomUUID().slice(0,8).toUpperCase(),...checked.value,createdAt:new Date().toISOString(),status:"RECEIVED"};
      state.incidents.unshift(incident);
      state.incidents = state.incidents.slice(0,1000);
      await persist();
      return json(res,201,{success:true,status:"PERSISTED",incident});
    }
    if (req.method === "GET" && url.pathname === "/api/alerts") return json(res,200,{alerts:state.alerts});
    return json(res,404,{error:"API route not found"});
  }
  const requested = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname).replace(/^\/+/, "");
  const file = path.resolve(PUBLIC, requested);
  if (!file.startsWith(PUBLIC + path.sep) && file !== path.join(PUBLIC,"index.html")) return json(res,403,{error:"Forbidden"});
  try {
    const data = await readFile(file);
    const ext = path.extname(file);
    const types = {".html":"text/html; charset=utf-8",".css":"text/css; charset=utf-8",".js":"text/javascript; charset=utf-8",".svg":"image/svg+xml"};
    res.writeHead(200,{"Content-Type":types[ext]||"application/octet-stream","X-Content-Type-Options":"nosniff","Cache-Control":"no-cache"});
    res.end(data);
  } catch { json(res,404,{error:"File not found"}); }
}
export async function startServer() {
  await loadState();
  const server = http.createServer((req,res) => {
    handle(req,res).catch(err => {
      if (!res.headersSent) json(res,err.status||500,{error:err.status ? err.message : "Internal server error"});
      else res.end();
      if (!err.status) console.error(err);
    });
  });
  server.listen(PORT,"0.0.0.0",() => console.log(`LANDSAFE AI listening on port ${PORT}`));
  return server;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  startServer();
}
