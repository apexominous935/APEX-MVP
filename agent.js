// Master Plumber Bot — conversational booking agent.
// Deterministic state machine. Swap to LLM later without changing the wire protocol:
// input  = { sessionId, userText }
// output = { reply, state, booking?, transferToHuman? }

const SUBURBS = require('./pronunciation');

const TIER = {
  EMERGENCY: { label: 'Emergency', priceFrom: 400, slotMins: 60 },
  URGENT:    { label: 'Urgent (same day)', priceFrom: 220, slotMins: 60 },
  STANDARD:  { label: 'Standard booking', priceFrom: 150, slotMins: 90 },
};

const EMERGENCY_KEYWORDS = [
  'burst', 'flooding', 'flood', 'gushing', 'no water', 'sewage', 'overflow',
  'gas leak', 'gas smell', 'hot water gone', 'no hot water', 'leaking everywhere'
];
const URGENT_KEYWORDS = [
  'blocked toilet', 'only toilet', 'leak', 'leaking', 'dripping badly', 'broken tap'
];

function classify(text) {
  const t = text.toLowerCase();
  if (EMERGENCY_KEYWORDS.some(k => t.includes(k))) return 'EMERGENCY';
  if (URGENT_KEYWORDS.some(k => t.includes(k)))    return 'URGENT';
  return 'STANDARD';
}

function findSuburb(text) {
  const t = text.toLowerCase();
  for (const s of Object.keys(SUBURBS)) {
    if (t.includes(s.toLowerCase())) return s;
  }
  return null;
}

// 30-min slots, business hours 7am-5pm, next 5 business days. Emergency = "ASAP today".
function generateSlots(now, tier) {
  if (tier === 'EMERGENCY') return ['ASAP — dispatching now'];
  const slots = [];
  const d = new Date(now);
  for (let day = 0; day < 5 && slots.length < 4; day++) {
    const date = new Date(d);
    date.setDate(d.getDate() + day + 1); // distinct day each iteration (tomorrow onward)
    date.setHours(8, 0, 0, 0);
    const label = date.toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short' });
    slots.push(`${label} 8:00 AM`);
    if (slots.length < 4) slots.push(`${label} 1:00 PM`);
  }
  return slots.slice(0, 4);
}

// ---- Voice-input helpers ----------------------------------------------------
// On a real call the transcriber gives us spoken words, not clean typed input.
// People say "oh four one two...", "the first one", "Tuesday" — parse those.

const NUM_WORDS = {
  zero: 0, oh: 0, o: 0, nought: 0,
  one: 1, two: 2, three: 3, four: 4, five: 5,
  six: 6, seven: 7, eight: 8, nine: 9, niner: 9,
};

// "oh four one two three" / "0412 345 678" / "double four" -> "0412..." digit string
function spokenToDigits(text) {
  const tokens = text.toLowerCase().replace(/[-.]/g, ' ').split(/\s+/);
  let out = '';
  let pendingDouble = 0; // 1 = double, 2 = triple
  for (const tok of tokens) {
    if (tok === 'double') { pendingDouble = 1; continue; }
    if (tok === 'triple') { pendingDouble = 2; continue; }
    let d = null;
    if (tok in NUM_WORDS) d = String(NUM_WORDS[tok]);
    else if (/^\d+$/.test(tok)) d = tok;
    if (d === null) { pendingDouble = 0; continue; }
    if (pendingDouble === 1) d = d + d;
    else if (pendingDouble === 2) d = d + d + d;
    pendingDouble = 0;
    out += d;
  }
  return out;
}

const ORDINALS = {
  first: 1, '1st': 1, second: 2, '2nd': 2, third: 3, '3rd': 3,
  fourth: 4, '4th': 4, fifth: 5, last: -1,
};

// Map a spoken slot choice to an index. Handles "the second one", "two",
// "Thursday", "Thursday morning", "the arvo one", a bare number, etc.
function parseSlotChoice(text, slots) {
  const t = text.toLowerCase();
  for (const [word, n] of Object.entries(ORDINALS)) {
    if (new RegExp(`\\b${word}\\b`).test(t)) return n === -1 ? slots.length - 1 : n - 1;
  }
  for (const [word, n] of Object.entries(NUM_WORDS)) {
    if (n >= 1 && n <= slots.length && new RegExp(`\\b${word}\\b`).test(t)) return n - 1;
  }
  const digit = t.replace(/\D/g, '');
  if (digit) { const i = parseInt(digit, 10) - 1; if (i >= 0 && i < slots.length) return i; }

  // Day name (caller says "Thursday", slot label says "Thu") + optional AM/PM.
  const wantAM = /\b(morning|early)\b/.test(t) || /\bam\b/.test(t);
  const wantPM = /\b(afternoon|arvo|midday|lunch|noon)\b/.test(t) || /\bpm\b/.test(t);
  const meta = slots.map(sl => {
    const low = sl.toLowerCase();
    const dayTok = (low.match(/[a-z]{3,}/) || [''])[0].slice(0, 3); // "thu"
    return { dayTok, isAM: /\bam\b/.test(low) };
  });
  let dayTok = null;
  for (const m of meta) {
    if (m.dayTok && new RegExp(`\\b${m.dayTok}[a-z]*`).test(t)) { dayTok = m.dayTok; break; }
  }
  if (dayTok) {
    const cands = meta.map((m, i) => ({ m, i })).filter(x => x.m.dayTok === dayTok);
    if (wantAM) { const h = cands.find(x => x.m.isAM); if (h) return h.i; }
    if (wantPM) { const h = cands.find(x => !x.m.isAM); if (h) return h.i; }
    if (cands.length) return cands[0].i;
  }
  if (wantAM) { const i = meta.findIndex(m => m.isAM); if (i >= 0) return i; }
  if (wantPM) { const i = meta.findIndex(m => !m.isAM); if (i >= 0) return i; }
  return -1;
}

const YES = /\b(yes|yeah|yep|yup|correct|right|that'?s? (it|right|correct)|spot on|perfect|exactly|sure)\b/i;

// Callers rarely say a bare name — they say "it's Tom", "I'm Tom", "my name's Tom".
// Strip the lead-in and title-case what's left.
function cleanName(text) {
  let t = text.trim().replace(/[.?!]+$/, '');
  t = t.replace(/^(hi|hey|yeah|yes|um+|uh+|so|ok|okay|well)[,\s]+/i, '');
  t = t.replace(/^(it'?s|i'?m|im|my name'?s|my name is|this is|name'?s|the name'?s|its)\s+/i, '');
  t = t.trim();
  if (!t) t = text.trim();
  return t.split(/\s+/).map(w => (w ? w[0].toUpperCase() + w.slice(1) : w)).join(' ');
}

function firstName(name) { return (name || '').split(/\s+/)[0] || 'there'; }

// Group an AU mobile for read-back: 0412 345 678
function formatPhone(d) {
  if (d.length === 10 && d.startsWith('0')) return d.replace(/(\d{4})(\d{3})(\d{3})/, '$1 $2 $3');
  if (d.length === 8) return d.replace(/(\d{4})(\d{4})/, '$1 $2');
  return d;
}

// Offer slots (or dispatch for emergencies) — shared by the phone-confirm branch.
function offerSlotsOrDispatch(s) {
  const slots = generateSlots(new Date(), s.data.tier);
  s.data.offeredSlots = slots;
  if (s.data.tier === 'EMERGENCY') {
    s.step = 'extra_notes';
    return `We'll dispatch the on-call plumber now. ETA usually 45–90 minutes. ` +
           `I'll send you a text confirmation. Anything else I should tell the plumber?`;
  }
  s.step = 'slot';
  return `Here's what we've got open:\n` +
         slots.map((sl, i) => `  ${i + 1}. ${sl}`).join('\n') +
         `\nWhich one suits? You can say the number or the day.`;
}
// -----------------------------------------------------------------------------

const SESSIONS = new Map();

function getSession(id) {
  if (!SESSIONS.has(id)) {
    SESSIONS.set(id, { step: 'greet', data: {}, transcript: [] });
  }
  return SESSIONS.get(id);
}

function resetSession(id) { SESSIONS.delete(id); }

function step(sessionId, userText, ctx) {
  const s = getSession(sessionId);
  if (userText) s.transcript.push({ role: 'caller', text: userText });

  // Safety guard: a normal booking is ~10-14 turns. Past 25, something is wrong
  // (caller confused, transcriber garbling) — hand to a human before racking up
  // call minutes and frustrating the caller.
  s.turns = (s.turns || 0) + 1;
  if (s.turns > 25 && s.step !== 'done') {
    const bail = `Let me put you through to one of our team to sort this out directly.`;
    s.transcript.push({ role: 'bot', text: bail });
    return { reply: bail, state: s.step, data: s.data, booking: null, transferToHuman: true };
  }

  let reply = '';
  let booking = null;
  let transfer = false;

  switch (s.step) {
    case 'greet':
      reply = "G'day, you've reached Master Plumbers — this is the AI assistant. " +
              "I can book you in or get a plumber out to you. What's the issue?";
      s.step = 'issue';
      break;

    case 'issue': {
      s.data.issue = userText;
      s.data.tier = classify(userText);
      const tier = TIER[s.data.tier];
      if (s.data.tier === 'EMERGENCY') {
        reply = `Sounds like an emergency — I'll get a plumber out to you ASAP. ` +
                `Emergency call-out is $${tier.priceFrom} minimum, then quoted on site. ` +
                `Can I grab your name?`;
      } else {
        reply = `Got it — that's ${tier.label.toLowerCase()}, ` +
                `typical call-out from $${tier.priceFrom}. Can I grab your name?`;
      }
      s.step = 'name';
      break;
    }

    case 'name':
      s.data.name = cleanName(userText);
      reply = `Thanks ${firstName(s.data.name)}. What's the suburb?`;
      s.step = 'suburb';
      break;

    case 'suburb': {
      const matched = findSuburb(userText);
      if (matched) {
        s.data.suburb = matched;
        const pron = SUBURBS[matched];
        reply = `Just to confirm — that's ${pron} (${matched})? Say yes or correct me.`;
        s.step = 'suburb_confirm';
      } else {
        s.data.suburb = userText.trim();
        reply = `${userText.trim()} — got it. (I'll flag that for the team to confirm.) ` +
                `What's the best mobile number for you?`;
        s.step = 'phone';
      }
      break;
    }

    case 'suburb_confirm': {
      if (YES.test(userText)) {
        reply = `Beauty. What's the best mobile number for you?`;
        s.step = 'phone';
      } else {
        s.data.suburb = userText.trim();
        reply = `Apologies — noted as "${userText.trim()}". What's the best mobile?`;
        s.step = 'phone';
      }
      break;
    }

    case 'phone': {
      const digits = spokenToDigits(userText);
      if (digits.length < 8) {
        reply = `Sorry, I didn't catch a full number — could you say it again, slowly, with the area code?`;
        break;
      }
      s.data.phone = digits;
      reply = `Let me read that back to make sure I've got it — ${formatPhone(digits)}. Is that right?`;
      s.step = 'phone_confirm';
      break;
    }

    case 'phone_confirm': {
      if (YES.test(userText)) {
        reply = offerSlotsOrDispatch(s);
      } else {
        reply = `No worries — go ahead and say the number again for me.`;
        s.step = 'phone';
      }
      break;
    }

    case 'slot': {
      const slots = s.data.offeredSlots || [];
      const idx = parseSlotChoice(userText, slots);
      if (idx < 0 || idx >= slots.length) {
        reply = `Sorry, I didn't catch which one — say the number (one to ${slots.length}) or the day.`;
        break;
      }
      s.data.slot = slots[idx];
      reply = `Booked you in for ${s.data.slot}. Anything else the plumber should know before they come?`;
      s.step = 'extra_notes';
      break;
    }

    case 'extra_notes': {
      s.data.notes = userText.trim();
      booking = finalize(s.data);
      ctx.persistBooking(booking);
      const tier = TIER[s.data.tier];
      const revenueEstimate = tier.priceFrom;
      reply = `All sorted, ${firstName(s.data.name)}. ` +
              (s.data.tier === 'EMERGENCY'
                 ? `Plumber is on the way — you'll get a text with their ETA in a minute.`
                 : `You're booked for ${s.data.slot}. Confirmation text coming through now.`) +
              `\n\n[SMS sent to ${s.data.phone}: "Hi ${firstName(s.data.name)}, booking confirmed — ${s.data.slot} for ${s.data.issue}. Reply STOP to cancel. — Master Plumbers"]`;
      s.step = 'done';
      break;
    }

    case 'done':
      reply = `You're all set. Hang up whenever you like, or say "transfer" to speak to a human.`;
      if (/transfer|human|person/i.test(userText)) transfer = true;
      break;

    default:
      reply = `Sorry, I lost track there — let me transfer you to a human.`;
      transfer = true;
  }

  s.transcript.push({ role: 'bot', text: reply });
  return { reply, state: s.step, data: s.data, booking, transferToHuman: transfer };
}

function finalize(data) {
  const tier = TIER[data.tier];
  return {
    id: 'BK-' + Date.now().toString(36).toUpperCase(),
    when: data.slot || 'ASAP',
    name: data.name,
    phone: data.phone,
    suburb: data.suburb,
    issue: data.issue,
    tier: tier.label,
    estRevenue: tier.priceFrom,
    notes: data.notes || '',
    createdAt: new Date().toISOString(),
  };
}

module.exports = { step, resetSession, getSession };
