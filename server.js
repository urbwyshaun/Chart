'use strict';

const express = require('express');
const path = require('path');
const crypto = require('crypto');

// ---------- Config (set these as environment variables on Render) ----------
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.GEMINI_API_KEY || '';
const ACCESS_CODE = process.env.ACCESS_CODE || '';
const PRIMARY_MODEL = process.env.GEMINI_MODEL || 'gemini-3.8-flash';
const FALLBACK_MODELS = (process.env.GEMINI_FALLBACKS || 'gemini-3.7-flash,gemini-3.6-flash')
  .split(',').map((s) => s.trim()).filter(Boolean);
const THINKING = (process.env.THINKING_LEVEL || 'medium').toLowerCase(); // low | medium | high
const MIN_SCORE = Number(process.env.MIN_SCORE || 70); // confluence needed before a trade is shown
const MIN_RR = Number(process.env.MIN_RR || 2); // minimum reward:risk to the final target
const RATE_LIMIT_PER_MIN = Number(process.env.RATE_LIMIT_PER_MIN || 10);
const MAX_IMAGES = 4;
const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp']);

// ---------- Confluence checklist (weights add up to 100) ----------
const CHECKLIST = [
  ['htf_bias_aligned', 15, 'Higher-timeframe bias aligned',
    'Higher-timeframe structure and the draw on liquidity support the trade direction.'],
  ['liquidity_sweep', 15, 'Liquidity sweep',
    'A clear raid of buy-side or sell-side liquidity (equal highs/lows, swing high/low, session or prior day/week extreme) occurred against the trade direction.'],
  ['market_structure_shift', 15, 'Market structure shift',
    'After the sweep, price shows an MSS / CHoCH with displacement in the trade direction.'],
  ['displacement_fvg', 10, 'Displacement with fair value gap',
    'The displacement leg left a visible fair value gap / imbalance.'],
  ['pd_array_entry', 15, 'Entry at a PD array',
    'The entry sits inside a valid PD array: order block, breaker, fair value gap, mitigation or rejection block, in the correct premium/discount side.'],
  ['premium_discount', 10, 'Premium / discount alignment',
    'Buys are taken from discount (below 50% of the dealing range), sells from premium (above 50%).'],
  ['amd_phase', 10, 'AMD phase valid',
    'Accumulation is visible, manipulation (stop run / Judas swing) has completed, and distribution is starting in the trade direction.'],
  ['liquidity_target', 5, 'Clear liquidity target',
    'There is an obvious opposing liquidity pool or PD array to target, at least the minimum reward:risk away.'],
  ['fib_ote', 5, 'Fibonacci OTE overlap',
    'The entry falls inside the 62-79% (OTE) retracement of the dealing-range leg and overlaps the PD array.'],
];
const MANDATORY = ['liquidity_sweep', 'market_structure_shift', 'pd_array_entry'];

// ---------- Prompt ----------
function buildSystemPrompt() {
  const checklistText = CHECKLIST.map(([k, w, , d]) => `- ${k} (weight ${w}): ${d}`).join('\n');
  return `You are a strict institutional-style price action analyst. You analyse screenshots of trading charts using Inner Circle Trader (ICT) concepts, Smart Money Concepts (SMC) and the AMD (Accumulation, Manipulation, Distribution) model. You only use what is visible in the image(s). You never invent prices.

METHOD (work top-down, in this order)
1. Chart reading: identify symbol, timeframe and the price axis. Read prices ONLY from axis labels and the last-price tag. If the axis is cropped or unreadable set price_axis_readable=false and return NO_TRADE.
2. Dealing range and premium/discount: mark the relevant swing high and swing low. Equilibrium is 50% of that range. Above 50% is premium (sell side); below is discount (buy side). Buy from discount, sell from premium.
3. Liquidity: buy-side liquidity (equal highs, swing highs, previous day/week highs, session highs) and sell-side liquidity (equal lows, swing lows, previous day/week lows, session lows). State what has been swept and the next draw on liquidity.
4. PD arrays: bullish and bearish order blocks, breakers, fair value gaps / imbalances, mitigation blocks, rejection blocks, liquidity voids, old highs/lows. Give zone_low and zone_high as prices.
5. Market structure (SMC): BOS, CHoCH / MSS, inducement, displacement, internal versus external structure.
6. AMD: Accumulation = range building (e.g. Asian range or consolidation). Manipulation = stop run / Judas swing beyond the range or a liquidity pool. Distribution = expansion toward the opposite liquidity. A valid entry normally comes after manipulation completes and an MSS shows distribution has begun.
7. Fibonacci: retracement of the leg that created the dealing range. Key levels 23.6, 38.2, 50, 61.8, 70.5, 78.6/80.9. OTE is the 62-79% zone. An entry inside OTE that overlaps a PD array is high confluence.
8. Time: only if session or time labels are visible, note the kill zone (London 02:00-05:00 New York time, NY AM 07:00-10:00, NY PM 13:30-16:00). Never guess the time.

TRADE RULES
- NO_TRADE is a correct and valuable answer. Most charts do not hold an A-grade setup. Do not force a trade.
- Only answer BUY or SELL when a sweep, a market structure shift and a PD array entry are all clearly visible and the trade has at least ${MIN_RR}R to the final target.
- Entry: normally a limit order at the PD array. Give zone_low, zone_high and price (the precise level, e.g. 50% of the FVG, the OTE level, or the open/mean threshold of the order block). Use type "market" only when price is already inside the zone and the MSS has confirmed.
- Stop loss: beyond the structural invalidation (beyond the swept liquidity extreme or the far edge of the PD array) plus a small buffer. Never an arbitrary distance.
- Take profits: 1 to 3 targets at opposing liquidity pools or opposing PD arrays. TP1 internal liquidity, later targets external range liquidity. Final target at least ${MIN_RR}R.
- positions: 1 to 3 positions with a plan (e.g. close 50% at TP1 and move the stop to break-even).
- Use the same price precision as the chart axis. Prices must be plain numbers.
- Score the checklist honestly: 0 = absent, 0.5 = partial or ambiguous, 1 = clear. Give a short evidence string that points to what you see on the chart.
- model_confidence (0-100) is how confident you are that this is a valid setup, not a probability of winning.

CHECKLIST KEYS
${checklistText}

Return ONE JSON object and nothing else, with exactly this shape (use null when unknown):
{
  "symbol": string|null, "timeframe": string|null,
  "chart_quality": "good"|"fair"|"poor", "price_axis_readable": boolean,
  "current_price": number|null,
  "htf_bias": "bullish"|"bearish"|"neutral",
  "narrative": string,
  "dealing_range": {"high": number|null, "low": number|null, "equilibrium": number|null, "price_location": "premium"|"discount"|"equilibrium"},
  "amd": {"phase": "accumulation"|"manipulation"|"distribution"|"unclear", "notes": string},
  "liquidity": {"buy_side": [{"level": number|null, "description": string}], "sell_side": [{"level": number|null, "description": string}], "swept": string},
  "pd_arrays": [{"type": string, "side": "bullish"|"bearish", "zone_low": number|null, "zone_high": number|null, "notes": string}],
  "structure": {"events": [string]},
  "fibonacci": {"swing_high": number|null, "swing_low": number|null, "ote_low": number|null, "ote_high": number|null, "notes": string},
  "checklist": { "<key>": {"score": 0|0.5|1, "evidence": string} },
  "model_confidence": number,
  "signal": "BUY"|"SELL"|"NO_TRADE",
  "trade": null | {
    "entry": {"type": "limit"|"market", "price": number, "zone_low": number, "zone_high": number},
    "stop_loss": number, "stop_reason": string,
    "take_profits": [{"price": number, "rationale": string, "close_percent": number}],
    "positions": {"count": number, "plan": string},
    "invalidation": string, "management": string
  },
  "wait_for": string|null,
  "risks": [string]
}
When signal is NO_TRADE set trade to null and use wait_for to say exactly what must appear on the chart before a trade is valid.`;
}
const SYSTEM_PROMPT = buildSystemPrompt();

// ---------- Small helpers ----------
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const round2 = (n) => Math.round(n * 100) / 100;
function num(v) {
  const n = typeof v === 'string' ? parseFloat(v.replace(/,/g, '')) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}
const str = (v) => (v === null || v === undefined ? '' : String(v).slice(0, 1200));
const strList = (a) => (Array.isArray(a) ? a.map(str).filter(Boolean).slice(0, 10) : []);
const levelList = (a) =>
  (Array.isArray(a) ? a : []).slice(0, 6).map((x) => ({ level: num(x && x.level), description: str(x && x.description) }));
const pdList = (a) =>
  (Array.isArray(a) ? a : []).slice(0, 8).map((x) => ({
    type: str(x && x.type),
    side: x && (x.side === 'bullish' || x.side === 'bearish') ? x.side : '',
    zone_low: num(x && x.zone_low),
    zone_high: num(x && x.zone_high),
    notes: str(x && x.notes),
  }));

function parseJson(text) {
  const t = text.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const a = t.indexOf('{');
  const b = t.lastIndexOf('}');
  if (a < 0 || b <= a) throw new Error('The model did not return a readable analysis. Try the scan again.');
  try {
    return JSON.parse(t.slice(a, b + 1));
  } catch {
    throw new Error('The model returned a broken analysis. Try the scan again.');
  }
}

// ---------- Validation + confidence (the server, not the model, decides if a trade is shown) ----------
function finalize(raw, model) {
  const axisOk = raw.price_axis_readable !== false;
  const quality = ['good', 'fair', 'poor'].includes(raw.chart_quality) ? raw.chart_quality : 'fair';

  let weighted = 0;
  const checklist = CHECKLIST.map(([key, weight, label]) => {
    const c = (raw.checklist && raw.checklist[key]) || {};
    const s = clamp(num(c.score) ?? 0, 0, 1);
    weighted += s * weight;
    return { key, label, weight, score: s, evidence: str(c.evidence) };
  });
  const score = Math.round(weighted);
  const byKey = Object.fromEntries(checklist.map((c) => [c.key, c.score]));
  const labelOf = (k) => (checklist.find((c) => c.key === k) || {}).label || k;

  let verdict = String(raw.signal || '').toUpperCase().replace(/[\s-]+/g, '_');
  if (verdict !== 'BUY' && verdict !== 'SELL') verdict = 'NO_TRADE';
  const rejected = [];
  let trade = null;

  if (verdict !== 'NO_TRADE') {
    const t = raw.trade || {};
    const e = t.entry || {};
    let zl = num(e.zone_low);
    let zh = num(e.zone_high);
    if (zl !== null && zh !== null && zl > zh) {
      const tmp = zl;
      zl = zh;
      zh = tmp;
    }
    let entry = num(e.price);
    if (entry === null && zl !== null && zh !== null) entry = (zl + zh) / 2;
    const sl = num(t.stop_loss);
    let tps = (Array.isArray(t.take_profits) ? t.take_profits : [])
      .map((tp) => ({ price: num(tp && tp.price), rationale: str(tp && tp.rationale), close_percent: num(tp && tp.close_percent) }))
      .filter((tp) => tp.price !== null);

    if (entry === null || sl === null || !tps.length) {
      rejected.push('The plan was missing an entry, stop loss or take profit.');
    } else {
      const dir = verdict === 'BUY' ? 1 : -1;
      const risk = (entry - sl) * dir;
      tps = tps
        .filter((tp) => (tp.price - entry) * dir > 0)
        .sort((a, b) => Math.abs(a.price - entry) - Math.abs(b.price - entry))
        .slice(0, 3);
      if (risk <= 0) {
        rejected.push('The stop loss is on the wrong side of the entry.');
      } else if (!tps.length) {
        rejected.push('No take profit sits on the profitable side of the entry.');
      } else {
        tps = tps.map((tp, i) => ({
          label: `TP${i + 1}`,
          price: tp.price,
          rr: round2(Math.abs(tp.price - entry) / risk),
          rationale: tp.rationale,
          close_percent: tp.close_percent,
        }));
        const finalRR = tps[tps.length - 1].rr;
        if (finalRR < MIN_RR) rejected.push(`The final target is only ${finalRR}R (minimum ${MIN_RR}R).`);
        trade = {
          direction: verdict,
          entry: { type: e.type === 'market' ? 'market' : 'limit', price: entry, zone_low: zl, zone_high: zh },
          stop_loss: sl,
          stop_reason: str(t.stop_reason),
          take_profits: tps,
          positions: {
            count: clamp(Math.round(num(t.positions && t.positions.count) || 1), 1, 3),
            plan: str(t.positions && t.positions.plan),
          },
          invalidation: str(t.invalidation),
          management: str(t.management),
        };
      }
    }

    if (!axisOk) rejected.push('The price axis is not readable, so the prices cannot be trusted.');
    if (quality === 'poor') rejected.push('The chart quality is too low to trust.');
    if (score < MIN_SCORE) rejected.push(`Confluence is ${score}%, below the ${MIN_SCORE}% minimum.`);
    for (const k of MANDATORY) {
      if ((byKey[k] || 0) < 0.5) rejected.push(`Missing a required confirmation: ${labelOf(k)}.`);
    }
    if (rejected.length) {
      verdict = 'NO_TRADE';
      trade = null;
    }
  }

  const modelConf = clamp(num(raw.model_confidence) ?? score, 0, 100);
  let confidence = Math.round(score * 0.7 + modelConf * 0.3);
  if (quality === 'poor') confidence = Math.min(confidence, 45);
  if (!axisOk) confidence = Math.min(confidence, 40);
  if (verdict === 'NO_TRADE') confidence = Math.min(confidence, MIN_SCORE - 1);

  const dr = raw.dealing_range || {};
  const fib = raw.fibonacci || {};
  const amd = raw.amd || {};
  const liq = raw.liquidity || {};
  return {
    verdict,
    confidence,
    confluence_score: score,
    grade: score >= 90 ? 'A+' : score >= 80 ? 'A' : score >= 70 ? 'B' : 'C',
    min_score: MIN_SCORE,
    symbol: str(raw.symbol) || null,
    timeframe: str(raw.timeframe) || null,
    chart_quality: quality,
    price_axis_readable: axisOk,
    current_price: num(raw.current_price),
    htf_bias: ['bullish', 'bearish', 'neutral'].includes(raw.htf_bias) ? raw.htf_bias : 'neutral',
    narrative: str(raw.narrative),
    dealing_range: {
      high: num(dr.high),
      low: num(dr.low),
      equilibrium: num(dr.equilibrium),
      price_location: ['premium', 'discount', 'equilibrium'].includes(dr.price_location) ? dr.price_location : '',
    },
    amd: {
      phase: ['accumulation', 'manipulation', 'distribution', 'unclear'].includes(amd.phase) ? amd.phase : 'unclear',
      notes: str(amd.notes),
    },
    liquidity: { buy_side: levelList(liq.buy_side), sell_side: levelList(liq.sell_side), swept: str(liq.swept) },
    pd_arrays: pdList(raw.pd_arrays),
    structure: strList(raw.structure && raw.structure.events),
    fibonacci: {
      swing_high: num(fib.swing_high),
      swing_low: num(fib.swing_low),
      ote_low: num(fib.ote_low),
      ote_high: num(fib.ote_high),
      notes: str(fib.notes),
    },
    checklist,
    trade,
    rejected,
    wait_for: str(raw.wait_for) || null,
    risks: strList(raw.risks),
    model,
  };
}

// ---------- Gemini ----------
async function callGemini(model, parts, withThinking) {
  const body = {
    systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
    contents: [{ role: 'user', parts }],
    generationConfig: { responseMimeType: 'application/json', maxOutputTokens: 16384 },
  };
  if (withThinking && ['low', 'medium', 'high'].includes(THINKING)) {
    body.generationConfig.thinkingConfig = { thinkingLevel: THINKING };
  }
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': API_KEY },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(100000),
  });
  const rawText = await res.text();
  let data = null;
  try {
    data = JSON.parse(rawText);
  } catch {
    data = null;
  }
  if (!res.ok) {
    const err = new Error((data && data.error && data.error.message) || `Gemini error ${res.status}`);
    err.status = res.status;
    throw err;
  }
  const cand = data && data.candidates && data.candidates[0];
  const text =
    cand && cand.content && Array.isArray(cand.content.parts)
      ? cand.content.parts.filter((p) => typeof p.text === 'string' && !p.thought).map((p) => p.text).join('')
      : '';
  if (!text.trim()) {
    const reason = (data && data.promptFeedback && data.promptFeedback.blockReason) || (cand && cand.finishReason) || 'empty response';
    const err = new Error(`Gemini returned no analysis (${reason}).`);
    err.status = 502;
    throw err;
  }
  return text;
}

async function runModel(parts) {
  const models = [PRIMARY_MODEL, ...FALLBACK_MODELS.filter((m) => m !== PRIMARY_MODEL)];
  let lastErr;
  for (const model of models) {
    for (const thinking of [true, false]) {
      try {
        const text = await callGemini(model, parts, thinking);
        return { text, model };
      } catch (e) {
        lastErr = e;
        const fatal = e.status === 401 || e.status === 403 || /api key/i.test(e.message || '');
        if (fatal) throw e;
        if (thinking && e.status === 400 && /think/i.test(e.message || '')) continue; // retry same model without thinking
        break; // move on to the next model
      }
    }
  }
  throw lastErr;
}

// ---------- App ----------
const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(express.json({ limit: '30mb' }));
app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'no-referrer');
  next();
});

const hits = new Map();
function rateLimit(req, res, next) {
  const now = Date.now();
  const recent = (hits.get(req.ip) || []).filter((t) => now - t < 60000);
  if (recent.length >= RATE_LIMIT_PER_MIN) {
    return res.status(429).json({ error: 'Too many scans in a minute. Wait a moment and try again.' });
  }
  recent.push(now);
  hits.set(req.ip, recent);
  next();
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, arr] of hits) if (!arr.some((t) => now - t < 60000)) hits.delete(ip);
}, 300000).unref();

function safeEqual(a, b) {
  const A = Buffer.from(String(a));
  const B = Buffer.from(String(b));
  return A.length === B.length && crypto.timingSafeEqual(A, B);
}
function requireAccess(req, res, next) {
  if (!ACCESS_CODE) return next();
  if (safeEqual(req.get('x-access-code') || '', ACCESS_CODE)) return next();
  res.status(401).json({ error: 'Wrong or missing access code.' });
}

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/health', (req, res) => res.json({ ok: true }));
app.get('/api/config', (req, res) =>
  res.json({ requiresCode: Boolean(ACCESS_CODE), configured: Boolean(API_KEY), model: PRIMARY_MODEL, minScore: MIN_SCORE, minRR: MIN_RR, maxImages: MAX_IMAGES })
);

app.post('/api/scan', requireAccess, rateLimit, async (req, res) => {
  if (!API_KEY) return res.status(500).json({ error: 'GEMINI_API_KEY is not set on the server.' });
  const body = req.body || {};
  const images = Array.isArray(body.images) ? body.images : [];
  if (!images.length || images.length > MAX_IMAGES) {
    return res.status(400).json({ error: `Upload between 1 and ${MAX_IMAGES} charts.` });
  }
  for (const img of images) {
    if (!img || !ALLOWED_MIME.has(img.mime) || typeof img.data !== 'string' || img.data.length < 100 || img.data.length > 12000000) {
      return res.status(400).json({ error: 'One of the images is missing, too large, or not a PNG, JPG or WebP.' });
    }
  }

  const clean = (v) => str(v).replace(/[\r\n]+/g, ' ').slice(0, 200).trim();
  const symbol = clean(body.symbol);
  const timeframe = clean(body.timeframe);
  const notes = clean(body.notes);
  const multi = images.length > 1;
  const intro =
    `Analyse the attached chart${multi ? 's. They show the SAME instrument on different timeframes, so do a top-down read from the highest to the lowest timeframe you can identify' : ''}.\n` +
    `User-supplied context (may be blank; the image wins if they disagree): pair="${symbol}", timeframe="${timeframe}", notes="${notes}".\n` +
    `Minimum reward:risk to the final target is ${MIN_RR}. Return the JSON object only.`;

  const parts = [{ text: intro }];
  images.forEach((img, i) => {
    if (multi) parts.push({ text: `Chart ${i + 1} of ${images.length}:` });
    parts.push({ inline_data: { mime_type: img.mime, data: img.data } });
  });

  try {
    const { text, model } = await runModel(parts);
    res.json(finalize(parseJson(text), model));
  } catch (e) {
    console.error('Scan failed:', e.status || '', e.message);
    if (e.status === 429) return res.status(429).json({ error: 'Gemini quota or rate limit reached. Wait a minute, or check your AI Studio quota.' });
    if (e.status === 401 || e.status === 403 || /api key/i.test(e.message || '')) {
      return res.status(502).json({ error: 'Gemini rejected the API key. Check GEMINI_API_KEY in your Render environment.' });
    }
    if (e.name === 'TimeoutError' || e.name === 'AbortError') {
      return res.status(504).json({ error: 'The scan timed out. Try again, or set THINKING_LEVEL to low.' });
    }
    res.status(502).json({ error: e.message || 'The scan failed. Try again.' });
  }
});

app.use((err, req, res, next) => {
  if (err && err.type === 'entity.too.large') return res.status(413).json({ error: 'The images are too large. Upload fewer or smaller charts.' });
  if (err instanceof SyntaxError) return res.status(400).json({ error: 'Bad request.' });
  console.error(err);
  res.status(500).json({ error: 'Server error.' });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`OP1BOT chart scanner on port ${PORT} using ${PRIMARY_MODEL}`);
  if (!API_KEY) console.warn('Warning: GEMINI_API_KEY is not set.');
});
