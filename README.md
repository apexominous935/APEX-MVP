# APEX MVP — Master Plumber Bot

The smallest version of APEX that actually works. A conversational AI receptionist
for an Australian plumber: answers, triages the job, confirms the suburb,
books a slot, "sends" a confirmation SMS, and logs the ROI.

**Why this exists:** the strategy docs are clear — the gap between you and your
first Apex dollar is a working bot, not another plan. This is that bot.

## Run

    cd apex_mvp
    node server.js
    # open http://localhost:5174

No npm install. No API keys. Zero dependencies.

## What it does

- **Triage logic** — classifies the call as Emergency / Urgent / Standard from keywords
  ("burst", "no hot water" → Emergency; "blocked toilet" → Urgent; everything else → Standard).
  This is Moat #1 from the doc: niche-specific AI logic, not a generic text-back.
- **Suburb confirmation** — recognises Melbourne suburbs and reads back the pronunciation
  ("Just to confirm, that's REZ-er-vwar (Reservoir)?"). Seed dictionary in `pronunciation.js`,
  expand it from real recordings during the July 2026 AU trip.
- **Slot booking** — offers 4 concrete time slots, books one, generates a booking ID,
  and "sends" the SMS (shown inline in the transcript).
- **ROI panel** — live count of jobs booked, estimated captured revenue, and a
  "Log missed call (no bot)" button so you can demo the contrast to a tradie:
  *"This column is what the bot caught. This column is what you'd have lost."*
- **Persistence** — bookings + missed calls saved to `data.json`. Survives restarts.

## Try the demo script

1. Click **New call**. Bot greets.
2. Type: `I've got a burst pipe under the sink, water everywhere`
3. Name: `Tom Smith`
4. Suburb: `Reservoir` → bot reads back "REZ-er-vwar"
5. Phone: `0412 345 678`
6. Notes: `back gate code is 1234`
7. Watch the ROI panel update. Then click **Log missed call (no bot)** twice
   to simulate what would have happened without you.

## How this maps to the strategy doc

| Doc concept | Where it lives |
|---|---|
| Vapi + Twilio + Make.com stack | `agent.js` is the **business logic**. Vapi handles STT/TTS later, Twilio handles the phone line, Make.com handles fan-out. The wire protocol (`POST /chat`) is what Vapi will call. |
| Australian pronunciation dictionary (Refinement 6) | `pronunciation.js` |
| "Confirmation repeat" trick | `suburb_confirm` state in `agent.js` |
| Emergency vs scheduled triage (Moat 1) | `classify()` in `agent.js` |
| Monthly ROI report (your retention weapon) | `/state` endpoint + ROI panel |
| Graceful degradation fallback (Refinement 5) | `transferToHuman: true` in agent output |

## Next 5 things to build (in order)

1. **Wire to Vapi** — point a Vapi assistant's tool/webhook at `POST /chat`. Use
   ElevenLabs/Cartesia AU voice. Test from an AU phone line on the July trip.
2. **Calendar integration** — replace the JSON store with Google Calendar API
   (one calendar per tradie). This is what makes it "book directly during the call"
   instead of "send a booking link" — that's the BookedUp differentiator.
3. **Per-business config** — extract business name, hours, price points,
   service area, emergency call-out fee into a `businesses.json`. One bot, many tenants.
4. **Review automation add-on** — 24h after a booking is marked complete,
   send the review SMS. This is the $79/mo add-on from Refinement 4.
5. **Dental variant** — swap the prompt, swap the triage keywords ("chipped tooth"
   → urgent, "cleaning" → standard), wire to Cliniko's API. Same `agent.js` shape.

## Files

    apex_mvp/
      server.js          # zero-dep HTTP server
      agent.js           # booking state machine
      pronunciation.js   # Melbourne suburb dictionary
      public/index.html  # demo UI (chat + ROI panel)
      data.json          # generated on first booking
      README.md
