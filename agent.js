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
    date.setDate(d.getDate() + (day === 0 ? 1 : day));
    date.setHours(8, 0, 0, 0);
    const label = date.toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short' });
    slots.push(`${label} 8:00 AM`);
    if (slots.length < 4) slots.push(`${label} 1:00 PM`);
  }
  return slots.slice(0, 4);
}

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
        reply = `Got it — ${userText}. That's a ${tier.label.toLowerCase()}, ` +
                `typical call-out from $${tier.priceFrom}. Can I grab your name?`;
      }
      s.step = 'name';
      break;
    }

    case 'name':
      s.data.name = userText.trim();
      reply = `Thanks ${s.data.name.split(' ')[0]}. What's the suburb?`;
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
      if (/^(yes|yeah|yep|correct|right|that's it|thats it)/i.test(userText)) {
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
      const digits = userText.replace(/\D/g, '');
      if (digits.length < 8) {
        reply = `Sorry, I didn't catch a full number — could you say it again with the area code?`;
        break;
      }
      s.data.phone = digits;
      const slots = generateSlots(new Date(), s.data.tier);
      s.data.offeredSlots = slots;
      if (s.data.tier === 'EMERGENCY') {
        reply = `We'll dispatch the on-call plumber now. ETA usually 45–90 minutes. ` +
                `I'll send you a text confirmation. Anything else I should tell the plumber?`;
        s.step = 'extra_notes';
      } else {
        reply = `Here's what we've got open:\n` +
                slots.map((sl, i) => `  ${i + 1}. ${sl}`).join('\n') +
                `\nWhich one suits? (1, 2, 3 or 4)`;
        s.step = 'slot';
      }
      break;
    }

    case 'slot': {
      const idx = parseInt(userText.replace(/\D/g, ''), 10) - 1;
      const slots = s.data.offeredSlots || [];
      if (isNaN(idx) || idx < 0 || idx >= slots.length) {
        reply = `Sorry, just say 1, 2, 3 or 4.`;
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
      reply = `All sorted, ${s.data.name.split(' ')[0]}. ` +
              (s.data.tier === 'EMERGENCY'
                 ? `Plumber is on the way — you'll get a text with their ETA in a minute.`
                 : `You're booked for ${s.data.slot}. Confirmation text coming through now.`) +
              `\n\n[SMS sent to ${s.data.phone}: "Hi ${s.data.name.split(' ')[0]}, booking confirmed — ${s.data.slot} for ${s.data.issue}. Reply STOP to cancel. — Master Plumbers"]`;
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
