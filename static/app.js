/* 
   app.js    Wealth Builder web frontend
   Talks to the Flask backend via JSON APIs.
   All live-fetch logic (bond rates, stock prices) runs on the
   server; this file only handles display and user interaction.
 */

"use strict";

//  State 
let STATE = {
  mode: "login",             // "login" | "register"
  username: null,
  entries: [],
  liveCache: {},             // ticker -> price
  filterYear: "All Years",
  filterMonth: "All Months",
  years: [],
  months: [],
  tickers: [],
  equityFunds: [],
  view: "dashboard",        // "dashboard" | "settings"
  theme: "dark",
};

//  Helpers 
function fmt(n) {
  return "\u20a6" + Math.round(n).toLocaleString("en-NG");
}

function el(id) { return document.getElementById(id); }

function show(id) { el(id).classList.remove("hidden"); }
function hide(id) { el(id).classList.add("hidden"); }

function showToast(msg, ms = 2400) {
  const t = el("toast");
  t.textContent = msg;
  t.classList.add("show");
  setTimeout(() => t.classList.remove("show"), ms);
}

function showConfirm(msg, onYes) {
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.innerHTML = `
    <div class="modal-box">
      <p>${msg}</p>
      <div class="modal-btns">
        <button class="modal-btn-cancel">Cancel</button>
        <button class="modal-btn-confirm">Delete</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  overlay.querySelector(".modal-btn-cancel").onclick = () => overlay.remove();
  overlay.querySelector(".modal-btn-confirm").onclick = () => {
    overlay.remove();
    onYes();
  };
}

async function api(path, method = "GET", body = null) {
  const opts = {
    method,
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
  };
  if (body !== null) opts.body = JSON.stringify(body);
  const res = await fetch(path, opts);
  const json = await res.json();
  return { ok: res.ok, status: res.status, data: json };
}

//  Boot 
async function boot() {
  // Load constants (years, months, tickers, funds) in parallel with /me
  const [meRes, constRes] = await Promise.all([
    api("/api/me"),
    api("/api/constants"),
  ]);

  if (constRes.ok) {
    STATE.years      = constRes.data.years;
    STATE.months     = constRes.data.months;
    STATE.tickers    = constRes.data.tickers;
    STATE.equityFunds = constRes.data.equity_funds;
    populateBaseSelects();
  }

  if (meRes.ok && meRes.data.username) {
    STATE.username = meRes.data.username;
    await loadAndShowDashboard();
  } else {
    show("login-screen");
  }
}

function populateBaseSelects() {
  // Form year / month
  const fy = el("f-year");
  fy.innerHTML = '<option value="">Year</option>';
  STATE.years.forEach(y => {
    const o = document.createElement("option");
    o.value = o.textContent = y;
    fy.appendChild(o);
  });

  const fm = el("f-month");
  fm.innerHTML = '<option value="">Month</option>';
  STATE.months.forEach(m => {
    const o = document.createElement("option");
    o.value = o.textContent = m;
    fm.appendChild(o);
  });

  // Filter year / month
  const fiy = el("filter-year");
  fiy.innerHTML = '<option value="All Years">All Years</option>';
  STATE.years.forEach(y => {
    const o = document.createElement("option");
    o.value = o.textContent = y;
    fiy.appendChild(o);
  });

  const fim = el("filter-month");
  fim.innerHTML = '<option value="All Months">All Months</option>';
  STATE.months.forEach(m => {
    const o = document.createElement("option");
    o.value = o.textContent = m;
    fim.appendChild(o);
  });
}

//  Login / Register 
function switchMode(mode) {
  STATE.mode = mode;
  el("tab-login").classList.toggle("active", mode === "login");
  el("tab-register").classList.toggle("active", mode === "register");
  el("confirm-label").classList.toggle("hidden", mode !== "register");
  el("login-confirm").classList.toggle("hidden", mode !== "register");
  el("login-submit-btn").textContent = mode === "login" ? "Login" : "Create Account";
  el("login-error").textContent = "";
}

async function submitLogin() {
  const username = el("login-username").value.trim();
  const password = el("login-password").value.trim();
  const confirm  = el("login-confirm").value.trim();
  const errEl    = el("login-error");
  errEl.textContent = "";

  if (!username) { errEl.textContent = "Please enter a username."; return; }
  if (!password) { errEl.textContent = "Please enter a password."; return; }
  if (password.length < 4) { errEl.textContent = "Password must be at least 4 characters."; return; }

  if (STATE.mode === "register") {
    if (password !== confirm) { errEl.textContent = "Passwords do not match."; return; }
    const r = await api("/api/register", "POST", { username, password });
    if (!r.ok) { errEl.textContent = r.data.error; return; }
    STATE.username = r.data.username;
  } else {
    const r = await api("/api/login", "POST", { username, password });
    if (!r.ok) { errEl.textContent = r.data.error; return; }
    STATE.username = r.data.username;
  }

  hide("login-screen");
  await loadAndShowDashboard();
}

// Enter key on login
document.addEventListener("keydown", e => {
  if (e.key === "Enter" && !el("login-screen").classList.contains("hidden")) {
    submitLogin();
  }
});

//  Load + show dashboard 
async function loadAndShowDashboard() {
  const r = await api("/api/entries");
  STATE.entries = r.ok ? r.data : [];

  el("topbar-username").textContent = STATE.username;
  show("app-screen");

  hide("settings-view");
  show("dashboard-view");
  STATE.view = "dashboard";
  el("settings-btn").classList.remove("active");

  renderAll();
  kickoffLivePrices();

  // Auto-refresh prices every 5 minutes
  setInterval(() => {
    STATE.liveCache = {};
    kickoffLivePrices();
  }, 5 * 60 * 1000);
}

//  Logout 
function logout() {
  showConfirm("Are you sure you want to logout?", async () => {
    await api("/api/logout", "POST");
    STATE.username = null;
    STATE.entries = [];
    STATE.liveCache = {};
    hide("app-screen");
    show("login-screen");
    el("login-username").value = "";
    el("login-password").value = "";
    el("login-confirm").value  = "";
    switchMode("login");
  });
}

//  Theme toggle 
function toggleTheme() {
  STATE.theme = STATE.theme === "dark" ? "light" : "dark";
  document.body.setAttribute("data-theme", STATE.theme);
  el("theme-btn").textContent = STATE.theme === "dark" ? " Light" : " Dark";
}

//  Settings 
async function openSettings() {
  const isOpen = STATE.view === "settings";

  if (isOpen) {
    STATE.view = "dashboard";
    hide("settings-view");
    show("dashboard-view");
    el("settings-btn").classList.remove("active");
    return;
  }

  STATE.view = "settings";
  hide("dashboard-view");
  show("settings-view");
  el("settings-btn").classList.add("active");

  // Load profile
  const r = await api("/api/profile");
  if (r.ok) {
    el("set-name").value  = r.data.display || STATE.username;
    el("set-email").value = r.data.email || "";
  }

  // Load bond history
  const hr = await api("/api/bond-history");
  renderBondHistory(hr.ok ? hr.data : []);
}

async function saveProfile() {
  const display = el("set-name").value.trim();
  const email   = el("set-email").value.trim();
  const msgEl   = el("profile-msg");
  msgEl.className = "settings-msg";

  if (!display) { msgEl.className += " err"; msgEl.textContent = "Name cannot be empty."; return; }

  const r = await api("/api/profile", "POST", { display, email });
  if (r.ok) {
    STATE.username = r.data.username;
    el("topbar-username").textContent = STATE.username;
    msgEl.className += " ok";
    msgEl.textContent = " Profile saved.";
  } else {
    msgEl.className += " err";
    msgEl.textContent = r.data.error;
  }
}

async function updatePassword() {
  const old     = el("set-old-pw").value.trim();
  const newPw   = el("set-new-pw").value.trim();
  const confirm = el("set-confirm-pw").value.trim();
  const msgEl   = el("pw-msg");
  msgEl.className = "settings-msg";

  if (!old || !newPw || !confirm) { msgEl.className += " err"; msgEl.textContent = "Please fill in all fields."; return; }
  if (newPw.length < 4) { msgEl.className += " err"; msgEl.textContent = "New password must be at least 4 characters."; return; }
  if (newPw !== confirm) { msgEl.className += " err"; msgEl.textContent = "Passwords do not match."; return; }

  const r = await api("/api/update-password", "POST", { old, new: newPw });
  if (r.ok) {
    msgEl.className += " ok";
    msgEl.textContent = " Password updated.";
    el("set-old-pw").value = el("set-new-pw").value = el("set-confirm-pw").value = "";
  } else {
    msgEl.className += " err";
    msgEl.textContent = r.data.error;
  }
}

function renderBondHistory(rows) {
  const c = el("bond-history");
  if (!rows.length) {
    c.innerHTML = '<div class="log-empty">No rates saved yet. Fetch a bond rate and it will appear here.</div>';
    return;
  }
  const tenorLabel = { "3yr": "3-Year", "2yr": "2-Year" };
  c.innerHTML = rows.map(r => `
    <div class="bond-history-row">
      <span>${r.month} ${r.year}  ${tenorLabel[r.tenor] || r.tenor}</span>
      <span class="bond-history-rate">${r.rate.toFixed(3)}% p.a.</span>
    </div>`).join("");
}

//  Form: investment type change 
function onTypeChange() {
  const type = el("f-type").value;
  const container = el("extra-fields");
  container.innerHTML = "";
  el("live-status").textContent = "";
  window._fetchedBondRate = null;

  if (type === "bond" || type === "bond2") {
    buildBondFields(container, type);
  } else if (type === "equity") {
    buildEquityFields(container);
  } else if (type === "stock") {
    buildStockFields(container);
  }
}

//  Bond extra fields 
function buildBondFields(container) {
  container.innerHTML = `
    <div class="bond-rate-display" id="bond-rate-label">Bond Rate % p.a.  click button to fetch</div>
    <div class="bond-rate-value" id="bond-rate-val"></div>
    <button class="btn-fetch" onclick="fetchBondRate()">  Fetch Latest Bond Rate</button>
    <div class="manual-rate-hint">Or type the rate yourself (from dmo.gov.ng):</div>
    <div class="manual-rate-row">
      <input type="number" id="manual-rate" placeholder="e.g. 14.777" step="0.001" oninput="onManualRate()">
      <span style="color:var(--muted);font-size:12px;">% p.a.</span>
    </div>`;
}

function onManualRate() {
  const val = parseFloat(el("manual-rate").value);
  if (!isNaN(val) && val > 0) {
    window._fetchedBondRate = val;
    el("bond-rate-label").textContent = "Using manually entered rate";
    el("bond-rate-val").textContent   = val.toFixed(3) + "% p.a.";
    el("bond-rate-val").style.color   = "var(--accent)";
  }
}

async function fetchBondRate() {
  const year  = el("f-year").value;
  const month = el("f-month").value;
  const type  = el("f-type").value;
  const tenor = type === "bond2" ? "2yr" : "3yr";

  if (!year || !month) {
    showToast("Please select Year and Month first, then tap Fetch.");
    return;
  }

  el("bond-rate-label").textContent = `Fetching live rate for ${month} ${year}`;
  el("bond-rate-val").textContent   = "";
  el("live-status").textContent     = "Searching";

  const r = await api("/api/fetch-bond-rate", "POST", { tenor, month, year });
  const d = r.data;

  if (d.rate !== null && d.rate !== undefined) {
    window._fetchedBondRate = d.rate;
    const tenor_label = tenor === "3yr" ? "3-Year" : "2-Year";
    el("bond-rate-label").textContent = `FGN Bond ${tenor_label} Rate  ${month} ${year}`;
    el("bond-rate-val").textContent   = d.rate.toFixed(3) + "% p.a.";
    el("bond-rate-val").style.color   = "var(--accent)";
    el("live-status").textContent     = " Rate loaded";
    el("live-status").style.color     = "var(--green)";
    // Mirror into manual input box so it's visible and editable
    if (el("manual-rate")) el("manual-rate").value = d.rate.toFixed(3);
  } else if (d.not_published) {
    el("bond-rate-label").textContent = "Rate not available yet";
    el("bond-rate-val").textContent   = "";
    el("live-status").textContent     = " " + d.message;
    el("live-status").style.color     = "var(--amber)";
  } else {
    el("bond-rate-label").textContent = "Could not fetch rate";
    el("bond-rate-val").textContent   = "";
    el("live-status").textContent     = " " + d.message;
    el("live-status").style.color     = "var(--red)";
  }
}

//  Equity extra fields 
function buildEquityFields(container) {
  const opts = STATE.equityFunds.map(f =>
    `<option value="${f}">${f}</option>`).join("");
  container.innerHTML = `
    <div style="margin-bottom:10px;">
      <label class="field-label">Equity Fund *</label>
      <select id="f-fund"><option value="">Select a fund</option>${opts}</select>
    </div>
    <div class="form-row cols-2">
      <div>
        <label class="field-label">Units Purchased *</label>
        <input type="number" id="f-eq-units" placeholder="e.g. 100">
      </div>
      <div>
        <label class="field-label">Cost per Unit () *</label>
        <input type="number" id="f-eq-cost" placeholder="e.g. 500">
      </div>
    </div>`;
}

//  Stock extra fields 
function buildStockFields(container) {
  container.innerHTML = `
    <div style="margin-bottom:10px;">
      <label class="field-label">Stock Ticker * (type to search)</label>
      <div class="autocomplete-wrap">
        <input type="text" id="f-ticker" placeholder="e.g. MTNN, GTCO"
          oninput="filterTickers()" onblur="setTimeout(hideTickerList,180)"
          autocomplete="off" style="text-transform:uppercase;">
        <div class="autocomplete-list hidden" id="ticker-list"></div>
      </div>
    </div>
    <div class="form-row cols-2" style="margin-bottom:8px;">
      <div>
        <label class="field-label">Units / Shares *</label>
        <input type="number" id="f-st-units" placeholder="e.g. 1000">
      </div>
      <div>
        <label class="field-label">Cost per Share () *</label>
        <input type="number" id="f-st-cost" placeholder="e.g. 800">
      </div>
    </div>
    <div style="display:flex;gap:8px;align-items:center;margin-bottom:4px;">
      <button class="btn-fetch" onclick="fetchCurrentPrice()"> Fetch Current Price</button>
      <span id="stock-price-status" class="live-status"></span>
    </div>`;
}

function filterTickers() {
  const input = el("f-ticker");
  const typed = input.value.toUpperCase().trim();
  const list  = el("ticker-list");

  if (!typed) { list.classList.add("hidden"); return; }

  const matches = STATE.tickers.filter(t => t.startsWith(typed)).slice(0, 12);
  if (!matches.length) { list.classList.add("hidden"); return; }

  list.innerHTML = matches.map(t =>
    `<div onmousedown="selectTicker('${t}')">${t}</div>`).join("");
  list.classList.remove("hidden");
}

function selectTicker(ticker) {
  const input = el("f-ticker");
  if (input) input.value = ticker;
  hideTickerList();
}

function hideTickerList() {
  const list = el("ticker-list");
  if (list) list.classList.add("hidden");
}

async function fetchCurrentPrice() {
  const tickerInput = el("f-ticker");
  if (!tickerInput) return;
  const ticker = tickerInput.value.trim().toUpperCase();
  if (!ticker) { showToast("Please enter a stock ticker first."); return; }

  const statusEl = el("stock-price-status");
  statusEl.textContent = `Fetching ${ticker} price`;
  statusEl.style.color = "var(--amber)";

  const r = await api("/api/fetch-stock-price", "POST", { ticker });
  const d = r.data;

  if (d.price !== null && d.price !== undefined) {
    tickerInput.value = d.ticker; // apply auto-correction (e.g. VFD -> VFDGROUP)
    const costInput = el("f-st-cost");
    if (costInput) costInput.value = d.price.toFixed(2);
    STATE.liveCache[d.ticker] = d.price;
    statusEl.textContent = ` ${d.ticker}: ${fmt(d.price)} (${d.source})`;
    statusEl.style.color = "var(--green)";
  } else {
    statusEl.textContent = " " + (d.message || "Could not fetch price.");
    statusEl.style.color = "var(--red)";
  }
}

//  Add entry 
async function addEntry() {
  const year   = el("f-year").value;
  const month  = el("f-month").value;
  const type   = el("f-type").value;
  const amount = el("f-amount").value;
  const status = el("live-status");

  status.textContent = "";
  status.style.color = "var(--muted)";

  if (!year)   { status.textContent = "Please select a year.";   status.style.color = "var(--red)"; return; }
  if (!month)  { status.textContent = "Please select a month.";  status.style.color = "var(--red)"; return; }
  if (!type)   { status.textContent = "Please select an investment type."; status.style.color = "var(--red)"; return; }
  if (!amount || parseFloat(amount) <= 0) { status.textContent = "Please enter a valid amount > 0."; status.style.color = "var(--red)"; return; }

  const body = { year, month, type, amount: parseFloat(amount) };

  if (type === "bond" || type === "bond2") {
    if (!window._fetchedBondRate) {
      status.textContent = "Please fetch the bond rate, or type it in, before saving.";
      status.style.color = "var(--red)";
      return;
    }
    body.rate = window._fetchedBondRate;
  }

  if (type === "equity") {
    const fund  = el("f-fund") ? el("f-fund").value : "";
    const units = el("f-eq-units") ? el("f-eq-units").value : "";
    const cost  = el("f-eq-cost") ? el("f-eq-cost").value : "";
    if (!fund)  { status.textContent = "Please select an equity fund."; status.style.color = "var(--red)"; return; }
    if (!units) { status.textContent = "Please enter units purchased."; status.style.color = "var(--red)"; return; }
    if (!cost)  { status.textContent = "Please enter cost per unit.";   status.style.color = "var(--red)"; return; }
    body.fund = fund;
    body.units = parseFloat(units);
    body.cost_per_unit = parseFloat(cost);
  }

  if (type === "stock") {
    const ticker = el("f-ticker") ? el("f-ticker").value.trim().toUpperCase() : "";
    const units  = el("f-st-units") ? el("f-st-units").value : "";
    const cost   = el("f-st-cost") ? el("f-st-cost").value : "";
    if (!ticker) { status.textContent = "Please enter a stock ticker.";   status.style.color = "var(--red)"; return; }
    if (!units)  { status.textContent = "Please enter number of units.";  status.style.color = "var(--red)"; return; }
    if (!cost)   { status.textContent = "Cost per share is required.";    status.style.color = "var(--red)"; return; }
    body.ticker = ticker;
    body.units  = parseFloat(units);
    body.cost_price = parseFloat(cost);
  }

  const r = await api("/api/entries", "POST", body);
  if (!r.ok) {
    status.textContent = r.data.error;
    status.style.color = "var(--red)";
    return;
  }

  STATE.entries.push(r.data);
  clearForm();
  renderAll();
  showToast("Entry saved!");
}

function clearForm() {
  el("f-year").value = "";
  el("f-month").value = "";
  el("f-type").value = "";
  el("f-amount").value = "";
  el("extra-fields").innerHTML = "";
  el("live-status").textContent = "";
  window._fetchedBondRate = null;
}

//  Delete entry 
function deleteEntry(id) {
  showConfirm("Remove this entry?", async () => {
    const r = await api(`/api/entries/${id}`, "DELETE");
    if (r.ok) {
      STATE.entries = STATE.entries.filter(e => e.id !== id);
      renderAll();
      showToast("Entry deleted.");
    }
  });
}

//  Live price fetching 
async function kickoffLivePrices() {
  const tickers = [...new Set(
    STATE.entries
      .filter(e => e.type === "stock" && e.ticker)
      .map(e => e.ticker.toUpperCase())
      .filter(t => !(t in STATE.liveCache))
  )];

  if (!tickers.length) return;

  const r = await api("/api/fetch-stock-prices-bulk", "POST", { tickers });
  if (r.ok) {
    Object.entries(r.data).forEach(([ticker, price]) => {
      if (price !== null) STATE.liveCache[ticker] = price;
    });
    renderLog();
    renderYearEnd();
  }
}

async function refreshAllPrices() {
  STATE.liveCache = {};
  await kickoffLivePrices();
  showToast("Prices refreshed.");
}

//  Render all 
function renderAll() {
  renderMetrics();
  renderLog();
  renderYearEnd();
}

function renderMetrics() {
  const bt = STATE.entries.filter(e => e.type === "bond" || e.type === "bond2").reduce((s,e) => s + e.amount, 0);
  const et = STATE.entries.filter(e => e.type === "equity").reduce((s,e) => s + e.amount, 0);
  const st = STATE.entries.filter(e => e.type === "stock").reduce((s,e) => s + e.amount, 0);
  el("m-total").textContent = fmt(bt + et + st);
  el("m-bond").textContent  = fmt(bt);
  el("m-equity").textContent = fmt(et);
  el("m-stock").textContent = fmt(st);
}

//  Log 
function renderLog() {
  const fy = el("filter-year").value;
  const fm = el("filter-month").value;
  STATE.filterYear  = fy;
  STATE.filterMonth = fm;

  let filtered = STATE.entries.filter(e =>
    (fy === "All Years"  || e.year  === fy) &&
    (fm === "All Months" || e.month === fm));

  const monthIdx = m => STATE.months.indexOf(m);
  const yearIdx  = y => STATE.years.indexOf(y);

  filtered = filtered.sort((a, b) => {
    const yd = yearIdx(a.year)  - yearIdx(b.year);
    if (yd !== 0) return yd;
    return monthIdx(a.month) - monthIdx(b.month);
  });

  const c = el("log-container");

  if (!filtered.length) {
    c.innerHTML = '<div class="log-empty">No entries for this period yet.</div>';
    return;
  }

  const COLS = {
    bond:   "var(--green)",
    bond2:  "var(--green)",
    equity: "var(--blue)",
    stock:  "var(--amber)",
  };

  c.innerHTML = filtered.map((e, i) => {
    const col    = COLS[e.type] || "var(--green)";
    const header = `${e.month} ${e.year}`;
    const oddEven = i % 2 === 0 ? "" : "odd";
    const body   = buildEntryBody(e, col);
    return `
      <div class="entry-row ${oddEven}">
        <div class="entry-accent" style="background:${col}"></div>
        <div class="entry-card">${body}</div>
        <button class="entry-delete" onclick="deleteEntry(${e.id})" title="Delete"></button>
      </div>`;
  }).join("");
}

function buildEntryBody(e, col) {
  const header = `${e.month} ${e.year}`;

  if (e.type === "bond" || e.type === "bond2") {
    const tenor = e.type === "bond" ? "FGN Bond 3yrs" : "FGN Bond 2yrs";
    const rate  = e.rate != null ? `${e.rate.toFixed(3)}% p.a.` : "";
    return `
      <div class="entry-line header">
        <span>${header}</span>
        <span style="color:${col}">${fmt(e.amount)}</span>
      </div>
      <div class="entry-divider"></div>
      <div class="entry-line sub">
        <span>${tenor}</span>
        <span style="color:${col};font-weight:700">${rate}</span>
      </div>`;
  }

  if (e.type === "stock") {
    const ticker   = e.ticker || "";
    const units    = e.units  || "";
    const cost     = e.cost_price || 0;
    const live     = STATE.liveCache[ticker.toUpperCase()] ?? null;
    let plHtml     = "";
    let totalHtml  = fmt(e.amount);

    if (live !== null && cost && units) {
      const totalVal = live * units;
      const pl       = totalVal - (cost * units);
      const plCol    = pl >= 0 ? "var(--green)" : "var(--red)";
      const plSign   = pl >= 0 ? "+" : "";
      plHtml = `
        <div class="entry-line sub">
          <span style="color:${plCol};font-weight:700">Profit/Loss (${plSign}${fmt(Math.abs(pl))})</span>
          <span style="color:${plCol};font-weight:700">${fmt(totalVal)}</span>
        </div>`;
      totalHtml = fmt(totalVal);
    } else if (live === null) {
      plHtml = `<div class="entry-line sub"><span style="color:var(--muted);font-style:italic"> Fetching live price</span></div>`;
    }

    return `
      <div class="entry-line header">
        <span>${header}</span>
        <span style="color:${col}">${fmt(e.amount)}</span>
      </div>
      <div class="entry-divider"></div>
      <div class="entry-line sub">
        <span>Stock (${ticker})</span>
        <span>${units} units</span>
      </div>
      ${cost ? `<div class="entry-line sub">
        <span>Cost: ${fmt(cost)}/share</span>
        ${live !== null ? `<span>Now: ${fmt(live)}/share</span>` : ""}
      </div>` : ""}
      ${plHtml}`;
  }

  if (e.type === "equity") {
    const fund    = e.fund || "Equity Fund";
    const units   = e.units || "";
    const cost    = e.cost_per_unit || 0;
    return `
      <div class="entry-line header">
        <span>${header}</span>
        <span style="color:${col}">${fmt(e.amount)}</span>
      </div>
      <div class="entry-divider"></div>
      <div class="entry-line sub">
        <span>${fund}</span>
        <span>${units} units</span>
      </div>
      ${cost ? `<div class="entry-line sub"><span>Cost: ${fmt(cost)}/unit</span></div>` : ""}`;
  }

  return `<div class="entry-line header"><span>${header}</span><span>${fmt(e.amount)}</span></div>`;
}

//  Year-end summary 
function renderYearEnd() {
  const total  = STATE.entries.reduce((s,e) => s + e.amount, 0);
  const bt     = STATE.entries.filter(e => e.type === "bond" || e.type === "bond2").reduce((s,e) => s + e.amount, 0);
  const months = new Set(STATE.entries.map(e => `${e.year}-${e.month}`));
  const largest = STATE.entries.reduce((best,e) => e.amount > (best?.amount||0) ? e : best, null);

  el("ye-total").textContent = fmt(total);
  el("ye-sub").textContent   = `${months.size} month${months.size !== 1 ? "s" : ""} logged`;
  el("ye-bond").textContent  = total > 0 ? Math.round((bt/total)*100) + "%" : "0%";
  el("ye-large").textContent = largest ? fmt(largest.amount) : "0";

  // Profit/loss across all stocks with live prices
  let pl = 0, plCount = 0;
  STATE.entries.filter(e => e.type === "stock" && e.ticker).forEach(e => {
    const live = STATE.liveCache[e.ticker.toUpperCase()];
    if (live !== null && live !== undefined && e.cost_price && e.units) {
      pl += (live - e.cost_price) * e.units;
      plCount++;
    }
  });

  const plEl  = el("ye-pl");
  const plSub = el("ye-pl-sub");
  if (plCount > 0) {
    const sign  = pl >= 0 ? "+" : "";
    plEl.textContent   = sign + fmt(Math.abs(pl));
    plEl.style.color   = pl >= 0 ? "var(--green)" : "var(--red)";
    plSub.textContent  = `${plCount} stock position${plCount !== 1 ? "s" : ""} tracked`;
  } else {
    plEl.textContent   = "0";
    plEl.style.color   = "var(--muted)";
    plSub.textContent  = "No live stock prices yet";
  }
}

//  Init 
window._fetchedBondRate = null;
boot();
