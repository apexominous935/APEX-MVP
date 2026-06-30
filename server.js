// Zero-dependency Node server. Run: node server.js
// Endpoints:
//   GET  /              -> chat UI
//   POST /chat          -> { sessionId, text } -> { reply, state, booking?, transferToHuman }
//   POST /reset         -> { sessionId } -> ok
//   GET  /state         -> { bookings, missedCalls, roi }
//   POST /missed        -> simulate a missed call (logs to missedCalls)
//
// Persistence: ./data.json on disk. Survives restarts.

const http = require('http');
const fs = require('fs');
const path = require('path');
const { step, resetSession } = require('./agent');

const DATA_FILE = path.join(__dirname, 'data.json');
const PORT = 5174;

function loadData() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
  catch { return { bookings: [], missedCalls: [] }; }
}
function saveData(d) { fs.writeFileSync(DATA_FILE, JSON.stringify(d, null, 2)); }

let DATA = loadData();

function persistBooking(b) {
  DATA.bookings.push(b);
  saveData(DATA);
}

function computeRoi() {
  const captured = DATA.bookings.reduce((s, b) => s + (b.estRevenue || 0), 0);
  return {
    callsHandled: DATA.bookings.length + DATA.missedCalls.length,
    jobsBooked: DATA.bookings.length,
    capturedRevenue: captured,
    missedWithoutBot: DATA.missedCalls.length,
  };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let chunks = '';
    req.on('data', c => { chunks += c; if (chunks.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(chunks ? JSON.parse(chunks) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

function send(res, code, body, headers = {}) {
  const isStr = typeof body === 'string';
  res.writeHead(code, {
    'Content-Type': isStr ? 'text/html; charset=utf-8' : 'application/json',
    ...headers,
  });
  res.end(isStr ? body : JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/') {
      return send(res, 200, fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8'));
    }
    if (req.method === 'POST' && req.url === '/chat') {
      const { sessionId, text } = await readBody(req);
      const result = step(sessionId || 'default', text || '', { persistBooking });
      return send(res, 200, result);
    }
    if (req.method === 'POST' && req.url === '/reset') {
      const { sessionId } = await readBody(req);
      resetSession(sessionId || 'default');
      return send(res, 200, { ok: true });
    }
    if (req.method === 'GET' && req.url === '/state') {
      return send(res, 200, { bookings: DATA.bookings, missedCalls: DATA.missedCalls, roi: computeRoi() });
    }
    if (req.method === 'POST' && req.url === '/missed') {
      DATA.missedCalls.push({ at: new Date().toISOString() });
      saveData(DATA);
      return send(res, 200, { ok: true });
    }
    if (req.method === 'POST' && req.url === '/wipe') {
      DATA = { bookings: [], missedCalls: [] };
      saveData(DATA);
      return send(res, 200, { ok: true });
    }
    send(res, 404, { error: 'not found' });
  } catch (e) {
    send(res, 500, { error: String(e) });
  }
});

server.listen(PORT, () => {
  console.log(`\n  APEX MVP — Master Plumber Bot`);
  console.log(`  Open http://localhost:${PORT}\n`);
});
