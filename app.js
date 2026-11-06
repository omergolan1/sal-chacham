"use strict";
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const ils = n => n == null || isNaN(n) || !isFinite(n) ? "—" : "₪" + Number(n).toFixed(2);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

/* Local server API – only exists when running on the home computer. */
let LOCAL = false;
async function api(path, body) {
  const opt = body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
  const r = await fetch("api/" + path, opt);
  if (!r.ok) throw new Error("שגיאת שרת " + r.status);
  return r.json();
}

function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove("show"), 2600);
}

/* ---------------- display preferences ---------------- */
const prefs = store.get("sal.prefs", { fs: 17, contrast: false, theme: null });
function applyPrefs() {
  const root = document.documentElement;
  root.style.setProperty("--fs", prefs.fs + "px");
  if (prefs.contrast) root.dataset.contrast = "high"; else delete root.dataset.contrast;
  if (prefs.theme) root.dataset.theme = prefs.theme; else delete root.dataset.theme;
  const dark = prefs.theme ? prefs.theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
  $("#themeBtn").setAttribute("aria-pressed", String(dark));
  $("#contrastBtn").setAttribute("aria-pressed", String(!!prefs.contrast));
  store.set("sal.prefs", prefs);
}
$("#fontUp").onclick = () => { prefs.fs = Math.min(26, prefs.fs + 2); applyPrefs(); toast("גודל טקסט: " + prefs.fs); };
$("#fontDown").onclick = () => { prefs.fs = Math.max(14, prefs.fs - 2); applyPrefs(); toast("גודל טקסט: " + prefs.fs); };
$("#contrastBtn").onclick = () => { prefs.contrast = !prefs.contrast; applyPrefs(); };
$("#themeBtn").onclick = () => {
  const dark = $("#themeBtn").getAttribute("aria-pressed") === "true";
  prefs.theme = dark ? "light" : "dark"; applyPrefs();
};
applyPrefs();

/* ---------------- tabs ---------------- */
function showView(name, focus = true) {
  $$(".tab").forEach(t => t.removeAttribute("aria-current"));
  $(`.tab[data-view="${name}"]`).setAttribute("aria-current", "page");
  $$(".view").forEach(v => v.hidden = v.id !== "view-" + name);
  if (name === "watch") renderWatch();
  if (name === "settings") renderSettings();
  if (focus) { const h = $(`#view-${name} h2:not([hidden])`) || $(`#view-${name} h2`); if (h) { h.tabIndex = -1; h.focus({ preventScroll: true }); } }
  history.replaceState(null, "", location.pathname + "#" + name);
}
$$(".tab").forEach(t => t.onclick = () => showView(t.dataset.view));
$(".tabs").addEventListener("keydown", e => {
  if (!["ArrowLeft", "ArrowRight"].includes(e.key)) return;
  const tabs = $$(".tab"), i = tabs.indexOf(document.activeElement);
  if (i < 0) return;
  const n = e.key === "ArrowLeft" ? (i + 1) % tabs.length : (i - 1 + tabs.length) % tabs.length; // RTL
  tabs[n].focus(); e.preventDefault();
});

/* ---------------- data ---------------- */
let DATA = null, HISTORY = null;
async function loadData() {
  try {
    const r = await fetch("data/prices.json", { cache: "no-cache" });
    if (!r.ok) throw new Error(r.status);
    DATA = await r.json();
    Engine.load(DATA);
    HISTORY = null;
    refreshBasketInfo();
    checkWatch();
  } catch { DATA = null; }
  renderHeader();
}
async function loadHistory() {
  if (HISTORY) return HISTORY;
  try { const r = await fetch("data/history.json", { cache: "no-cache" }); HISTORY = r.ok ? await r.json() : {}; }
  catch { HISTORY = {}; }
  return HISTORY;
}

function fmtTime(t) {
  if (!t) return "";
  const d = new Date(t), now = new Date();
  const hm = d.toLocaleTimeString("he-IL", { hour: "2-digit", minute: "2-digit" });
  return d.toDateString() === now.toDateString() ? `היום ${hm}` : `${d.toLocaleDateString("he-IL")} ${hm}`;
}

function renderHeader() {
  const line = $("#areaLine");
  if (DATA) line.textContent = `${DATA.cities.join(", ")} · ${DATA.stores.length} סניפים · עודכן ${fmtTime(DATA.updated)}`;
  else line.textContent = "אין עדיין מחירים";
  const n = unseenAlerts();
  const badge = $("#alertBadge");
  badge.hidden = !n; badge.textContent = n; badge.setAttribute("aria-label", `${n} התראות חדשות`);
}

/* ---------------- basket state ---------------- */
let basket = store.get("sal.basket", []);   // [{gcode,name,qty,weighted,manufacturer,min,max,stores}]
let currentBasketId = store.get("sal.basketId", null);
function saveBasketLocal() { store.set("sal.basket", basket); store.set("sal.basketId", currentBasketId); }
function refreshBasketInfo() {
  basket.forEach(b => { const p = Engine.product(b.gcode); if (p) Object.assign(b, { min: p.min, max: p.max, stores: p.stores }); });
  renderBasket();
}

function addToBasket(p, qty = 1, quiet = false) {
  const ex = basket.find(b => b.gcode === p.gcode);
  if (ex) ex.qty = +(ex.qty + qty).toFixed(2);
  else basket.push({ gcode: p.gcode, name: p.name, qty, weighted: !!p.weighted, manufacturer: p.manufacturer || "", min: p.min, max: p.max, stores: p.stores });
  saveBasketLocal(); renderBasket();
  if (!quiet) toast(`נוסף לסל: ${p.name}`);
}

function renderBasket() {
  const ul = $("#basketList");
  ul.innerHTML = "";
  $("#basketEmpty").hidden = basket.length > 0;
  $("#basketActions").hidden = basket.length === 0;
  $("#basketCount").textContent = basket.length ? `(${basket.length} מוצרים)` : "";
  basket.forEach((b, i) => {
    const li = document.createElement("li");
    li.className = "b-item";
    const unit = b.weighted ? 'ק"ג' : "יח'";
    const step = b.weighted ? 0.25 : 1;
    li.innerHTML = `
      <div>
        <div class="b-name">${esc(b.name)}</div>
        <div class="b-meta">${b.manufacturer ? esc(b.manufacturer) + " · " : ""}${b.min != null && isFinite(b.min) ? `${ils(b.min)}–${ils(b.max)} ${b.weighted ? 'לק"ג ' : ""}ב-${b.stores} סניפים` : ""}</div>
      </div>
      <div class="b-controls">
        <div class="qty" role="group" aria-label="כמות של ${esc(b.name)}">
          <button type="button" data-act="minus" aria-label="הפחת כמות">−</button>
          <input type="number" inputmode="decimal" min="${step}" step="${step}" value="${b.qty}" aria-label="כמות ב${unit}">
          <button type="button" data-act="plus" aria-label="הוסף כמות">+</button>
        </div>
        <span class="muted" aria-hidden="true">${unit}</span>
      </div>
      <div class="b-tools">
        <button type="button" class="chip tip" data-act="alt">חלופה זולה יותר?</button>
        <button type="button" class="chip" data-act="info">היסטוריית מחיר ומעקב</button>
        <button type="button" class="chip remove" data-act="remove" aria-label="הסר את ${esc(b.name)} מהסל">הסר</button>
      </div>`;
    const input = $("input", li);
    const set = v => { v = Math.max(step, Math.round(v / step) * step); b.qty = +v.toFixed(2); input.value = b.qty; saveBasketLocal(); };
    $('[data-act="minus"]', li).onclick = () => set(b.qty - step);
    $('[data-act="plus"]', li).onclick = () => set(b.qty + step);
    input.onchange = () => set(parseFloat(input.value) || step);
    $('[data-act="remove"]', li).onclick = () => {
      basket.splice(i, 1); saveBasketLocal(); renderBasket(); toast(`הוסר: ${b.name}`);
      const next = $$("#basketList .b-item")[Math.min(i, basket.length - 1)];
      (next ? $("input", next) : $("#searchInput")).focus();
    };
    $('[data-act="alt"]', li).onclick = () => openProduct(b.gcode, "alt");
    $('[data-act="info"]', li).onclick = () => openProduct(b.gcode, "history");
    ul.appendChild(li);
  });
}

$("#clearBasket").onclick = () => {
  if (!confirm("לרוקן את הסל?")) return;
  basket = []; currentBasketId = null; saveBasketLocal(); renderBasket(); $("#results").hidden = true;
  $("#savedSelect").value = "";
};

/* ---------------- search combobox ---------------- */
const sInput = $("#searchInput"), sList = $("#searchList");
let sResults = [], sActive = -1, sTimer;
function closeList() { sList.hidden = true; sInput.setAttribute("aria-expanded", "false"); sInput.removeAttribute("aria-activedescendant"); sActive = -1; }
function setActive(i) {
  const items = $$("li", sList);
  items.forEach((li, j) => li.setAttribute("aria-selected", String(j === i)));
  sActive = i;
  if (items[i]) { sInput.setAttribute("aria-activedescendant", items[i].id); items[i].scrollIntoView({ block: "nearest" }); }
}
function renderSearch() {
  sList.innerHTML = "";
  if (!sResults.length) { closeList(); return; }
  sResults.forEach((p, i) => {
    const li = document.createElement("li");
    li.id = "opt-" + i; li.setAttribute("role", "option"); li.setAttribute("aria-selected", "false");
    li.innerHTML = `<span><span class="r-name">${esc(p.name)}</span><br><span class="r-meta">${esc(p.manufacturer)}${p.manufacturer ? " · " : ""}ב-${p.stores} סניפים</span></span>
      <span class="r-price">${p.min === p.max ? ils(p.min) : ils(p.min) + "–" + ils(p.max)}${p.weighted ? '<span class="r-meta"> לק"ג</span>' : ""}</span>`;
    li.onmousedown = e => { e.preventDefault(); pick(i); };
    sList.appendChild(li);
  });
  sList.hidden = false; sInput.setAttribute("aria-expanded", "true");
}
function pick(i) {
  const p = sResults[i]; if (!p) return;
  addToBasket(p, 1);
  sInput.value = ""; sResults = []; closeList(); sInput.focus();
}
sInput.addEventListener("input", () => {
  clearTimeout(sTimer);
  const q = sInput.value.trim();
  if (q.length < 2 || !DATA) { sResults = []; closeList(); return; }
  sTimer = setTimeout(() => {
    sResults = Engine.search(q);
    renderSearch();
    $("#searchStatus").textContent = sResults.length ? `${sResults.length} תוצאות` : "לא נמצאו מוצרים";
  }, 150);
});
sInput.addEventListener("keydown", e => {
  if (e.key === "ArrowDown") { if (sList.hidden && sResults.length) renderSearch(); setActive(Math.min(sActive + 1, sResults.length - 1)); e.preventDefault(); }
  else if (e.key === "ArrowUp") { setActive(Math.max(sActive - 1, 0)); e.preventDefault(); }
  else if (e.key === "Enter") { if (sActive >= 0) { pick(sActive); e.preventDefault(); } else if (sResults.length === 1) { pick(0); e.preventDefault(); } }
  else if (e.key === "Escape") closeList();
});
sInput.addEventListener("blur", () => setTimeout(closeList, 150));

/* ---------------- compare ---------------- */
function runCompare(focusResults = true) {
  if (!basket.length) return;
  if (!DATA) return toast("אין עדיין מחירים");
  renderResults(Engine.compare(basket, $("#clubToggle").checked));
  $("#results").hidden = false;
  if (focusResults) { const h = $("#h-results"); h.tabIndex = -1; h.focus(); }
}
$("#compareBtn").onclick = () => runCompare();
$("#clubToggle").onchange = () => { store.set("sal.club", $("#clubToggle").checked); runCompare(false); };

function renderResults(res) {
  const sum = $("#summary"), ol = $("#storeList");
  ol.innerHTML = "";
  if (!res.stores.length) { sum.innerHTML = "אין עדיין מחירים מהסניפים באזור."; return; }
  const s = res.summary;
  if (s && s.cheapest) {
    sum.innerHTML = s.saving > 0.009
      ? `<div>הכי זול לסל המלא: <strong>${esc(s.cheapest)}</strong> – ${ils(s.cheapest_total)}</div>
         <div>חיסכון של <span class="big-num">${ils(s.saving)}</span> לעומת ${esc(s.dearest)} (${ils(s.dearest_total)})</div>`
      : `<div>הכי זול לסל המלא: <strong>${esc(s.cheapest)}</strong> – ${ils(s.cheapest_total)}</div>`;
  } else {
    sum.innerHTML = "אף סניף לא מוכר את כל המוצרים בסל. הסניפים מסודרים לפי מספר המוצרים החסרים ואז לפי מחיר.";
  }
  res.stores.forEach((st, idx) => {
    const li = document.createElement("li");
    const best = idx === 0 && st.missing === 0;
    li.className = "store" + (best ? " best" : "");
    const promos = st.lines.filter(l => l.promo).length;
    const flags = [];
    if (st.missing) flags.push(`<span class="flag miss">חסרים ${st.missing}</span>`);
    if (st.approx) flags.push(`<span class="flag approx">${st.approx} מוצרים דומים (לא זהים)</span>`);
    if (promos) flags.push(`<span class="flag promo">${promos} מבצעים הופעלו</span>`);
    const rows = st.lines.map(l => {
      if (l.status === "missing") return `<tr class="missing"><td>${esc(l.name)}<span class="sub">לא נמכר בסניף הזה</span></td><td class="num">${l.qty}</td><td class="num">—</td></tr>`;
      return `<tr><td>${esc(l.status === "approx" ? l.store_name : l.name)}
          ${l.status === "approx" ? `<span class="sub">במקום: ${esc(l.name)}</span>` : ""}
          ${l.promo ? `<span class="promo-txt">מבצע${l.promo.club ? " מועדון" : ""}: ${esc(l.promo.description)}</span>` : ""}</td>
        <td class="num">${l.qty}${l.weighted ? ' ק"ג' : ""}<span class="sub">${ils(l.unit_price)}${l.weighted ? '/ק"ג' : ""}</span></td>
        <td class="num">${ils(l.cost)}${l.promo ? `<span class="sub" style="text-decoration:line-through">${ils(l.base)}</span>` : ""}</td></tr>`;
    }).join("");
    li.innerHTML = `<details>
      <summary aria-label="${esc(st.label)}, מקום ${idx + 1}, סך הכל ${ils(st.total)}${st.missing ? `, חסרים ${st.missing} מוצרים` : ""}">
        <span class="rank" aria-hidden="true">${idx + 1}</span>
        <span><span class="s-name">${esc(st.label)}</span><br><span class="s-addr">${esc(st.address)}</span></span>
        <span class="s-total">${ils(st.total)}${st.before_promos - st.total > 0.009 ? `<span class="s-before">${ils(st.before_promos)}</span>` : ""}</span>
        ${flags.length ? `<span class="s-flags">${flags.join("")}</span>` : ""}
      </summary>
      <div class="lines-wrap"><table class="lines"><caption class="sr-only">פירוט הסל ב${esc(st.label)}</caption>
        <thead><tr><th scope="col">מוצר</th><th scope="col">כמות</th><th scope="col">מחיר</th></tr></thead><tbody>${rows}</tbody></table></div>
    </details>`;
    ol.appendChild(li);
  });
}

/* ---------------- saved & shared baskets (kept on this device) ---------------- */
let saved = store.get("sal.saved", []);   // [{id,name,items,updated}]
function renderSaved() {
  const sel = $("#savedSelect");
  sel.innerHTML = `<option value="">סלים שמורים…</option>` + saved.map(b => `<option value="${b.id}">${esc(b.name)} (${b.items.length})</option>`).join("");
  if (currentBasketId) sel.value = String(currentBasketId);
}
$("#savedSelect").onchange = e => {
  const b = saved.find(x => String(x.id) === e.target.value);
  if (!b) return;
  if (basket.length && !confirm(`לטעון את "${b.name}" במקום הסל הנוכחי?`)) { e.target.value = currentBasketId || ""; return; }
  basket = JSON.parse(JSON.stringify(b.items)); currentBasketId = b.id; saveBasketLocal(); refreshBasketInfo(); $("#results").hidden = true;
  toast(`נטען: ${b.name}`);
};
$("#saveBasket").onclick = () => {
  if (!basket.length) return toast("הסל ריק");
  const cur = saved.find(b => b.id === currentBasketId);
  const name = (prompt("שם לסל:", cur ? cur.name : "הסל השבועי") || "").trim();
  if (!name) return;
  if (cur && cur.name === name) { cur.items = basket; cur.updated = Date.now(); }
  else { currentBasketId = Date.now(); saved.unshift({ id: currentBasketId, name, items: basket, updated: Date.now() }); }
  store.set("sal.saved", saved); saveBasketLocal(); renderSaved(); toast(`הסל נשמר: ${name}`);
};
function b64url(s) { return btoa(unescape(encodeURIComponent(s))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); }
function unb64url(s) { s = s.replace(/-/g, "+").replace(/_/g, "/"); return decodeURIComponent(escape(atob(s))); }
$("#shareBasket").onclick = async () => {
  if (!basket.length) return toast("הסל ריק");
  const payload = basket.map(b => [b.gcode, b.qty, b.name, b.weighted ? 1 : 0]);
  const url = location.origin + location.pathname + "#basket=" + b64url(JSON.stringify(payload));
  try {
    if (navigator.share) await navigator.share({ title: "הסל שלי – סל חכם", url });
    else { await navigator.clipboard.writeText(url); toast("הקישור לסל הועתק"); }
  } catch { prompt("העתק את הקישור:", url); }
};
function importSharedBasket() {
  const m = location.hash.match(/basket=([\w-]+)/);
  if (!m) return false;
  try {
    const items = JSON.parse(unb64url(m[1]));
    if (confirm(`לטעון סל משותף עם ${items.length} מוצרים?`)) {
      basket = items.map(([gcode, qty, name, w]) => ({ gcode, qty, name, weighted: !!w, manufacturer: "" }));
      currentBasketId = null; saveBasketLocal(); refreshBasketInfo(); toast("הסל נטען");
    }
  } catch { toast("הקישור לסל לא תקין"); }
  history.replaceState(null, "", location.pathname + "#basket");
  return true;
}

/* ---------------- watch & alerts (kept on this device) ---------------- */
let watch = store.get("sal.watch", {});     // gcode -> {name, last}
let alerts = store.get("sal.alerts", []);   // [{gcode,name,old,new,store,created,seen}]
const unseenAlerts = () => alerts.filter(a => !a.seen).length;
function checkWatch() {
  let changed = false;
  for (const [g, w] of Object.entries(watch)) {
    const c = Engine.cheapestNow(g);
    if (!c) continue;
    if (w.last && c.price < w.last - 0.005) {
      alerts.unshift({ gcode: g, name: w.name, old: w.last, new: c.price, store: c.store, created: new Date().toISOString(), seen: false });
      if ("Notification" in window && Notification.permission === "granted") {
        try { new Notification("סל חכם – ירידת מחיר", { body: `${w.name}: ${ils(w.last)} ← ${ils(c.price)}` }); } catch {}
      }
    }
    if (w.last !== c.price) { w.last = c.price; changed = true; }
  }
  alerts = alerts.slice(0, 50);
  store.set("sal.alerts", alerts);
  if (changed) store.set("sal.watch", watch);
}
function setWatch(gcode, name, on) {
  if (on) {
    const c = Engine.cheapestNow(gcode);
    watch[gcode] = { name, last: c ? c.price : null };
    if ("Notification" in window && Notification.permission === "default") Notification.requestPermission().catch(() => {});
  } else delete watch[gcode];
  store.set("sal.watch", watch);
}
function renderWatch() {
  $("#alertList").innerHTML = alerts.length ? alerts.map(a => `<li>
      <span>${a.seen ? "" : "<strong>חדש · </strong>"}${esc(a.name)}<br><span class="hint">${esc(a.store || "")} · ${esc(fmtTime(a.created))}</span></span>
      <span class="down">${ils(a.old)} ← ${ils(a.new)}</span></li>`).join("")
    : `<li>אין התראות עדיין.</li>`;
  const ws = Object.entries(watch);
  $("#watchList").innerHTML = ws.length ? ws.map(([g, w]) => `<li>
      <span>${esc(w.name)}<br><span class="hint">המחיר הנמוך באזור: ${ils(w.last)}</span></span>
      <span><button type="button" class="btn small" data-open="${esc(g)}">פרטים</button>
      <button type="button" class="btn small ghost danger" data-unwatch="${esc(g)}">הפסק מעקב</button></span></li>`).join("")
    : `<li>אין מוצרים במעקב.</li>`;
  $$("[data-open]").forEach(b => b.onclick = () => openProduct(b.dataset.open, "history"));
  $$("[data-unwatch]").forEach(b => b.onclick = () => { setWatch(b.dataset.unwatch, "", false); renderWatch(); });
}
$("#markSeen").onclick = () => { alerts.forEach(a => a.seen = true); store.set("sal.alerts", alerts); renderWatch(); renderHeader(); };

/* ---------------- product dialog: alternatives, history, watch ---------------- */
function chartSVG(series) {
  if (!series || !series.length) return `<p class="hint">אין עדיין שינויי מחיר. ההיסטוריה נבנית אוטומטית עם כל עדכון.</p>`;
  const W = 600, H = 220, P = 34;
  const vals = series.flatMap(s => [s[1], s[2]]);
  let lo = Math.min(...vals), hi = Math.max(...vals);
  if (hi - lo < 0.5) { hi += 0.5; lo = Math.max(0, lo - 0.5); }
  const x = i => W - (P + (i * (W - 2 * P)) / (series.length - 1));   // oldest on the right (RTL)
  const y = v => H - P - ((v - lo) * (H - 2 * P)) / (hi - lo);
  const path = k => series.map((s, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(s[k]).toFixed(1)}`).join(" ");
  const pts = series.map((s, i) => `<circle cx="${x(i).toFixed(1)}" cy="${y(s[1]).toFixed(1)}" r="3.5"/>`).join("");
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="גרף המחיר הנמוך באזור לאורך זמן, מ-${ils(series[0][1])} ל-${ils(series.at(-1)[1])}">
    <line class="axis" x1="${P}" y1="${H - P}" x2="${W - P}" y2="${H - P}"/>
    <text x="${W - P}" y="${H - 10}" text-anchor="middle">${series[0][0]}</text>
    <text x="${P}" y="${H - 10}" text-anchor="middle">${series.at(-1)[0]}</text>
    <text x="${P - 4}" y="${y(hi) + 4}" text-anchor="start">${ils(hi)}</text>
    <text x="${P - 4}" y="${y(lo) + 4}" text-anchor="start">${ils(lo)}</text>
    <path class="lineMax" d="${path(2)}"/><path class="lineMin" d="${path(1)}"/>${pts}</svg>
    <p class="hint">קו מלא: המחיר הנמוך ביותר באזור. קו מקווקו: הגבוה ביותר. הזמן מתקדם מימין לשמאל.</p>
    <details><summary>הצג כטבלה</summary><table class="lines"><thead><tr><th>תאריך</th><th>הכי זול</th><th>רשת</th><th>הכי יקר</th></tr></thead>
    <tbody>${series.map(s => `<tr><td>${s[0]}</td><td>${ils(s[1])}</td><td>${esc(s[3])}</td><td>${ils(s[2])}</td></tr>`).join("")}</tbody></table></details>`;
}

async function openProduct(gcode, focus) {
  const dlg = $("#productDialog"), body = $("#pdBody");
  const p = Engine.product(gcode) || { name: (basket.find(b => b.gcode === gcode) || {}).name || "מוצר", per100: null };
  $("#pdTitle").textContent = p.name;
  const alts = DATA ? Engine.alternatives(gcode) : [];
  body.innerHTML = `
    <section aria-labelledby="altH">
      <h3 id="altH">חלופות זולות יותר</h3>
      ${alts.length ? alts.map((a, i) => `<div class="alt">
          <div><strong>${esc(a.name)}</strong><div class="hint">${esc(a.manufacturer)} · ${a.base === "u" ? "ליחידה" : a.base === "g" ? "ל-100 גרם" : 'ל-100 מ"ל'}: ${ils(a.per100)} · ${esc(a.where)}</div></div>
          <div><div class="save">זול ב-${a.saving_pct}%</div><button type="button" class="btn small" data-swap="${i}">החלף בסל</button></div>
        </div>`).join("") : `<p class="hint">לא מצאתי מוצר דומה שזול יותר ליחידת מידה${p.per100 ? "" : " (חסר מידע על גודל האריזה)"}.</p>`}
      ${alts.length ? `<p class="fine">ההשוואה לפי מחיר ל-100 גרם / 100 מ"ל. כדאי לוודא שהמוצר באמת מתאים לך.</p>` : ""}
    </section>
    <section aria-labelledby="histH">
      <h3 id="histH">היסטוריית מחיר</h3>
      <div id="histBox"><p class="hint">טוען…</p></div>
      <label class="switch"><input type="checkbox" id="watchToggle" ${watch[gcode] ? "checked" : ""}><span>התרע לי כשהמחיר יורד</span></label>
    </section>
    <section aria-labelledby="nowH">
      <h3 id="nowH">מחיר היום בכל סניף</h3>
      <ul class="plain">${Engine.pricesNow(gcode).map(n => `<li><span>${esc(n.store)}</span><strong>${ils(n.price)}</strong></li>`).join("") || "<li>לא נמכר כרגע באזור</li>"}</ul>
    </section>`;
  dlg.showModal();
  $$("[data-swap]", body).forEach(b => b.onclick = () => {
    const a = alts[+b.dataset.swap], i = basket.findIndex(x => x.gcode === gcode);
    const qty = i >= 0 ? basket[i].qty : 1;
    if (i >= 0) basket.splice(i, 1, { gcode: a.gcode, name: a.name, qty, weighted: a.weighted, manufacturer: a.manufacturer, min: a.min, max: a.max, stores: a.stores });
    saveBasketLocal(); renderBasket(); dlg.close(); toast(`הוחלף ב: ${a.name}`);
    if (!$("#results").hidden) runCompare(false);
  });
  $("#watchToggle").onchange = e => { setWatch(gcode, p.name, e.target.checked); toast(e.target.checked ? "אתריע כשהמחיר ירד" : "הוסר מהמעקב"); };
  const target = focus === "history" ? $("#histH") : $("#altH");
  target.tabIndex = -1; target.focus();
  const h = await loadHistory();
  $("#histBox").innerHTML = chartSVG(h[gcode]);
}

/* ---------------- paste list ---------------- */
let parsed = [];
$("#parseBtn").onclick = () => {
  const text = $("#pasteText").value.trim();
  if (!text) return toast("הדבק קודם רשימה");
  if (!DATA) return toast("אין עדיין מחירים");
  parsed = Engine.parseList(text);
  $("#parsedList").innerHTML = parsed.map((p, i) => `<li>
      <div class="p-orig">${esc(p.text)}</div>
      <div class="p-row">
        <div><label class="sr-only" for="pc${i}">מוצר עבור ${esc(p.text)}</label>
          <select id="pc${i}">
            ${p.candidates.map((c, j) => `<option value="${j}">${esc(c.name)} – ${ils(c.min)}${c.weighted ? '/ק"ג' : ""} (${c.stores} סניפים)</option>`).join("")}
            <option value="-1" ${p.candidates.length ? "" : "selected"}>${p.candidates.length ? "לא להוסיף" : "לא נמצא – דלג"}</option>
          </select></div>
        <div><label class="sr-only" for="pq${i}">כמות</label><input type="number" id="pq${i}" min="0.25" step="0.25" value="${p.qty}" inputmode="decimal"></div>
      </div></li>`).join("");
  $("#parsedCard").hidden = false;
  toast(`זוהו ${parsed.filter(p => p.candidates.length).length} מתוך ${parsed.length} שורות`);
  $("#parsedCard h3").tabIndex = -1; $("#parsedCard h3").focus();
};
$("#addParsed").onclick = () => {
  let n = 0;
  parsed.forEach((p, i) => {
    const j = +$("#pc" + i).value, q = parseFloat($("#pq" + i).value) || 1;
    if (j >= 0 && p.candidates[j]) { addToBasket(p.candidates[j], q, true); n++; }
  });
  toast(`נוספו ${n} מוצרים לסל`);
  $("#parsedCard").hidden = true; $("#pasteText").value = "";
  showView("basket");
};

/* ---------------- settings ---------------- */
let status = null;
function renderStores() {
  const st = DATA ? DATA.stores : [];
  $("#storeInfo").innerHTML = st.length ? st.map(s => `<li><span>${esc(s.label)}<br><span class="hint">${esc(s.address)}</span></span>
      <span class="hint">${(s.items || 0).toLocaleString("he-IL")} מוצרים · ${esc(fmtTime(s.prices_at))}</span></li>`).join("")
    : `<li>עוד לא נטענו סניפים.</li>`;
}
async function renderSettings() {
  renderStores();
  $$(".local-only").forEach(e => e.hidden = !LOCAL);
  $$(".public-only").forEach(e => e.hidden = LOCAL);
  if (!LOCAL) {
    $("#pubInfo").textContent = DATA
      ? `המחירים עודכנו ${fmtTime(DATA.updated)} עבור ${DATA.cities.join(", ")}, מקבצי שקיפות המחירים של הרשתות.`
      : "המחירים עוד לא פורסמו.";
    return;
  }
  if (!status) await refreshStatus();
  const s = status.settings;
  $("#cityChecks").innerHTML = status.known_cities.map(c =>
    `<label><input type="checkbox" value="${esc(c)}" ${s.cities.includes(c) ? "checked" : ""}>${esc(c)}</label>`).join("");
  $("#clubDefault").checked = s.include_club;
  try { const l = await api("log"); $("#logBox").textContent = l.log.join(""); } catch {}
}
$("#saveSettings").onclick = async () => {
  const cities = $$("#cityChecks input:checked").map(i => i.value);
  if (!cities.length) return toast("בחר לפחות עיר אחת");
  await api("settings", { cities, include_club: $("#clubDefault").checked });
  await api("update", {});
  toast("נשמר. מעדכן מחירים לאזור החדש…");
  refreshStatus();
};
$("#updateNow").onclick = async () => {
  const r = await api("update", {});
  toast(r.started ? "העדכון התחיל" : "עדכון כבר רץ");
  refreshStatus();
};

let pollTimer, wasRunning = false;
async function refreshStatus() {
  try { status = await api("status"); } catch { return; }
  const u = status.update || {};
  const fr = $("#firstRun");
  if (u.running) {
    fr.hidden = false;
    fr.innerHTML = `<strong>${DATA ? "מעדכן מחירים…" : "מוריד מחירים בפעם הראשונה – זה יכול לקחת 5 עד 20 דקות."}</strong>${esc(u.message || "")}`;
  } else if (!DATA) {
    fr.hidden = false;
    fr.innerHTML = `<strong>עוד אין מחירים.</strong>${u.errors && u.errors.length ? esc(u.errors.at(-1)) + " · " : ""}אפשר להפעיל עדכון בלשונית "אזור והגדרות".`;
  } else fr.hidden = true;
  $("#updateStatus").textContent = u.running ? `רץ עכשיו: ${u.message || ""}`
    : u.finished ? `העדכון האחרון הסתיים ${fmtTime(u.finished)}. ${u.message || ""}${u.errors && u.errors.length ? ` (${u.errors.length} הודעות ביומן)` : ""}` : "עוד לא בוצע עדכון.";
  const pb = status.publish || {};
  $("#publishStatus").innerHTML = pb.url
    ? `האתר באוויר: <a dir="ltr" href="${esc(pb.url)}" target="_blank" rel="noopener">${esc(pb.url)}</a>${pb.last ? ` · פורסם ${esc(fmtTime(pb.last))}` : ""}${pb.error ? ` · <span style="color:var(--bad)">${esc(pb.error)}</span>` : ""}`
    : "האתר עדיין לא מפורסם באינטרנט. להפעלה: הרץ במחשב את publish-setup.sh.";
  if (wasRunning && !u.running) { await loadData(); if (!$("#view-settings").hidden) renderSettings(); }
  wasRunning = !!u.running;
  clearTimeout(pollTimer);
  pollTimer = setTimeout(refreshStatus, u.running ? 3000 : 60000);
}

/* ---------------- init ---------------- */
(async function init() {
  $("#clubToggle").checked = !!store.get("sal.club", false);
  renderBasket(); renderSaved();
  try { const r = await fetch("api/status", { cache: "no-store" }); LOCAL = r.ok && (r.headers.get("content-type") || "").includes("json"); } catch { LOCAL = false; }
  await loadData();
  if (DATA && store.get("sal.club", null) == null) $("#clubToggle").checked = !!DATA.include_club;
  if (LOCAL) refreshStatus();
  else if (!DATA) { const fr = $("#firstRun"); fr.hidden = false; fr.innerHTML = "<strong>המחירים עוד לא פורסמו.</strong>נסה שוב מאוחר יותר."; }
  const shared = importSharedBasket();
  const h = location.hash.slice(1);
  if (!shared && ["basket", "paste", "watch", "settings"].includes(h)) showView(h, false);
})();
