// Dashboard client: renders data into boxes.
// By default this file runs a mock data generator. You can replace `connectMock()` with a WebSocket
// to your engine (or expose a simple HTTP endpoint) and call `render(payload)` with the same shape.

const $ = sel => document.querySelector(sel);

function fmtMoney(v){ return (v === null || v === undefined) ? '—' : '$' + Number(v).toFixed(3); }
function fmtCents(p){ return (p === null || p === undefined) ? '—' : Math.round(p*100) + 'c'; }

function render(data){
  // System status
  $('#system-status-content').innerHTML = `
    <div class="kv"><span class="k">Mode</span><span class="v">${data.mode || '—'}</span></div>
    <div class="kv"><span class="k">Live</span><span class="v">${data.live ? 'YES':'NO'}</span></div>
    <div class="kv"><span class="k">Last tick</span><span class="v">${data.lastUpdated ? new Date(data.lastUpdated).toLocaleTimeString() : '—'}</span></div>
    <div class="kv"><span class="k">Opportunities</span><span class="v">${data.opportunitiesFound ?? 0}</span></div>
  `;

  // Wallet & balance
  $('#wallet-content').innerHTML = `
    <div class="kv"><span class="k">Exchange balance</span><span class="v">${fmtMoney(data.collateral?.balanceUsdc)}</span></div>
    <div class="kv"><span class="k">Allowance</span><span class="v">${fmtMoney(data.collateral?.allowanceUsdc)}</span></div>
    <div class="kv"><span class="k">Paper cap</span><span class="v">${fmtMoney(data.paperBalance)}</span></div>
  `;

  // Entry / re-entry
  $('#entry-content').innerHTML = `
    <div class="kv"><span class="k">Required range</span><span class="v">${data.certainty?.requiredEntryRange?.label || '80-82c'}</span></div>
    <div class="kv"><span class="k">Entry OK</span><span class="v">${data.certainty?.entryOk ? 'READY':'NO'}</span></div>
    <div class="kv"><span class="k">Entry reason</span><span class="v">${data.certainty?.entryReason || '—'}</span></div>
    <div class="kv"><span class="k">Re-entry required</span><span class="v">${data.certainty?.intervalState?.requireReentryUntilResolved ? 'YES' : 'NO'}</span></div>
    <div class="kv"><span class="k">Last stop exit</span><span class="v">${fmtCents(data.certainty?.intervalState?.lastStopLossExitPrice)}</span></div>
  `;

  // Open position
  const open = data.certainty?.open;
  if (open) {
    $('#open-content').innerHTML = `
      <div class="kv"><span class="k">Side</span><span class="v">${open.side}</span></div>
      <div class="kv"><span class="k">Shares</span><span class="v">${open.shares}</span></div>
      <div class="kv"><span class="k">Entry px</span><span class="v">${fmtCents(open.entryLimitPrice || open.entryCostUsdc / Math.max(1, open.shares))}</span></div>
      <div class="kv"><span class="k">Opened</span><span class="v">${open.openedAt ? new Date(open.openedAt).toLocaleTimeString() : '—'}</span></div>
    `;
  } else {
    $('#open-content').innerHTML = '<div class="kv"><span class="k">No open position</span><span class="v">—</span></div>';
  }

  // Orderbooks (top few levels)
  const books = data.orderbooks || {};
  const up = books.up || {asks:[], bids:[]};
  const down = books.down || {asks:[], bids:[]};
  function bookToHtml(sideBooks){
    let html='';
    const topAsks = (sideBooks.asks||[]).slice(0,5);
    const topBids = (sideBooks.bids||[]).slice(0,5);
    html += '<div style="display:flex;gap:8px">';
    html += '<div><strong>Asks</strong><br>' + topAsks.map(l=>`${l.size} @ ${fmtCents(l.price)}`).join('<br>') + '</div>';
    html += '<div><strong>Bids</strong><br>' + topBids.map(l=>`${l.size} @ ${fmtCents(l.price)}`).join('<br>') + '</div>';
    html += '</div>';
    return html;
  }
  $('#books-content').innerHTML = '<div><strong>UP</strong><br>' + bookToHtml(up) + '</div><hr>' + '<div><strong>DOWN</strong><br>' + bookToHtml(down) + '</div>';

  // Trades log
  const log = data.certainty?.trades || [];
  const lines = (log || []).slice(-40).reverse().map(t => {
    const when = t.entryTime ? new Date(t.entryTime).toLocaleTimeString() : '';
    const lbl = t.status || (t.exitType||'OPEN');
    return `<div class="log-line">${when} | ${lbl} | ${t.entrySide || ''} ${t.shares||''} sh @ ${fmtCents(t.entryPrice)} | ${t.capitalBeforeUsdc ? fmtMoney(t.capitalBeforeUsdc) : ''} -> ${t.capitalAfterUsdc ? fmtMoney(t.capitalAfterUsdc) : ''}</div>`;
  }).join('');
  $('#trades-content').innerHTML = lines || '<div class="log-line">—</div>';

  // footer
  $('#footer').textContent = 'Last update: ' + (data.lastUpdated ? new Date(data.lastUpdated).toLocaleTimeString() : '—');
}

// --- Mock data generator ---
let mockRunning = true;
let MOCK = {
  mode: 'CERTAINTY',
  live:false,
  lastUpdated: Date.now(),
  opportunitiesFound: 0,
  paperBalance: 1.00,
  collateral: { balanceUsdc: 10.0, allowanceUsdc: 100.0 },
  orderbooks: {
    up: { asks:[{price:0.80,size:10},{price:0.81,size:15}], bids:[{price:0.79,size:8},{price:0.78,size:20}] },
    down: { asks:[{price:0.80,size:5}], bids:[{price:0.79,size:6}] }
  },
  certainty: {
    requiredEntryRange: {label:'80-82c'},
    entryOk: false,
    entryReason: null,
    intervalState: { requireReentryUntilResolved:false, lastStopLossExitPrice:null },
    trades: []
  },
  lastUpdated: Date.now()
};

function randomTick(){
  // simulate small movement
  const drift = (Math.random()-0.5) * 0.02;
  MOCK.orderbooks.up.asks[0].price = Math.max(0.01, (MOCK.orderbooks.up.asks[0].price || 0.80) + drift);
  MOCK.orderbooks.up.bids[0].price = Math.max(0.01, MOCK.orderbooks.up.asks[0].price - 0.01);
  MOCK.lastUpdated = Date.now();
  // randomly simulate stop-loss and re-entry
  if (Math.random() < 0.02) {
    // simulate stop-loss executed
    const exitPrice = 0.749 + Math.random()*0.01; // ~75c
    MOCK.certainty.intervalState.lastStopLossExitPrice = exitPrice;
    MOCK.certainty.intervalState.requireReentryUntilResolved = true;
    // add a trade
    MOCK.certainty.trades.push({ entryTime: new Date().toISOString(), entrySide:'UP', shares:10, entryPrice:0.81, status:'STOPPED', capitalBeforeUsdc:MOCK.paperBalance, capitalAfterUsdc:MOCK.paperBalance - 0.05 });
  }
  // if reentry required, sometimes simulate it succeeds
  if (MOCK.certainty.intervalState.requireReentryUntilResolved && Math.random() < 0.3) {
    MOCK.certainty.intervalState.requireReentryUntilResolved = false;
    MOCK.certainty.trades.push({ entryTime: new Date().toISOString(), entrySide:'DOWN', shares:12, entryPrice: MOCK.certainty.intervalState.lastStopLossExitPrice, status:'OPEN', capitalBeforeUsdc:MOCK.paperBalance, capitalAfterUsdc:MOCK.paperBalance + 0.02 });
  }
  render(MOCK);
}

let interval = setInterval(()=>{ if (mockRunning) randomTick(); }, 1000);

// Controls
$('#btn-toggle-mock').addEventListener('click', ()=>{ mockRunning = !mockRunning; $('#btn-toggle-mock').textContent = mockRunning ? 'Pause Mock' : 'Resume Mock'; });
$('#btn-use-ws').addEventListener('click', ()=>{ connectWS(); });

// Attempt to connect to a websocket at ws://localhost:8080/ws by default. If unreachable, it falls back to mock.
function connectWS(){
  try{
    const url = (new URL('../', location.href)).origin.replace(/^http/, 'ws') + ':8080/ws';
    const ws = new WebSocket(url);
    ws.onopen = ()=>{ mockRunning = false; $('#footer').textContent = 'Connected to ' + url; };
    ws.onmessage = (ev)=>{
      try{ const payload = JSON.parse(ev.data); render(payload); }catch(e){ console.error('bad payload', e) }
    };
    ws.onclose = ()=>{ $('#footer').textContent = 'WebSocket closed — using mock'; mockRunning = true; };
    ws.onerror = (e)=>{ $('#footer').textContent = 'WebSocket error — using mock'; mockRunning = true; };
  }catch(e){ $('#footer').textContent = 'WS connect failed — using mock'; }
}

// initial render
render(MOCK);
