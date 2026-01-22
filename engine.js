import { ClobClient, Side, AssetType, OrderType } from '@polymarket/clob-client';
import { SignatureType } from '@polymarket/order-utils';
import { ethers } from 'ethers';
import axios from 'axios';
import dotenv from 'dotenv';
import { createWalletManager } from './wallet-manager.js';

dotenv.config();

// Helper function to detect Gnosis Safe
const isGnosisSafe = async (address, provider) => {
    try {
        const code = await provider.getCode(address);
        return code !== '0x';
    } catch (error) {
        return false;
    }
};

// --- CONFIGURATION (shared) ---
const LIVE_TRADING = String(process.env.LIVE_TRADING || '').toLowerCase() === 'true';
// Safety gate: even if LIVE_TRADING=true, we will not post orders unless this is also true.
const ENABLE_LIVE_ORDERS = String(process.env.ENABLE_LIVE_ORDERS || '').toLowerCase() === 'true';
const PAPER_TRADING = !LIVE_TRADING;

const INITIAL_BALANCE = Number(process.env.INITIAL_BALANCE || 1.0);
let paperBalance = INITIAL_BALANCE;

// Balance checks (live mode)
const BALANCE_POLL_MS = Number(process.env.BALANCE_POLL_MS || 10000);

// 15-minute BTC Up/Down series
const SERIES_SLUG_PREFIX = process.env.SERIES_SLUG_PREFIX || 'btc-updown-15m-';
const INTERVAL_SECONDS = 15 * 60;

// RTDS source (restricted to feeds Polymarket commonly references: Binance + Chainlink)
// - binance_ws: Binance WebSocket trades (BTCUSDT) (fast RTDS proxy)
// - chainlink: Chainlink BTC/USD oracle on Polygon (slower, on-chain)
// - auto: use Binance when fresh, otherwise fall back to Chainlink
const RTDS_SOURCE_RAW = String(process.env.RTDS_SOURCE || 'auto').toLowerCase();
const RTDS_SOURCE = (RTDS_SOURCE_RAW === 'binance_ws' || RTDS_SOURCE_RAW === 'chainlink' || RTDS_SOURCE_RAW === 'auto')
    ? RTDS_SOURCE_RAW
    : 'auto';

// Cadences
const UNDERLYING_POLL_MS = Number(process.env.UNDERLYING_POLL_MS || 1000);
const MARKET_REFRESH_MS = Number(process.env.MARKET_REFRESH_MS || 2000);
// Polling orderbooks faster catches fleeting arb; tune via env to respect rate limits.
const ORDERBOOK_POLL_MS = Number(process.env.ORDERBOOK_POLL_MS || 100);
// Quotes used by Polymarket UI are often derived from dedicated quote endpoints.
// Keep this slower than raw orderbooks to avoid hammering endpoints.
const QUOTE_POLL_MS = Number(process.env.QUOTE_POLL_MS || 1000);
const DASHBOARD_MS = Number(process.env.DASHBOARD_MS || 500);

// Optional, informational estimate for on-chain actions (approve/deposit/withdraw/claim).
// NOTE: CLOB orders themselves are off-chain; gas costs typically apply to on-chain wallet actions.
const EST_ONCHAIN_TX_USD = process.env.EST_ONCHAIN_TX_USD ? Number(process.env.EST_ONCHAIN_TX_USD) : null;

// APIs
const CHAIN_ID = 137;
const GAMMA_MARKETS_URL = 'https://gamma-api.polymarket.com/markets';
const GAMMA_EVENTS_URL = 'https://gamma-api.polymarket.com/events';
// Chainlink BTC/USD on Polygon mainnet
const CHAINLINK_BTC_USD_FEED = process.env.CHAINLINK_BTC_USD_FEED || '0xc907E116054Ad103354f2D350FD2514433D57F6f';

const http = axios.create({
    timeout: 8000,
    headers: {
        'User-Agent': 'polymarketarb/1.0'
    }
});

// --- STATE ---
const state = {
    now: new Date(),
    marketsScanned: 0,
    opportunitiesFound: 0,
    recentLogs: [],

    // Underlying feed (RTDS)
    underlying: {
        source: 'RTDS',
        price: 0,
        lastUpdated: null,
        exchangeTimestampMs: null,
        error: null
    },

    // Per-feed snapshots (used when RTDS_SOURCE=auto)
    underlyingFeeds: {
        binance_ws: {
            source: 'Binance WS BTCUSDT',
            price: null,
            lastUpdated: null,
            exchangeTimestampMs: null,
            error: null,
            connected: false,
            // Rolling trade tape for volume/flow indicators (best-effort).
            // Each item: { t: ms, p: price, q: qty (BTC), m: isBuyerMaker }
            trades: [],
            lastQty: null,
            lastIsBuyerMaker: null
        },
        chainlink: { source: 'Chainlink BTC/USD (Polygon)', price: null, lastUpdated: null, exchangeTimestampMs: null, error: null, connected: true }
    },

    collateral: {
        balanceUsdc: null,
        allowanceUsdc: null,
        lastUpdated: null,
        error: null
    },

    // Current interval market
    interval: {
        slug: null,
        startEpochSec: null,
        endEpochSec: null,
        entrySpot: null,
        entrySpotSetAt: null
    },

    market: {
        id: null,
        conditionId: null,
        question: null,
        description: null,
        resolutionSource: null,
        referencePrice: null // "mark price to beat" / reference at interval start (if available)
    },

    tokens: {
        upTokenId: null,
        downTokenId: null,
        upFeeBps: null,
        downFeeBps: null,
        feeError: null,
        lastResolved: null,
        error: null
    },

    orderbooks: {
        up: null,
        down: null,
        upAsksLevels: null,
        upBidsLevels: null,
        downAsksLevels: null,
        downBidsLevels: null,
        quoteUpBuy: null,
        quoteDownBuy: null,
        midpointUp: null,
        midpointDown: null,
        lastUpdated: null,
        lastLatencyMs: null,
        lastError: null
    },

    // Strategy-owned sub-state (modes can mutate freely)
    arb: {
        lastSignalAt: null,
        lastCost: null,
        lastProfitCents: null,
        suggestedShares: null,
        suggestedCost: null,
        suggestedProfitCentsEach: null,
        lastTradeAt: null,

        // Paper-mode straddle is held until resolution.
        // { sharesPerSide, totalCostUsdc, openedAt, endEpochSec, referencePrice, openedSpot }
        open: null
    },

    lag: {
        lastSpot: null,
        lastUpMid: null,
        lastDownMid: null,
        lastEvalAt: null,
        lastSignalAt: null,
        signal: null,
        reason: null,
        suggestedSide: null,
        suggestedSpend: null,
        suggestedShares: null,
        suggestedLimitPrice: null,
        open: null,
        lastTradeAt: null
    },

    certainty: {
        lastEvalAt: null,
        lastSignalAt: null,
        lastTradeAt: null,
        candidateSide: null,
        spotGapUsd: null,
        timeRemainingSec: null,
        entryOk: null,
        entryReason: null,
        exitReasons: null,
        confirmTicks: null,
        open: null
    }
};

// --- SETUP ---
const RPC_URL = process.env.RPC_URL || 'https://polygon-rpc.com';
const provider = new ethers.providers.JsonRpcProvider(RPC_URL);

let wallet;
if (process.env.PRIVATE_KEY) {
    wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
} else if (PAPER_TRADING) {
    wallet = ethers.Wallet.createRandom().connect(provider);
} else {
    console.error('Error: PRIVATE_KEY is required for real trading. Set it in .env');
    process.exit(1);
}

// Certainty mode (proxy wallet) configuration
const CERTAINTY_MODE = String(process.env.CERTAINTY_MODE || '').toLowerCase() === 'true';
const PROXY_WALLET_ADDRESS = process.env.PROXY_WALLET_ADDRESS || null;
const isProxySafe = CERTAINTY_MODE && PROXY_WALLET_ADDRESS ? await isGnosisSafe(PROXY_WALLET_ADDRESS, provider) : false;
const signatureType = isProxySafe ? SignatureType.POLY_GNOSIS_SAFE : SignatureType.EOA;
const funderAddress = CERTAINTY_MODE && PROXY_WALLET_ADDRESS ? PROXY_WALLET_ADDRESS : undefined;

if (CERTAINTY_MODE) {
    if (!PROXY_WALLET_ADDRESS) {
        console.error('Error: CERTAINTY_MODE=true requires PROXY_WALLET_ADDRESS in .env');
        process.exit(1);
    }
    log(`Certainty mode enabled with proxy wallet: ${PROXY_WALLET_ADDRESS}`, 'INFO');
}

// CLOB L2 API creds (required to post/cancel orders)
let CLOB_API_KEY = process.env.CLOB_API_KEY || process.env.POLY_API_KEY || null;
let CLOB_API_SECRET = process.env.CLOB_API_SECRET || process.env.POLY_API_SECRET || null;
let CLOB_API_PASSPHRASE = process.env.CLOB_API_PASSPHRASE || process.env.POLY_API_PASSPHRASE || null;
let clobCreds = (CLOB_API_KEY && CLOB_API_SECRET && CLOB_API_PASSPHRASE)
    ? { key: CLOB_API_KEY, secret: CLOB_API_SECRET, passphrase: CLOB_API_PASSPHRASE }
    : undefined;

// Generate API keys if not present and live trading
if (!clobCreds && LIVE_TRADING) {
    console.log('Generating API keys...');
    const originalConsoleLog = console.log;
    const originalConsoleError = console.error;
    console.log = function () {};
    console.error = function () {};
    try {
        let tempClient = new ClobClient(
            'https://clob.polymarket.com',
            137,
            wallet,
            undefined,
            signatureType,
            funderAddress
        );
        let creds = await tempClient.createApiKey();
        if (!creds || !creds.key) {
            creds = await tempClient.deriveApiKey();
        }
        if (creds && creds.key) {
            clobCreds = creds;
            CLOB_API_KEY = creds.key;
            CLOB_API_SECRET = creds.secret;
            CLOB_API_PASSPHRASE = creds.passphrase;
        }
    } catch (error) {
        console.error('Failed to generate API keys:', error.message);
    } finally {
        console.log = originalConsoleLog;
        console.error = originalConsoleError;
    }
}

if (LIVE_TRADING && !clobCreds) {
    console.error('LIVE_TRADING=true requires CLOB_API_KEY, CLOB_API_SECRET, CLOB_API_PASSPHRASE');
    process.exit(1);
}

// Optional builder creds (adds builder headers to order POSTs)
let builderConfig;
try {
    const BUILDER_KEY = process.env.BUILDER_API_KEY || process.env.POLY_BUILDER_API_KEY || null;
    const BUILDER_SECRET = process.env.BUILDER_API_SECRET || process.env.POLY_BUILDER_SECRET || null;
    const BUILDER_PASSPHRASE = process.env.BUILDER_API_PASSPHRASE || process.env.POLY_BUILDER_PASSPHRASE || null;
    if (BUILDER_KEY && BUILDER_SECRET && BUILDER_PASSPHRASE) {
        const mod = await import('@polymarket/builder-signing-sdk');
        const BuilderConfig = mod.BuilderConfig;
        builderConfig = new BuilderConfig({
            localBuilderCreds: {
                key: BUILDER_KEY,
                secret: BUILDER_SECRET,
                passphrase: BUILDER_PASSPHRASE
            }
        });
    }
} catch {
    builderConfig = undefined;
}

const HAS_BUILDER_HEADERS = !!builderConfig;
const HAS_CLOB_CREDS = !!clobCreds;

const clobClient = new ClobClient(
    'https://clob.polymarket.com',
    CHAIN_ID,
    wallet,
    clobCreds,
    signatureType,
    funderAddress,
    undefined,
    true,
    builderConfig
);

// Initialize wallet manager for real trading
let walletManager = null;
if (LIVE_TRADING && wallet && provider && clobClient) {
    try {
        walletManager = createWalletManager({
            wallet,
            provider,
            clobClient,
            log: (msg, type) => log(msg, type),
            funderAddress,
            signatureType
        });
        log('Wallet manager initialized for live trading', 'INFO');
    } catch (err) {
        log(`Failed to initialize wallet manager: ${err.message}`, 'WARN');
    }
}

// --- HELPERS ---
function log(message, type = 'INFO') {
    const timestamp = new Date().toLocaleTimeString();
    state.recentLogs.unshift(`[${timestamp}] [${type}] ${message}`);
    if (state.recentLogs.length > 12) state.recentLogs.pop();
}

function fmtMoney(value, decimals = 2) {
    if (!Number.isFinite(value)) return '—';
    return `$${value.toFixed(decimals)}`;
}

function epochToLocalTime(epochSec) {
    if (!epochSec) return '—';
    return new Date(epochSec * 1000).toLocaleTimeString();
}

function getIntervalStartEpoch(nowEpochSec) {
    return Math.floor(nowEpochSec / INTERVAL_SECONDS) * INTERVAL_SECONDS;
}

function extractReferencePriceFromText(text) {
    if (!text) return null;
    // common patterns: "Reference Price: $123,456.78", "Starting price: $...", etc.
    const patterns = [
        /reference\s*price\s*[:\-]\s*\$\s*([0-9,]+(\.[0-9]+)?)/i,
        /starting\s*price\s*[:\-]\s*\$\s*([0-9,]+(\.[0-9]+)?)/i,
        /start\s*price\s*[:\-]\s*\$\s*([0-9,]+(\.[0-9]+)?)/i,
        /\$\s*([0-9,]+(\.[0-9]+)?)/
    ];
    for (const re of patterns) {
        const m = text.match(re);
        if (m?.[1]) return parseFloat(m[1].replace(/,/g, ''));
    }
    return null;
}

function computeMarkPrice(bestBid, bestAsk) {
    if (bestBid > 0 && bestAsk > 0) return (bestBid + bestAsk) / 2;
    if (bestAsk > 0) return bestAsk;
    if (bestBid > 0) return bestBid;
    return 0;
}

function priceToCents(price01) {
    if (!Number.isFinite(price01)) return null;
    return price01 * 100;
}

function fmtCents(price01, decimals = 1) {
    const cents = priceToCents(price01);
    if (!Number.isFinite(cents)) return '—';
    return `${cents.toFixed(decimals)}¢`;
}

function feeAmountUsdc(amountUsdc, feeBps) {
    if (!Number.isFinite(amountUsdc)) return null;
    const bps = Number.isFinite(feeBps) ? feeBps : 0;
    return amountUsdc * (bps / 10000);
}

function normalizeFeeBps(raw) {
    const x = Number(raw);
    if (!Number.isFinite(x) || x < 0) return null;
    // Some APIs return fee as a fraction (e.g. 0.02 for 2%). Others return bps.
    // Heuristic:
    // - 0 < x < 1  => treat as fraction and convert to bps
    // - otherwise  => treat as already-bps
    if (x > 0 && x < 1) return x * 10000;
    return x;
}

function applyTakerFeeOnBuy(amountUsdc, feeBps) {
    if (!Number.isFinite(amountUsdc)) return null;
    const bps = Number.isFinite(feeBps) ? feeBps : 0;
    return amountUsdc * (1 + bps / 10000);
}

function applyTakerFeeOnSell(proceedsUsdc, feeBps) {
    if (!Number.isFinite(proceedsUsdc)) return null;
    const bps = Number.isFinite(feeBps) ? feeBps : 0;
    return proceedsUsdc * (1 - bps / 10000);
}

function liveCanSpendUsdc(requiredUsdc) {
    if (!(requiredUsdc > 0)) return { ok: true, reason: null };
    const bal = state.collateral.balanceUsdc;
    const allow = state.collateral.allowanceUsdc;
    if (!Number.isFinite(bal) || !Number.isFinite(allow)) return { ok: false, reason: 'Balance/allowance unknown (still loading)' };
    // Allow trades as small as $0.50
    if (bal < 0.5) return { ok: false, reason: `Balance too low: $${bal.toFixed(2)} (minimum $0.50)` };
    if (bal + 1e-9 < requiredUsdc) return { ok: false, reason: `Insufficient USDC balance ($${bal.toFixed(2)} < $${requiredUsdc.toFixed(2)})` };
    if (allow + 1e-9 < requiredUsdc) return { ok: false, reason: `Insufficient allowance ($${allow.toFixed(2)} < $${requiredUsdc.toFixed(2)})` };
    return { ok: true, reason: null };
}

function clampInt(n, min, max) {
    const x = Math.floor(n);
    if (!Number.isFinite(x)) return min;
    return Math.max(min, Math.min(max, x));
}

// Cost (USDC) to buy `shares` shares by sweeping asks from best upwards.
function costToBuySharesFromAsks(asks, shares, feeBps) {
    if (!Array.isArray(asks) || asks.length === 0) return null;
    if (!(shares > 0)) return null;
    let remaining = shares;
    let cost = 0;
    let maxPrice = 0;
    for (const level of asks) {
        if (!(remaining > 0)) break;
        const take = Math.min(remaining, level.size);
        if (take <= 0) continue;
        cost += take * level.price;
        maxPrice = level.price;
        remaining -= take;
    }
    if (remaining > 1e-9) return null;
    return {
        cost: cost * (1 + (feeBps || 0) / 10000),
        maxPrice
    };
}

function maxSharesForBudget(asks, feeBps, maxUsdc, minShares = 1) {
    if (!Array.isArray(asks) || asks.length === 0) return null;
    const best = asks?.[0]?.price;
    if (!(best > 0) || !(maxUsdc > 0)) return null;
    const totalSize = Math.floor((asks || []).reduce((acc, l) => acc + (Number.isFinite(l.size) ? l.size : 0), 0));
    if (totalSize < minShares) return null;

    const approxPerShare = best * (1 + (feeBps || 0) / 10000);
    const budgetBound = approxPerShare > 0 ? Math.floor(maxUsdc / approxPerShare) : 0;
    let hi = clampInt(Math.min(totalSize, budgetBound), 0, 1e9);
    if (hi < minShares) return null;

    let lo = minShares;
    let bestFill = null;
    while (lo <= hi) {
        const mid = Math.floor((lo + hi) / 2);
        const fill = costToBuySharesFromAsks(asks, mid, feeBps);
        if (!fill) {
            hi = mid - 1;
            continue;
        }
        if (fill.cost <= maxUsdc) {
            bestFill = { shares: mid, cost: fill.cost, maxPrice: fill.maxPrice };
            lo = mid + 1;
        } else {
            hi = mid - 1;
        }
    }
    return bestFill;
}

// Proceeds (USDC) from selling `shares` shares by sweeping bids from best downwards,
// only taking bids priced at or above `minPrice01`.
function proceedsFromSellingSharesToBids(bids, shares, feeBps, minPrice01 = 0) {
    if (!Array.isArray(bids) || bids.length === 0) return null;
    if (!(shares > 0)) return null;
    let remaining = shares;
    let gross = 0;
    let minFilled = null;
    for (const level of bids) {
        if (!(remaining > 0)) break;
        if (!(level.price >= minPrice01)) break;
        const take = Math.min(remaining, level.size);
        if (take <= 0) continue;
        gross += take * level.price;
        minFilled = level.price;
        remaining -= take;
    }
    if (remaining > 1e-9) return null;
    const net = applyTakerFeeOnSell(gross, feeBps);
    return {
        gross,
        proceeds: net,
        minFilledPrice: minFilled
    };
}

function normalizeLevels(levels) {
    return (levels || []).map(l => ({
        price: Number.parseFloat(l.price),
        size: Number.parseFloat(l.size)
    })).filter(l => Number.isFinite(l.price) && Number.isFinite(l.size));
}

function sortBidsAsksFromBook(book) {
    const bids = normalizeLevels(book?.bids).sort((a, b) => b.price - a.price);
    const asks = normalizeLevels(book?.asks).sort((a, b) => a.price - b.price);
    return { bids, asks };
}

function summarizeOrderbook(book) {
    // NOTE: CLOB sometimes returns levels in non-best-first order.
    // Normalize + sort to ensure:
    // - best ask = lowest ask
    // - best bid = highest bid
    const { bids, asks } = sortBidsAsksFromBook(book);

    const bestBid = bids.length > 0 ? bids[0].price : 0;
    const bestAsk = asks.length > 0 ? asks[0].price : 0;
    const mark = computeMarkPrice(bestBid, bestAsk);
    return {
        bids: bids.slice(0, 5),
        asks: asks.slice(0, 5),
        bestBid,
        bestAsk,
        mark
    };
}

function findOutcomeToken(market, wantedOutcomes) {
    const candidates = [];
    if (Array.isArray(market?.tokens)) candidates.push(...market.tokens);
    if (Array.isArray(market?.outcomes)) candidates.push(...market.outcomes);
    if (Array.isArray(market?.assets)) candidates.push(...market.assets);

    for (const wanted of wantedOutcomes) {
        const wantedLc = wanted.toLowerCase();
        const t = candidates.find(x => {
            const label = String(
                x?.outcome ??
                x?.outcome_name ??
                x?.name ??
                x?.label ??
                x?.title ??
                ''
            ).toLowerCase();
            return label === wantedLc;
        });
        if (t) return t;
    }
    return null;
}

// --- DATA FETCHERS ---
const CHAINLINK_AGGREGATOR_ABI = [
    'function decimals() view returns (uint8)',
    'function latestRoundData() view returns (uint80 roundId,int256 answer,uint256 startedAt,uint256 updatedAt,uint80 answeredInRound)'
];

let chainlinkDecimals = null;
let chainlinkContract = null;

async function fetchUnderlyingChainlink() {
    try {
        if (!chainlinkContract) {
            chainlinkContract = new ethers.Contract(CHAINLINK_BTC_USD_FEED, CHAINLINK_AGGREGATOR_ABI, provider);
        }
        if (!Number.isFinite(chainlinkDecimals)) {
            const d = await chainlinkContract.decimals();
            chainlinkDecimals = typeof d?.toNumber === 'function' ? d.toNumber() : Number(d);
        }
        const [, answer, , updatedAt] = await chainlinkContract.latestRoundData();
        const ans = typeof answer === 'bigint' ? Number(answer) : Number(answer?.toString?.() ?? answer);
        const upd = typeof updatedAt === 'bigint' ? Number(updatedAt) : Number(updatedAt?.toString?.() ?? updatedAt);
        if (!Number.isFinite(ans) || ans <= 0) throw new Error('Chainlink invalid answer');
        const denom = 10 ** (Number.isFinite(chainlinkDecimals) ? chainlinkDecimals : 8);
        const price = ans / denom;
        const snap = state.underlyingFeeds.chainlink;
        snap.price = price;
        snap.lastUpdated = new Date();
        snap.exchangeTimestampMs = Number.isFinite(upd) && upd > 0 ? upd * 1000 : null;
        snap.error = null;
    } catch (err) {
        state.underlyingFeeds.chainlink.error = err?.message || 'Chainlink fetch failed';
    }
}

function pickBestUnderlyingFeed() {
    const now = Date.now();
    const candidates = [];
    for (const key of Object.keys(state.underlyingFeeds)) {
        const f = state.underlyingFeeds[key];
        if (!f) continue;
        if (!Number.isFinite(f.price) || !(f.price > 0)) continue;
        if (!f.lastUpdated) continue;
        const ts = Number.isFinite(f.exchangeTimestampMs) ? f.exchangeTimestampMs : (f.lastUpdated ? f.lastUpdated.getTime() : null);
        const ageMs = Number.isFinite(ts) ? (now - ts) : 1e9;

        // Penalize disconnected/error WS feeds.
        let penalty = 0;
        if (key.endsWith('_ws') && !f.connected) penalty += 10000;
        if (f.error) penalty += 20000;
        candidates.push({ key, feed: f, score: ageMs + penalty, ageMs });
    }
    candidates.sort((a, b) => a.score - b.score);
    return candidates[0] || null;
}

function applyUnderlyingFromFeed(best) {
    if (!best?.feed) return;
    state.underlying.source = best.feed.source;
    state.underlying.price = best.feed.price;
    state.underlying.lastUpdated = best.feed.lastUpdated;
    state.underlying.exchangeTimestampMs = best.feed.exchangeTimestampMs;
    state.underlying.error = best.feed.error;
}

let binanceWsStop = null;
let binanceWsConnected = false;

async function startBinanceWsTicker() {
    if (binanceWsStop) return;
    if (!(RTDS_SOURCE === 'binance_ws' || RTDS_SOURCE === 'auto')) return;

    let WebSocketCtor;
    try {
        const mod = await import('ws');
        WebSocketCtor = mod.default || mod.WebSocket || mod;
    } catch {
        log('RTDS_SOURCE=binance_ws but ws module not installed; falling back to Chainlink', 'WARN');
        return;
    }

    const ws = new WebSocketCtor('wss://stream.binance.com:9443/ws/btcusdt@trade');
    let lastMessageAt = Date.now();
    let health = null;

    const cleanup = () => {
        if (health) clearInterval(health);
        health = null;
        binanceWsStop = null;
        binanceWsConnected = false;
    };

    ws.on('open', () => {
        binanceWsConnected = true;
        state.underlyingFeeds.binance_ws.connected = true;
        state.underlyingFeeds.binance_ws.error = null;
        log('Connected Binance WS trade stream', 'INFO');
    });

    ws.on('message', (data) => {
        lastMessageAt = Date.now();
        try {
            const msg = JSON.parse(String(data));
            const p = Number.parseFloat(msg?.p);
            const q = Number.parseFloat(msg?.q);
            const isBuyerMaker = !!msg?.m;
            if (!Number.isFinite(p)) return;
            const tradeTs = Number.parseInt(msg?.T, 10);
            const snap = state.underlyingFeeds.binance_ws;
            snap.price = p;
            snap.lastUpdated = new Date();
            snap.exchangeTimestampMs = Number.isFinite(tradeTs) ? tradeTs : null;
            snap.lastQty = Number.isFinite(q) ? q : null;
            snap.lastIsBuyerMaker = isBuyerMaker;
            snap.error = null;

            // Maintain a compact rolling trade tape for volume/price-action indicators.
            // Keep ~2 minutes of trades and hard-cap length to avoid memory growth.
            const t = Number.isFinite(tradeTs) ? tradeTs : Date.now();
            if (Array.isArray(snap.trades)) {
                if (Number.isFinite(q) && q > 0) {
                    snap.trades.push({ t, p, q, m: isBuyerMaker });
                }
                const cutoff = t - 2 * 60 * 1000;
                while (snap.trades.length && snap.trades[0].t < cutoff) snap.trades.shift();
                if (snap.trades.length > 5000) snap.trades.splice(0, snap.trades.length - 5000);
            }
        } catch {
            // ignore
        }
    });

    ws.on('error', (err) => {
        state.underlyingFeeds.binance_ws.error = err?.message || 'Binance WS error';
        binanceWsConnected = false;
        state.underlyingFeeds.binance_ws.connected = false;
    });

    ws.on('close', () => {
        binanceWsConnected = false;
        state.underlyingFeeds.binance_ws.connected = false;
        state.underlyingFeeds.binance_ws.error = state.underlyingFeeds.binance_ws.error || 'Binance WS closed';
        cleanup();
    });

    health = setInterval(() => {
        const ageMs = Date.now() - lastMessageAt;
        if (ageMs > 5000) {
            state.underlyingFeeds.binance_ws.error = 'Binance WS stale (>5s)';
            binanceWsConnected = false;
            state.underlyingFeeds.binance_ws.connected = false;
        }
    }, 2000);

    binanceWsStop = () => {
        cleanup();
        try { ws.close(); } catch { /* ignore */ }
    };
}

async function gammaGetEventBySlug(slug) {
    const res = await http.get(GAMMA_EVENTS_URL, { params: { slug } });
    const events = Array.isArray(res.data) ? res.data : [];
    return events[0] || null;
}

async function gammaGetMarketById(marketId) {
    const res = await http.get(`${GAMMA_MARKETS_URL}/${marketId}`);
    return res.data;
}

async function refreshCurrentIntervalMarket() {
    const nowSec = Math.floor(Date.now() / 1000);
    const intervalStart = getIntervalStartEpoch(nowSec);

    if (state.interval.startEpochSec === intervalStart && state.market?.id) return;

    const candidates = [intervalStart, intervalStart - INTERVAL_SECONDS, intervalStart + INTERVAL_SECONDS];

    for (const startSec of candidates) {
        const slug = `${SERIES_SLUG_PREFIX}${startSec}`;
        try {
            const event = await gammaGetEventBySlug(slug);
            state.marketsScanned += 1;

            if (!event || !Array.isArray(event.markets) || event.markets.length === 0) continue;

            const marketStub = event.markets[0];
            const fullMarket = await gammaGetMarketById(marketStub.id);

            const prevStart = state.interval.startEpochSec;

            state.interval.slug = slug;
            state.interval.startEpochSec = startSec;
            state.interval.endEpochSec = startSec + INTERVAL_SECONDS;

            // Reset entry spot when the interval changes.
            // For new intervals, fetch the Chainlink BTC price to match Polymarket's beat price
            if (prevStart !== startSec) {
                state.interval.entrySpot = null;
                state.interval.entrySpotSetAt = null;
                
                // Fetch Chainlink price for the beat price (this is what Polymarket uses)
                try {
                    await fetchUnderlyingChainlink();
                    const chainlinkPrice = state.underlyingFeeds.chainlink?.price;
                    if (Number.isFinite(chainlinkPrice) && chainlinkPrice > 0) {
                        state.interval.entrySpot = chainlinkPrice;
                        state.interval.entrySpotSetAt = new Date();
                        log(`New interval - Beat Price from Chainlink: $${chainlinkPrice.toFixed(2)}`, 'INFO');
                    } else {
                        // Fallback to current underlying price if Chainlink fails
                        const fallbackPrice = state.underlying.price;
                        if (Number.isFinite(fallbackPrice) && fallbackPrice > 0) {
                            state.interval.entrySpot = fallbackPrice;
                            state.interval.entrySpotSetAt = new Date();
                            log(`New interval - Beat Price from fallback: $${fallbackPrice.toFixed(2)} (Chainlink unavailable)`, 'WARN');
                        }
                    }
                } catch (err) {
                    log(`Failed to fetch Chainlink beat price: ${err?.message || err}`, 'ERROR');
                    // Use current price as fallback
                    const fallbackPrice = state.underlying.price;
                    if (Number.isFinite(fallbackPrice) && fallbackPrice > 0) {
                        state.interval.entrySpot = fallbackPrice;
                        state.interval.entrySpotSetAt = new Date();
                    }
                }
            }

            const prevCondition = state.market.conditionId;

            state.market.id = String(fullMarket.id);
            state.market.conditionId =
                fullMarket.condition_id ||
                fullMarket.conditionId ||
                marketStub.conditionId ||
                marketStub.condition_id ||
                null;
            state.market.question = fullMarket.question || marketStub.question || null;
            state.market.description = fullMarket.description || null;
            state.market.resolutionSource = fullMarket.resolutionSource || fullMarket.resolution_source || null;

            const ref = extractReferencePriceFromText(`${state.market.description || ''} ${state.market.question || ''}`);
            state.market.referencePrice = Number.isFinite(ref) ? ref : null;

            if (prevCondition !== state.market.conditionId) {
                state.tokens.upTokenId = null;
                state.tokens.downTokenId = null;
                state.tokens.lastResolved = null;
                state.tokens.error = null;
                state.orderbooks.up = null;
                state.orderbooks.down = null;
                state.orderbooks.lastUpdated = null;
                state.orderbooks.lastError = null;
            }

            log(`Tracking interval market: ${state.interval.slug}`, 'INFO');
            return;
        } catch {
            // Keep trying candidates
        }
    }

    state.interval.slug = null;
    state.interval.startEpochSec = intervalStart;
    state.interval.endEpochSec = intervalStart + INTERVAL_SECONDS;
    state.market.id = null;
    state.market.conditionId = null;
    state.market.question = null;
    state.market.description = null;
    state.market.resolutionSource = null;
    state.market.referencePrice = null;
}

async function resolveOutcomeTokenIds() {
    if (!state.market?.conditionId) return;
    if (state.tokens.upTokenId && state.tokens.downTokenId) return;

    try {
        const clobMarket = await clobClient.getMarket(state.market.conditionId);
        const upToken = findOutcomeToken(clobMarket, ['Up']);
        const downToken = findOutcomeToken(clobMarket, ['Down']);

        const upTokenId = upToken?.token_id || upToken?.tokenId || upToken?.asset_id || upToken?.assetId;
        const downTokenId = downToken?.token_id || downToken?.tokenId || downToken?.asset_id || downToken?.assetId;
        if (!upTokenId || !downTokenId) {
            throw new Error('CLOB market payload missing Up/Down token ids');
        }

        state.tokens.upTokenId = String(upTokenId);
        state.tokens.downTokenId = String(downTokenId);

        try {
            const [upFee, downFee] = await Promise.all([
                clobClient.getFeeRateBps(state.tokens.upTokenId),
                clobClient.getFeeRateBps(state.tokens.downTokenId)
            ]);
            state.tokens.upFeeBps = normalizeFeeBps(upFee);
            state.tokens.downFeeBps = normalizeFeeBps(downFee);
            state.tokens.feeError = null;
        } catch (err) {
            state.tokens.upFeeBps = null;
            state.tokens.downFeeBps = null;
            state.tokens.feeError = err?.message || 'Failed to fetch fee rates';
            log(`Fee rate fetch error: ${state.tokens.feeError}`, 'ERROR');
        }

        state.tokens.lastResolved = new Date();
        state.tokens.error = null;
        log('Resolved Up/Down token IDs from CLOB market', 'INFO');
    } catch (err) {
        state.tokens.error = err?.message || 'Failed to resolve token IDs';
    }
}

async function refreshOrderbooks(mode) {
    if (!state.market?.conditionId) return;

    await resolveOutcomeTokenIds();
    if (!state.tokens.upTokenId || !state.tokens.downTokenId) return;

    const start = process.hrtime.bigint();
    try {
        const [upBook, downBook] = await Promise.all([
            clobClient.getOrderBook(state.tokens.upTokenId),
            clobClient.getOrderBook(state.tokens.downTokenId)
        ]);

        const upSides = sortBidsAsksFromBook(upBook);
        const downSides = sortBidsAsksFromBook(downBook);
        state.orderbooks.upAsksLevels = upSides.asks;
        state.orderbooks.upBidsLevels = upSides.bids;
        state.orderbooks.downAsksLevels = downSides.asks;
        state.orderbooks.downBidsLevels = downSides.bids;

        state.orderbooks.up = summarizeOrderbook(upBook);
        state.orderbooks.down = summarizeOrderbook(downBook);
        state.orderbooks.lastUpdated = new Date();
        state.orderbooks.lastError = null;

        const end = process.hrtime.bigint();
        state.orderbooks.lastLatencyMs = Number(end - start) / 1e6;

        const up = state.orderbooks.up;
        const down = state.orderbooks.down;
        if (up?.bestAsk > 0 && down?.bestAsk > 0) {
            if (up.bestAsk > 0.9 && down.bestAsk > 0.9) {
                state.orderbooks.lastError = 'Sanity check failed: Up and Down both > 0.90';
                log('Sanity check: Up/Down both priced > 0.90; token mapping/market selection likely wrong', 'ERROR');
                return;
            }

            if (mode?.onOrderbooks) {
                try {
                    await mode.onOrderbooks();
                } catch (err) {
                    const msg = err?.message || String(err);
                    state.orderbooks.lastError = `mode.onOrderbooks: ${msg}`;
                    log(`Mode orderbook handler error: ${msg}`, 'ERROR');
                }
            }
        }
    } catch (err) {
        const end = process.hrtime.bigint();
        state.orderbooks.lastLatencyMs = Number(end - start) / 1e6;
        const msg = err?.message || String(err) || 'Orderbook fetch failed';
        state.orderbooks.lastError = msg;
        log(`Orderbooks error: ${msg}`, 'ERROR');
    }
}

async function refreshQuotes() {
    if (!state.tokens.upTokenId || !state.tokens.downTokenId) return;
    try {
        const [upBuy, downBuy, upMid, downMid] = await Promise.all([
            clobClient.getPrice(state.tokens.upTokenId, Side.BUY),
            clobClient.getPrice(state.tokens.downTokenId, Side.BUY),
            clobClient.getMidpoint(state.tokens.upTokenId),
            clobClient.getMidpoint(state.tokens.downTokenId)
        ]);

        const pickNumber = (obj) => {
            if (typeof obj === 'number') return obj;
            if (!obj || typeof obj !== 'object') return null;
            for (const k of ['price', 'p', 'midpoint', 'm']) {
                const v = Number.parseFloat(obj[k]);
                if (Number.isFinite(v)) return v;
            }
            for (const v of Object.values(obj)) {
                const n = Number.parseFloat(v);
                if (Number.isFinite(n)) return n;
            }
            return null;
        };

        state.orderbooks.quoteUpBuy = pickNumber(upBuy);
        state.orderbooks.quoteDownBuy = pickNumber(downBuy);
        state.orderbooks.midpointUp = pickNumber(upMid);
        state.orderbooks.midpointDown = pickNumber(downMid);
    } catch {
        // ignore quote errors
    }
}

// --- DASHBOARD ---
const ANSI = {
    reset: '\x1b[0m',
    dim: '\x1b[2m',
    bold: '\x1b[1m',
    cyan: '\x1b[36m',
    yellow: '\x1b[33m',
    green: '\x1b[32m',
    red: '\x1b[31m',
    gray: '\x1b[90m'
};

function c(text, color) {
    return `${color}${text}${ANSI.reset}`;
}

function padRight(text, width) {
    const s = String(text ?? '');
    if (s.length >= width) return s.slice(0, width);
    return s + ' '.repeat(width - s.length);
}

function boxLine(left, mid, right, width) {
    return `${left}${mid.repeat(Math.max(0, width - 2))}${right}`;
}

function boxRow(label, value, width, labelWidth = 16) {
    const left = `│ ${c(padRight(label, labelWidth), ANSI.yellow)} `;
    const right = ` ${padRight(value, width - 4 - labelWidth)} │`;
    return left + right;
}

function renderOrderbookSide(levels) {
    if (!levels || levels.length === 0) return '—';
    return levels.map(l => `${l.price.toFixed(3)} (${l.size.toFixed(0)})`).join(' | ');
}

// ============== GRID DASHBOARD HELPERS ==============
function stripAnsi(str) {
    return String(str).replace(/\x1b\[[0-9;]*m/g, '');
}

function visibleLength(str) {
    return stripAnsi(str).length;
}

function padRightAnsi(text, width) {
    const s = String(text ?? '');
    const vLen = visibleLength(s);
    if (vLen >= width) return s;
    return s + ' '.repeat(width - vLen);
}

function truncateAnsi(text, maxLen) {
    const s = String(text ?? '');
    let count = 0;
    let result = '';
    let inEscape = false;
    for (let i = 0; i < s.length; i++) {
        const ch = s[i];
        if (ch === '\x1b') inEscape = true;
        if (!inEscape) {
            if (count >= maxLen) break;
            count++;
        }
        result += ch;
        if (inEscape && ch === 'm') inEscape = false;
    }
    return result;
}

function boxTop(width, title = null) {
    if (title) {
        const t = ` ${title} `;
        const left = '┌─';
        const right = '─┐';
        const mid = '─'.repeat(Math.max(0, width - left.length - right.length - t.length));
        return c(left + t + mid + right, ANSI.cyan);
    }
    return c(boxLine('┌', '─', '┐', width), ANSI.cyan);
}

function boxMid(width, title = null) {
    if (title) {
        const t = ` ${title} `;
        const left = '├─';
        const right = '─┤';
        const mid = '─'.repeat(Math.max(0, width - left.length - right.length - t.length));
        return c(left + t + mid + right, ANSI.cyan);
    }
    return c(boxLine('├', '─', '┤', width), ANSI.cyan);
}

function boxBot(width) {
    return c(boxLine('└', '─', '┘', width), ANSI.cyan);
}

function boxRowGrid(label, value, width, labelWidth = 14) {
    const inner = width - 4;
    const lbl = truncateAnsi(padRightAnsi(c(label, ANSI.yellow), labelWidth), labelWidth);
    const val = truncateAnsi(padRightAnsi(value, inner - labelWidth - 1), inner - labelWidth - 1);
    return c('│', ANSI.cyan) + ' ' + lbl + ' ' + val + ' ' + c('│', ANSI.cyan);
}

function emptyRow(width) {
    return c('│', ANSI.cyan) + ' '.repeat(width - 2) + c('│', ANSI.cyan);
}

// Merge two side-by-side box lines
function mergeBoxes(leftLine, rightLine, gap = 1) {
    return leftLine + ' '.repeat(gap) + rightLine;
}

function renderDashboard(modeLabel, mode) {
    state.now = new Date();
    console.clear();

    const pnl = paperBalance - INITIAL_BALANCE;
    const pnlColor = pnl >= 0 ? ANSI.green : ANSI.red;

    const ref = state.market.referencePrice;
    const spot = state.underlying.price;
    const diff = Number.isFinite(ref) && ref ? spot - ref : null;
    const diffColor = diff === null ? ANSI.reset : (diff >= 0 ? ANSI.green : ANSI.red);
    const diffStr = diff === null ? '—' : `${diff >= 0 ? '+' : ''}${diff.toFixed(2)}`;

    const up = state.orderbooks.up;
    const down = state.orderbooks.down;

    // Grid dimensions
    const colW = 48;
    const fullW = colW * 2 + 1;

    // === HEADER ===
    const title = `${ANSI.bold}POLYMARKET BTC 15m BOT${ANSI.reset}`;
    const subtitle = state.interval.slug || 'no interval resolved';
    const timeStr = state.now.toLocaleTimeString();

    console.log(c(boxLine('╔', '═', '╗', fullW), ANSI.cyan));
    console.log(c('║', ANSI.cyan) + ' ' + c(padRightAnsi(title, fullW - 4), ANSI.bold) + ' ' + c('║', ANSI.cyan));
    console.log(c('║', ANSI.cyan) + ' ' + c(padRightAnsi(subtitle, fullW - 18), ANSI.gray) + padRightAnsi(timeStr, 14) + ' ' + c('║', ANSI.cyan));
    console.log(c(boxLine('╚', '═', '╝', fullW), ANSI.cyan));
    console.log('');

    // === ROW 1: SYSTEM STATUS | WALLET & BALANCE ===
    const runModeStr = PAPER_TRADING ? c('PAPER', ANSI.yellow) : c('LIVE', ANSI.red);
    const stratStr = c(String(modeLabel || '').toUpperCase(), ANSI.cyan);
    const modeStr = `${runModeStr} / ${stratStr}`;
    const liveGateStr = (!PAPER_TRADING && ENABLE_LIVE_ORDERS) ? c('ENABLED', ANSI.green) : c('DISABLED', ANSI.gray);
    const clobStr = HAS_CLOB_CREDS ? c('YES', ANSI.green) : c('NO', ANSI.gray);
    const builderStr = HAS_BUILDER_HEADERS ? c('YES', ANSI.green) : c('NO', ANSI.gray);
    const walletStr = `${wallet.address.substring(0, 6)}...${wallet.address.substring(38)}`;
    const balStr = `$${paperBalance.toFixed(2)}`;
    const pnlStr = `${pnlColor}$${pnl.toFixed(2)}${ANSI.reset}`;

    let leftBox = [];
    leftBox.push(boxTop(colW, 'SYSTEM STATUS'));
    leftBox.push(boxRowGrid('Mode', modeStr, colW));
    leftBox.push(boxRowGrid('Live Orders', PAPER_TRADING ? '—' : liveGateStr, colW));
    leftBox.push(boxRowGrid('CLOB Creds', clobStr, colW));
    leftBox.push(boxRowGrid('Builder Hdrs', builderStr, colW));
    leftBox.push(boxBot(colW));

    let rightBox = [];
    rightBox.push(boxTop(colW, 'WALLET & BALANCE'));
    rightBox.push(boxRowGrid('Wallet', walletStr, colW));
    rightBox.push(boxRowGrid('Balance', PAPER_TRADING ? balStr : '—', colW));
    rightBox.push(boxRowGrid('PnL', pnlStr, colW));
    rightBox.push(boxRowGrid('Opps Found', String(state.opportunitiesFound), colW));
    rightBox.push(boxBot(colW));

    for (let i = 0; i < leftBox.length; i++) {
        console.log(mergeBoxes(leftBox[i], rightBox[i]));
    }
    console.log('');

    // === ROW 2: PRICE FEED | INTERVAL ===
    const isCertaintyMode = modeLabel?.toLowerCase() === 'certainty';
    
    // BTC Spot should always show the actual spot price from the feed
    const spotStr = fmtMoney(spot, 2);
    const refStr = ref ? fmtMoney(ref, 2) : '—';
    const feedErr = state.underlying.error ? c(state.underlying.error, ANSI.red) : c('OK', ANSI.green);
    const updatedStr = state.underlying.lastUpdated ? state.underlying.lastUpdated.toLocaleTimeString() : '—';
    const exchTs = state.underlying.exchangeTimestampMs;
    const exchAgeMs = Number.isFinite(exchTs) ? (Date.now() - exchTs) : null;
    const ageStr = Number.isFinite(exchAgeMs) ? `${Math.max(0, Math.round(exchAgeMs))}ms` : '—';
    const intervalStr = `${epochToLocalTime(state.interval.startEpochSec)} → ${epochToLocalTime(state.interval.endEpochSec)}`;
    const question = state.market.question ? state.market.question.substring(0, 42) : '—';

    leftBox = [];
    leftBox.push(boxTop(colW, 'PRICE FEED'));
    leftBox.push(boxRowGrid('BTC Spot', spotStr, colW));
    
    // Beat Price: The BTC price at interval start that needs to be beaten
    // In certainty mode, this is captured dynamically when the interval starts
    // Otherwise, try to extract from market description (if available)
    let beatPriceVal = null;
    if (isCertaintyMode && Number.isFinite(state.certainty?.intervalStartBtcPrice)) {
        beatPriceVal = state.certainty.intervalStartBtcPrice;
    } else if (Number.isFinite(ref)) {
        beatPriceVal = ref;
    }
    const beatStr = Number.isFinite(beatPriceVal) ? '$' + beatPriceVal.toFixed(2) : '—';
    
    // BTC Diff: difference between current BTC spot and the beat price
    let btcDiffStr = '—';
    if (Number.isFinite(beatPriceVal) && Number.isFinite(spot)) {
        const btcDiff = spot - beatPriceVal;
        const btcDiffColor = btcDiff >= 0 ? ANSI.green : ANSI.red;
        btcDiffStr = c((btcDiff >= 0 ? '+$' : '-$') + Math.abs(btcDiff).toFixed(2), btcDiffColor);
    } else if (diff !== null) {
        // Fallback to original diff calculation
        const diffColored = `${diffColor}${diffStr}${ANSI.reset}`;
        btcDiffStr = diffColored;
    }
    
    leftBox.push(boxRowGrid('Beat Price', beatStr, colW));
    leftBox.push(boxRowGrid('Diff', btcDiffStr, colW));
    const sourceStr = isCertaintyMode ? 'Polymarket Market' : (state.underlying.source || '—');
    leftBox.push(boxRowGrid('Source', sourceStr, colW));
    leftBox.push(boxRowGrid('Updated', isCertaintyMode ? 'Market Ref' : `${updatedStr} (${ageStr})`, colW));
    leftBox.push(boxRowGrid('Status', feedErr, colW));
    leftBox.push(boxBot(colW));

    rightBox = [];
    rightBox.push(boxTop(colW, 'MARKET INTERVAL'));
    rightBox.push(boxRowGrid('Interval', intervalStr, colW));
    rightBox.push(boxRowGrid('Question', question, colW));
    rightBox.push(boxRowGrid('Market ID', (state.market.id || '—').substring(0, 32), colW));
    const feeLoadStr = state.tokens.feeError ? c(state.tokens.feeError, ANSI.red) : c('OK', ANSI.green);
    rightBox.push(boxRowGrid('Fee Load', feeLoadStr, colW));
    // Live balance if not paper
    if (!PAPER_TRADING) {
        const bal = state.collateral.balanceUsdc;
        const allow = state.collateral.allowanceUsdc;
        const balStr2 = Number.isFinite(bal) ? `$${bal.toFixed(2)}` : '—';
        const colErr = state.collateral.error ? c('ERR', ANSI.red) : c('OK', ANSI.green);
        rightBox.push(boxRowGrid('USDC Bal', `${balStr2} | ${colErr}`, colW));
    } else {
        rightBox.push(emptyRow(colW));
    }
    rightBox.push(emptyRow(colW));
    rightBox.push(boxBot(colW));

    for (let i = 0; i < leftBox.length; i++) {
        console.log(mergeBoxes(leftBox[i], rightBox[i]));
    }
    console.log('');

    // === ROW 3: UP ORDERBOOK | DOWN ORDERBOOK ===
    const upBuy = up?.bestAsk || 0;
    const downBuy = down?.bestAsk || 0;
    const upFee = state.tokens.upFeeBps;
    const downFee = state.tokens.downFeeBps;
    const upFeeStr = Number.isFinite(upFee) ? `${upFee}bps` : '—';
    const downFeeStr = Number.isFinite(downFee) ? `${downFee}bps` : '—';
    const upMidpoint = state.orderbooks.midpointUp;
    const downMidpoint = state.orderbooks.midpointDown;

    leftBox = [];
    leftBox.push(boxTop(colW, 'UP ORDERBOOK'));
    leftBox.push(boxRowGrid('Best Ask', up ? `${fmtCents(upBuy)} (${upBuy.toFixed(3)})` : '—', colW));
    leftBox.push(boxRowGrid('Best Bid', up ? `${fmtCents(up.bestBid)} (${up.bestBid.toFixed(3)})` : '—', colW));
    leftBox.push(boxRowGrid('Mark', up ? `${fmtCents(up.mark)} (${up.mark.toFixed(3)})` : '—', colW));
    leftBox.push(boxRowGrid('Midpoint', Number.isFinite(upMidpoint) ? `${fmtCents(upMidpoint)}` : '—', colW));
    leftBox.push(boxRowGrid('Fee', upFeeStr, colW));
    leftBox.push(boxRowGrid('Asks', up ? renderOrderbookSide(up.asks).substring(0, 30) : '—', colW));
    leftBox.push(boxRowGrid('Bids', up ? renderOrderbookSide(up.bids).substring(0, 30) : '—', colW));
    leftBox.push(boxBot(colW));

    rightBox = [];
    rightBox.push(boxTop(colW, 'DOWN ORDERBOOK'));
    rightBox.push(boxRowGrid('Best Ask', down ? `${fmtCents(downBuy)} (${downBuy.toFixed(3)})` : '—', colW));
    rightBox.push(boxRowGrid('Best Bid', down ? `${fmtCents(down.bestBid)} (${down.bestBid.toFixed(3)})` : '—', colW));
    rightBox.push(boxRowGrid('Mark', down ? `${fmtCents(down.mark)} (${down.mark.toFixed(3)})` : '—', colW));
    rightBox.push(boxRowGrid('Midpoint', Number.isFinite(downMidpoint) ? `${fmtCents(downMidpoint)}` : '—', colW));
    rightBox.push(boxRowGrid('Fee', downFeeStr, colW));
    rightBox.push(boxRowGrid('Asks', down ? renderOrderbookSide(down.asks).substring(0, 30) : '—', colW));
    rightBox.push(boxRowGrid('Bids', down ? renderOrderbookSide(down.bids).substring(0, 30) : '—', colW));
    rightBox.push(boxBot(colW));

    for (let i = 0; i < leftBox.length; i++) {
        console.log(mergeBoxes(leftBox[i], rightBox[i]));
    }

    const obMeta = `${state.orderbooks.lastUpdated ? state.orderbooks.lastUpdated.toLocaleTimeString() : '—'} | ${state.orderbooks.lastLatencyMs ? state.orderbooks.lastLatencyMs.toFixed(1) + 'ms' : '—'} | ${state.orderbooks.lastError ? c('ERR', ANSI.red) : c('OK', ANSI.green)}`;
    console.log(c('│', ANSI.cyan) + ` Books updated: ${obMeta}` + ' '.repeat(Math.max(0, fullW - 20 - visibleLength(obMeta))) + c('│', ANSI.cyan));
    console.log('');

    // === ROW 4: STRATEGY STATE (from mode.renderDashboardRows) ===
    if (mode?.renderDashboardRows) {
        const modeRows = mode.renderDashboardRows({ render: { ANSI, c, boxRow: boxRowGrid, fmtCents }, width: fullW }) || [];
        if (modeRows.length > 0) {
            // Split mode rows into two columns
            const half = Math.ceil(modeRows.length / 2);
            const leftRows = modeRows.slice(0, half);
            const rightRows = modeRows.slice(half);

            // Pad arrays to same length
            while (leftRows.length < rightRows.length) leftRows.push(emptyRow(colW));
            while (rightRows.length < leftRows.length) rightRows.push(emptyRow(colW));

            console.log(mergeBoxes(boxTop(colW, 'STRATEGY STATE'), boxTop(colW, 'TRADING SIGNALS')));
            for (let i = 0; i < leftRows.length; i++) {
                // Re-render for column width
                const lRow = leftRows[i] || emptyRow(colW);
                const rRow = rightRows[i] || emptyRow(colW);
                // Mode already renders full-width rows, so we need to truncate
                const lTrunc = truncateAnsi(lRow, colW);
                const rTrunc = truncateAnsi(rRow, colW);
                // Just print as-is if they're already formatted
                console.log(mergeBoxes(lTrunc + ' '.repeat(Math.max(0, colW - visibleLength(lTrunc))), rTrunc + ' '.repeat(Math.max(0, colW - visibleLength(rTrunc)))));
            }
            console.log(mergeBoxes(boxBot(colW), boxBot(colW)));
            console.log('');
        }
    }

    // === RECENT ACTIVITY LOG (full width) ===
    const logs = state.recentLogs.length ? state.recentLogs : ['(no logs yet)'];
    console.log(boxTop(fullW, 'RECENT ACTIVITY'));
    for (const line of logs.slice(0, 6)) {
        const truncLine = truncateAnsi(line, fullW - 4);
        console.log(c('│', ANSI.cyan) + ' ' + padRightAnsi(truncLine, fullW - 4) + ' ' + c('│', ANSI.cyan));
    }
    console.log(boxBot(fullW));
}

function executePaperDelta(deltaUsdc) {
    const next = paperBalance + deltaUsdc;
    if (!Number.isFinite(next)) return false;
    paperBalance = next;
    return true;
}

function getPaperBalance() {
    return paperBalance;
}

function findCertaintyTrade(tradeId) {
    const arr = state.certainty?.trades;
    if (!Array.isArray(arr)) return null;
    return arr.find((t) => t.tradeId === tradeId) || null;
}

function normalizeOutcomeLabel(raw) {
    if (raw === null || raw === undefined) return null;
    if (typeof raw === 'string') return raw.trim();
    if (typeof raw === 'number') return String(raw);
    return null;
}

function mapResolvedOutcomeToUpDown(resolvedLabel, marketObj) {
    const s = String(resolvedLabel || '').trim().toLowerCase();
    if (!s) return null;

    // Direct label matches
    if (s === 'up' || s.startsWith('up ')) return 'UP';
    if (s === 'down' || s.startsWith('down ')) return 'DOWN';

    // Some Gamma payloads store the winning outcome as an index into `outcomes`.
    const idx = Number.parseInt(s, 10);
    if (Number.isFinite(idx) && Array.isArray(marketObj?.outcomes) && marketObj.outcomes[idx]) {
        return mapResolvedOutcomeToUpDown(marketObj.outcomes[idx], null);
    }

    return null;
}

async function resolveGammaWinnerForMarketId(marketId) {
    if (!marketId) return null;
    try {
        const m = await gammaGetMarketById(marketId);
        if (!m || typeof m !== 'object') return null;

        // Only consider resolved when Gamma provides a winner.
        const winnerRaw =
            normalizeOutcomeLabel(m.outcome) ||
            normalizeOutcomeLabel(m.winningOutcome) ||
            normalizeOutcomeLabel(m.winning_outcome) ||
            normalizeOutcomeLabel(m.resolvedOutcome) ||
            normalizeOutcomeLabel(m.resolved_outcome) ||
            normalizeOutcomeLabel(m.result) ||
            null;

        const winner = mapResolvedOutcomeToUpDown(winnerRaw, m);
        return winner;
    } catch {
        return null;
    }
}

async function maybeSettlePaperPositions() {
    if (!PAPER_TRADING) return;

    const nowSec = Math.floor(Date.now() / 1000);

    // Arb straddle: always pays out N shares; fees are ignored in paper settlement.
    const open = state.arb.open;
    if (open && (nowSec >= open.endEpochSec)) {
        // Prefer Gamma winner when available; otherwise delay settlement.
        const winner = await resolveGammaWinnerForMarketId(open.marketId);
        if (winner) {
            const payout = open.sharesPerSide * 1.0;
            executePaperDelta(payout);

            const totalPnL = payout - open.totalCostUsdc;
            log(`PAPER STRADDLE SETTLED: +$${payout.toFixed(3)} | PnL=$${totalPnL.toFixed(3)} | winner=${winner}`, 'TRADE');
            state.arb.open = null;
        }
    }

    // Lag: pays out if side matches winner.
    const lagOpen = state.lag.open;
    if (lagOpen && (nowSec >= (lagOpen.endEpochSec || 0))) {
        const winner2 = await resolveGammaWinnerForMarketId(lagOpen.marketId);
        if (winner2) {
            const shares2 = lagOpen.shares;
            const entryCost2 = lagOpen.entryCostUsdc;
            const payout2 = (winner2 === lagOpen.side) ? (shares2 * 1.0) : 0.0;
            executePaperDelta(payout2);

            const pnl2 = (Number.isFinite(entryCost2) ? (payout2 - entryCost2) : null);
            const pnlStr2 = pnl2 === null ? 'PnL=—' : `PnL=$${pnl2.toFixed(3)}`;
            log(`PAPER LAG SETTLED: +$${payout2.toFixed(3)} | ${pnlStr2} | winner=${winner2}`, 'TRADE');
            state.lag.open = null;
        }
    }

    // Certainty: pays out if side matches winner.
    const certOpen = state.certainty.open;
    if (certOpen && (nowSec >= (certOpen.endEpochSec || 0))) {
        const winner3 = await resolveGammaWinnerForMarketId(certOpen.marketId);
        if (winner3) {
            const settleGas = Number(process.env.RES_GAS_SETTLE_USDC || 0);
            const shares3 = certOpen.shares;
            const entryCost3 = certOpen.entryCostUsdc;
            const payout3 = (winner3.toLowerCase() === certOpen.side) ? (shares3 * 1.0) : 0.0;
            executePaperDelta(payout3);
            if (Number.isFinite(settleGas) && settleGas > 0) executePaperDelta(-settleGas);

            const t = findCertaintyTrade(certOpen.tradeId);
            if (t) {
                t.exitTime = new Date();
                t.resolvedWinner = winner3;
                t.settlementPayoutUsdc = payout3;
                t.gasPaidUsdc = (Number.isFinite(t.gasPaidUsdc) ? t.gasPaidUsdc : 0) + (Number.isFinite(settleGas) ? settleGas : 0);
                t.capitalAfterUsdc = getPaperBalance();
                if (Number.isFinite(t.capitalBeforeUsdc) && t.capitalBeforeUsdc > 0) {
                    t.roi = (t.capitalAfterUsdc - t.capitalBeforeUsdc) / t.capitalBeforeUsdc;
                }
                if (t.status === 'OPEN') t.status = 'SETTLED';
            }

            const pnl3 = (Number.isFinite(entryCost3) ? (payout3 - entryCost3) : null);
            const pnlStr3 = pnl3 === null ? 'PnL=—' : `PnL=$${pnl3.toFixed(3)}`;
            const gasStr3 = Number.isFinite(settleGas) ? ` | gas=$${settleGas.toFixed(2)}` : '';
            log(`PAPER RES SETTLED: +$${payout3.toFixed(3)}${gasStr3} | ${pnlStr3} | winner=${winner3}`, 'TRADE');
            state.certainty.open = null;
        }
    }
}

// --- ENGINE LOOPS ---
let marketInFlight = false;
let underlyingInFlight = false;
let booksInFlight = false;
let quotesInFlight = false;
let collateralInFlight = false;

async function marketLoop() {
    if (marketInFlight) return;
    marketInFlight = true;
    try {
        await refreshCurrentIntervalMarket();
        await resolveOutcomeTokenIds();
    } catch (err) {
        log(err?.message || 'Market loop error', 'ERROR');
    } finally {
        marketInFlight = false;
    }
}

async function underlyingLoop() {
    if (underlyingInFlight) return;
    underlyingInFlight = true;
    try {
        await startBinanceWsTicker();
        // Note: intentionally only Binance WS + Chainlink per config constraint.

        // Always refresh Chainlink as fallback/anchor.
        await fetchUnderlyingChainlink();

        const wsHealthy = binanceWsConnected && (RTDS_SOURCE === 'binance_ws' || RTDS_SOURCE === 'auto');
        if (RTDS_SOURCE === 'binance_ws' && !wsHealthy) {
            state.underlyingFeeds.binance_ws.error = state.underlyingFeeds.binance_ws.error || 'Binance WS not connected';
        }

        if (RTDS_SOURCE === 'binance_ws') {
            applyUnderlyingFromFeed({ feed: state.underlyingFeeds.binance_ws });
        } else if (RTDS_SOURCE === 'chainlink') {
            applyUnderlyingFromFeed({ feed: state.underlyingFeeds.chainlink });
        } else {
            // auto: choose freshest between Binance WS and Chainlink.
            const best = pickBestUnderlyingFeed();
            if (best) applyUnderlyingFromFeed(best);
        }
    } catch {
        // errors stored in state
    } finally {
        // Capture the interval entry spot once per interval as a fallback reference.
        // Some market descriptions may omit a parseable "reference price".
        if (Number.isFinite(state.interval?.startEpochSec) && !Number.isFinite(state.interval?.entrySpot)) {
            const spot = state.underlying?.price;
            if (Number.isFinite(spot) && spot > 0) {
                state.interval.entrySpot = spot;
                state.interval.entrySpotSetAt = new Date();
            }
        }
        underlyingInFlight = false;
    }
}

async function booksLoop(mode) {
    if (booksInFlight) return;
    booksInFlight = true;
    try {
        await maybeSettlePaperPositions();
        await refreshOrderbooks(mode);
    } catch {
        // errors stored in state
    } finally {
        booksInFlight = false;
    }
}

async function quotesLoop() {
    if (quotesInFlight) return;
    quotesInFlight = true;
    try {
        await resolveOutcomeTokenIds();
        await refreshQuotes();
    } finally {
        quotesInFlight = false;
    }
}

async function collateralLoop() {
    if (collateralInFlight) return;
    collateralInFlight = true;
    try {
        if (PAPER_TRADING) return;
        const res = await clobClient.getBalanceAllowance({ asset_type: AssetType.COLLATERAL });
        const bal = Number.parseFloat(res?.balance);
        const allowance = Number.parseFloat(res?.allowance);
        state.collateral.balanceUsdc = Number.isFinite(bal) ? bal : null;
        state.collateral.allowanceUsdc = Number.isFinite(allowance) ? allowance : null;
        state.collateral.lastUpdated = new Date();
        state.collateral.error = null;
    } finally {
        collateralInFlight = false;
    }
}

export async function startEngine({ modeLabel, mode }) {
    if (LIVE_TRADING && !process.env.PRIVATE_KEY) {
        console.error('LIVE_TRADING=true requires PRIVATE_KEY in .env');
        process.exit(1);
    }
    if (LIVE_TRADING && !clobCreds) {
        console.error('LIVE_TRADING=true requires CLOB_API_KEY, CLOB_API_SECRET, CLOB_API_PASSPHRASE');
        process.exit(1);
    }
    if (LIVE_TRADING && !ENABLE_LIVE_ORDERS) {
        log('LIVE_TRADING enabled but ENABLE_LIVE_ORDERS is false; will NOT place orders.', 'WARN');
    }

    if (HAS_BUILDER_HEADERS) {
        log('Builder headers enabled (attribution). This does not make orders gasless; CLOB orders are off-chain, on-chain actions may still cost gas.', 'INFO');
    }

    // Bind mode context hooks.
    const ctx = {
        state,
        log,
        clobClient,
        wallet,
        walletManager,
        clobCreds,
        RTDS_SOURCE,
        LIVE_TRADING,
        ENABLE_LIVE_ORDERS,
        PAPER_TRADING,
        EST_ONCHAIN_TX_USD,
        getPaperBalance,
        executePaperDelta,
        helpers: {
            fmtCents,
            fmtMoney,
            feeAmountUsdc,
            normalizeFeeBps,
            applyTakerFeeOnBuy,
            applyTakerFeeOnSell,
            clampInt,
            costToBuySharesFromAsks,
            maxSharesForBudget,
            proceedsFromSellingSharesToBids,
            summarizeOrderbook,
            sortBidsAsksFromBook,
            liveCanSpendUsdc
        }
    };

    if (mode?.attach) {
        mode.attach(ctx);
    }

    // expose ctx to mode hooks via closure
    if (mode) {
        mode.onOrderbooks = mode.onOrderbooks?.bind(null, ctx);
        mode.renderDashboardRows = mode.renderDashboardRows?.bind(null, ctx);
    }

    log('Bot started.');

    // initial warmup (best-effort)
    await marketLoop();
    await underlyingLoop();
    await booksLoop(mode);
    await quotesLoop();
    await collateralLoop();

    const dashboardTimer = setInterval(() => renderDashboard(modeLabel, mode), DASHBOARD_MS);
    const marketTimer = setInterval(marketLoop, MARKET_REFRESH_MS);
    const underlyingTimer = setInterval(underlyingLoop, UNDERLYING_POLL_MS);
    const booksTimer = setInterval(() => booksLoop(mode), ORDERBOOK_POLL_MS);
    const quotesTimer = setInterval(quotesLoop, QUOTE_POLL_MS);
    const collateralTimer = setInterval(collateralLoop, BALANCE_POLL_MS);

    const shutdown = () => {
        clearInterval(dashboardTimer);
        clearInterval(marketTimer);
        clearInterval(underlyingTimer);
        clearInterval(booksTimer);
        clearInterval(quotesTimer);
        clearInterval(collateralTimer);
        try { binanceWsStop?.(); } catch { /* ignore */ }
        log('Shutting down...', 'INFO');
        setTimeout(() => process.exit(0), 50);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
}

// Load mode and start engine
const modeArg = process.argv[2] || 'arbitrage';
let mode;

if (modeArg === 'arbitrage') {
    const { createArbitrageMode } = await import('./modes/arbitrage.js');
    mode = createArbitrageMode();
} else if (modeArg === 'certainty') {
    const { createCertaintyMode } = await import('./modes/certainty.js');
    mode = createCertaintyMode();
} else if (modeArg === 'lag') {
    const { createLagMode } = await import('./modes/lag.js');
    mode = createLagMode();
} else {
    console.error(`Unknown mode: ${modeArg}`);
    process.exit(1);
}

startEngine({ modeLabel: modeArg, mode }).catch(console.error);
