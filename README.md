# APEX MVP — AI Voice Receptionist Prototype

A conversational AI receptionist for a local trades business (currently demoed as a
plumber). It answers an incoming call, triages the job, confirms the suburb,
books a time slot, and sends a confirmation message — built as a state machine
so the logic is deterministic and testable before wiring in a real voice layer.

## Run

    cd apex_mvp
    node server.js
    # open http://localhost:5174

No npm install. No API keys required for the local demo. Zero dependencies.

## What it does

- **Call triage** — classifies the request as Emergency / Urgent / Standard from
  keywords (e.g. "burst pipe" → Emergency; "blocked toilet" → Urgent; everything
  else → Standard) and responds accordingly.
- **Suburb confirmation** — recognises known suburb names and reads the
  pronunciation back to the caller for confirmation before proceeding. Seed
  dictionary in `pronunciation.js`.
- **Slot booking** — offers available time slots, books one, generates a booking
  ID, and shows the confirmation message inline in the transcript.
- **ROI panel** — live count of jobs booked and estimated captured revenue, plus
  a way to log a "missed call" for comparison.
- **Persistence** — bookings and missed calls saved to `data.json` locally.

## Try it

1. Click **New call**. Bot greets.
2. Type: `I've got a burst pipe under the sink, water everywhere`
3. Name: `Tom Smith`
4. Suburb: `Reservoir` → bot reads back the pronunciation
5. Phone: `0412 345 678`
6. Notes: anything you like
7. Watch the ROI panel update.

## Architecture

`agent.js` is the core business logic — a plain state machine with no external
dependencies, exposed over HTTP via `server.js` (`POST /chat`). This separation
means the same logic can sit behind a real voice layer (e.g. Vapi for
STT/TTS/telephony orchestration) without changing the decision logic itself —
only the transport changes.

## Files

    apex_mvp/
      server.js          # zero-dep HTTP server
      agent.js            # booking/triage state machine
      pronunciation.js    # suburb pronunciation dictionary
      public/index.html   # demo UI (chat + ROI panel)
      data.json            # generated locally on first booking (gitignored)
      README.md
