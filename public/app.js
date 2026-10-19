const $ = (selector) => document.querySelector(selector);
const OFFLINE_KEY = "landsafe_offline_incidents_queue";
const FACTOR_META = [
  ["rain24","24h rainfall","mm",0.35],["rain72","72h antecedent rainfall","mm",0.25],
  ["soilMoisture","Soil moisture","%",0.20],["slope","Slope","°",0.15],["pga","Ground acceleration","g",0.05]
];
let lastRisk = null;
let toastTimer;
function escapeHtml(value) { return String(value ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c])); }
function getQueue() { try { return JSON.parse(localStorage.getItem(OFFLINE_KEY) || "[]"); } catch { return []; } }
function setQueue(queue) { localStorage.setItem(OFFLINE_KEY, JSON.stringify(queue)); updateOfflineBanner(); }
function updateOfflineBanner() {
  const offline = !navigator.onLine;
  const count = getQueue().length;
  $("#offline-banner").hidden = !offline && count === 0;
  $("#pending-count").textContent = count + " pending report" + (count === 1 ? "" : "s");
  $("#connection-label").textContent = offline ? "Offline mode" : "Connected";
  $("#connection-detail").textContent = count ? count + " report(s) waiting to sync" : (offline ? "Reports are saved locally" : "API connection available");
  $("#footer-status").textContent = offline ? "Offline" : "Online";
  $("#footer-time").textContent = new Date().toLocaleTimeString([], {hour:"2-digit",minute:"2-digit"});
}
function toast(message) {
  const node = $("#toast"); node.textContent = message; node.classList.add("show");
  clearTimeout(toastTimer); toastTimer = setTimeout(() => node.classList.remove("show"), 3200);
}
async function api(url, options={}) {
  const response = await fetch(url, { ...options, headers:{"Content-Type":"application/json",...(options.headers||{})} });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Request failed ("+response.status+")");
  return data;
}
function riskClass(category) { return ({SAFE:"safe",WATCH:"watch",HIGH:"high",EVACUATE:"evacuate"})[category] || "neutral"; }
function renderRisk(risk) {
  if (!risk) return;
  lastRisk = risk;
  $("#metric-risk").innerHTML = escapeHtml(risk.score) + "<small>/100</small>";
  $("#metric-risk-tag").className = "tag " + riskClass(risk.category);
  $("#metric-risk-tag").textContent = risk.category;
  $("#score-number").textContent = risk.score;
  const deg = Math.round(risk.score * 3.6);
  const color = risk.score >= 75 ? "#ff6b7c" : risk.score >= 50 ? "#ffad66" : risk.score >= 30 ? "#f6d278" : "#42d6a0";
  $("#score-ring").style.background = "conic-gradient("+color+" "+deg+"deg,#1c3348 "+deg+"deg)";
  $("#risk-category").className = "tag " + riskClass(risk.category);
  $("#risk-category").textContent = risk.category;
  $("#risk-sector").textContent = risk.sector || (risk.scenario === "SAFE" ? "Gangtok Lower Ridge, Sikkim" : "Risk evaluation");
  $("#risk-guidance").textContent = risk.guidance || "Review field conditions and confirm observations.";
  $("#risk-provenance").textContent = "Data provenance: " + (risk.dataStatus || "SIMULATED") + (risk.stalePenalty ? " · +" + risk.stalePenalty + " uncertainty penalty" : "");
  const factors = FACTOR_META.map(([key,label,unit,weight]) => {
    const value = risk.values?.[key];
    const norm = risk.normalizedFactors?.[key];
    const contribution = risk.contributions?.[key] || 0;
    const width = norm == null ? 0 : Math.max(0,Math.min(100,norm));
    return '<div class="factor-item"><div class="factor-head"><span>'+label+'</span><b>'+(value == null ? "Missing" : escapeHtml(value)+" "+unit)+'</b></div><div class="factor-track"><div class="factor-fill" style="width:'+width+'%"></div></div><div class="factor-foot"><span>'+(norm == null ? "No telemetry" : "Normalized "+norm+"/100 · weight "+Math.round(weight*100)+"%")+'</span><b>'+(value == null ? "—" : "+"+Number(contribution).toFixed(1)+" pts")+'</b></div></div>';
  }).join("");
  $("#factor-list").innerHTML = factors;
  $("#map-updated").textContent = risk.scenario ? "Updated by demo" : "Updated just now";
}
function renderIncidents(incidents) {
  $("#metric-incidents").textContent = incidents.length;
  $("#incident-nav-count").textContent = incidents.length;
  $("#incident-foot").textContent = incidents.length + " report(s) stored";
  if (!incidents.length) { $("#incident-table").innerHTML = '<tr><td colspan="4" class="empty-state">No reports yet. Submit a demo incident.</td></tr>'; return; }
  $("#incident-table").innerHTML = incidents.slice(0,8).map(item => '<tr><td>'+escapeHtml(item.incidentType)+'</td><td>'+escapeHtml(item.sector)+'</td><td><span class="severity '+escapeHtml(item.visualSeverity.toLowerCase())+'">'+escapeHtml(item.visualSeverity)+'</span></td><td><span class="status-received">● '+escapeHtml(item.status)+'</span></td></tr>').join("");
}
function renderAlerts(alerts) {
  $("#metric-alerts").textContent = alerts.length;
  if (!alerts.length) { $("#alert-list").innerHTML = '<div class="empty-state">No alerts yet. Run the high-risk scenario.</div>'; return; }
  $("#alert-list").innerHTML = alerts.slice(0,6).map(a => '<div class="alert-item"><div class="alert-icon">♢</div><div class="alert-content"><b>'+escapeHtml(a.category)+' · '+escapeHtml(a.sector)+'</b><p>'+escapeHtml(a.message || "Risk threshold reached in demo.")+'</p><small>'+new Date(a.createdAt).toLocaleString()+' · '+escapeHtml(a.status)+'</small></div><div class="alert-score">'+escapeHtml(a.score)+'</div></div>').join("");
}
async function refreshDashboard() {
  try {
    const [health,dashboard] = await Promise.all([api("/api/health"),api("/api/dashboard")]);
    $("#connection-label").textContent = "Service online";
    $("#connection-detail").textContent = health.uptimeSeconds + "s uptime · prototype";
    $("#mode-label").textContent = health.mode || "DEMO MODE";
    $("#footer-status").textContent = health.status;
    renderIncidents(dashboard.incidents || []);
    renderAlerts(dashboard.alerts || []);
    if (dashboard.recentRisk) renderRisk(dashboard.recentRisk);
  } catch (err) {
    $("#connection-label").textContent = navigator.onLine ? "API unavailable" : "Offline mode";
    $("#connection-detail").textContent = "Reports can be queued locally";
  }
  updateOfflineBanner();
}
async function runScenario(scenario) {
  const button = scenario === "HIGH_RISK" ? $("#high-risk-btn") : $("#safe-btn");
  button.disabled = true;
  $("#scenario-status").textContent = "Evaluating scenario…";
  try {
    const data = await api("/api/demo/scenario",{method:"POST",body:JSON.stringify({scenario})});
    renderRisk(data.risk);
    renderAlerts(data.alerts || []);
    $("#metric-alerts").textContent = (data.alerts || []).length;
    $("#scenario-status").textContent = scenario + " complete · score " + data.risk.score + "/100 · " + data.risk.category;
    toast(scenario === "HIGH_RISK" ? "High-risk demo evaluated and alert recorded." : "Safe scenario evaluated. No new alert generated.");
  } catch (err) {
    $("#scenario-status").textContent = "Scenario failed: " + err.message;
    toast(err.message);
  } finally { button.disabled = false; }
}
async function submitIncident(payload) {
  if (!navigator.onLine) throw new Error("offline");
  return api("/api/incidents/sync",{method:"POST",body:JSON.stringify(payload)});
}
async function syncQueue() {
  if (!navigator.onLine) return;
  const queue = getQueue();
  if (!queue.length) { updateOfflineBanner(); return; }
  const remaining = [];
  for (const item of queue) {
    try { await submitIncident({...item,source:"OFFLINE_SYNC"}); }
    catch { remaining.push(item); }
  }
  setQueue(remaining);
  if (queue.length !== remaining.length) {
    toast((queue.length-remaining.length)+" offline report(s) synchronized.");
    await refreshDashboard();
  }
}
function openDialog() {
  $("#form-message").textContent = "";
  if (typeof $("#incident-dialog").showModal === "function") $("#incident-dialog").showModal();
  else $("#incident-dialog").setAttribute("open","");
}
function closeDialog() { $("#incident-dialog").close?.(); $("#incident-dialog").removeAttribute("open"); }
$("#high-risk-btn").addEventListener("click", () => runScenario("HIGH_RISK"));
$("#safe-btn").addEventListener("click", () => runScenario("SAFE"));
$("#refresh-btn").addEventListener("click", () => refreshDashboard().then(() => syncQueue()));
$("#new-report-btn").addEventListener("click", openDialog);
$("#close-dialog").addEventListener("click", closeDialog);
$("#cancel-dialog").addEventListener("click", closeDialog);
$("#view-all-incidents").addEventListener("click", refreshDashboard);
$("#incident-form").addEventListener("submit", async event => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const payload = {
    sector:String(form.get("sector")||"").trim(),
    incidentType:String(form.get("incidentType")||"").trim(),
    visualSeverity:String(form.get("visualSeverity")||"MODERATE"),
    description:String(form.get("description")||"").trim(),
    reporterRole:"Community Warden",
    clientReportId:crypto.randomUUID()
  };
  if (!payload.sector || !payload.incidentType) { $("#form-message").textContent = "Please fill the required fields."; return; }
  try {
    if (!navigator.onLine) throw new Error("offline");
    const result = await submitIncident(payload);
    $("#form-message").textContent = "Report saved: " + result.status;
    toast("Incident report saved.");
    await refreshDashboard();
    setTimeout(closeDialog,500);
    event.currentTarget.reset();
  } catch (err) {
    if (err.message !== "offline" && navigator.onLine) {
      $("#form-message").textContent = err.message;
      return;
    }
    const queue = getQueue();
    queue.push(payload);
    setQueue(queue);
    $("#form-message").textContent = "Offline: report saved on this device and queued for synchronization.";
    toast("Report queued locally. It will sync when online.");
    event.currentTarget.reset();
  }
});
window.addEventListener("offline",updateOfflineBanner);
window.addEventListener("online",() => { updateOfflineBanner(); syncQueue(); refreshDashboard(); });
window.addEventListener("storage",updateOfflineBanner);
refreshDashboard().then(syncQueue);
