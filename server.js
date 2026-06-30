// Zero-dependency Node server. Run: node server.js
// Endpoints:
//   GET  /                       -> chat UI
//   POST /chat                   -> { sessionId, text } -> { reply, state, booking?, transferToHuman }
//   POST /reset                  -> { sessionId } -> ok
//   GET  /state                  -> { bookings, missedCalls, roi }
//   POST /missed                 -> simulate a missed call (logs to missedCalls)
//   GET  /health                 -> { ok: true }  (used to test the tunnel)
//   POST /vapi/chat/completions  -> Vapi "Custom LLM" adapter. Vapi posts an
//                                   OpenAI-format chat request; we drive agent.js
//                                   and return an OpenAI-format reply (SSE or JSON).
//                                   This makes the deterministic state machine the
//                                   voice agent's brain — zero hallucination.
//
// Persistence: ./data.json on disk. Survives restarts.

const http = require('http');
const fs = require('fs');
const path = require('path');
const { step, resetSession, getSession } = require('./agent');

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

// ---- Vapi "Custom LLM" adapter ----------------------------------------------
// Vapi sends an OpenAI-compatible chat-completions request on every caller turn,
// with the full message history. We key the state machine by the Vapi call id,
// pull the latest caller utterance, run one step, and return the bot's reply.
// Supports both streaming (SSE) and non-streaming responses.

function lastUserText(messages) {
  if (!Array.isArray(messages)) return '';
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i] && messages[i].role === 'user') {
      const c = messages[i].content;
      return typeof c === 'string' ? c : Array.isArray(c) ? c.map(p => p.text || '').join(' ') : '';
    }
  }
  return '';
}

function vapiReply(callId, text) {
  // Advance past the 'greet' step so Vapi's spoken firstMessage isn't duplicated,
  // but still greet if the caller hasn't said anything yet.
  const sess = getSession(callId);
  if (sess.step === 'greet') {
    const greeting = step(callId, '', { persistBooking });
    if (!text) return greeting;
  }
  return step(callId, text || '', { persistBooking });
}

function sendOpenAIJson(res, content) {
  send(res, 200, {
    id: 'chatcmpl-' + Date.now(),
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: 'apex-agent',
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
  });
}

function sendOpenAISSE(res, content) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });
  const id = 'chatcmpl-' + Date.now();
  const created = Math.floor(Date.now() / 1000);
  const chunk = (delta, finish) => res.write('data: ' + JSON.stringify({
    id, object: 'chat.completion.chunk', created, model: 'apex-agent',
    choices: [{ index: 0, delta, finish_reason: finish }],
  }) + '\n\n');
  chunk({ role: 'assistant', content }, null);
  chunk({}, 'stop');
  res.write('data: [DONE]\n\n');
  res.end();
}
// -----------------------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/') {
      return send(res, 200, fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8'));
    }
    if (req.method === 'GET' && req.url === '/health') {
      return send(res, 200, { ok: true, service: 'apex-mvp' });
    }
    if (req.method === 'POST' && req.url === '/vapi/chat/completions') {
      const body = await readBody(req);
      const callId =
        (body.call && body.call.id) ||
        (body.metadata && body.metadata.callId) ||
        'vapi-default';
      const text = lastUserText(body.messages);
      const result = vapiReply(callId, text);
      if (body.stream) return sendOpenAISSE(res, result.reply);
      return sendOpenAIJson(res, result.reply);
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
