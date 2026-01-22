import { OrderType, Side } from '@polymarket/clob-client';

export function createArbitrageMode() {
    // Arb/straddle settings
    const STRADDLE_MIN_USDC = Number(process.env.STRADDLE_MIN_USDC || 5);
    const STRADDLE_MAX_USDC_RAW = Number(process.env.STRADDLE_MAX_USDC || 10);
    const STRADDLE_MAX_USDC = Math.max(STRADDLE_MIN_USDC, STRADDLE_MAX_USDC_RAW);
    const STRADDLE_MIN_PROFIT_CENTS = Number(process.env.STRADDLE_MIN_PROFIT_CENTS || 0.25);
    const STRADDLE_COOLDOWN_MS = Number(process.env.STRADDLE_COOLDOWN_MS || 2500);
    const STRADDLE_MIN_SHARES = Number(process.env.STRADDLE_MIN_SHARES || 1);

    function computeEqualProfitStraddle(ctx, {
        upAsks,
        downAsks,
        upFeeBps,
        downFeeBps,
        maxUsdc,
        minShares,
        minProfitCents
    }) {
        const upFee = Number.isFinite(upFeeBps) ? upFeeBps : 0;
        const downFee = Number.isFinite(downFeeBps) ? downFeeBps : 0;

        const sumSizes = (levels) => (levels || []).reduce((acc, l) => acc + (Number.isFinite(l.size) ? l.size : 0), 0);

        const maxFillableShares = Math.floor(Math.min(sumSizes(upAsks), sumSizes(downAsks)));
        if (maxFillableShares < minShares) return null;

        const upBest = upAsks?.[0]?.price;
        const downBest = downAsks?.[0]?.price;
        if (!(upBest > 0 && downBest > 0)) return null;

        const approxPerShare = upBest * (1 + upFee / 10000) + downBest * (1 + downFee / 10000);
        const budgetBound = maxUsdc > 0 && approxPerShare > 0 ? Math.floor(maxUsdc / approxPerShare) : 0;
        let hi = ctx.helpers.clampInt(Math.min(maxFillableShares, budgetBound), 0, 1e9);
        if (hi < minShares) return null;

        let lo = minShares;
        let best = null;
        while (lo <= hi) {
            const mid = Math.floor((lo + hi) / 2);
            const upFill = ctx.helpers.costToBuySharesFromAsks(upAsks, mid, upFee);
            const downFill = ctx.helpers.costToBuySharesFromAsks(downAsks, mid, downFee);
            if (upFill === null || downFill === null) {
                hi = mid - 1;
                continue;
            }
            const totalCost = upFill.cost + downFill.cost;
            const profitEach = mid - totalCost;
            const profitCentsEach = profitEach * 100;

            const ok = totalCost <= maxUsdc && profitCentsEach >= minProfitCents;
            if (ok) {
                best = {
                    shares: mid,
                    cost: totalCost,
                    profitCentsEach,
                    upCost: upFill.cost,
                    downCost: downFill.cost,
                    upMaxPrice: upFill.maxPrice,
                    downMaxPrice: downFill.maxPrice
                };
                lo = mid + 1;
            } else {
                hi = mid - 1;
            }
        }
        return best;
    }

    async function executeLiveStraddle(ctx, straddle) {
        if (ctx.PAPER_TRADING) return;
        if (!ctx.ENABLE_LIVE_ORDERS) return;
        if (!ctx.state.tokens.upTokenId || !ctx.state.tokens.downTokenId) throw new Error('Missing token ids');
        if (!ctx.clobCreds) throw new Error('Missing CLOB API creds (CLOB_API_KEY/SECRET/PASSPHRASE)');

        const canSpend = ctx.helpers.liveCanSpendUsdc(straddle.cost);
        if (!canSpend.ok) {
            ctx.log(`LIVE STRADDLE blocked: ${canSpend.reason}`, 'WARN');
            return;
        }

        const upOrder = {
            tokenID: ctx.state.tokens.upTokenId,
            price: straddle.upMaxPrice,
            size: straddle.shares,
            side: Side.BUY
        };
        const downOrder = {
            tokenID: ctx.state.tokens.downTokenId,
            price: straddle.downMaxPrice,
            size: straddle.shares,
            side: Side.BUY
        };

        const upRes = await ctx.clobClient.createAndPostOrder(upOrder, undefined, OrderType.FOK, false);
        const downRes = await ctx.clobClient.createAndPostOrder(downOrder, undefined, OrderType.FOK, false);
        return { upRes, downRes };
    }

    function executePaperStraddle(ctx, sharesPerSide, totalCostUsdc) {
        const cost = totalCostUsdc;
        if (!(cost > 0)) return;
        if (cost > ctx.getPaperBalance()) return;
        if (ctx.state.arb.open) return;

        ctx.executePaperDelta(-cost);

        const endEpochSec = ctx.state.interval.endEpochSec || (Math.floor(Date.now() / 1000) + 15 * 60);
        ctx.state.arb.open = {
            sharesPerSide,
            totalCostUsdc: cost,
            openedAt: new Date(),
            endEpochSec,
            marketId: ctx.state.market?.id ?? null,
            referencePrice: Number.isFinite(ctx.state.market.referencePrice) ? ctx.state.market.referencePrice : null,
            openedSpot: Number.isFinite(ctx.state.underlying.price) ? ctx.state.underlying.price : null
        };

        const settlesAt = new Date(endEpochSec * 1000).toLocaleTimeString();
        ctx.log(`PAPER STRADDLE OPEN: ${sharesPerSide} sh/side | Cost=$${cost.toFixed(3)} | settles @ ${settlesAt}`, 'TRADE');
    }

    return {
        onOrderbooks: async (ctx) => {
            if (ctx.PAPER_TRADING && ctx.state.arb.open) return;

            const up = ctx.state.orderbooks.up;
            const down = ctx.state.orderbooks.down;
            if (!(up?.bestAsk > 0 && down?.bestAsk > 0)) return;

            // Fees matter for guaranteed arb. If we don't know fees, skip trading.
            const upFeeBps = ctx.state.tokens.upFeeBps;
            const downFeeBps = ctx.state.tokens.downFeeBps;
            const feesKnown = Number.isFinite(upFeeBps) && Number.isFinite(downFeeBps);
            if (!feesKnown) {
                ctx.state.arb.suggestedShares = null;
                ctx.state.arb.suggestedCost = null;
                ctx.state.arb.suggestedProfitCentsEach = null;
                return;
            }

            const maxUsdc = ctx.PAPER_TRADING ? Math.min(ctx.getPaperBalance(), STRADDLE_MAX_USDC) : STRADDLE_MAX_USDC;

            const straddle = computeEqualProfitStraddle(ctx, {
                upAsks: ctx.state.orderbooks.upAsksLevels,
                downAsks: ctx.state.orderbooks.downAsksLevels,
                upFeeBps,
                downFeeBps,
                maxUsdc,
                minShares: STRADDLE_MIN_SHARES,
                minProfitCents: STRADDLE_MIN_PROFIT_CENTS
            });

            ctx.state.arb.suggestedShares = straddle?.shares ?? null;
            ctx.state.arb.suggestedCost = straddle?.cost ?? null;
            ctx.state.arb.suggestedProfitCentsEach = straddle?.profitCentsEach ?? null;

            const oneShareCost = up.bestAsk * (1 + upFeeBps / 10000) + down.bestAsk * (1 + downFeeBps / 10000);
            const profitCents = (1.0 - oneShareCost) * 100;
            ctx.state.arb.lastCost = oneShareCost;
            ctx.state.arb.lastProfitCents = profitCents;

            if (!straddle) return;

            const now = Date.now();
            const lastTradeAt = ctx.state.arb.lastTradeAt ? ctx.state.arb.lastTradeAt.getTime() : 0;
            const cooledDown = (now - lastTradeAt) >= STRADDLE_COOLDOWN_MS;
            if (!cooledDown) return;

            ctx.state.opportunitiesFound += 1;
            ctx.state.arb.lastSignalAt = new Date();
            ctx.log(`ARB straddle: ${straddle.shares} sh/side | cost=$${straddle.cost.toFixed(3)} | profit=${straddle.profitCentsEach.toFixed(2)}¢ each`, 'SUCCESS');

            if (ctx.PAPER_TRADING) {
                executePaperStraddle(ctx, straddle.shares, straddle.cost);
                ctx.state.arb.lastTradeAt = new Date();
                return;
            }

            if (!ctx.ENABLE_LIVE_ORDERS) return;
            try {
                await executeLiveStraddle(ctx, straddle);
                ctx.state.arb.lastTradeAt = new Date();
                ctx.log(`LIVE STRADDLE filled: ${straddle.shares} sh/side`, 'TRADE');
            } catch (err) {
                ctx.log(`LIVE STRADDLE failed: ${err?.message || err}`, 'ERROR');
            }
        },

        renderDashboardRows: (ctx, { render, width }) => {
            const up = ctx.state.orderbooks.up;
            const down = ctx.state.orderbooks.down;
            const upBuy = up?.bestAsk || 0;
            const downBuy = down?.bestAsk || 0;

            const upFee = ctx.state.tokens.upFeeBps;
            const downFee = ctx.state.tokens.downFeeBps;
            const buyBothRaw = upBuy > 0 && downBuy > 0 ? upBuy + downBuy : null;
            const buyBothFeeEst = (upBuy > 0 && downBuy > 0 && Number.isFinite(upFee) && Number.isFinite(downFee))
                ? (upBuy * (1 + upFee / 10000) + downBuy * (1 + downFee / 10000))
                : null;

            const buyBothShown = buyBothFeeEst ?? buyBothRaw;
            const buyBothStr = buyBothShown === null ? '—' : `${render.fmtCents(buyBothShown, 2)} (${buyBothShown.toFixed(3)})`;
            const arbProfitStr = buyBothShown === null ? '—' : `${((1 - buyBothShown) * 100).toFixed(2)}¢`;
            const arbProfitColored = buyBothShown === null ? '—' : ((buyBothShown < 1.0) ? render.c(arbProfitStr, render.ANSI.green) : render.c(arbProfitStr, render.ANSI.gray));
            const arbStr = (buyBothShown !== null && buyBothShown < 1.0) ? render.c('YES', render.ANSI.green) : render.c('NO', render.ANSI.gray);

            const sugShares = ctx.state.arb.suggestedShares;
            const sugCost = ctx.state.arb.suggestedCost;
            const sugProfitEach = ctx.state.arb.suggestedProfitCentsEach;
            const sugStr = (Number.isFinite(sugShares) && Number.isFinite(sugCost) && Number.isFinite(sugProfitEach))
                ? `${sugShares} sh/side | Cost $${sugCost.toFixed(3)} | Profit ${sugProfitEach.toFixed(2)}¢ each`
                : '—';
            const lastTradeStr = ctx.state.arb.lastTradeAt ? ctx.state.arb.lastTradeAt.toLocaleTimeString() : '—';

            const open = ctx.state.arb.open;
            const openStr = open
                ? `OPEN ${open.sharesPerSide} sh/side | cost $${open.totalCostUsdc.toFixed(3)} | settles @ ${new Date(open.endEpochSec * 1000).toLocaleTimeString()}`
                : '—';

            return [
                render.boxRow('Buy Both', buyBothStr, width),
                render.boxRow('Profit', arbProfitColored, width),
                render.boxRow('Straddle (EqProfit)', sugStr, width),
                render.boxRow('Arb Position', openStr, width),
                render.boxRow('Last Straddle', lastTradeStr, width),
                render.boxRow('Arb', `${arbStr}  (UpBuy+DownBuy < 100.0¢)`, width)
            ];
        }
    };
}
