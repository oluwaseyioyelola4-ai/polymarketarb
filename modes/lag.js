import { OrderType, Side } from '@polymarket/clob-client';

export function createLagMode() {
    const LAG_MIN_USDC = Number(process.env.LAG_MIN_USDC || 5);
    const LAG_MAX_USDC_RAW = Number(process.env.LAG_MAX_USDC || 10);
    const LAG_MAX_USDC = Math.max(LAG_MIN_USDC, LAG_MAX_USDC_RAW);
    // Spot movement (USD) within window to consider "meaningful"
    const LAG_SPOT_MOVE_USD = Number(process.env.LAG_SPOT_MOVE_USD || 15);
    // Required minimum market response (in probability points, e.g. 0.005 = 0.5¢)
    const LAG_MIN_MARKET_MOVE = Number(process.env.LAG_MIN_MARKET_MOVE || 0.005);
    // Take-profit target. You can specify either:
    // - LAG_TAKE_PROFIT_CENTS (fixed cents per share)
    // - LAG_TAKE_PROFIT_PCT (fraction of entry, e.g. 0.03 = 3%)
    // If both are set, PCT wins.
    const LAG_TAKE_PROFIT_CENTS = Number(process.env.LAG_TAKE_PROFIT_CENTS || 1.0);
    const LAG_TAKE_PROFIT_PCT = process.env.LAG_TAKE_PROFIT_PCT ? Number(process.env.LAG_TAKE_PROFIT_PCT) : null;
    // Dynamic TP: scale profit target by forecasted lag.
    // forecastedLagCents ~= |spotDeltaUsd| * centsPerUsd - marketMoveCents
    // targetCents = clamp(min, max, forecastedLagCents)
    const LAG_TAKE_PROFIT_MODE = String(process.env.LAG_TAKE_PROFIT_MODE || 'dynamic').toLowerCase(); // fixed|percent|dynamic
    // Minimum profit per share (cents). Hard floor across ALL TP modes.
    const LAG_MIN_PROFIT_CENTS = Number(process.env.LAG_MIN_PROFIT_CENTS || 1.0);
    const LAG_TP_MIN_CENTS = Number(process.env.LAG_TP_MIN_CENTS || 1.0);
    const LAG_TP_MAX_CENTS = Number(process.env.LAG_TP_MAX_CENTS || 10.0);
    const LAG_TP_CENTS_PER_USD = Number(process.env.LAG_TP_CENTS_PER_USD || 0.05);
    // Stop-loss: percent stop + optional dynamic (strict) stop.
    // - LAG_STOP_LOSS_PCT: classic stop (1% default)
    // - LAG_STOP_LOSS_MODE:
    //    - percent: only percent stop
    //    - dynamic: only dynamic stop based on forecasted lag
    //    - strict: use BOTH and pick the stricter stop (default)
    const LAG_STOP_LOSS_PCT = Number(process.env.LAG_STOP_LOSS_PCT || 0.01);
    const LAG_STOP_LOSS_MODE = String(process.env.LAG_STOP_LOSS_MODE || 'strict').toLowerCase();
    // Dynamic stop tuning: allowed loss (cents/share) = clamp(min,max, desiredProfitCents * riskFrac)
    const LAG_SL_MIN_CENTS = Number(process.env.LAG_SL_MIN_CENTS || 1.0);
    const LAG_SL_MAX_CENTS = Number(process.env.LAG_SL_MAX_CENTS || 3.0);
    const LAG_SL_RISK_FRAC = Number(process.env.LAG_SL_RISK_FRAC || 0.5);
    // Stop-loss noise guards
    const LAG_STOP_GRACE_MS = Number(process.env.LAG_STOP_GRACE_MS || 3000);
    const LAG_STOP_CONFIRM_TICKS = Number(process.env.LAG_STOP_CONFIRM_TICKS || 2);

    // Risk controls (lag mode)
    // Cap worst-case loss per trade (approx) to avoid blowing up during chop.
    const LAG_MAX_RISK_USDC = Number(process.env.LAG_MAX_RISK_USDC || 1.0);
    // Optional: if set, overrides LAG_MAX_RISK_USDC using a % of balance (paper/live).
    const LAG_RISK_PCT_BALANCE = process.env.LAG_RISK_PCT_BALANCE ? Number(process.env.LAG_RISK_PCT_BALANCE) : null;
    // Minimum risk/reward ratio required: TP profit cents must be >= RR * stop-loss cents.
    const LAG_MIN_RR = Number(process.env.LAG_MIN_RR || 1.5);
    // Extra cooldown after a stop-out (ms)
    const LAG_STOP_COOLDOWN_MS = Number(process.env.LAG_STOP_COOLDOWN_MS || 15000);
    // Cooldown between lag trades
    const LAG_COOLDOWN_MS = Number(process.env.LAG_COOLDOWN_MS || 1500);

    // --- Lag entry model (microstructure + fast/slow RTDS) ---
    // This is intentionally conservative: it prefers skipping trades over "mindless" entries.
    const LAG_ENTRY_MODEL = String(process.env.LAG_ENTRY_MODEL || 'micro').toLowerCase(); // basic|micro
    const LAG_FAST_SEC = Number(process.env.LAG_FAST_SEC || 2);     // ~"1s chart" proxy (uses sampled history)
    const LAG_SLOW_SEC = Number(process.env.LAG_SLOW_SEC || 30);    // "normal" horizon
    const LAG_HISTORY_SEC = Number(process.env.LAG_HISTORY_SEC || 120);
    const LAG_EDGE_MIN_CENTS = Number(process.env.LAG_EDGE_MIN_CENTS || 0.25);
    const LAG_MAX_SPREAD_CENTS = Number(process.env.LAG_MAX_SPREAD_CENTS || 3.0);
    const LAG_IMBALANCE_MIN = Number(process.env.LAG_IMBALANCE_MIN || 0.05); // 0..1
    const LAG_IMBALANCE_LEVELS = Number(process.env.LAG_IMBALANCE_LEVELS || 5);
    const LAG_SPIKE_USD = Number(process.env.LAG_SPIKE_USD || 80); // treat fast move >= this as spike
    const LAG_SPIKE_EXTRA_EDGE_CENTS = Number(process.env.LAG_SPIKE_EXTRA_EDGE_CENTS || 0.5);
    // Optional penalties (defaults 0) that let you still trade if it's profitable,
    // but require a bit more edge when conditions are sketchy.
    const LAG_WEAK_PRESSURE_EXTRA_EDGE_CENTS = Number(process.env.LAG_WEAK_PRESSURE_EXTRA_EDGE_CENTS || 0);
    const LAG_AGAINST_PRESSURE_EXTRA_EDGE_CENTS = Number(process.env.LAG_AGAINST_PRESSURE_EXTRA_EDGE_CENTS || 0);
    const LAG_SPIKE_DISAGREE_EXTRA_EDGE_CENTS = Number(process.env.LAG_SPIKE_DISAGREE_EXTRA_EDGE_CENTS || 0);
    // Used to convert BTC move (USD) to implied token move (cents). Defaults to TP mapping.
    const LAG_MODEL_CENTS_PER_USD = process.env.LAG_MODEL_CENTS_PER_USD ? Number(process.env.LAG_MODEL_CENTS_PER_USD) : LAG_TP_CENTS_PER_USD;

    // --- Binance volume / price-action indicators (used to refine entries) ---
    // These are soft factors by default: they adjust the required edge rather than hard-blocking.
    const LAG_USE_BINANCE_FLOW = String(process.env.LAG_USE_BINANCE_FLOW || 'true').toLowerCase() !== 'false';
    const LAG_FLOW_WINDOW_SEC = Number(process.env.LAG_FLOW_WINDOW_SEC || 10);
    const LAG_FLOW_BASELINE_SEC = Number(process.env.LAG_FLOW_BASELINE_SEC || 60);
    // Require recent volume-per-second to be at least this multiple of baseline (if baseline is available).
    const LAG_FLOW_MIN_RATIO = Number(process.env.LAG_FLOW_MIN_RATIO || 1.10);
    // Minimum buy/sell imbalance magnitude to consider flow as aligned.
    const LAG_FLOW_IMBALANCE_MIN = Number(process.env.LAG_FLOW_IMBALANCE_MIN || 0.05);
    // Edge penalties/bonus (cents) based on flow conditions.
    const LAG_FLOW_WEAK_EXTRA_EDGE_CENTS = Number(process.env.LAG_FLOW_WEAK_EXTRA_EDGE_CENTS || 0);
    const LAG_FLOW_AGAINST_EXTRA_EDGE_CENTS = Number(process.env.LAG_FLOW_AGAINST_EXTRA_EDGE_CENTS || 0.25);
    const LAG_FLOW_BONUS_EDGE_CENTS = Number(process.env.LAG_FLOW_BONUS_EDGE_CENTS || 0.15);

    // --- Lightweight online learning ("AI") ---
    // This is intentionally simple + local (no external LLM calls).
    // Learns a small linear model to predict token response (cents) from:
    // spot deltas + orderbook microstructure + Binance flow.
    const LAG_AI_ENABLE = String(process.env.LAG_AI_ENABLE || 'true').toLowerCase() !== 'false';
    const LAG_AI_LEARN = String(process.env.LAG_AI_LEARN || 'true').toLowerCase() !== 'false';
    const LAG_AI_MIN_SAMPLES = Number(process.env.LAG_AI_MIN_SAMPLES || 30);
    const LAG_AI_LR = Number(process.env.LAG_AI_LR || 0.02);
    const LAG_AI_L2 = Number(process.env.LAG_AI_L2 || 0.002);
    const LAG_AI_MAX_ABS_W = Number(process.env.LAG_AI_MAX_ABS_W || 5.0);
    // Blend AI prediction with the baseline cents-per-USD prediction once trained.
    // 0 => baseline only, 1 => AI only.
    const LAG_AI_BLEND = Number(process.env.LAG_AI_BLEND || 0.5);

    // Cross-feed consistency (when RTDS_SOURCE=auto, we still have both snapshots).
    // If Binance and Chainlink disagree too much, the "true" spot is uncertain; skip entries.
    const LAG_FEED_DISAGREE_USD = Number(process.env.LAG_FEED_DISAGREE_USD || 20);
    const LAG_FEED_DISAGREE_USD_HARD = Number(process.env.LAG_FEED_DISAGREE_USD_HARD || 150);
    const LAG_BINANCE_MAX_AGE_MS = Number(process.env.LAG_BINANCE_MAX_AGE_MS || 5000);
    const LAG_CHAINLINK_MAX_AGE_MS = Number(process.env.LAG_CHAINLINK_MAX_AGE_MS || 180000);

    // Online calibration: learn cents-per-USD mapping from recent observed market response.
    const LAG_CALIBRATE = String(process.env.LAG_CALIBRATE || 'true').toLowerCase() !== 'false';
    const LAG_CALIBRATE_ALPHA = Number(process.env.LAG_CALIBRATE_ALPHA || 0.15); // EMA weight
    const LAG_CALIBRATE_MIN_SAMPLES = Number(process.env.LAG_CALIBRATE_MIN_SAMPLES || 8);
    const LAG_CALIBRATE_MIN_CENTS_PER_USD = Number(process.env.LAG_CALIBRATE_MIN_CENTS_PER_USD || 0.005);
    const LAG_CALIBRATE_MAX_CENTS_PER_USD = Number(process.env.LAG_CALIBRATE_MAX_CENTS_PER_USD || 0.25);

    // Entry confirmation: require the signal to persist N book polls before entering.
    const LAG_ENTRY_CONFIRM_TICKS = Number(process.env.LAG_ENTRY_CONFIRM_TICKS || 2);

    function pushSpotSample(ctx, spot) {
        const t = Number.isFinite(ctx.state.underlying.exchangeTimestampMs)
            ? ctx.state.underlying.exchangeTimestampMs
            : Date.now();
        if (!Number.isFinite(spot) || !(spot > 0)) return;
        if (!ctx.state.lag.spotHistory) ctx.state.lag.spotHistory = [];
        const hist = ctx.state.lag.spotHistory;
        const last = hist.length ? hist[hist.length - 1] : null;
        // De-dupe very frequent calls.
        if (last && Math.abs(t - last.t) < 250) return;
        hist.push({ t, p: spot });
        const cutoff = t - Math.max(5, LAG_HISTORY_SEC) * 1000;
        while (hist.length && hist[0].t < cutoff) hist.shift();
    }

    function feedAgeMs(feed) {
        if (!feed) return null;
        const ts = Number.isFinite(feed.exchangeTimestampMs)
            ? feed.exchangeTimestampMs
            : (feed.lastUpdated ? feed.lastUpdated.getTime() : null);
        if (!Number.isFinite(ts)) return null;
        return Math.max(0, Date.now() - ts);
    }

    function feedDisagreementUsd(ctx) {
        if (ctx?.RTDS_SOURCE && String(ctx.RTDS_SOURCE).toLowerCase() !== 'auto') return null;
        const bFeed = ctx.state.underlyingFeeds?.binance_ws;
        const cFeed = ctx.state.underlyingFeeds?.chainlink;
        const b = bFeed?.price;
        const c = cFeed?.price;
        if (!Number.isFinite(b) || !Number.isFinite(c) || !(b > 0) || !(c > 0)) return null;

        // Only compare when both feeds are fresh enough.
        // Chainlink updates are naturally slower; a stale Chainlink price should not block entries.
        const bAge = feedAgeMs(bFeed);
        const cAge = feedAgeMs(cFeed);
        if (!Number.isFinite(bAge) || !Number.isFinite(cAge)) return null;
        if (Number.isFinite(LAG_BINANCE_MAX_AGE_MS) && bAge > LAG_BINANCE_MAX_AGE_MS) return null;
        if (Number.isFinite(LAG_CHAINLINK_MAX_AGE_MS) && cAge > LAG_CHAINLINK_MAX_AGE_MS) return null;

        return Math.abs(b - c);
    }

    function getModelCentsPerUsd(ctx) {
        const learned = ctx.state.lag?.modelCentsPerUsd;
        if (Number.isFinite(learned) && learned > 0) return learned;
        return (Number.isFinite(LAG_MODEL_CENTS_PER_USD) && LAG_MODEL_CENTS_PER_USD > 0) ? LAG_MODEL_CENTS_PER_USD : 0;
    }

    function getBinanceFlow(ctx) {
        if (!LAG_USE_BINANCE_FLOW) return null;
        const feed = ctx.state.underlyingFeeds?.binance_ws;
        const trades = feed?.trades;
        if (!Array.isArray(trades) || trades.length < 5) return null;

        const nowT = Number.isFinite(feed.exchangeTimestampMs) ? feed.exchangeTimestampMs : Date.now();
        const winMs = Math.max(1, (Number.isFinite(LAG_FLOW_WINDOW_SEC) ? LAG_FLOW_WINDOW_SEC : 10)) * 1000;
        const baseMs = Math.max(winMs, (Number.isFinite(LAG_FLOW_BASELINE_SEC) ? LAG_FLOW_BASELINE_SEC : 60) * 1000);
        const winCut = nowT - winMs;
        const baseCut = nowT - baseMs;

        let winQuote = 0;
        let winBuyQuote = 0;
        let winSellQuote = 0;
        let winFirstP = null;
        let winLastP = null;

        let baseQuote = 0;

        for (let i = trades.length - 1; i >= 0; i--) {
            const tr = trades[i];
            const t = tr?.t;
            if (!Number.isFinite(t)) continue;
            if (t < baseCut) break;
            const p = tr?.p;
            const q = tr?.q;
            if (!Number.isFinite(p) || !Number.isFinite(q) || !(p > 0) || !(q > 0)) continue;
            const quote = p * q;
            baseQuote += quote;
            if (t >= winCut) {
                winQuote += quote;
                // Binance @trade: m=true means buyer is maker => taker SELL; m=false => taker BUY.
                const takerSell = !!tr?.m;
                if (takerSell) winSellQuote += quote;
                else winBuyQuote += quote;
                if (!Number.isFinite(winLastP)) winLastP = p;
                winFirstP = p;
            }
        }

        if (!(winQuote > 0) || !Number.isFinite(winFirstP) || !Number.isFinite(winLastP)) return null;

        const imbDen = winBuyQuote + winSellQuote;
        const imbalance = imbDen > 0 ? (winBuyQuote - winSellQuote) / imbDen : 0;
        const priceDeltaUsd = winLastP - winFirstP;
        const winPerSec = winQuote / Math.max(1, winMs / 1000);
        const basePerSec = baseQuote / Math.max(1, baseMs / 1000);
        const volRatio = (basePerSec > 0) ? (winPerSec / basePerSec) : null;

        return {
            winVolUsd: winQuote,
            baseVolUsd: baseQuote,
            volRatio,
            imbalance,
            priceDeltaUsd
        };
    }

    function aiModelState(ctx) {
        if (!ctx.state.lag._ai) ctx.state.lag._ai = { n: 0, b: 0, w: {} };
        return ctx.state.lag._ai;
    }

    function clampAbs(x, maxAbs) {
        const m = Number.isFinite(maxAbs) ? Math.abs(maxAbs) : 0;
        if (!(m > 0) || !Number.isFinite(x)) return x;
        return Math.max(-m, Math.min(m, x));
    }

    function buildAiFeatures({ spotDeltaFast, spotDeltaSlow, spotDeltaBaseline, pressure, flow }) {
        // Normalize to keep updates stable.
        const f = {};
        // Spot deltas in $; scale down.
        f.dFast = (Number.isFinite(spotDeltaFast) ? spotDeltaFast : 0) / 50;
        f.dSlow = (Number.isFinite(spotDeltaSlow) ? spotDeltaSlow : 0) / 200;
        f.dBase = (Number.isFinite(spotDeltaBaseline) ? spotDeltaBaseline : 0) / 200;

        // Microstructure: spread in cents, imbalance [-1..1], microPressure in probability points.
        f.spread = (Number.isFinite(pressure?.spreadCents) ? pressure.spreadCents : 0) / 5;
        f.imb = Number.isFinite(pressure?.imbalance) ? pressure.imbalance : 0;
        f.micro = (Number.isFinite(pressure?.microPressure) ? pressure.microPressure : 0) * 100; // -> cents-ish

        // Flow: vol ratio centered at 1, imbalance [-1..1], price delta ($)
        const vr = Number.isFinite(flow?.volRatio) ? flow.volRatio : null;
        f.vr = (vr && vr > 0) ? clampAbs((vr - 1), 5) : 0;
        f.fimb = Number.isFinite(flow?.imbalance) ? flow.imbalance : 0;
        f.fpx = (Number.isFinite(flow?.priceDeltaUsd) ? flow.priceDeltaUsd : 0) / 50;

        // Bias term is handled separately.
        return f;
    }

    function aiPredictCents(ctx, features) {
        if (!LAG_AI_ENABLE) return null;
        const s = aiModelState(ctx);
        if (!s || !s.w) return null;
        let y = Number.isFinite(s.b) ? s.b : 0;
        for (const k of Object.keys(features || {})) {
            const x = features[k];
            const w = s.w[k];
            if (!Number.isFinite(x) || !Number.isFinite(w)) continue;
            y += w * x;
        }
        // Prevent extreme predictions; keep within [0, 20] cents.
        if (!Number.isFinite(y)) return null;
        return Math.max(0, Math.min(20, y));
    }

    function aiUpdate(ctx, { features, targetCents }) {
        if (!LAG_AI_ENABLE || !LAG_AI_LEARN) return;
        if (!features || !Number.isFinite(targetCents)) return;
        const s = aiModelState(ctx);
        const pred = aiPredictCents(ctx, features);
        if (!Number.isFinite(pred)) return;
        const err = targetCents - pred;
        const lr = Math.max(0.0001, Math.min(0.2, Number.isFinite(LAG_AI_LR) ? LAG_AI_LR : 0.02));
        const l2 = Math.max(0, Math.min(0.1, Number.isFinite(LAG_AI_L2) ? LAG_AI_L2 : 0.002));
        // Bias update
        s.b = clampAbs((Number.isFinite(s.b) ? s.b : 0) + lr * err, 20);
        // Weight updates
        for (const k of Object.keys(features)) {
            const x = features[k];
            if (!Number.isFinite(x) || x === 0) continue;
            const prev = Number.isFinite(s.w[k]) ? s.w[k] : 0;
            const next = prev + lr * (err * x - l2 * prev);
            s.w[k] = clampAbs(next, LAG_AI_MAX_ABS_W);
        }
        s.n = (s.n || 0) + 1;
    }

    function maybeUpdateCalibration(ctx, { spotDeltaUsd, upDelta01, downDelta01 }) {
        if (!LAG_CALIBRATE) return;
        if (!Number.isFinite(spotDeltaUsd) || spotDeltaUsd === 0) return;
        if (!Number.isFinite(upDelta01) || !Number.isFinite(downDelta01)) return;

        // Use the "correct" side response only.
        const response01 = spotDeltaUsd > 0 ? Math.max(0, upDelta01) : Math.max(0, downDelta01);
        const responseCents = response01 * 100;
        const ratio = responseCents / Math.abs(spotDeltaUsd);
        if (!Number.isFinite(ratio) || ratio <= 0) return;

        const bounded = Math.max(LAG_CALIBRATE_MIN_CENTS_PER_USD, Math.min(LAG_CALIBRATE_MAX_CENTS_PER_USD, ratio));
        const s = ctx.state.lag;
        if (!s._cal) s._cal = { n: 0, ema: null };
        s._cal.n = (s._cal.n || 0) + 1;
        if (!Number.isFinite(s._cal.ema)) {
            s._cal.ema = bounded;
        } else {
            const a = Math.max(0.01, Math.min(0.75, Number.isFinite(LAG_CALIBRATE_ALPHA) ? LAG_CALIBRATE_ALPHA : 0.15));
            s._cal.ema = (1 - a) * s._cal.ema + a * bounded;
        }
        if (s._cal.n >= LAG_CALIBRATE_MIN_SAMPLES) {
            s.modelCentsPerUsd = s._cal.ema;
        }
    }

    function spotDeltaOverSeconds(ctx, seconds) {
        const hist = ctx.state.lag.spotHistory;
        if (!Array.isArray(hist) || hist.length < 2) return null;
        const now = hist[hist.length - 1];
        const targetT = now.t - Math.max(0.5, seconds) * 1000;
        // Find the latest sample at or before targetT.
        let prior = null;
        for (let i = hist.length - 1; i >= 0; i--) {
            const s = hist[i];
            if (s.t <= targetT) { prior = s; break; }
        }
        if (!prior) return null;
        const d = now.p - prior.p;
        return Number.isFinite(d) ? d : null;
    }

    function orderbookPressure({ bidsLevels, asksLevels }) {
        const bids = Array.isArray(bidsLevels) ? bidsLevels : [];
        const asks = Array.isArray(asksLevels) ? asksLevels : [];
        const bestBid = bids?.[0]?.price;
        const bestAsk = asks?.[0]?.price;
        if (!(bestBid > 0) || !(bestAsk > 0)) return null;
        const spreadCents = (bestAsk - bestBid) * 100;

        const n = Math.max(1, Math.floor(Number.isFinite(LAG_IMBALANCE_LEVELS) ? LAG_IMBALANCE_LEVELS : 5));
        const sumSize = (levels) => (levels || []).slice(0, n).reduce((acc, l) => acc + (Number.isFinite(l.size) ? l.size : 0), 0);
        const bidSize = sumSize(bids);
        const askSize = sumSize(asks);
        const denom = bidSize + askSize;
        const imbalance = denom > 0 ? (bidSize - askSize) / denom : 0;

        // Microprice using top-of-book sizes (more sensitive than mid for short-term pressure).
        const topBidSize = Number.isFinite(bids?.[0]?.size) ? bids[0].size : 0;
        const topAskSize = Number.isFinite(asks?.[0]?.size) ? asks[0].size : 0;
        const mid = (bestBid + bestAsk) / 2;
        const micro = (topBidSize + topAskSize) > 0
            ? (bestAsk * topBidSize + bestBid * topAskSize) / (topBidSize + topAskSize)
            : mid;
        const microPressure = micro - mid;

        return {
            bestBid,
            bestAsk,
            spreadCents: Number.isFinite(spreadCents) ? spreadCents : null,
            imbalance: Number.isFinite(imbalance) ? imbalance : 0,
            microPressure: Number.isFinite(microPressure) ? microPressure : 0
        };
    }

    function breakevenDeltaCents({ entryAsk01, feeBps }) {
        if (!Number.isFinite(entryAsk01) || !(entryAsk01 > 0)) return null;
        const buyMult = 1 + (Number.isFinite(feeBps) ? feeBps : 0) / 10000;
        const sellMult = 1 - (Number.isFinite(feeBps) ? feeBps : 0) / 10000;
        if (!(sellMult > 0)) return null;
        const breakEvenSell = (entryAsk01 * buyMult) / sellMult;
        if (!Number.isFinite(breakEvenSell)) return null;
        return Math.max(0, (breakEvenSell - entryAsk01) * 100);
    }

    async function confirmFokFilled(ctx, orderResp, expectedShares) {
        if (!orderResp) return { ok: false, reason: 'No response' };
        if (orderResp.success !== true) return { ok: false, reason: orderResp.errorMsg || 'Order rejected' };
        const orderID = orderResp.orderID;
        if (!orderID) return { ok: false, reason: 'Missing orderID' };
        try {
            const ord = await ctx.clobClient.getOrder(orderID);
            const matched = Number.parseFloat(ord?.size_matched);
            const original = Number.parseFloat(ord?.original_size);
            const target = Number.isFinite(original) ? original : expectedShares;
            if (Number.isFinite(matched) && matched + 1e-9 >= target) return { ok: true, reason: null, orderID };
            return { ok: false, reason: `Not filled (matched ${matched || 0} < ${target})`, orderID };
        } catch {
            // Fallback: best-effort infer fill from response amounts.
            const making = Number.parseFloat(orderResp.makingAmount);
            if (Number.isFinite(making) && making + 1e-9 >= expectedShares) return { ok: true, reason: null, orderID };
            return { ok: false, reason: 'Unable to confirm fill', orderID };
        }
    }

    function computeTargetSellPrice01({ entryLimitPrice01, profitCents, buyFeeBps, sellFeeBps }) {
        const desiredProfitUsdcPerShare = profitCents / 100;
        const buyMult = 1 + (Number.isFinite(buyFeeBps) ? buyFeeBps : 0) / 10000;
        const sellMult = 1 - (Number.isFinite(sellFeeBps) ? sellFeeBps : 0) / 10000;
        if (!(sellMult > 0)) return null;
        const numer = entryLimitPrice01 * buyMult + desiredProfitUsdcPerShare;
        const sRaw = numer / sellMult;
        if (!Number.isFinite(sRaw)) return null;
        // If the required sell price is at/above the market cap (99¢), profit is not realistically achievable.
        if (sRaw >= 0.99) return null;
        const s = Math.min(0.99, Math.max(0.001, sRaw));
        if (!(s > entryLimitPrice01)) return null;
        return s;
    }

    function maxAchievableProfitCentsAtCap({ entryLimitPrice01, feeBps, capPrice01 = 0.99 }) {
        if (!Number.isFinite(entryLimitPrice01) || !Number.isFinite(feeBps)) return null;
        if (!(capPrice01 > 0)) return null;
        const entryCost = ctxHelpersApplyTakerFeeOnBuy(entryLimitPrice01, feeBps);
        const bestExitProceeds = ctxHelpersApplyTakerFeeOnSell(capPrice01, feeBps);
        if (!Number.isFinite(entryCost) || !Number.isFinite(bestExitProceeds)) return null;
        return (bestExitProceeds - entryCost) * 100;
    }

    function profitCentsForEntry({ entryPrice01, spotDeltaUsd, sideMarketMove01 }) {
        const minProfit = (Number.isFinite(LAG_MIN_PROFIT_CENTS) && LAG_MIN_PROFIT_CENTS > 0) ? LAG_MIN_PROFIT_CENTS : 0;

        if (LAG_TAKE_PROFIT_MODE === 'fixed') return Math.max(minProfit, LAG_TAKE_PROFIT_CENTS);

        if (LAG_TAKE_PROFIT_MODE === 'percent') {
            if (Number.isFinite(LAG_TAKE_PROFIT_PCT) && LAG_TAKE_PROFIT_PCT > 0 && Number.isFinite(entryPrice01) && entryPrice01 > 0) {
                return Math.max(minProfit, entryPrice01 * 100 * LAG_TAKE_PROFIT_PCT);
            }
            return Math.max(minProfit, LAG_TAKE_PROFIT_CENTS);
        }

        // dynamic (default)
        // If user explicitly set a percent TP but left mode at default, honor the percent.
        if (!process.env.LAG_TAKE_PROFIT_MODE && Number.isFinite(LAG_TAKE_PROFIT_PCT) && LAG_TAKE_PROFIT_PCT > 0 && Number.isFinite(entryPrice01) && entryPrice01 > 0) {
            return Math.max(minProfit, entryPrice01 * 100 * LAG_TAKE_PROFIT_PCT);
        }

        const centsPerUsd = Number.isFinite(LAG_TP_CENTS_PER_USD) && LAG_TP_CENTS_PER_USD > 0 ? LAG_TP_CENTS_PER_USD : 0;
        const minC = Number.isFinite(LAG_TP_MIN_CENTS) ? LAG_TP_MIN_CENTS : 0;
        const maxC = Number.isFinite(LAG_TP_MAX_CENTS) ? LAG_TP_MAX_CENTS : minC;
        const spotMoveUsd = Number.isFinite(spotDeltaUsd) ? Math.abs(spotDeltaUsd) : 0;
        const forecastCents = spotMoveUsd * centsPerUsd;
        const marketMoveCents = (Number.isFinite(sideMarketMove01) && sideMarketMove01 > 0) ? (sideMarketMove01 * 100) : 0;
        const lagCents = Math.max(0, forecastCents - marketMoveCents);
        return Math.max(minProfit, Math.max(minC, Math.min(maxC, lagCents)));
    }

    function stopLossCentsForEntry(desiredProfitCents) {
        const minC = Number.isFinite(LAG_SL_MIN_CENTS) ? LAG_SL_MIN_CENTS : 0;
        const maxC = Number.isFinite(LAG_SL_MAX_CENTS) ? LAG_SL_MAX_CENTS : minC;
        const frac = Number.isFinite(LAG_SL_RISK_FRAC) ? LAG_SL_RISK_FRAC : 0.5;
        const base = Number.isFinite(desiredProfitCents) ? desiredProfitCents : 0;
        const dyn = base * frac;
        return Math.max(minC, Math.min(maxC, dyn));
    }

    function computeStopPrice01({ entryPrice01, desiredProfitCents }) {
        if (!Number.isFinite(entryPrice01) || !(entryPrice01 > 0)) return null;

        const pct = Number.isFinite(LAG_STOP_LOSS_PCT) ? LAG_STOP_LOSS_PCT : 0.01;
        const stopPct = entryPrice01 * (1 - pct);

        const lossCents = stopLossCentsForEntry(desiredProfitCents);
        const stopDyn = entryPrice01 - (lossCents / 100);

        const clamp01 = (x) => Math.min(0.99, Math.max(0.001, x));

        if (LAG_STOP_LOSS_MODE === 'percent') return clamp01(stopPct);
        if (LAG_STOP_LOSS_MODE === 'dynamic') return clamp01(stopDyn);
        // strict (default): pick the higher stop price (closer to entry) => triggers sooner
        return clamp01(Math.max(stopPct, stopDyn));

    }

    function clampInt(n, min, max) {
        const x = Math.floor(n);
        if (!Number.isFinite(x)) return min;
        return Math.max(min, Math.min(max, x));
    }

    function netLossPerShareAtStopUsdc({ entryPrice01, stopPrice01, feeBps }) {
        if (!Number.isFinite(entryPrice01) || !Number.isFinite(stopPrice01)) return null;
        // Approx worst-case (per share): entry cost incl buy fee minus proceeds at stop incl sell fee.
        const buy = ctxHelpersApplyTakerFeeOnBuy(entryPrice01, feeBps);
        const sell = ctxHelpersApplyTakerFeeOnSell(stopPrice01, feeBps);
        const loss = buy - sell;
        if (!Number.isFinite(loss)) return null;
        return Math.max(0, loss);
    }

    function maxRiskBudgetUsdc(ctx) {
        const fixed = Number.isFinite(LAG_MAX_RISK_USDC) ? LAG_MAX_RISK_USDC : 0;
        const pct = Number.isFinite(LAG_RISK_PCT_BALANCE) ? LAG_RISK_PCT_BALANCE : null;
        if (pct && pct > 0) {
            const bal = ctx.PAPER_TRADING ? ctx.getPaperBalance() : ctx.state.collateral.balanceUsdc;
            if (Number.isFinite(bal) && bal > 0) return Math.max(0, bal * pct);
        }
        return Math.max(0, fixed);
    }

    // Local wrappers to avoid depending on ctx in pure helpers.
    function ctxHelpersApplyTakerFeeOnBuy(amountUsdc, feeBps) {
        const bps = Number.isFinite(feeBps) ? feeBps : 0;
        return amountUsdc * (1 + bps / 10000);
    }

    function ctxHelpersApplyTakerFeeOnSell(proceedsUsdc, feeBps) {
        const bps = Number.isFinite(feeBps) ? feeBps : 0;
        return proceedsUsdc * (1 - bps / 10000);
    }

    async function executeLiveLagTrade(ctx, { tokenId, shares, limitPrice }) {
        if (ctx.PAPER_TRADING) return null;
        if (!ctx.ENABLE_LIVE_ORDERS) return null;
        if (!tokenId) throw new Error('Missing token id');
        if (!ctx.clobCreds) throw new Error('Missing CLOB API creds (CLOB_API_KEY/SECRET/PASSPHRASE)');

        // Best-effort collateral precheck. Exact cost depends on fill; for FOK, this is a reasonable upper bound.
        const feeBps = (tokenId === ctx.state.tokens.upTokenId) ? ctx.state.tokens.upFeeBps : ctx.state.tokens.downFeeBps;
        const estCost = ctx.helpers.applyTakerFeeOnBuy(shares * limitPrice, feeBps);
        const canSpend = ctx.helpers.liveCanSpendUsdc(estCost);
        if (!canSpend.ok) {
            ctx.log(`LIVE LAG ENTRY blocked: ${canSpend.reason}`, 'WARN');
            return null;
        }

        const order = {
            tokenID: tokenId,
            price: limitPrice,
            size: shares,
            side: Side.BUY
        };
        return ctx.clobClient.createAndPostOrder(order, undefined, OrderType.FOK, false);
    }

    async function executeLiveLagExit(ctx, { tokenId, shares, limitPrice }) {
        if (ctx.PAPER_TRADING) return null;
        if (!ctx.ENABLE_LIVE_ORDERS) return null;
        if (!tokenId) throw new Error('Missing token id');
        if (!ctx.clobCreds) throw new Error('Missing CLOB API creds (CLOB_API_KEY/SECRET/PASSPHRASE)');
        const order = {
            tokenID: tokenId,
            price: limitPrice,
            size: shares,
            side: Side.SELL
        };
        return ctx.clobClient.createAndPostOrder(order, undefined, OrderType.FOK, false);
    }

    function evalLagSignal(ctx) {
        const spot = ctx.state.underlying.price;
        const up = ctx.state.orderbooks.up;
        const down = ctx.state.orderbooks.down;
        if (!Number.isFinite(spot) || !(spot > 0)) return;
        if (!up || !down) return;
        if (!(up.mark > 0) || !(down.mark > 0)) return;

        // Maintain a short rolling RTDS history so we can reason about spikes/dips
        // on a fast horizon (~seconds) AND a slower baseline.
        pushSpotSample(ctx, spot);

        // If feeds disagree, spot is uncertain; skip taking new lag entries.
        const disagree = feedDisagreementUsd(ctx);
        ctx.state.lag._feedDisagreeUsd = Number.isFinite(disagree) ? disagree : null;
        // Hard stop only on extreme divergence (likely stale/mispriced feed or USDT dislocation).
        if (Number.isFinite(disagree) && Number.isFinite(LAG_FEED_DISAGREE_USD_HARD) && disagree > LAG_FEED_DISAGREE_USD_HARD) {
            ctx.state.lag.lastEvalAt = new Date();
            ctx.state.lag.signal = 'LAG';
            ctx.state.lag.reason = `feeds diverge hard $${disagree.toFixed(2)}`;
            ctx.state.lag.suggestedSide = null;
            ctx.state.lag.suggestedSpend = null;
            ctx.state.lag.suggestedShares = null;
            ctx.state.lag.suggestedLimitPrice = null;
            ctx.state.lag._spotDeltaUsd = null;
            ctx.state.lag._sideMarketMove01 = null;
            return;
        }

        // Safety: do not suggest opening new positions shortly before interval ends.
        const endEpochSec = ctx.state.interval?.endEpochSec;
        const nowEpochSec = Date.now() / 1000;
        if (Number.isFinite(endEpochSec) && (endEpochSec - nowEpochSec) <= 60) {
            ctx.state.lag.lastEvalAt = new Date();
            ctx.state.lag.signal = null;
            ctx.state.lag.reason = null;
            ctx.state.lag.suggestedSide = null;
            ctx.state.lag.suggestedSpend = null;
            ctx.state.lag.suggestedShares = null;
            ctx.state.lag.suggestedLimitPrice = null;
            return;
        }

        ctx.state.lag.lastEvalAt = new Date();

        if (!Number.isFinite(ctx.state.lag.lastSpot) || ctx.state.lag.lastSpot === null) {
            ctx.state.lag.lastSpot = spot;
            ctx.state.lag.lastUpMid = up.mark;
            ctx.state.lag.lastDownMid = down.mark;
            return;
        }

        const spotDeltaBaseline = spot - ctx.state.lag.lastSpot;
        const spotDeltaFast = spotDeltaOverSeconds(ctx, LAG_FAST_SEC);
        const spotDeltaSlow = spotDeltaOverSeconds(ctx, LAG_SLOW_SEC);

        // If we don't have enough history yet, fall back to baseline delta.
        const spotDelta = Number.isFinite(spotDeltaFast) ? spotDeltaFast : spotDeltaBaseline;
        const spike = Number.isFinite(spotDeltaFast) && Math.abs(spotDeltaFast) >= (Number.isFinite(LAG_SPIKE_USD) ? LAG_SPIKE_USD : 80);
        const upDelta = up.mark - ctx.state.lag.lastUpMid;
        const downDelta = down.mark - ctx.state.lag.lastDownMid;

        // If either side has moved materially, consider the market as having responded.
        const marketDelta = Math.max(Math.abs(upDelta), Math.abs(downDelta));

        if (marketDelta >= LAG_MIN_MARKET_MOVE) {
            // If we were tracking a lag window, record how long it took to respond.
            const lat = ctx.state.lag._lat || (ctx.state.lag._lat = { n: 0, emaMs: null, lastMs: null, maxMs: null });
            const startMs = ctx.state.lag._lagStartMs;
            const nowMs = Number.isFinite(ctx.state.underlying.exchangeTimestampMs)
                ? ctx.state.underlying.exchangeTimestampMs
                : Date.now();
            if (Number.isFinite(startMs) && Number.isFinite(nowMs) && nowMs >= startMs) {
                const dt = nowMs - startMs;
                lat.n = (lat.n || 0) + 1;
                lat.lastMs = dt;
                lat.maxMs = Number.isFinite(lat.maxMs) ? Math.max(lat.maxMs, dt) : dt;
                const a = 0.15;
                lat.emaMs = Number.isFinite(lat.emaMs) ? ((1 - a) * lat.emaMs + a * dt) : dt;
            }
            ctx.state.lag._lagStartMs = null;
            ctx.state.lag._lagSide = null;
            ctx.state.lag._lagSpotDeltaUsd = null;

            // Market has responded: update calibration from how much the market moved per USD of spot move.
            maybeUpdateCalibration(ctx, { spotDeltaUsd: spotDeltaBaseline, upDelta01: upDelta, downDelta01: Math.max(0, -downDelta) });

            // Lightweight AI update: learn from the last captured feature snapshot.
            // Use the "correct" side response in cents.
            const last = ctx.state.lag._aiLast;
            if (last?.features) {
                const response01 = last.side === 'UP'
                    ? Math.max(0, upDelta)
                    : Math.max(0, Math.max(0, -downDelta));
                const responseCents = response01 * 100;
                if (Number.isFinite(responseCents) && responseCents >= 0) {
                    aiUpdate(ctx, { features: last.features, targetCents: responseCents });
                }
            }
            ctx.state.lag.lastSpot = spot;
            ctx.state.lag.lastUpMid = up.mark;
            ctx.state.lag.lastDownMid = down.mark;
            ctx.state.lag.signal = null;
            ctx.state.lag.reason = null;
            ctx.state.lag.suggestedSide = null;
            ctx.state.lag.suggestedSpend = null;
            ctx.state.lag.suggestedShares = null;
            ctx.state.lag.suggestedLimitPrice = null;
            ctx.state.lag._spotDeltaUsd = null;
            ctx.state.lag._sideMarketMove01 = null;
            return;
        }

        const meaningfulSpot = Math.abs(spotDelta) >= LAG_SPOT_MOVE_USD;
        if (!meaningfulSpot) {
            ctx.state.lag.signal = null;
            ctx.state.lag.reason = null;
            ctx.state.lag.suggestedSide = null;
            ctx.state.lag.suggestedSpend = null;
            ctx.state.lag.suggestedShares = null;
            ctx.state.lag.suggestedLimitPrice = null;
            ctx.state.lag._spotDeltaUsd = null;
            ctx.state.lag._sideMarketMove01 = null;
            return;
        }

        // Track the start of a lag window (spot moved meaningfully, market hasn't responded yet).
        // This helps validate the "30–90s stale" hypothesis and tune the entry loop.
        const lagNowMs = Number.isFinite(ctx.state.underlying.exchangeTimestampMs)
            ? ctx.state.underlying.exchangeTimestampMs
            : Date.now();
        const currSide = spotDelta > 0 ? 'UP' : 'DOWN';
        if (!Number.isFinite(ctx.state.lag._lagStartMs) || ctx.state.lag._lagSide !== currSide) {
            ctx.state.lag._lagStartMs = lagNowMs;
            ctx.state.lag._lagSide = currSide;
            ctx.state.lag._lagSpotDeltaUsd = spotDelta;
        }

        const spikeDisagree = spike && Number.isFinite(spotDeltaSlow) && Number.isFinite(spotDeltaFast)
            ? (Math.sign(spotDeltaFast) !== Math.sign(spotDeltaSlow))
            : false;

        const suggestedSide = currSide;
        const tokenId = suggestedSide === 'UP' ? ctx.state.tokens.upTokenId : ctx.state.tokens.downTokenId;
        const asks = suggestedSide === 'UP' ? ctx.state.orderbooks.upAsksLevels : ctx.state.orderbooks.downAsksLevels;
        const bids = suggestedSide === 'UP' ? ctx.state.orderbooks.upBidsLevels : ctx.state.orderbooks.downBidsLevels;
        const feeBps = suggestedSide === 'UP' ? ctx.state.tokens.upFeeBps : ctx.state.tokens.downFeeBps;

        if (!Number.isFinite(feeBps)) {
            ctx.state.lag.signal = 'LAG';
            ctx.state.lag.reason = 'fees unknown';
            ctx.state.lag.suggestedSide = suggestedSide;
            ctx.state.lag.suggestedSpend = null;
            ctx.state.lag.suggestedShares = null;
            ctx.state.lag.suggestedLimitPrice = null;
            return;
        }

        const maxUsdc = ctx.PAPER_TRADING ? Math.min(ctx.getPaperBalance(), LAG_MAX_USDC) : LAG_MAX_USDC;
        if (!(maxUsdc >= LAG_MIN_USDC)) {
            ctx.state.lag.signal = 'LAG';
            ctx.state.lag.reason = 'Budget < min';
            ctx.state.lag.suggestedSide = suggestedSide;
            ctx.state.lag.suggestedSpend = null;
            ctx.state.lag.suggestedShares = null;
            ctx.state.lag.suggestedLimitPrice = null;
            return;
        }

        const fillBudget = ctx.helpers.maxSharesForBudget(asks, feeBps, maxUsdc, 1);

        // Capture a feature snapshot for the lightweight AI model.
        // We do this before gating so the model learns from both good/bad situations.
        const flowForAi = getBinanceFlow(ctx);
        const pressureForAi = orderbookPressure({ bidsLevels: bids, asksLevels: asks });
        ctx.state.lag._aiLast = {
            side: suggestedSide,
            features: buildAiFeatures({
                spotDeltaFast,
                spotDeltaSlow,
                spotDeltaBaseline,
                pressure: pressureForAi,
                flow: flowForAi
            })
        };

        // --- Microstructure-aware gating ---
        if (LAG_ENTRY_MODEL === 'micro') {
            const pressure = orderbookPressure({ bidsLevels: bids, asksLevels: asks });
            if (!pressure) {
                ctx.state.lag.signal = 'LAG';
                ctx.state.lag.reason = 'no book pressure';
                ctx.state.lag.suggestedSide = suggestedSide;
                ctx.state.lag.suggestedSpend = null;
                ctx.state.lag.suggestedShares = null;
                ctx.state.lag.suggestedLimitPrice = null;
                return;
            }

            if (Number.isFinite(pressure.spreadCents) && pressure.spreadCents > LAG_MAX_SPREAD_CENTS) {
                ctx.state.lag.signal = 'LAG';
                ctx.state.lag.reason = `spread too wide (${pressure.spreadCents.toFixed(2)}¢)`;
                ctx.state.lag.suggestedSide = suggestedSide;
                ctx.state.lag.suggestedSpend = null;
                ctx.state.lag.suggestedShares = null;
                ctx.state.lag.suggestedLimitPrice = null;
                return;
            }

            // Pressure is now a soft factor: we may still trade if profitable,
            // but optionally require more edge when pressure is weak/against us.
            const pressureOk = (pressure.imbalance >= LAG_IMBALANCE_MIN) || (pressure.microPressure > 0);
            const againstPressure = (pressure.imbalance <= -Math.abs(LAG_IMBALANCE_MIN)) && (pressure.microPressure < 0);

            // Predict whether the token price move is large enough to overcome fees+spread.
            const entryAsk01 = fillBudget?.maxPrice;
            const quoteBuy = suggestedSide === 'UP' ? ctx.state.orderbooks.quoteUpBuy : ctx.state.orderbooks.quoteDownBuy;
            // Use the worse of (book sweep) and (quote) for breakeven estimation.
            const effectiveAsk01 = (Number.isFinite(entryAsk01) && Number.isFinite(quoteBuy) && quoteBuy > 0)
                ? Math.max(entryAsk01, quoteBuy)
                : entryAsk01;
            const beDelta = breakevenDeltaCents({ entryAsk01: effectiveAsk01, feeBps });
            const modelCentsPerUsd = getModelCentsPerUsd(ctx);
            const predictedMoveCentsBase = Math.abs(spotDelta) * modelCentsPerUsd;
            // AI prediction (cents) from feature snapshot; blend once trained.
            const ai = ctx.state.lag?._ai;
            const aiOk = LAG_AI_ENABLE && Number.isFinite(ai?.n) && ai.n >= (Number.isFinite(LAG_AI_MIN_SAMPLES) ? LAG_AI_MIN_SAMPLES : 30);
            const aiPred = aiOk ? aiPredictCents(ctx, ctx.state.lag._aiLast?.features) : null;
            const blend = aiOk ? Math.max(0, Math.min(1, Number.isFinite(LAG_AI_BLEND) ? LAG_AI_BLEND : 0.5)) : 0;
            const predictedMoveCents = (Number.isFinite(aiPred))
                ? ((1 - blend) * predictedMoveCentsBase + blend * aiPred)
                : predictedMoveCentsBase;
            const observedMoveCents = ((suggestedSide === 'UP') ? Math.max(0, (up.mark - ctx.state.lag.lastUpMid)) : Math.max(0, (down.mark - ctx.state.lag.lastDownMid))) * 100;
            const lagCents = Math.max(0, predictedMoveCents - observedMoveCents);
            const weakPressurePenalty = (!pressureOk && Number.isFinite(LAG_WEAK_PRESSURE_EXTRA_EDGE_CENTS)) ? LAG_WEAK_PRESSURE_EXTRA_EDGE_CENTS : 0;
            const againstPressurePenalty = (againstPressure && Number.isFinite(LAG_AGAINST_PRESSURE_EXTRA_EDGE_CENTS)) ? LAG_AGAINST_PRESSURE_EXTRA_EDGE_CENTS : 0;
            const spikeDisagreePenalty = (spikeDisagree && Number.isFinite(LAG_SPIKE_DISAGREE_EXTRA_EDGE_CENTS)) ? LAG_SPIKE_DISAGREE_EXTRA_EDGE_CENTS : 0;

            // Binance flow / volume / price action (soft adjustments)
            const flow = getBinanceFlow(ctx);
            let flowWeakPenalty = 0;
            let flowAgainstPenalty = 0;
            let flowBonus = 0;
            let flowTag = '';
            if (flow) {
                const ratioOk = (!Number.isFinite(flow.volRatio) || !Number.isFinite(LAG_FLOW_MIN_RATIO))
                    ? true
                    : (flow.volRatio >= LAG_FLOW_MIN_RATIO);

                const imbMin = Number.isFinite(LAG_FLOW_IMBALANCE_MIN) ? Math.abs(LAG_FLOW_IMBALANCE_MIN) : 0;
                const imb = Number.isFinite(flow.imbalance) ? flow.imbalance : 0;
                const px = Number.isFinite(flow.priceDeltaUsd) ? flow.priceDeltaUsd : 0;

                const alignedImb = suggestedSide === 'UP' ? (imb >= imbMin) : (imb <= -imbMin);
                const againstImb = suggestedSide === 'UP' ? (imb <= -imbMin) : (imb >= imbMin);
                const alignedPx = suggestedSide === 'UP' ? (px >= 0) : (px <= 0);
                const againstPx = suggestedSide === 'UP' ? (px < 0) : (px > 0);

                const flowOk = ratioOk && (alignedImb || alignedPx);
                const flowAgainst = (!ratioOk) ? false : (againstImb && againstPx);

                if (!flowOk && Number.isFinite(LAG_FLOW_WEAK_EXTRA_EDGE_CENTS)) flowWeakPenalty = LAG_FLOW_WEAK_EXTRA_EDGE_CENTS;
                if (flowAgainst && Number.isFinite(LAG_FLOW_AGAINST_EXTRA_EDGE_CENTS)) flowAgainstPenalty = LAG_FLOW_AGAINST_EXTRA_EDGE_CENTS;
                if (flowOk && Number.isFinite(LAG_FLOW_BONUS_EDGE_CENTS)) flowBonus = Math.max(0, LAG_FLOW_BONUS_EDGE_CENTS);

                const rStr = Number.isFinite(flow.volRatio) ? flow.volRatio.toFixed(2) : '—';
                flowTag = ` | flow r=${rStr} imb=${imb.toFixed(2)} px=${px >= 0 ? '+' : ''}${px.toFixed(1)}`;
            }

            const needed = (Number.isFinite(beDelta) ? beDelta : 0)
                + (Number.isFinite(pressure.spreadCents) ? pressure.spreadCents : 0)
                + (Number.isFinite(LAG_EDGE_MIN_CENTS) ? LAG_EDGE_MIN_CENTS : 0)
                + (spike ? (Number.isFinite(LAG_SPIKE_EXTRA_EDGE_CENTS) ? LAG_SPIKE_EXTRA_EDGE_CENTS : 0) : 0)
                + weakPressurePenalty
                + againstPressurePenalty
                + spikeDisagreePenalty
                + flowWeakPenalty
                + flowAgainstPenalty
                - flowBonus;

            const neededClamped = Math.max(0, needed);

            if (!(lagCents >= neededClamped)) {
                ctx.state.lag.signal = 'LAG';
                const pressTag = pressureOk ? '' : (againstPressure ? ' | PRESSURE_AGAINST' : ' | PRESSURE_WEAK');
                const spikeTag = spikeDisagree ? ' | SPIKE_SLOW_DISAGREE' : '';
                ctx.state.lag.reason = `edge too small (lag ${lagCents.toFixed(2)}¢ < need ${neededClamped.toFixed(2)}¢)${pressTag}${spikeTag}${flowTag}`;
                ctx.state.lag.suggestedSide = suggestedSide;
                ctx.state.lag.suggestedSpend = null;
                ctx.state.lag.suggestedShares = null;
                ctx.state.lag.suggestedLimitPrice = null;
                ctx.state.lag._spotDeltaUsd = null;
                ctx.state.lag._sideMarketMove01 = null;
                return;
            }
        }

        // Persist current lag context for dynamic TP calculation.
        ctx.state.lag._spotDeltaUsd = spotDelta;
        ctx.state.lag._sideMarketMove01 = (suggestedSide === 'UP') ? Math.max(0, upDelta) : Math.max(0, downDelta);

        // Risk-aware sizing + RR gating (use the budget-sized entry price as the first approximation).
        const entryPx0 = fillBudget?.maxPrice;
        let desiredProfitCents0 = null;
        let targetSell0 = null;
        let stop0 = null;
        let lossPerShare0 = null;
        if (Number.isFinite(entryPx0)) {
            desiredProfitCents0 = profitCentsForEntry({ entryPrice01: entryPx0, spotDeltaUsd: ctx.state.lag._spotDeltaUsd, sideMarketMove01: ctx.state.lag._sideMarketMove01 });
            targetSell0 = computeTargetSellPrice01({ entryLimitPrice01: entryPx0, profitCents: desiredProfitCents0, buyFeeBps: feeBps, sellFeeBps: feeBps });
            stop0 = computeStopPrice01({ entryPrice01: entryPx0, desiredProfitCents: desiredProfitCents0 });
            lossPerShare0 = (stop0 > 0) ? netLossPerShareAtStopUsdc({ entryPrice01: entryPx0, stopPrice01: stop0, feeBps }) : null;
        }

        const riskBudget = maxRiskBudgetUsdc(ctx);
        const riskShares = (riskBudget > 0 && lossPerShare0 > 0) ? clampInt(riskBudget / lossPerShare0, 0, 1e9) : 0;
        const sharesTarget = (fillBudget?.shares > 0) ? Math.max(0, Math.min(fillBudget.shares, riskShares || 0)) : 0;

        // If risk cap forces size to 0, don't suggest an entry.
        if (!(sharesTarget >= 1)) {
            ctx.state.lag.signal = 'LAG';
            ctx.state.lag.reason = 'risk cap blocks trade';
            ctx.state.lag.suggestedSide = suggestedSide;
            ctx.state.lag.suggestedSpend = null;
            ctx.state.lag.suggestedShares = null;
            ctx.state.lag.suggestedLimitPrice = null;
            return;
        }

        // Recompute fill at the risk-sized shares to get the actual entry limit price.
        const fill = ctx.helpers.costToBuySharesFromAsks(asks, sharesTarget, feeBps);
        if (!fill) {
            ctx.state.lag.signal = 'LAG';
            ctx.state.lag.reason = 'insufficient depth';
            ctx.state.lag.suggestedSide = suggestedSide;
            ctx.state.lag.suggestedSpend = null;
            ctx.state.lag.suggestedShares = null;
            ctx.state.lag.suggestedLimitPrice = null;
            return;
        }

        // Apply RR gating using the recomputed entry/stop.
        const entryPx = fill.maxPrice;
        const desiredProfitCents = profitCentsForEntry({ entryPrice01: entryPx, spotDeltaUsd: ctx.state.lag._spotDeltaUsd, sideMarketMove01: ctx.state.lag._sideMarketMove01 });
        const targetSell = computeTargetSellPrice01({ entryLimitPrice01: entryPx, profitCents: desiredProfitCents, buyFeeBps: feeBps, sellFeeBps: feeBps });
        if (!(targetSell > 0)) {
            ctx.state.lag.signal = 'LAG';
            ctx.state.lag.reason = 'tp unreachable';
            ctx.state.lag.suggestedSide = suggestedSide;
            ctx.state.lag.suggestedSpend = null;
            ctx.state.lag.suggestedShares = null;
            ctx.state.lag.suggestedLimitPrice = null;
            return;
        }

        const stopPrice = computeStopPrice01({ entryPrice01: entryPx, desiredProfitCents });
        const lossPerShare = (stopPrice > 0) ? netLossPerShareAtStopUsdc({ entryPrice01: entryPx, stopPrice01: stopPrice, feeBps }) : null;
        const lossCents = Number.isFinite(lossPerShare) ? (lossPerShare * 100) : null;
        const rrMin = Number.isFinite(LAG_MIN_RR) ? LAG_MIN_RR : 1.0;
        if (!(Number.isFinite(lossCents) && lossCents > 0 && desiredProfitCents >= rrMin * lossCents)) {
            ctx.state.lag.signal = 'LAG';
            ctx.state.lag.reason = 'RR too low';
            ctx.state.lag.suggestedSide = suggestedSide;
            ctx.state.lag.suggestedSpend = null;
            ctx.state.lag.suggestedShares = null;
            ctx.state.lag.suggestedLimitPrice = null;
            return;
        }

        // If even a move to 99¢ cannot meet take-profit after fees, don't suggest an entry.
        const entryLimit = fill?.maxPrice;
        if (Number.isFinite(entryLimit)) {
            const maxProfitCents = maxAchievableProfitCentsAtCap({ entryLimitPrice01: entryLimit, feeBps, capPrice01: 0.99 });
            const desiredProfitCents = profitCentsForEntry({ entryPrice01: entryLimit, spotDeltaUsd: ctx.state.lag._spotDeltaUsd, sideMarketMove01: ctx.state.lag._sideMarketMove01 });
            if (!Number.isFinite(maxProfitCents) || maxProfitCents + 1e-6 < desiredProfitCents) {
                ctx.state.lag.signal = 'LAG';
                ctx.state.lag.reason = 'no room to profit (near cap)';
                ctx.state.lag.suggestedSide = suggestedSide;
                ctx.state.lag.suggestedSpend = null;
                ctx.state.lag.suggestedShares = null;
                ctx.state.lag.suggestedLimitPrice = null;
                return;
            }
        }

        ctx.state.lag.signal = 'LAG';
        const fastStr = Number.isFinite(spotDeltaFast) ? `${spotDeltaFast >= 0 ? '+' : ''}${spotDeltaFast.toFixed(2)}` : '—';
        const slowStr = Number.isFinite(spotDeltaSlow) ? `${spotDeltaSlow >= 0 ? '+' : ''}${spotDeltaSlow.toFixed(2)}` : '—';
        const spikeStr = spike ? ' | SPIKE' : '';
        const spikeDisagreeStr = spikeDisagree ? ' | SPIKE_SLOWX' : '';
        const modelStr = Number.isFinite(ctx.state.lag?.modelCentsPerUsd) ? ` | k=${ctx.state.lag.modelCentsPerUsd.toFixed(3)}c/$` : '';
        const feedDelta = ctx.state.lag?._feedDisagreeUsd;
        const feedStr = (Number.isFinite(feedDelta) && Number.isFinite(LAG_FEED_DISAGREE_USD) && feedDelta > LAG_FEED_DISAGREE_USD)
            ? ` | feedΔ=$${feedDelta.toFixed(1)}`
            : '';
        ctx.state.lag.reason = `spot f=${fastStr} s=${slowStr}${spikeStr}${spikeDisagreeStr}${modelStr}${feedStr} | up ${(upDelta * 100).toFixed(2)}¢ | dn ${(downDelta * 100).toFixed(2)}¢`;
        ctx.state.lag.suggestedSide = suggestedSide;
        ctx.state.lag.suggestedSpend = maxUsdc;
        ctx.state.lag.suggestedShares = sharesTarget;
        ctx.state.lag.suggestedLimitPrice = fill?.maxPrice ?? null;
        if (tokenId && sharesTarget && fill?.maxPrice) {
            // keep in state; execution uses these fields
        }
    }

    async function maybeExecuteLag(ctx) {
        if (ctx.state.lag.open) return;
        if (ctx.state.lag.signal !== 'LAG') return;

        // Entry confirm: require the same suggested side/price to persist for a few ticks.
        const confirmN = Math.max(1, Math.floor(Number.isFinite(LAG_ENTRY_CONFIRM_TICKS) ? LAG_ENTRY_CONFIRM_TICKS : 1));
        const side0 = ctx.state.lag.suggestedSide;
        const px0 = ctx.state.lag.suggestedLimitPrice;
        if (!side0 || !Number.isFinite(px0) || !(px0 > 0)) return;
        const p = ctx.state.lag._pending;
        if (!p || p.side !== side0 || !Number.isFinite(p.px) || Math.abs(p.px - px0) > 1e-9) {
            ctx.state.lag._pending = { side: side0, px: px0, hits: 1, firstAt: Date.now() };
            return;
        }
        p.hits = (p.hits || 0) + 1;
        if (p.hits < confirmN) return;

        // Safety backstop: do not enter new trades shortly before interval ends.
        const endEpochSec = ctx.state.interval?.endEpochSec;
        const nowEpochSec = Date.now() / 1000;
        if (Number.isFinite(endEpochSec) && (endEpochSec - nowEpochSec) <= 60) return;

        const now = Date.now();
        const lastTradeAt = ctx.state.lag.lastTradeAt ? ctx.state.lag.lastTradeAt.getTime() : 0;
        if ((now - lastTradeAt) < LAG_COOLDOWN_MS) return;
        const lastStopAt = ctx.state.lag.lastStopAt ? ctx.state.lag.lastStopAt.getTime() : 0;
        if (lastStopAt && (now - lastStopAt) < LAG_STOP_COOLDOWN_MS) return;

        const side = ctx.state.lag.suggestedSide;
        const shares = ctx.state.lag.suggestedShares;
        const limitPrice = ctx.state.lag.suggestedLimitPrice;
        if (!side || !(shares > 0) || !(limitPrice > 0)) return;

        const tokenId = side === 'UP' ? ctx.state.tokens.upTokenId : ctx.state.tokens.downTokenId;
        if (!tokenId) return;

        const feeBps = side === 'UP' ? ctx.state.tokens.upFeeBps : ctx.state.tokens.downFeeBps;
        if (!Number.isFinite(feeBps)) return;

        // Hard guard: if there's not enough room to profit even if price runs to 99¢, don't enter.
        if (!(limitPrice < 0.99)) return;
        const maxProfitCents = maxAchievableProfitCentsAtCap({ entryLimitPrice01: limitPrice, feeBps, capPrice01: 0.99 });
        const desiredProfitCents = profitCentsForEntry({ entryPrice01: limitPrice, spotDeltaUsd: ctx.state.lag._spotDeltaUsd, sideMarketMove01: ctx.state.lag._sideMarketMove01 });
        if (!Number.isFinite(maxProfitCents) || maxProfitCents + 1e-6 < desiredProfitCents) return;

        const targetSell = computeTargetSellPrice01({
            entryLimitPrice01: limitPrice,
            profitCents: desiredProfitCents,
            buyFeeBps: feeBps,
            sellFeeBps: feeBps
        });
        if (!(targetSell > 0)) return;

        const stopPrice = computeStopPrice01({ entryPrice01: limitPrice, desiredProfitCents });
        if (!(stopPrice > 0)) return;

        ctx.state.lag.lastSignalAt = new Date();
        ctx.log(`LAG signal: buy ${side} ${shares} sh @ ${ctx.helpers.fmtCents(limitPrice)} (tp ${ctx.helpers.fmtCents(targetSell)} | sl ${ctx.helpers.fmtCents(stopPrice)})`, 'SUCCESS');

        if (ctx.PAPER_TRADING) {
            const asks = side === 'UP' ? ctx.state.orderbooks.upAsksLevels : ctx.state.orderbooks.downAsksLevels;
            const fill = ctx.helpers.costToBuySharesFromAsks(asks, shares, feeBps);
            if (!fill) return;
            if (fill.cost > ctx.getPaperBalance()) return;

            ctx.executePaperDelta(-fill.cost);
            ctx.state.lag.open = {
                side,
                tokenId,
                shares,
                entryPrice: limitPrice,
                sellPrice: targetSell,
                stopPrice,
                feeBps,
                entryCostUsdc: fill.cost,
                endEpochSec: ctx.state.interval?.endEpochSec ?? null,
                marketId: ctx.state.market?.id ?? null,
                referencePrice: Number.isFinite(ctx.state.market?.referencePrice) ? ctx.state.market.referencePrice : null,
                conditionId: ctx.state.market?.conditionId ?? null,
                _stopHits: 0,
                openedAt: new Date()
            };
            ctx.state.lag.lastTradeAt = new Date();
            ctx.log(`PAPER LAG ENTRY: ${side} ${shares} sh | entry ${ctx.helpers.fmtCents(limitPrice)} | tp ${ctx.helpers.fmtCents(targetSell)} | sl ${ctx.helpers.fmtCents(stopPrice)} | cost=$${fill.cost.toFixed(3)}`, 'TRADE');
            return;
        }

        if (!ctx.ENABLE_LIVE_ORDERS) return;
        try {
            const res = await executeLiveLagTrade(ctx, { tokenId, shares, limitPrice });
            const filled = await confirmFokFilled(ctx, res, shares);
            if (!filled.ok) {
                ctx.log(`LIVE LAG ENTRY not filled: ${filled.reason}`, 'WARN');
                return;
            }
            ctx.state.lag.open = {
                side,
                tokenId,
                shares,
                entryPrice: limitPrice,
                sellPrice: targetSell,
                stopPrice,
                feeBps,
                endEpochSec: ctx.state.interval?.endEpochSec ?? null,
                marketId: ctx.state.market?.id ?? null,
                referencePrice: Number.isFinite(ctx.state.market?.referencePrice) ? ctx.state.market.referencePrice : null,
                conditionId: ctx.state.market?.conditionId ?? null,
                _stopHits: 0,
                openedAt: new Date()
            };
            ctx.state.lag.lastTradeAt = new Date();
            ctx.log(`LIVE LAG ENTRY: ${side} ${shares} sh | entry ${ctx.helpers.fmtCents(limitPrice)} | tp ${ctx.helpers.fmtCents(targetSell)} | sl ${ctx.helpers.fmtCents(stopPrice)} (FOK filled)`, 'TRADE');
        } catch (err) {
            ctx.log(`LIVE LAG ENTRY failed: ${err?.message || err}`, 'ERROR');
        }
    }

    async function maybeExitLag(ctx) {
        const open = ctx.state.lag.open;
        if (!open) return;

        // If the interval rolled and token ids changed, do not evaluate exit on the wrong market's orderbook.
        const currentTokenId = open.side === 'UP' ? ctx.state.tokens.upTokenId : ctx.state.tokens.downTokenId;
        if (currentTokenId && open.tokenId && String(currentTokenId) !== String(open.tokenId)) {
            if (!open._mismatchLogged) {
                open._mismatchLogged = true;
                ctx.log('LAG open position token mismatch vs current interval; skipping exit evaluation to avoid cross-interval paper PnL artifacts', 'WARN');
            }
            return;
        }

        const book = open.side === 'UP' ? ctx.state.orderbooks.up : ctx.state.orderbooks.down;
        const bidsLevels = open.side === 'UP' ? ctx.state.orderbooks.upBidsLevels : ctx.state.orderbooks.downBidsLevels;
        if (!book) return;
        const bestBid = book.bestBid;
        const mark = book.mark;
        if (!(bestBid > 0)) return;

        const tpTriggered = bestBid >= open.sellPrice;
        // Stop uses mark (less noisy than bestBid spread flickers)
        const stopRef = (Number.isFinite(mark) && mark > 0) ? mark : bestBid;
        const stopTriggeredRaw = Number.isFinite(open.stopPrice) ? (stopRef <= open.stopPrice) : false;
        // Avoid immediate stop-outs from entry microstructure.
        const openedAtMs = open.openedAt?.getTime?.();
        const graceMs = Number.isFinite(LAG_STOP_GRACE_MS) ? LAG_STOP_GRACE_MS : 0;
        const stopArmed = Number.isFinite(openedAtMs) ? ((Date.now() - openedAtMs) >= graceMs) : true;

        // Require stop condition to persist across a few ticks.
        const confirmTicks = Math.max(1, Number.isFinite(LAG_STOP_CONFIRM_TICKS) ? Math.floor(LAG_STOP_CONFIRM_TICKS) : 1);
        if (stopTriggeredRaw && stopArmed) {
            open._stopHits = (Number.isFinite(open._stopHits) ? open._stopHits : 0) + 1;
        } else {
            open._stopHits = 0;
        }
        const stopTriggered = stopTriggeredRaw && stopArmed && (open._stopHits >= confirmTicks);

        if (!tpTriggered && !stopTriggered) return;

        const shares = open.shares;
        const tokenId = open.tokenId;

        const feeBps = Number.isFinite(open.feeBps)
            ? open.feeBps
            : (open.side === 'UP' ? ctx.state.tokens.upFeeBps : ctx.state.tokens.downFeeBps);
        const minExit = tpTriggered ? open.sellPrice : 0;
        const est = ctx.helpers.proceedsFromSellingSharesToBids(bidsLevels, shares, feeBps, minExit);
        if (!est) return; // not enough bid depth (tp) or insufficient depth overall (stop)

        if (ctx.PAPER_TRADING) {
            const proceeds = est.proceeds;
            const exitPx = Number.isFinite(est.minFilledPrice) ? est.minFilledPrice : open.sellPrice;
            ctx.executePaperDelta(proceeds);
            const why = tpTriggered
                ? `TP (>= ${ctx.helpers.fmtCents(open.sellPrice)})`
                : `STOP (<= ${ctx.helpers.fmtCents(open.stopPrice)})`;
            ctx.log(`PAPER LAG EXIT: ${open.side} ${shares} sh | entry ${ctx.helpers.fmtCents(open.entryPrice)} | exit ${ctx.helpers.fmtCents(exitPx)} | ${why} | +$${proceeds.toFixed(3)}`, 'TRADE');
            if (!tpTriggered) ctx.state.lag.lastStopAt = new Date();
            ctx.state.lag.open = null;
            return;
        }

        if (!ctx.ENABLE_LIVE_ORDERS) return;
        try {
            // TP: use limit at threshold so order can sweep multiple bid levels.
            // STOP: use current best bid to get out quickly.
            const exitLimit = tpTriggered ? minExit : bestBid;
            const res = await executeLiveLagExit(ctx, { tokenId, shares, limitPrice: exitLimit });
            const filled = await confirmFokFilled(ctx, res, shares);
            if (!filled.ok) {
                ctx.log(`LIVE LAG EXIT not filled: ${filled.reason}`, 'WARN');
                return;
            }
            const why = tpTriggered
                ? `TP (>= ${ctx.helpers.fmtCents(open.sellPrice)})`
                : `STOP (<= ${ctx.helpers.fmtCents(open.stopPrice)})`;
            ctx.log(`LIVE LAG EXIT: ${open.side} ${shares} sh | entry ${ctx.helpers.fmtCents(open.entryPrice)} | exit ${ctx.helpers.fmtCents(exitLimit)} | ${why} (FOK filled)`, 'TRADE');
            if (!tpTriggered) ctx.state.lag.lastStopAt = new Date();
            ctx.state.lag.open = null;
        } catch (err) {
            ctx.log(`LIVE LAG EXIT failed: ${err?.message || err}`, 'ERROR');
        }
    }

    return {
        onOrderbooks: async (ctx) => {
            evalLagSignal(ctx);
            await maybeExitLag(ctx);
            await maybeExecuteLag(ctx);
        },

        renderDashboardRows: (ctx, { render, width }) => {
            const lagSignal = ctx.state.lag.signal ? render.c(ctx.state.lag.signal, render.ANSI.green) : render.c('—', render.ANSI.gray);
            const lagReason = ctx.state.lag.reason ? ctx.state.lag.reason : '—';
            const lagSug = (ctx.state.lag.suggestedSide && Number.isFinite(ctx.state.lag.suggestedShares) && Number.isFinite(ctx.state.lag.suggestedLimitPrice))
                ? `${ctx.state.lag.suggestedSide} ${ctx.state.lag.suggestedShares} sh @ ${render.fmtCents(ctx.state.lag.suggestedLimitPrice)} (${ctx.state.lag.suggestedLimitPrice.toFixed(3)})`
                : '—';

            const sugSide = ctx.state.lag.suggestedSide;
            const sugShares = ctx.state.lag.suggestedShares;
            const sugEntry = ctx.state.lag.suggestedLimitPrice;
            const sugFeeBps = sugSide === 'UP' ? ctx.state.tokens.upFeeBps : (sugSide === 'DOWN' ? ctx.state.tokens.downFeeBps : null);
            const sugTp = (Number.isFinite(sugEntry) && sugSide)
                ? computeTargetSellPrice01({ entryLimitPrice01: sugEntry, profitCents: profitCentsForEntry({ entryPrice01: sugEntry, spotDeltaUsd: ctx.state.lag._spotDeltaUsd, sideMarketMove01: ctx.state.lag._sideMarketMove01 }), buyFeeBps: sugFeeBps, sellFeeBps: sugFeeBps })
                : null;
            const sugCost = (Number.isFinite(sugShares) && Number.isFinite(sugEntry))
                ? ctx.helpers.applyTakerFeeOnBuy(sugShares * sugEntry, sugFeeBps)
                : null;
            const sugProceeds = (Number.isFinite(sugShares) && Number.isFinite(sugTp))
                ? ctx.helpers.applyTakerFeeOnSell(sugShares * sugTp, sugFeeBps)
                : null;
            const sugProfit = (Number.isFinite(sugCost) && Number.isFinite(sugProceeds)) ? (sugProceeds - sugCost) : null;
            const lagPnLEst = (Number.isFinite(sugTp) && Number.isFinite(sugProfit) && Number.isFinite(sugCost))
                ? `TP ${render.fmtCents(sugTp)} | est PnL $${sugProfit.toFixed(3)} on $${sugCost.toFixed(2)}`
                : '—';

            const lagOpen = ctx.state.lag.open
                ? `${ctx.state.lag.open.side} ${ctx.state.lag.open.shares} sh | entry ${render.fmtCents(ctx.state.lag.open.entryPrice)} | tp ${render.fmtCents(ctx.state.lag.open.sellPrice)} | sl ${render.fmtCents(ctx.state.lag.open.stopPrice)} | ${ctx.state.lag.open.openedAt?.toLocaleTimeString?.() || '—'}`
                : '—';

            let lagUnrl = '—';
            if (ctx.state.lag.open) {
                const open = ctx.state.lag.open;
                const book = open.side === 'UP' ? ctx.state.orderbooks.up : ctx.state.orderbooks.down;
                const bestBid = book?.bestBid;
                const feeBps = open.side === 'UP' ? ctx.state.tokens.upFeeBps : ctx.state.tokens.downFeeBps;
                const entryCost = ctx.helpers.applyTakerFeeOnBuy(open.shares * open.entryPrice, feeBps);
                const exitVal = (Number.isFinite(bestBid) && bestBid > 0)
                    ? ctx.helpers.applyTakerFeeOnSell(open.shares * bestBid, feeBps)
                    : null;
                if (Number.isFinite(entryCost) && Number.isFinite(exitVal)) {
                    const unrl = exitVal - entryCost;
                    lagUnrl = `bestBid ${render.fmtCents(bestBid)} | unrl PnL $${unrl.toFixed(3)} (fee-aware)`;
                }
            }
            const lagLast = ctx.state.lag.lastTradeAt ? ctx.state.lag.lastTradeAt.toLocaleTimeString() : '—';

            const lat = ctx.state.lag._lat;
            const emaS = Number.isFinite(lat?.emaMs) ? (lat.emaMs / 1000).toFixed(1) + 's' : '—';
            const lastS = Number.isFinite(lat?.lastMs) ? (lat.lastMs / 1000).toFixed(1) + 's' : '—';
            const maxS = Number.isFinite(lat?.maxMs) ? (lat.maxMs / 1000).toFixed(1) + 's' : '—';
            const lagAge = Number.isFinite(ctx.state.lag._lagStartMs)
                ? `${((Date.now() - ctx.state.lag._lagStartMs) / 1000).toFixed(1)}s`
                : '—';

            const ai = ctx.state.lag?._ai;
            const aiStr = (ai && Number.isFinite(ai.n)) ? `n=${ai.n}` : '—';

            return [
                render.boxRow('Lag Signal', `${lagSignal} | ${lagReason}`, width),
                render.boxRow('Lag Suggest', lagSug, width),
                render.boxRow('Lag PnL (est)', lagPnLEst, width),
                render.boxRow('Lag Open', lagOpen, width),
                render.boxRow('Lag PnL (unrl)', lagUnrl, width),
                render.boxRow('Lag Latency', `ema ${emaS} | last ${lastS} | max ${maxS} | windowAge ${lagAge}`, width),
                render.boxRow('Lag AI', aiStr, width),
                render.boxRow('Last Lag', lagLast, width)
            ];
        }
    };
}
