import { OrderType, Side, AssetType } from '@polymarket/clob-client';

export function createCertaintyMode() {
    // Mode 3: Certainty Trading (Simple Strategy)
    // 
    // ENTRY RULES:
    // - ONLY enter with < 10 minutes remaining in interval
    // - First entry: Buy at 80c (0.80) with all funds, on EITHER direction (Up or Down)
    // - Entry must come from PRICE INCREASE (e.g., 78c→80c), NOT decrease (e.g., 85c→80c)
    // - After stop-loss: Re-entry at 75c in ANY direction (whichever hits first)
    // - After take-profit: Re-entry at 80c in ANY direction (whichever hits first)
    //
    // EXIT RULES:
    // - Stop-loss: Sell at 75c if price drops after entry
    // - Take-profit: Sell at 96c-99c
    //
    // KEY: Entries only happen when price is RISING to the entry level, never falling through it
    // NOTE: Re-entries can be in a DIFFERENT direction than the previous trade

    // TIME WINDOW: Only allow entries with less than this many seconds remaining
    const ENTRY_TIME_WINDOW_SEC = Number(process.env.RES_ENTRY_WINDOW_SEC || 600); // 10 minutes = 600 sec

    // Entry price RANGES (must be WITHIN range, not just at or below)
    const ENTRY_PRICE_MIN = Number(process.env.RES_ENTRY_PRICE_MIN || 0.80);  // 80c
    const ENTRY_PRICE_MAX = Number(process.env.RES_ENTRY_PRICE_MAX || 0.82);  // 82c
    const REENTRY_PRICE_MIN = Number(process.env.RES_REENTRY_PRICE_MIN || 0.75);  // 75c
    const REENTRY_PRICE_MAX = Number(process.env.RES_REENTRY_PRICE_MAX || 0.77);  // 77c
    
    // Exit thresholds
    const STOP_LOSS_PRICE = Number(process.env.RES_STOP_PRICE || 0.75);
    const TAKE_PROFIT_MIN = Number(process.env.RES_TAKE_PROFIT_MIN || 0.96);
    const TAKE_PROFIT_MAX = Number(process.env.RES_TAKE_PROFIT_MAX || 0.99);
    
    // Exit price buffers (slippage allowance for better fill rates)
    const STOP_LOSS_BUFFER = Number(process.env.RES_STOP_BUFFER || 0.015);  // Allow 1.5c below stop (73.5c)
    const TAKE_PROFIT_BUFFER = Number(process.env.RES_TP_BUFFER || 0.01);   // Allow 1c below TP (95c)
    
    // Startup protection: require N ticks of data before allowing any entry
    const MIN_TICKS_BEFORE_ENTRY = 5;

    // Liquidity / spread protection
    const MAX_SPREAD = Number(process.env.RES_MAX_SPREAD || 0.02);
    const MIN_SHARES = Number(process.env.RES_MIN_SHARES || 1);

    // Simulation knobs
    const ORDER_GAS_USDC = Number(process.env.RES_ORDER_GAS_USDC || 0);
    const COOLDOWN_MS = Number(process.env.RES_COOLDOWN_MS || 1000);
    const CONFIRM_TICKS = Math.max(1, Number(process.env.RES_CONFIRM_TICKS || 2));
    const PRICE_EPS = Number(process.env.RES_PRICE_EPS || 0.001);

    // Price direction tracking - how many ticks to require ascending price
    const DIRECTION_CONFIRM_TICKS = Math.max(1, Number(process.env.RES_DIRECTION_CONFIRM_TICKS || 2));

    // Polymarket Fee Model:
    // - Taker fee is 2% (200 bps) applied to the UNFAVORED side (1 - price)
    // - Fee = notional * (1 - price) * 0.02
    // - Example: Buy at 80c -> fee = notional * 0.20 * 0.02 = 0.4% of notional
    // - Example: Buy at 20c -> fee = notional * 0.80 * 0.02 = 1.6% of notional
    const POLYMARKET_FEE_RATE = 0.02; // 2%

    function calcPolymarketFee(notionalUsdc, price01) {
        if (!Number.isFinite(notionalUsdc) || !Number.isFinite(price01)) return 0;
        // Fee is based on the complementary price (unfavored side)
        const unfavoredSide = 1 - price01;
        return notionalUsdc * unfavoredSide * POLYMARKET_FEE_RATE;
    }

    function applyTakerFeeOnBuy(notionalUsdc, price01) {
        if (!Number.isFinite(notionalUsdc)) return null;
        const fee = calcPolymarketFee(notionalUsdc, price01);
        return notionalUsdc + fee;
    }

    function applyTakerFeeOnSell(grossUsdc, price01) {
        if (!Number.isFinite(grossUsdc)) return null;
        const fee = calcPolymarketFee(grossUsdc, price01);
        return grossUsdc - fee;
    }

    function costToBuySharesFromAsksReal(asks, shares, maxPrice01 = null) {
        if (!Array.isArray(asks) || asks.length === 0) return null;
        if (!(shares > 0)) return null;
        let remaining = shares;
        let notional = 0;
        let maxFilled = 0;
        let weightedPriceSum = 0;
        let filledShares = 0;
        for (const level of asks) {
            if (!(remaining > 0)) break;
            const p = level?.price;
            const sz = level?.size;
            if (!Number.isFinite(p) || !(p > 0) || !Number.isFinite(sz) || !(sz > 0)) continue;
            if (Number.isFinite(maxPrice01) && p > maxPrice01 + PRICE_EPS) break;
            const take = Math.min(remaining, sz);
            notional += take * p;
            weightedPriceSum += take * p;
            filledShares += take;
            maxFilled = p;
            remaining -= take;
        }
        if (remaining > 1e-9) return null;
        const avgPrice = filledShares > 0 ? weightedPriceSum / filledShares : maxFilled;
        const fee = calcPolymarketFee(notional, avgPrice);
        const cost = notional + fee;
        return { shares, notional, fee, cost, maxPrice: maxFilled, avgPrice };
    }

    function maxSharesForBudgetReal(asks, budgetUsdc, maxPrice01 = null, minShares = 1) {
        if (!Array.isArray(asks) || asks.length === 0) return null;
        if (!(budgetUsdc > 0)) return null;

        const totalSize = Math.floor((asks || []).reduce((acc, l) => acc + (Number.isFinite(l.size) ? l.size : 0), 0));
        if (totalSize < minShares) return null;

        const best = asks?.[0]?.price;
        if (!(best > 0)) return null;
        if (Number.isFinite(maxPrice01) && best > maxPrice01 + PRICE_EPS) return null;
        // Estimate cost per share including Polymarket fee
        const approxFeeRate = (1 - best) * POLYMARKET_FEE_RATE;
        const approxPerShare = best * (1 + approxFeeRate);
        const budgetBound = approxPerShare > 0 ? Math.floor(budgetUsdc / approxPerShare) : 0;
        let hi = Math.max(0, Math.min(totalSize, budgetBound));
        if (hi < minShares) return null;

        let lo = minShares;
        let bestFill = null;
        while (lo <= hi) {
            const mid = Math.floor((lo + hi) / 2);
            const fill = costToBuySharesFromAsksReal(asks, mid, maxPrice01);
            if (!fill) {
                hi = mid - 1;
                continue;
            }
            if (fill.cost <= budgetUsdc + 1e-9) {
                bestFill = fill;
                lo = mid + 1;
            } else {
                hi = mid - 1;
            }
        }
        return bestFill;
    }

    function proceedsFromSellingSharesToBidsReal(bids, shares, minPrice01 = null) {
        if (!Array.isArray(bids) || bids.length === 0) return null;
        if (!(shares > 0)) return null;
        let remaining = shares;
        let gross = 0;
        let minFilled = null;
        let weightedPriceSum = 0;
        let filledShares = 0;
        for (const level of bids) {
            if (!(remaining > 0)) break;
            const p = level?.price;
            const sz = level?.size;
            if (!Number.isFinite(p) || !Number.isFinite(sz) || !(sz > 0)) continue;
            if (Number.isFinite(minPrice01) && p < minPrice01 - PRICE_EPS) break;
            const take = Math.min(remaining, sz);
            gross += take * p;
            weightedPriceSum += take * p;
            filledShares += take;
            minFilled = p;
            remaining -= take;
        }
        if (remaining > 1e-9) return null;
        const avgPrice = filledShares > 0 ? weightedPriceSum / filledShares : minFilled;
        const fee = calcPolymarketFee(gross, avgPrice);
        const proceeds = gross - fee;
        return { shares, gross, fee, proceeds, minFilledPrice: minFilled, avgPrice };
    }

    // Find the best available price in the orderbook at or below the target price
    // Returns the price where we can actually fill orders, or null if orderbook is empty
    function findBestAvailableSellPrice(bids, targetPrice, maxPriceBelow = STOP_LOSS_BUFFER) {
        if (!Array.isArray(bids) || bids.length === 0) return null;
        
        let bestPrice = null;
        const minAcceptable = targetPrice - maxPriceBelow;
        
        for (const level of bids) {
            const p = level?.price;
            const sz = level?.size;
            if (!Number.isFinite(p) || !Number.isFinite(sz) || !(sz > 0)) continue;
            
            // We want the highest bid that's at or below our target
            if (p <= targetPrice + PRICE_EPS && p >= minAcceptable - PRICE_EPS) {
                if (bestPrice === null || p > bestPrice) {
                    bestPrice = p;
                }
            }
        }
        
        return bestPrice;
    }

    function nowSec() {
        return Math.floor(Date.now() / 1000);
    }

    function timeRemainingSec(ctx) {
        const end = ctx.state.interval?.endEpochSec;
        if (!Number.isFinite(end)) return null;
        return Math.max(0, end - nowSec());
    }

    function sideLabel(side) {
        return side === 'up' ? 'UP' : 'DOWN';
    }

    function getBooks(ctx, side) {
        if (side === 'up') {
            return {
                side,
                tokenId: ctx.state.tokens.upTokenId,
                asks: ctx.state.orderbooks.upAsksLevels,
                bids: ctx.state.orderbooks.upBidsLevels,
                summary: ctx.state.orderbooks.up,
                feeBps: ctx.state.tokens.upFeeBps
            };
        }
        return {
            side,
            tokenId: ctx.state.tokens.downTokenId,
            asks: ctx.state.orderbooks.downAsksLevels,
            bids: ctx.state.orderbooks.downBidsLevels,
            summary: ctx.state.orderbooks.down,
            feeBps: ctx.state.tokens.downFeeBps
        };
    }

    function spreadOk(summary) {
        const a = summary?.bestAsk;
        const b = summary?.bestBid;
        if (!(a > 0) || !(b > 0)) return false;
        return (a - b) <= (MAX_SPREAD + 1e-12);
    }

    function ensureTradeState(ctx) {
        if (!ctx.state.certainty) ctx.state.certainty = {};
        if (!Array.isArray(ctx.state.certainty.trades)) ctx.state.certainty.trades = [];
        if (!Number.isFinite(ctx.state.certainty.tradeSeq)) ctx.state.certainty.tradeSeq = 0;
        
        // Track 1-minute OHLC candles for momentum (better volatility handling)
        if (!ctx.state.certainty.candles) {
            ctx.state.certainty.candles = {
                up: { current: null, history: [] },
                down: { current: null, history: [] }
            };
        }
        
        // Track interval state (resets each 15-min interval)
        if (!ctx.state.certainty.intervalState) {
            ctx.state.certainty.intervalState = {
                marketId: null,
                lastExitType: null,  // 'stop-loss' or 'take-profit' or null
                entryCount: 0,
                startBtcPrice: null,  // BTC price at interval start (Beat Price)
                lastStopLossExitPrice: null  // Actual price where stop loss was executed
            };
        }
    }

    function nextTradeId(ctx) {
        ensureTradeState(ctx);
        ctx.state.certainty.tradeSeq += 1;
        return ctx.state.certainty.tradeSeq;
    }

    function findTrade(ctx, tradeId) {
        ensureTradeState(ctx);
        return ctx.state.certainty.trades.find((t) => t.tradeId === tradeId) || null;
    }

    function recordTrade(ctx, trade) {
        ensureTradeState(ctx);
        ctx.state.certainty.trades.push(trade);
    }

    // Update OHLC candles (1-minute bars)
    function updateOHLC(ctx, side, price) {
        ensureTradeState(ctx);
        const data = ctx.state.certainty.candles[side];
        const now = Date.now();
        const currentMinute = Math.floor(now / 60000); // Unix minute

        // Initialize current candle if missing or new minute started
        if (!data.current || data.current.minute !== currentMinute) {
            if (data.current) {
                // Archive previous candle
                data.history.push(data.current);
                if (data.history.length > 5) data.history.shift(); // Keep last 5 mins
            }
            // Start new candle
            data.current = {
                minute: currentMinute,
                open: price,
                high: price,
                low: price,
                close: price,
                startTime: now
            };
        }

        // Update current candle
        const c = data.current;
        c.close = price;
        if (price > c.high) c.high = price;
        if (price < c.low) c.low = price;
    }

    // Check if momentum is bullish on 1-minute chart
    // Rule: Current 1-minute candle is GREEN (Close >= Open) OR price higher than 1 minute ago
    // This handles volatility better: 83c->80c is still bullish if 1m open was <=80c
    function isBullishMomentum(ctx, side) {
        ensureTradeState(ctx);
        const data = ctx.state.certainty.candles[side];
        const c = data.current;
        
        if (!c) return false; // No data yet

        const currentPrice = c.close;
        const openPrice = c.open;
        
        // PRIMARY: Is the current 1-minute candle GREEN? (Close >= Open)
        // Handles 80c->83c->80c volatility: as long as 1m open was <=80c, it's bullish
        if (currentPrice >= openPrice - PRICE_EPS) {
            return true;
        }

        // SECONDARY: If current candle is slightly red, compare to previous minute
        const prev = data.history[data.history.length - 1];
        if (prev && currentPrice >= prev.close - PRICE_EPS) {
            return true;
        }
        
        return false;
    }
    
    // Check if we have enough history (at least 5 seconds in current candle)
    function isWarmedUp(ctx, side) {
        ensureTradeState(ctx);
        const data = ctx.state.certainty.candles[side];
        if (!data.current) return false;
        const MIN_SECONDS = 5;
        return (Date.now() - data.current.startTime) > (MIN_SECONDS * 1000);
    }

    // Get the current required entry price RANGE based on interval state
    function getCurrentEntryRange(ctx) {
        ensureTradeState(ctx);
        const iState = ctx.state.certainty.intervalState;
        
        // Check if we're in the same interval
        const currentMarketId = ctx.state.market?.id;
        if (!currentMarketId || currentMarketId !== iState.marketId) {
            // New interval - reset state and capture starting BTC price
            iState.marketId = currentMarketId;
            iState.lastExitType = null;
            iState.entryCount = 0;
            iState.lastStopLossExitPrice = null;  // Reset stop loss exit price
            // Capture BTC price at interval start (Beat Price)
            // Priority: 1) Chainlink price (interval.entrySpot), 2) Market's reference price from description
            const btcRef = ctx.state.interval?.entrySpot || ctx.state.market?.referencePrice;
            if (Number.isFinite(btcRef)) {
                iState.startBtcPrice = btcRef;
                // Expose to engine for dashboard display
                ctx.state.certainty.intervalStartBtcPrice = btcRef;
                ctx.log(`[CERTAINTY] Set Beat Price: $${btcRef.toFixed(2)} (from ${ctx.state.interval?.entrySpot ? 'Chainlink' : 'market desc'})`, 'DEBUG');
            }
            return { min: ENTRY_PRICE_MIN, max: ENTRY_PRICE_MAX, label: '80-82c' };
        }
        
        // Same interval - ensure intervalStartBtcPrice is always exposed to engine
        if (Number.isFinite(iState.startBtcPrice)) {
            ctx.state.certainty.intervalStartBtcPrice = iState.startBtcPrice;
        }
        
        // Same interval - check last exit type
        if (iState.lastExitType === 'stop-loss') {
            // If we have an actual stop loss exit price, use it for re-entry
            // This handles cases where price jumped and we exited below 75c
            if (Number.isFinite(iState.lastStopLossExitPrice)) {
                // Re-entry at the actual exit price (with small buffer for price variation)
                const reentryPrice = iState.lastStopLossExitPrice;
                // Use the configured STOP_LOSS_BUFFER as the re-entry window around the actual exit price
                const buffer = STOP_LOSS_BUFFER || 0.015;
                return { 
                    min: Math.max(0.01, reentryPrice - buffer), 
                    max: reentryPrice + buffer, 
                    label: ctx.helpers.fmtCents(reentryPrice, 1) 
                };
            }
            // Fallback to standard range if no exit price recorded
            return { min: REENTRY_PRICE_MIN, max: REENTRY_PRICE_MAX, label: '75-77c' };
        }
        
        // After take-profit or first entry
        return { min: ENTRY_PRICE_MIN, max: ENTRY_PRICE_MAX, label: '80-82c' };
    }

    // Check if we should enter a position
    function canEnterPosition(ctx, side, tRem) {
        const books = getBooks(ctx, side);
        const bestAsk = books.summary?.bestAsk;
        const bestBid = books.summary?.bestBid;
        const mark = books.summary?.mark;
        
        const iState = ctx.state.certainty?.intervalState || {};
        const reentryRequired = !!iState.requireReentryUntilResolved;

        // STARTUP PROTECTION: Don't enter until we have enough candle data
        if (!reentryRequired && !isWarmedUp(ctx, side)) {
            return { ok: false, reason: 'Warming up (need 5s)' };
        }

        // TIME WINDOW CHECK: Only enter with < 10 minutes remaining (unless re-entry is required)
        if (!reentryRequired && (!Number.isFinite(tRem) || tRem > ENTRY_TIME_WINDOW_SEC)) {
            const minLeft = Number.isFinite(tRem) ? Math.ceil(tRem / 60) : '?';
            return { ok: false, reason: 'Wait for <10min (' + minLeft + 'm left)' };
        }
        
        if (!(bestAsk > 0)) return { ok: false, reason: 'No best ask' };
        if (!spreadOk(books.summary)) return { ok: false, reason: 'Spread too wide' };
        
        const entryRange = getCurrentEntryRange(ctx);
        
        // Check if price is WITHIN the entry range (not above, not below)
        if (bestAsk > entryRange.max + PRICE_EPS) {
            return { ok: false, reason: 'Ask ' + (bestAsk * 100).toFixed(1) + 'c > ' + entryRange.label };
        }
        if (bestAsk < entryRange.min - PRICE_EPS) {
            return { ok: false, reason: 'Ask ' + (bestAsk * 100).toFixed(1) + 'c < ' + entryRange.label };
        }
        
        // CRITICAL: Check if 1-minute momentum is bullish (unless re-entry required)
        if (!reentryRequired && !isBullishMomentum(ctx, side)) {
            return { ok: false, reason: 'Bearish 1m candle' };
        }
        
        const capitalBefore = ctx.PAPER_TRADING
            ? ctx.getPaperBalance()
            : (Number.isFinite(ctx.state.collateral?.balanceUsdc) ? ctx.state.collateral.balanceUsdc : null);
        
        if (!(capitalBefore > 0)) return { ok: false, reason: 'No capital' };
        
        const budget = ctx.PAPER_TRADING ? (capitalBefore - ORDER_GAS_USDC) : capitalBefore;
        if (!(budget > 0)) return { ok: false, reason: 'Capital too small' };
        
        const fill = maxSharesForBudgetReal(books.asks, budget, entryRange.max, MIN_SHARES);
        if (!fill) return { ok: false, reason: 'Insufficient liquidity' };
        
        return {
            ok: true,
            reason: null,
            side,
            entryRange,
            books,
            fill,
            capitalBefore,
            debug: {
                bestAsk,
                bestBid,
                mark: mark ?? null,
                priceAscending: true
            }
        };
    }

    // Check for stop-loss condition
    // IMPORTANT: Only trigger stop-loss if we have a valid entry (position opened after startup)
    function checkStopLoss(ctx, open) {
        // Don't trigger stop-loss if position was not properly entered
        if (!open || !open.openedAt) return { trigger: false, px: null };
        
        // Require position to be at least 2 seconds old to avoid false triggers on startup
        const posAgeMs = Date.now() - open.openedAt.getTime();
        if (posAgeMs < 2000) return { trigger: false, px: null };
        
        const books = getBooks(ctx, open.side);
        const bestBid = books.summary?.bestBid;
        const mark = books.summary?.mark;
        const px = (Number.isFinite(mark) && mark > 0) ? mark : bestBid;
        
        if (!Number.isFinite(px) || !(px > 0)) return { trigger: false, px: null };
        
        // Stop-loss triggers at or below 75c
        return { trigger: (px <= STOP_LOSS_PRICE + PRICE_EPS), px, type: 'stop-loss' };
    }

    // Check for take-profit condition
    function checkTakeProfit(ctx, open) {
        const books = getBooks(ctx, open.side);
        const bestBid = books.summary?.bestBid;
        const mark = books.summary?.mark;
        const px = (Number.isFinite(mark) && mark > 0) ? mark : bestBid;
        
        if (!Number.isFinite(px) || !(px > 0)) return { trigger: false, px: null };
        
        // Take-profit triggers between 96c and 99c
        const inTakeProfitZone = (px >= TAKE_PROFIT_MIN - PRICE_EPS) && (px <= TAKE_PROFIT_MAX + PRICE_EPS);
        return { trigger: inTakeProfitZone, px, type: 'take-profit' };
    }

    function executePaperBuy(ctx, { tradeId, side, tokenId, shares, fill, maxPrice01, capitalBeforeUsdc }) {
        if (ctx.state.certainty.open) return;
        if (!(shares > 0) || !fill) return;
        const gas = ORDER_GAS_USDC;
        const total = fill.cost + gas;
        if (total > ctx.getPaperBalance()) return;

        ctx.executePaperDelta(-total);

        const endEpochSec = ctx.state.interval?.endEpochSec || (nowSec() + 15 * 60);
        ctx.state.certainty.open = {
            tradeId,
            side,
            tokenId,
            shares,
            entryCostUsdc: fill.cost,
            entryNotionalUsdc: fill.notional,
            entryFeeUsdc: fill.fee,
            entryGasUsdc: gas,
            entryLimitPrice: maxPrice01,
            openedAt: new Date(),
            endEpochSec,
            marketId: ctx.state.market?.id ?? null,
            referencePrice: Number.isFinite(ctx.state.market?.referencePrice) ? ctx.state.market.referencePrice : null,
            entrySpot: Number.isFinite(ctx.state.underlying?.price) ? ctx.state.underlying.price : null
        };

        // Update interval state
        ctx.state.certainty.intervalState.entryCount += 1;

        // Clear re-entry requirement on successful entry
        if (ctx.state.certainty.intervalState) {
            ctx.state.certainty.intervalState.requireReentryUntilResolved = false;
            ctx.state.certainty.intervalState.lastExitType = null;
        }

        const tRem = timeRemainingSec(ctx);
        recordTrade(ctx, {
            tradeId,
            entryTime: new Date(),
            timeToResolutionSec: tRem,
            entrySide: sideLabel(side),
            entryPrice: maxPrice01,
            shares,
            entryNotionalUsdc: fill.notional,
            takerFeesPaidUsdc: fill.fee,
            gasPaidUsdc: gas,
            capitalBeforeUsdc,
            capitalAfterUsdc: ctx.getPaperBalance(),
            status: 'OPEN'
        });

        ctx.log('PAPER BUY #' + tradeId + ': ' + sideLabel(side) + ' ' + shares + ' sh @<=' + ctx.helpers.fmtCents(maxPrice01, 1) + ' | cost=$' + fill.cost.toFixed(3) + ' fee=$' + fill.fee.toFixed(4) + ' gas=$' + gas.toFixed(2) + ' | t=' + Math.floor(tRem || 0) + 's | cap=$' + capitalBeforeUsdc.toFixed(3) + '->$' + ctx.getPaperBalance().toFixed(3), 'TRADE');
    }

    async function executeLiveBuy(ctx, { entry }) {
        if (ctx.PAPER_TRADING) return;
        if (!ctx.ENABLE_LIVE_ORDERS) return;
        const { side, books, fill, tradeId: maybeTradeId, limitPrice01 } = entry || {};
        const tokenId = books?.tokenId;
        const shares = fill?.shares;
        const maxPrice01 = Number.isFinite(limitPrice01) ? limitPrice01 : fill?.maxPrice;
        const costUsdc = fill?.cost;
        const tRem = timeRemainingSec(ctx);
        
        if (!tokenId) throw new Error('Missing token id');
        if (!ctx.clobCreds) throw new Error('Missing CLOB API creds (CLOB_API_KEY/SECRET/PASSPHRASE)');

    // Capture available capital before attempting live buy (used for reinvestment tracking)
    const capitalBefore = Number.isFinite(ctx.state.collateral?.balanceUsdc) ? ctx.state.collateral.balanceUsdc : null;

    let canSpend = ctx.helpers.liveCanSpendUsdc(costUsdc);
    if (!canSpend.ok) {
            // If balance/allowance are unknown (initial load), try a synchronous refresh
            if (canSpend.reason && String(canSpend.reason).toLowerCase().includes('unknown')) {
                try {
                    const res = await ctx.clobClient.getBalanceAllowance({ asset_type: AssetType.COLLATERAL });
                    const bal = Number.parseFloat(res?.balance);
                    const allowance = Number.parseFloat(res?.allowance);
                    ctx.state.collateral.balanceUsdc = Number.isFinite(bal) ? bal : null;
                    ctx.state.collateral.allowanceUsdc = Number.isFinite(allowance) ? allowance : null;
                    ctx.state.collateral.lastUpdated = new Date();
                    // Re-evaluate spending after refresh
                    canSpend = ctx.helpers.liveCanSpendUsdc(costUsdc);
                } catch (err) {
                    ctx.log('Failed to refresh balance/allowance: ' + (err?.message || err), 'ERROR');
                }
            }

            if (!canSpend.ok) {
                ctx.log('LIVE BUY blocked: ' + canSpend.reason, 'WARN');
                return;
            }
        }

        const order = {
            tokenID: tokenId,
            price: maxPrice01,
            size: shares,
            side: Side.BUY
        };

        await ctx.clobClient.createAndPostOrder(order, undefined, OrderType.FOK, false);

        const endEpochSec = ctx.state.interval?.endEpochSec || (nowSec() + 15 * 60);
        const tradeId = Number.isFinite(maybeTradeId) ? maybeTradeId : nextTradeId(ctx);
        ctx.state.certainty.open = {
            tradeId,
            side,
            tokenId,
            shares,
            entryCostUsdc: costUsdc,
            entryLimitPrice: maxPrice01,
            openedAt: new Date(),
            endEpochSec,
            marketId: ctx.state.market?.id ?? null,
            referencePrice: Number.isFinite(ctx.state.market?.referencePrice) ? ctx.state.market.referencePrice : null,
            entrySpot: Number.isFinite(ctx.state.underlying?.price) ? ctx.state.underlying.price : null
        };

        // Update interval state
        ctx.state.certainty.intervalState.entryCount += 1;

        // Clear re-entry requirement on successful entry
        if (ctx.state.certainty.intervalState) {
            ctx.state.certainty.intervalState.requireReentryUntilResolved = false;
            ctx.state.certainty.intervalState.lastExitType = null;
        }

        recordTrade(ctx, {
            tradeId,
            entryTime: new Date(),
            timeToResolutionSec: tRem,
            entrySide: sideLabel(side),
            entryPrice: maxPrice01,
            shares,
            entryNotionalUsdc: fill?.notional ?? null,
            takerFeesPaidUsdc: fill?.fee ?? null,
            gasPaidUsdc: ORDER_GAS_USDC,
            capitalBeforeUsdc: capitalBefore,
            capitalAfterUsdc: null,
            status: 'OPEN'
        });

        ctx.log('LIVE BUY #' + tradeId + ': ' + sideLabel(side) + ' ' + shares + ' sh @<=' + ctx.helpers.fmtCents(maxPrice01, 1) + ' | estCost=$' + Number(costUsdc || 0).toFixed(3) + ' | t=' + Math.floor(Number(tRem || 0)) + 's', 'TRADE');
    }

    function executePaperSell(ctx, open, sellFill, exitType) {
        if (!open) return;
        if (!sellFill) return;
        const gas = ORDER_GAS_USDC;
        ctx.executePaperDelta(sellFill.proceeds);
        ctx.executePaperDelta(-gas);

        const t = findTrade(ctx, open.tradeId);
        if (t) {
            t.exitType = exitType;
            t.exitTime = new Date();
            t.exitPrice = sellFill.minFilledPrice;
            t.exitGrossUsdc = sellFill.gross;
            t.exitFeeUsdc = sellFill.fee;
            t.exitProceedsUsdc = sellFill.proceeds;
            t.gasPaidUsdc = (Number.isFinite(t.gasPaidUsdc) ? t.gasPaidUsdc : 0) + gas;
            t.capitalAfterUsdc = ctx.getPaperBalance();
            t.status = exitType === 'take-profit' ? 'PROFIT' : 'STOPPED';
            if (Number.isFinite(t.capitalBeforeUsdc) && t.capitalBeforeUsdc > 0) {
                t.roi = (t.capitalAfterUsdc - t.capitalBeforeUsdc) / t.capitalBeforeUsdc;
            }
        }

        // Update interval state with exit type
        ctx.state.certainty.intervalState.lastExitType = exitType;
        
        // If this is a stop loss, store the actual exit price for re-entry
        if (exitType === 'stop-loss' && Number.isFinite(sellFill.avgPrice)) {
            ctx.state.certainty.intervalState.lastStopLossExitPrice = sellFill.avgPrice;
            // Require re-entry targeting this actual exit price until we successfully re-enter
            ctx.state.certainty.intervalState.requireReentryUntilResolved = true;
        }

        const exitLabel = exitType === 'take-profit' ? 'TAKE-PROFIT' : 'STOP-LOSS';
        ctx.log('PAPER ' + exitLabel + ' #' + open.tradeId + ': ' + sideLabel(open.side) + ' ' + open.shares + ' sh @' + ctx.helpers.fmtCents(sellFill.minFilledPrice, 1) + ' | proceeds=$' + sellFill.proceeds.toFixed(3) + ' fee=$' + sellFill.fee.toFixed(4) + ' gas=$' + gas.toFixed(2) + ' | cap=$' + ctx.getPaperBalance().toFixed(3), 'TRADE');
        ctx.state.certainty.open = null;
    }

    async function executeLiveSell(ctx, open, { tokenId, minPrice01, proceedsUsdc, exitType }) {
        if (ctx.PAPER_TRADING) return;
        if (!ctx.ENABLE_LIVE_ORDERS) return;
        if (!tokenId) throw new Error('Missing token id');
        if (!ctx.clobCreds) throw new Error('Missing CLOB API creds (CLOB_API_KEY/SECRET/PASSPHRASE)');

        const order = {
            tokenID: tokenId,
            price: minPrice01,
            size: open.shares,
            side: Side.SELL
        };

        await ctx.clobClient.createAndPostOrder(order, undefined, OrderType.FOK, false);
        
        // Update interval state with exit type
        ctx.state.certainty.intervalState.lastExitType = exitType;
        
        // If this is a stop loss, store the actual exit price for re-entry and require re-entry until satisfied
        if (exitType === 'stop-loss' && Number.isFinite(minPrice01)) {
            ctx.state.certainty.intervalState.lastStopLossExitPrice = minPrice01;
            ctx.state.certainty.intervalState.requireReentryUntilResolved = true;
        }

        // Update local exchange balance optimistically to allow immediate reinvestment
        try {
            const prevBal = Number.isFinite(ctx.state.collateral?.balanceUsdc) ? ctx.state.collateral.balanceUsdc : 0;
            const newBal = prevBal + (Number.isFinite(proceedsUsdc) ? proceedsUsdc : 0) - ORDER_GAS_USDC;
            ctx.state.collateral.balanceUsdc = newBal;
            ctx.state.collateral.lastUpdated = new Date();
        } catch (e) {
            // ignore
        }

        // Update recorded trade (if any) with exit info so capitalAfter is available for reinvest
        try {
            const t = findTrade(ctx, open.tradeId);
            if (t) {
                t.exitType = exitType;
                t.exitTime = new Date();
                t.exitPrice = minPrice01;
                t.exitProceedsUsdc = Number.isFinite(proceedsUsdc) ? proceedsUsdc : null;
                t.gasPaidUsdc = (Number.isFinite(t.gasPaidUsdc) ? t.gasPaidUsdc : 0) + ORDER_GAS_USDC;
                t.capitalAfterUsdc = Number.isFinite(ctx.state.collateral?.balanceUsdc) ? ctx.state.collateral.balanceUsdc : null;
                t.status = exitType === 'take-profit' ? 'PROFIT' : 'STOPPED';
                if (Number.isFinite(t.capitalBeforeUsdc) && t.capitalBeforeUsdc > 0) {
                    t.roi = (t.capitalAfterUsdc - t.capitalBeforeUsdc) / t.capitalBeforeUsdc;
                }
            }
        } catch (e) {
            // ignore
        }

        const exitLabel = exitType === 'take-profit' ? 'TAKE-PROFIT' : 'STOP-LOSS';
        ctx.log('LIVE ' + exitLabel + ': ' + sideLabel(open.side) + ' ' + open.shares + ' sh @>=' + ctx.helpers.fmtCents(minPrice01, 1) + ' (est proceeds $' + (proceedsUsdc || 0).toFixed(3) + ')', 'TRADE');
        ctx.state.certainty.open = null;
    }

    function cooldownOk(ctx) {
        const last = ctx.state.certainty.lastTradeAt ? ctx.state.certainty.lastTradeAt.getTime() : 0;
        return (Date.now() - last) >= COOLDOWN_MS;
    }

    function bumpConfirm(ctx, side) {
        if (!ctx.state.certainty._confirm) ctx.state.certainty._confirm = { side: null, ticks: 0 };
        const c = ctx.state.certainty._confirm;
        if (c.side === side) c.ticks += 1;
        else {
            c.side = side;
            c.ticks = 1;
        }
        return c.ticks;
    }

    function clearConfirm(ctx) {
        if (ctx.state.certainty._confirm) ctx.state.certainty._confirm = { side: null, ticks: 0 };
    }

    return {
        onOrderbooks: async (ctx) => {
            ensureTradeState(ctx);

            const tRem = timeRemainingSec(ctx);
            ctx.state.certainty.timeRemainingSec = Number.isFinite(tRem) ? tRem : null;

            // Update OHLC candles for both sides (1-minute bars)
            const upBooks = getBooks(ctx, 'up');
            const downBooks = getBooks(ctx, 'down');
            
            if (Number.isFinite(upBooks.summary?.bestAsk)) {
                updateOHLC(ctx, 'up', upBooks.summary.bestAsk);
            }
            if (Number.isFinite(downBooks.summary?.bestAsk)) {
                updateOHLC(ctx, 'down', downBooks.summary.bestAsk);
            }

            const open = ctx.state.certainty.open;
            ctx.state.certainty.lastEvalAt = new Date();

            // ═══════════════════════════════════════════════════════════════
            // POSITION MANAGEMENT: Check exits for open position
            // ═══════════════════════════════════════════════════════════════
            if (open) {
                // Check if interval has ended (awaiting resolution)
                if (Number.isFinite(open.endEpochSec) && nowSec() >= open.endEpochSec) {
                    ctx.state.certainty.exitReasons = 'Awaiting resolution';
                    return;
                }

                // Check for market mismatch (interval rolled)
                const currentTokenId = open.side === 'up' ? ctx.state.tokens.upTokenId : ctx.state.tokens.downTokenId;
                if (currentTokenId && open.tokenId && String(currentTokenId) !== String(open.tokenId)) {
                    ctx.state.certainty.exitReasons = 'Token mismatch (interval rolled)';
                    return;
                }

                if (open.marketId && ctx.state.market?.id && String(open.marketId) !== String(ctx.state.market.id)) {
                    ctx.state.certainty.exitReasons = 'Market mismatch (interval rolled)';
                    return;
                }

                // Check TAKE-PROFIT first (priority over stop-loss)
                const tp = checkTakeProfit(ctx, open);
                if (tp.trigger) {
                    ctx.state.certainty.exitReasons = 'TAKE-PROFIT @' + ctx.helpers.fmtCents(tp.px, 1);
                    
                    // Confirm take-profit signal
                    if (!ctx.state.certainty._tpConfirm) ctx.state.certainty._tpConfirm = { ticks: 0 };
                    ctx.state.certainty._tpConfirm.ticks += 1;
                    if (ctx.state.certainty._tpConfirm.ticks < CONFIRM_TICKS) return;
                    if (!cooldownOk(ctx)) return;

                    const books = getBooks(ctx, open.side);
                    // Try to fill at or above (TP_MIN - buffer) for better execution
                    const minAcceptablePrice = TAKE_PROFIT_MIN - TAKE_PROFIT_BUFFER;
                    const sellFill = proceedsFromSellingSharesToBidsReal(books.bids, open.shares, minAcceptablePrice);
                    
                    if (!sellFill) {
                        ctx.log('TAKE-PROFIT blocked: no fill at >=' + ctx.helpers.fmtCents(minAcceptablePrice, 1), 'WARN');
                        return;
                    }

                    try {
                        if (ctx.PAPER_TRADING) {
                            executePaperSell(ctx, open, sellFill, 'take-profit');
                        } else {
                            await executeLiveSell(ctx, open, {
                                tokenId: books.tokenId,
                                minPrice01: TAKE_PROFIT_MIN - TAKE_PROFIT_BUFFER,
                                proceedsUsdc: sellFill.proceeds,
                                exitType: 'take-profit'
                            });
                        }
                        ctx.state.certainty.lastTradeAt = new Date();
                        clearConfirm(ctx);
                        ctx.state.certainty._tpConfirm = { ticks: 0 };
                        ctx.state.certainty._stopConfirm = { ticks: 0 };
                    } catch (err) {
                        ctx.log('TAKE-PROFIT sell failed: ' + (err?.message || err), 'ERROR');
                    }
                    return;
                }

                // Check STOP-LOSS
                const sl = checkStopLoss(ctx, open);
                ctx.state.certainty.exitReasons = sl.trigger ? 'STOP-LOSS @' + ctx.helpers.fmtCents(sl.px, 1) : null;
                
                if (sl.trigger) {
                    // Confirm stop signal
                    if (!ctx.state.certainty._stopConfirm) ctx.state.certainty._stopConfirm = { ticks: 0 };
                    ctx.state.certainty._stopConfirm.ticks += 1;
                    ctx.state.certainty.confirmTicks = ctx.state.certainty._stopConfirm.ticks;
                    if (ctx.state.certainty._stopConfirm.ticks < CONFIRM_TICKS) return;
                    if (!cooldownOk(ctx)) return;

                    const books = getBooks(ctx, open.side);
                    
                    // Find the best available price in the orderbook at or below stop loss target
                    // This handles cases where there are price jumps and no liquidity at exactly 75c
                    const bestAvailablePrice = findBestAvailableSellPrice(books.bids, STOP_LOSS_PRICE, STOP_LOSS_BUFFER);
                    
                    if (!bestAvailablePrice || !Number.isFinite(bestAvailablePrice)) {
                        ctx.log('STOP-LOSS blocked: no bids available in range ' + 
                            ctx.helpers.fmtCents(STOP_LOSS_PRICE - STOP_LOSS_BUFFER, 1) + '-' + 
                            ctx.helpers.fmtCents(STOP_LOSS_PRICE, 1), 'WARN');
                        return;
                    }
                    
                    // Try to sell at the best available price we found
                    const sellFill = proceedsFromSellingSharesToBidsReal(books.bids, open.shares, bestAvailablePrice);
                    
                    if (!sellFill) {
                        ctx.log('STOP-LOSS blocked: cannot fill ' + open.shares + ' shares at ' + 
                            ctx.helpers.fmtCents(bestAvailablePrice, 1), 'WARN');
                        return;
                    }

                    try {
                        // Store the actual exit price for re-entry logic
                        const actualExitPrice = sellFill.avgPrice;
                        
                        if (ctx.PAPER_TRADING) {
                            executePaperSell(ctx, open, sellFill, 'stop-loss');
                        } else {
                            await executeLiveSell(ctx, open, {
                                tokenId: books.tokenId,
                                minPrice01: bestAvailablePrice,
                                proceedsUsdc: sellFill.proceeds,
                                exitType: 'stop-loss'
                            });
                        }
                        
                        // Log the actual execution price for re-entry reference
                        ctx.log('STOP-LOSS executed at ' + ctx.helpers.fmtCents(actualExitPrice, 2) + 
                            ' (re-entry will target this price)', 'INFO');
                        
                        ctx.state.certainty.lastTradeAt = new Date();
                        clearConfirm(ctx);
                        ctx.state.certainty._stopConfirm = { ticks: 0 };
                    } catch (err) {
                        ctx.log('STOP-LOSS sell failed: ' + (err?.message || err), 'ERROR');
                    }
                }
                
                // Reset take-profit confirm if not triggered
                ctx.state.certainty._tpConfirm = { ticks: 0 };
                return;
            }

            // ═══════════════════════════════════════════════════════════════
            // NO OPEN POSITION: Look for entry opportunities
            // ═══════════════════════════════════════════════════════════════
            ctx.state.certainty.exitReasons = null;
            ctx.state.certainty.confirmTicks = null;
            ctx.state.certainty._stopConfirm = { ticks: 0 };
            ctx.state.certainty._tpConfirm = { ticks: 0 };

            // Check both UP and DOWN sides for entry
            const upEntry = canEnterPosition(ctx, 'up', tRem);
            const downEntry = canEnterPosition(ctx, 'down', tRem);

            // Choose the best entry (prefer the one with more shares / better fill)
            let enter = null;
            if (upEntry.ok && downEntry.ok) {
                // Both sides qualify - pick the one with more shares
                enter = (upEntry.fill.shares >= downEntry.fill.shares) ? upEntry : downEntry;
            } else if (upEntry.ok) {
                enter = upEntry;
            } else if (downEntry.ok) {
                enter = downEntry;
            }

            // Update dashboard state
            const currentEntryRange = getCurrentEntryRange(ctx);
            ctx.state.certainty.requiredEntryRange = currentEntryRange;
            ctx.state.certainty.lastExitType = ctx.state.certainty.intervalState?.lastExitType || null;
            ctx.state.certainty.upBullish = isBullishMomentum(ctx, 'up');
            ctx.state.certainty.downBullish = isBullishMomentum(ctx, 'down');
            
            ctx.state.certainty.entryOk = enter?.ok || false;
            ctx.state.certainty.entryReason = enter?.ok ? null : (upEntry.reason || downEntry.reason || 'No entry');
            ctx.state.certainty.entrySide = enter?.ok ? enter.side : null;
            ctx.state.certainty.bestAsk01 = enter?.ok ? (enter.debug?.bestAsk ?? null) : null;
            ctx.state.certainty.bestBid01 = enter?.ok ? (enter.debug?.bestBid ?? null) : null;
            ctx.state.certainty.mark01 = enter?.ok ? (enter.debug?.mark ?? null) : null;
            ctx.state.certainty.estCostUsdc = enter?.ok ? (enter.fill?.cost ?? null) : null;
            ctx.state.certainty.estFeeUsdc = enter?.ok ? (enter.fill?.fee ?? null) : null;

            if (!enter || !enter.ok) {
                clearConfirm(ctx);
                return;
            }

            if (!cooldownOk(ctx)) return;

            const ticks = bumpConfirm(ctx, enter.side);
            ctx.state.certainty.confirmTicks = ticks;
            if (ticks < CONFIRM_TICKS) return;

            // Execute entry
            const tradeId = nextTradeId(ctx);
            ctx.state.opportunitiesFound += 1;
            ctx.state.certainty.lastSignalAt = new Date();

            const fee = enter.fill?.fee ?? 0;
            const gas = ORDER_GAS_USDC;
            const cost = (enter.fill?.cost ?? 0);
            const limitPrice01 = enter.entryRange.max;
            const maxFillStr = Number.isFinite(enter.fill.maxPrice)
                ? ' (maxFill ' + ctx.helpers.fmtCents(enter.fill.maxPrice, 1) + ')'
                : '';
            
            ctx.log('ENTRY #' + tradeId + ': ' + sideLabel(enter.side) + ' | entryLvl=' + (limitPrice01 * 100).toFixed(0) + 'c | sh=' + enter.fill.shares + ' @<=' + ctx.helpers.fmtCents(limitPrice01, 1) + maxFillStr + ' | cost=$' + cost.toFixed(3) + ' fee=$' + fee.toFixed(4) + ' gas=$' + gas.toFixed(2) + ' | t=' + Math.floor(Number(tRem || 0)) + 's', 'SUCCESS');

            try {
                if (ctx.PAPER_TRADING) {
                    executePaperBuy(ctx, {
                        tradeId,
                        side: enter.side,
                        tokenId: enter.books.tokenId,
                        shares: enter.fill.shares,
                        fill: enter.fill,
                        maxPrice01: limitPrice01,
                        capitalBeforeUsdc: enter.capitalBefore
                    });
                } else {
                    await executeLiveBuy(ctx, { entry: { ...enter, tradeId, limitPrice01 } });
                }
                ctx.state.certainty.lastTradeAt = new Date();
                clearConfirm(ctx);
            } catch (err) {
                ctx.log('BUY failed: ' + (err?.message || err), 'ERROR');
            }
        },

        renderDashboardRows: (ctx, { render, width }) => {
            const colW = 48; // Match engine grid column width
            const tRem = ctx.state.certainty?.timeRemainingSec;
            const tStr = Number.isFinite(tRem) ? Math.floor(tRem) + 's' : '—';
            const entryWindow = tRem <= ENTRY_TIME_WINDOW_SEC;
            const timeColor = entryWindow ? render.ANSI.green : render.ANSI.yellow;
            const timeLabel = Number.isFinite(tRem) ? (entryWindow ? render.c(tStr + ' ✓', timeColor) : render.c(tStr + ' (wait)', timeColor)) : '—';

            // Entry price range info
            const entryRange = ctx.state.certainty?.requiredEntryRange;
            const lastExit = ctx.state.certainty?.lastExitType;
            const entryPriceStr = entryRange
                ? entryRange.label + (lastExit ? ' (' + lastExit + ')' : '')
                : '—';

            // Price direction (combined) - 1m candle momentum
            const upBullish = ctx.state.certainty?.upBullish;
            const downBullish = ctx.state.certainty?.downBullish;
            const upDir = upBullish ? render.c('UP▲', render.ANSI.green) : render.c('UP▼', render.ANSI.gray);
            const downDir = downBullish ? render.c('DN▲', render.ANSI.green) : render.c('DN▼', render.ANSI.gray);
            const dirStr = upDir + '  ' + downDir;

            const entryOk = ctx.state.certainty?.entryOk;
            const entryReason = ctx.state.certainty?.entryReason;
            const entrySide = ctx.state.certainty?.entrySide;
            const entryStr = entryOk
                ? render.c('READY ' + sideLabel(entrySide), render.ANSI.green)
                : render.c(entryReason || '—', render.ANSI.gray);

            const open = ctx.state.certainty?.open;
            
            // BTC Price to Beat (interval start price) and Difference
            const intervalStartPrice = ctx.state.certainty?.intervalStartBtcPrice;
            // TRADING SIGNALS: Entry price, direction, mark, % gain
            let entryPxStr = '—';
            let directionStr = '—';
            let markPxStr = '—';
            let pctGainStr = '—';
            
            if (open) {
                // Entry price (what we paid per share)
                const entryPricePerShare = open.entryLimitPrice || (open.entryCostUsdc / open.shares);
                entryPxStr = render.c((entryPricePerShare * 100).toFixed(1) + 'c', render.ANSI.cyan);
                
                // Direction
                directionStr = render.c(sideLabel(open.side), render.ANSI.cyan);
                
                // Current mark price
                const books = open.side === 'up' ? ctx.state.orderbooks?.up : ctx.state.orderbooks?.down;
                const currentMark = books?.mark;
                if (Number.isFinite(currentMark)) {
                    markPxStr = (currentMark * 100).toFixed(1) + 'c';
                    
                    // Calculate % gain: (currentMark - entryPrice) / entryPrice * 100
                    const pctGain = ((currentMark - entryPricePerShare) / entryPricePerShare) * 100;
                    const gainColor = pctGain >= 0 ? render.ANSI.green : render.ANSI.red;
                    pctGainStr = render.c((pctGain >= 0 ? '+' : '') + pctGain.toFixed(2) + '%', gainColor);
                }
            }

            const exitReasons = ctx.state.certainty?.exitReasons;
            const exitStr = exitReasons ? render.c(exitReasons, render.ANSI.yellow) : '—';

            // Beat Price (from Polymarket market reference price)
            const beatPriceStr = Number.isFinite(intervalStartPrice) ? '$' + intervalStartPrice.toFixed(2) : '—';
            // In certainty mode, we use Polymarket's reference price only, so diff is 0
            const btcDiffStr = Number.isFinite(intervalStartPrice) ? render.c('$0.00', render.ANSI.gray) : '—';

            // Thresholds short form
            const thresholds = 'Entry ' + (ENTRY_PRICE_MIN * 100).toFixed(0) + '-' + (ENTRY_PRICE_MAX * 100).toFixed(0) + 'c | Re ' + (REENTRY_PRICE_MIN * 100).toFixed(0) + '-' + (REENTRY_PRICE_MAX * 100).toFixed(0) + 'c | TP ' + (TAKE_PROFIT_MIN * 100).toFixed(0) + '-' + (TAKE_PROFIT_MAX * 100).toFixed(0) + 'c';

            return [
                render.boxRow('Time Left', timeLabel, colW),
                render.boxRow('Entry Lvl', entryPriceStr, colW),
                render.boxRow('Thresholds', thresholds, colW),
                render.boxRow('Momentum', dirStr, colW),
                render.boxRow('Entry Gate', entryStr, colW),
                render.boxRow('Beat Price', beatPriceStr, colW),
                render.boxRow('BTC Diff', btcDiffStr, colW),
                render.boxRow('Entry Px', entryPxStr, colW),
                render.boxRow('Direction', directionStr, colW),
                render.boxRow('Mark Px', markPxStr, colW),
                render.boxRow('% Gain', pctGainStr, colW),
                render.boxRow('Exit Sig', exitStr, colW)
            ];
        }
    };
}
