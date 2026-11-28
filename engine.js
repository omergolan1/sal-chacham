"use strict";
/* Price engine that runs in the browser: search, basket comparison, promotions,
   cheaper alternatives, free-text list parsing. Reads data/prices.json. */
const Engine = (() => {
  // ---------------- text helpers (same rules as common.py) ----------------
  const PUNCT = /["'`׳״\-.,/\\()\[\]*+!?:;_|#&]+/g;
  const UNIT_WORDS = new Set(["גרם", "גר", "ג", "גרמים", "קג", "קילו", "קילוגרם", "ליטר", "ל", "ליט", "מל", "מיליליטר",
    "יח", "יחידות", "יחידה", "מארז", "באריזה", "אריזה", "של", "ב", "עם", "x", "ק"]);
  const normText = s => (s || "").replace(/[‎‏]/g, " ").replace(PUNCT, " ").replace(/\s+/g, " ").trim().toLowerCase();
  const stem = t => (t.length >= 5 && (t.endsWith("ות") || t.endsWith("ים"))) ? t.slice(0, -2)
    : (t.length >= 4 && t.endsWith("ה")) ? t.slice(0, -1) : t;
  const tokens = s => normText(s).split(" ").filter(Boolean);
  const hasDigit = t => /\d/.test(t);
  const wordTokens = s => tokens(s).filter(t => !hasDigit(t) && !UNIT_WORDS.has(t) && t.length >= 2).map(stem);
  const pctTokens = s => new Set([...(s || "").matchAll(/(\d+(?:\.\d+)?)\s*%/g)].map(m => m[1]));
  const similarity = (a, b) => {
    const ta = new Set(wordTokens(a)), tb = new Set(wordTokens(b));
    if (!ta.size || !tb.size) return 0;
    let inter = 0; ta.forEach(t => tb.has(t) && inter++);
    return inter / (ta.size + tb.size - inter);
  };
  const intersects = (a, b) => { for (const x of a) if (b.has(x)) return true; return false; };
  const today = () => { const d = new Date(); return new Date(d - d.getTimezoneOffset() * 6e4).toISOString().slice(0, 10); };

  // ---------------- data ----------------
  let D = null, P = [], byG = new Map(), tokMap = new Map(), tokKeys = [], firstMap = new Map(), promoIdx = [];

  function load(data) {
    D = data; P = []; byG = new Map(); tokMap = new Map(); firstMap = new Map();
    data.products.forEach((r, i) => {
      const [g, name, man, w, base, factor, prices] = r;
      let min = Infinity, max = -Infinity, n = 0;
      prices.forEach(p => { if (p != null) { n++; if (p < min) min = p; if (p > max) max = p; } });
      const words = wordTokens(name);
      const p = { i, gcode: g, name, manufacturer: man, weighted: !!w, base: base || null, factor, prices,
        min, max, stores: n, per100: factor ? +(factor * min).toFixed(3) : null, words };
      P.push(p); byG.set(g, i);
      new Set([...tokens(name), ...words]).forEach(t => { let a = tokMap.get(t); if (!a) tokMap.set(t, a = []); a.push(i); });
      if (words.length) { let a = firstMap.get(words[0]); if (!a) firstMap.set(words[0], a = []); a.push(i); }
    });
    tokKeys = [...tokMap.keys()];
    promoIdx = data.promos.map(list => {
      const m = new Map();
      list.forEach(([desc, start, end, mq, dp, rate, club, items]) => {
        items.forEach(([pi, idp, imq, irate]) => {
          const o = { description: desc, start, end, min_qty: mq, discounted_price: dp, discount_rate: rate, club: !!club };
          if (idp || irate) { o.discounted_price = idp || 0; o.discount_rate = irate || 0; o.min_qty = imq || mq; }
          let a = m.get(pi); if (!a) m.set(pi, a = []); a.push(o);
        });
      });
      return m;
    });
  }

  const pub = p => p && ({ gcode: p.gcode, name: p.name, manufacturer: p.manufacturer, stores: p.stores, min: p.min, max: p.max,
    weighted: p.weighted, base: p.base, per100: p.per100 });

  // ---------------- search ----------------
  function candidatesFor(tok) {
    const t = hasDigit(tok) ? tok : stem(tok);
    const set = new Set();
    for (const k of tokKeys) if (k.startsWith(t)) tokMap.get(k).forEach(i => set.add(i));
    return set;
  }
  function search(q, limit = 20) {
    q = (q || "").trim();
    if (!q) return [];
    const digits = q.replace(/\D/g, "");
    if (digits.length >= 6 && digits.length >= q.replace(/\s/g, "").length - 1) {
      const g = digits.replace(/^0+/, "");
      return P.filter(p => p.gcode === g || p.gcode.endsWith(":" + digits)).slice(0, limit).map(pub);
    }
    const qt = tokens(q);
    if (!qt.length) return [];
    let set = null;
    for (const t of qt) {
      const c = candidatesFor(t);
      set = set ? new Set([...set].filter(i => c.has(i))) : c;
      if (!set.size) return [];
    }
    const first = stem(qt[0]), qw = new Set(wordTokens(q));
    const rows = [...set].map(i => P[i]).filter(p => p.stores > 0);
    const rank = p => {
      const ws = new Set(p.words);
      return [qw.size && [...qw].every(w => ws.has(w)) ? 0 : 1, p.words[0] && p.words[0].startsWith(first) ? 0 : 1, -p.stores, p.name.length];
    };
    rows.sort((a, b) => { const ra = rank(a), rb = rank(b); for (let k = 0; k < 4; k++) if (ra[k] !== rb[k]) return ra[k] - rb[k]; return 0; });
    const out = [], merged = new Map();
    for (const p of rows) {
      const o = pub(p);
      if (p.gcode.includes(":")) {          // produce: same item under each chain's own code
        const key = p.words.join(" ") + "|" + p.weighted;
        const m = merged.get(key);
        if (m) { m.stores += o.stores; m.min = Math.min(m.min, o.min); m.max = Math.max(m.max, o.max); continue; }
        merged.set(key, o);
      }
      out.push(o);
      if (out.length >= limit) break;
    }
    return out;
  }

  // ---------------- promotions ----------------
  const DESC_BUNDLE = /(\d+(?:\.\d+)?)\s*(?:יח'?|יחידות|ק"?ג|ק ג|קג)?\s*ב\s*-?\s*₪?\s*(\d+(?:\.\d+)?)/;
  const r2 = x => Math.round(x * 100) / 100;
  function promoCost(pr, price, qty, weighted) {
    let m = pr.min_qty || 1;
    if (!weighted) m = Math.max(1, Math.round(m));
    if (qty + 1e-9 < m) return null;
    const dp = pr.discounted_price || 0, rate = pr.discount_rate || 0;
    const pct = r => (r > 100 ? r / 100 : r);
    if (weighted) {
      if (dp > 0 && dp < price) return r2(qty * dp);
      if (rate > 0) { const r = pct(rate); if (r > 0 && r <= 70) return r2(qty * price * (1 - r / 100)); }
      return null;
    }
    const bundles = Math.floor(qty / m), rest = qty - bundles * m;
    if (dp > 0) {
      let total = null;
      const mm = (pr.description || "").match(DESC_BUNDLE);
      if (mm && Math.abs(parseFloat(mm[1]) - m) < 0.01) {
        const d = parseFloat(mm[2]);
        if (Math.abs(d - dp) <= 0.05 * d) total = dp;
        else if (Math.abs(d - dp * m) <= 0.05 * d) total = dp * m;
      }
      if (total == null) {
        const full = price * m, asTotal = 1 - dp / full, asUnit = 1 - (dp * m) / full;
        if (asTotal >= 0.02 && asTotal <= 0.65) total = dp;
        else if (asUnit >= 0.02 && asUnit <= 0.65) total = dp * m;
        else return null;
      }
      if (total >= price * m) return null;
      return r2(bundles * total + rest * price);
    }
    if (rate > 0) {
      const r = pct(rate);
      if (!(r > 0 && r <= 70)) return null;
      return r2(bundles * m * price * (1 - r / 100) + rest * price);
    }
    return null;
  }
  function bestLineCost(si, pi, qty, includeClub) {
    const price = P[pi].prices[si], base = r2(price * qty), t = today();
    let best = base, promo = null;
    for (const pr of promoIdx[si].get(pi) || []) {
      if (pr.club && !includeClub) continue;
      if (pr.start && pr.start > t) continue;
      if (pr.end && pr.end < t) continue;
      const c = promoCost(pr, price, qty, P[pi].weighted);
      if (c != null && c < best - 0.004) { best = c; promo = { description: pr.description || "מבצע", club: pr.club, end: pr.end }; }
    }
    return { base, cost: best, promo };
  }

  // ---------------- compare ----------------
  function approxInStore(si, name, weighted) {
    const words = wordTokens(name);
    if (!words.length) return null;
    const pct = pctTokens(name);
    let best = null, bestScore = 0;
    for (const i of firstMap.get(words[0]) || []) {
      const p = P[i];
      if (p.prices[si] == null || p.weighted !== !!weighted) continue;
      if (pct.size && !intersects(pct, pctTokens(p.name))) continue;
      const s = similarity(name, p.name);
      if (s > bestScore || (Math.abs(s - bestScore) < 1e-6 && best && p.prices[si] < best.prices[si])) { best = p; bestScore = s; }
    }
    return best && bestScore >= 0.5 ? best : null;
  }
  function compare(items, includeClub) {
    const results = D.stores.map((s, si) => {
      let total = 0, before = 0, missing = 0, approx = 0;
      const lines = items.map(it => {
        const qty = +it.qty || 1;
        let pi = byG.get(it.gcode), status = "exact";
        if (pi == null || P[pi].prices[si] == null) {
          const a = approxInStore(si, it.name || (pi != null ? P[pi].name : ""), it.weighted);
          pi = a ? a.i : null; status = a ? "approx" : "missing";
        }
        if (pi == null) { missing++; return { gcode: it.gcode, name: it.name, qty, status: "missing" }; }
        if (status === "approx") approx++;
        const c = bestLineCost(si, pi, qty, includeClub);
        total += c.cost; before += c.base;
        return { gcode: it.gcode, name: it.name, store_name: P[pi].name, qty, unit_price: P[pi].prices[si], cost: c.cost,
          base: c.base, promo: c.promo, status, weighted: P[pi].weighted };
      });
      return { store_key: s.key, label: s.label, chain: s.chain, address: s.address, total: r2(total), before_promos: r2(before),
        missing, approx, lines, prices_at: s.prices_at };
    });
    results.sort((a, b) => a.missing - b.missing || a.total - b.total);
    const complete = results.filter(r => !r.missing);
    let summary = {};
    if (complete.length) {
      const cheapest = complete[0], dearest = complete.reduce((a, b) => (b.total > a.total ? b : a));
      summary = { cheapest: cheapest.label, cheapest_total: cheapest.total, dearest: dearest.label,
        dearest_total: dearest.total, saving: r2(dearest.total - cheapest.total) };
    }
    return { stores: results, summary, count: items.length };
  }

  // ---------------- cheaper alternatives ----------------
  function alternatives(gcode, limit = 5) {
    const i = byG.get(gcode);
    if (i == null) return [];
    const me = P[i];
    if (!me.base || !me.per100 || !me.words.length) return [];
    const pct = pctTokens(me.name), out = [];
    for (const j of firstMap.get(me.words[0]) || []) {
      const p = P[j];
      if (j === i || p.base !== me.base || !p.per100 || !p.stores) continue;
      if (pct.size && !intersects(pct, pctTokens(p.name))) continue;
      if (me.words.length > 1 && similarity(me.name, p.name) < 0.2) continue;
      if (p.per100 < me.per100 * 0.95) {
        let si = -1, bp = Infinity;
        p.prices.forEach((x, k) => { if (x != null && x < bp) { bp = x; si = k; } });
        out.push({ ...pub(p), saving_pct: Math.round(100 * (1 - p.per100 / me.per100)), where: si >= 0 ? D.stores[si].label : "" });
      }
    }
    return out.sort((a, b) => a.per100 - b.per100).slice(0, limit);
  }

  // ---------------- free-text list ----------------
  const QTY_WORDS = { "פעמיים": 2, "שניים": 2, "שתיים": 2, "שני": 2, "שתי": 2, "שלוש": 3, "שלושה": 3, "ארבע": 4, "ארבעה": 4,
    "חמש": 5, "חמישה": 5, "שש": 6, "שישה": 6, "עשר": 10, "עשרה": 10 };
  const LEAD = /^\s*(\d+(?:[.,]\d+)?)\s*(?:x|X|×|יח'?|יחידות|ק"?ג|קילו)?\s+(.+)$/;
  const TRAIL = /^(.+?)\s*(?:x|X|×|\*)\s*(\d+(?:[.,]\d+)?)\s*$/;
  const TRAIL2 = /^(.+?)\s+(\d+(?:[.,]\d+)?)\s*(?:יח'?|יחידות|ק"?ג|קילו)\s*$/;
  function parseLine(line) {
    line = line.replace(/^\s*(?:[-•*·✓☐]|\d+[.)](?!\d))\s*/, "").replace(/^[\s\-•*·]+|[\s\-•*·]+$/g, "");
    if (!line) return null;
    let qty = 1, m = line.match(LEAD);
    if (m) { qty = parseFloat(m[1].replace(",", ".")); line = m[2]; }
    else if ((m = line.match(TRAIL) || line.match(TRAIL2))) { line = m[1]; qty = parseFloat(m[2].replace(",", ".")); }
    else { const [w, ...rest] = line.split(" "); if (rest.length && QTY_WORDS[w]) { qty = QTY_WORDS[w]; line = rest.join(" "); } }
    return { text: line.trim(), qty };
  }
  function parseList(text) {
    const parts = [];
    (text || "").split(/[\n\r]+/).forEach(raw => raw.split(/[,،;]/).forEach(piece => {
      const p = parseLine(piece);
      if (p && p.text.length >= 2) parts.push(p);
    }));
    return parts.slice(0, 80).map(p => ({ ...p, candidates: search(p.text, 4) }));
  }

  // ---------------- per-product details ----------------
  function product(gcode) { const i = byG.get(gcode); return i == null ? null : pub(P[i]); }
  function pricesNow(gcode) {
    const i = byG.get(gcode);
    if (i == null) return [];
    return P[i].prices.map((x, si) => x == null ? null : { price: x, store: D.stores[si].label })
      .filter(Boolean).sort((a, b) => a.price - b.price);
  }
  function cheapestNow(gcode) {
    const n = pricesNow(gcode);
    return n.length ? n[0] : null;
  }

  return { load, search, compare, alternatives, parseList, product, pricesNow, cheapestNow, promoCost,
    get data() { return D; }, _norm: { normText, stem, wordTokens } };
})();
