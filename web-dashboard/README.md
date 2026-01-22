Polymarket Arb — Web Dashboard

A simple static dashboard to visualize the bot's activity in a browser. It mimics the terminal dashboard layout (black background, blue borders) and groups information: system status, wallet & balance, entry/re-entry, open position, trades log, and orderbooks.

Files
- index.html — the dashboard UI
- styles.css — styling (black background, blue borders)
- app.js — client script with a mock data generator and optional WebSocket hookup

How to use

1) Serve the directory as static files. From the repository root you can use a quick static server. Examples:

```bash
# using npm's http-server (install if needed)
npx http-server web-dashboard -p 8081

# or using serve
npx serve web-dashboard -p 8081
```

2) Open http://localhost:8081 in your browser.

3) By default the page runs a mock data generator to demonstrate layout and updates. To connect it to a live engine you can either:

- Expose a small WebSocket on the engine that sends JSON payloads matching the mock shape and click "Use Live WS" in the UI; default client tries ws://<origin>:8080/ws (you can change the URL in `app.js`).

- Or expose an HTTP endpoint that returns the same JSON shape and modify `app.js` to poll that endpoint and call `render(payload)`.

Recommended payload shape

The dashboard expects a JSON object with fields similar to the engine state:

{
  mode: 'CERTAINTY',
  live: true|false,
  lastUpdated: 167xxxxx,
  opportunitiesFound: number,
  paperBalance: number,
  collateral: { balanceUsdc: number, allowanceUsdc: number },
  orderbooks: { up: { asks:[{price,size}], bids:[{price,size}] }, down: { ... } },
  certainty: {
    requiredEntryRange: { label: '80-82c' },
    entryOk: true|false,
    entryReason: string|null,
    intervalState: { requireReentryUntilResolved: true|false, lastStopLossExitPrice: 0.75 },
    open: { side:'up', shares:10, entryLimitPrice:0.80, openedAt: 'ISO string' },
    trades: [ ... ]
  }
}

If you want, I can integrate a small HTTP/WS adapter inside the bot to stream the engine's `state` directly to this dashboard. Would you like that next?