# Wiring APEX MVP to a real phone (Vapi + tunnel)

This connects the local `agent.js` brain to a real voice call. The state machine
stays the brain — Vapi only adds ears (speech-to-text), a mouth (text-to-speech),
and the phone line. No LLM is used for decisions, so there is zero hallucination.

## The two terminals you always run

**Terminal 1 — the server:**

    cd apex_mvp
    node server.js
    # -> http://localhost:5174

**Terminal 2 — the public tunnel** (no signup, free):

    cloudflared tunnel --url http://localhost:5174

cloudflared prints a line like:

    https://something-random-words.trycloudflare.com

That HTTPS address is your public base URL. It **changes every time** you restart
cloudflared, so re-paste it into Vapi each session. (Want a URL that never changes?
Use ngrok with your authtoken, or a named cloudflared tunnel — both need a free
account. Not needed for learning.)

## Configure Vapi (one-time, ~5 minutes)

1. Vapi dashboard → **Assistants** → create one.
2. **Model** → provider **Custom LLM**.
   - URL: `https://<your-tunnel>.trycloudflare.com/vapi`
     (Vapi automatically appends `/chat/completions` → it will call
     `https://<your-tunnel>.trycloudflare.com/vapi/chat/completions`, which this
     server implements.)
   - Any API key value is fine (this server ignores it).
3. **Transcriber** → Deepgram, model Nova-3 (or Nova-2), language English (en-AU).
4. **Voice** → ElevenLabs, pick an Australian voice. (Test a few — accent quality
   is the single biggest trust factor for AU callers.)
5. **First message** → set it to the greeting so the bot speaks first:
   `G'day, you've reached Master Plumbers — how can I help?`
   (The server detects the greeting was already spoken and skips re-greeting.)
6. Save.

## Test without a phone number (free)

Vapi dashboard → your assistant → **Talk to Assistant** (mic in the browser).
Say *"I've got a burst pipe, water everywhere."* You should hear the emergency
triage response. Watch the server terminal / Vapi logs to see the turns.

## Test with a real phone (when you buy a Twilio number)

1. Twilio → buy a number (AU +61 = instant; Swiss +41 needs a regulatory bundle).
2. Vapi → **Phone Numbers** → import the Twilio number (Vapi gives exact field
   values — account SID, auth token, the number).
3. Attach the assistant to that number.
4. Call it from your mobile.

## What to listen for (your real learning data)

- Latency — any awkward silence after you speak?
- Suburb pronunciation — does "Reservoir" come out "REZ-er-vwar"? Add/fix entries
  in `pronunciation.js`.
- Mishears — does Deepgram get names/numbers right? The confirm-back steps catch most.
- Every call transcript is saved in the Vapi dashboard — that's your scenario
  library, built from real calls instead of guesses.

## Quick sanity checks (curl)

    # is the server up?
    curl https://<your-tunnel>.trycloudflare.com/health

    # does the brain respond like Vapi expects?
    curl -X POST https://<your-tunnel>.trycloudflare.com/vapi/chat/completions \
      -H "Content-Type: application/json" \
      -d '{"call":{"id":"t1"},"messages":[{"role":"user","content":"burst pipe"}]}'
