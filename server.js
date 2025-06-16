// server.js
require('dotenv').config();
const express   = require('express');
const http      = require('http');
const WebSocket = require('ws');
const twilio    = require('twilio');
const { OpenAI } = require('openai');

////////////////////////////////////////////////////////////////////////////////
// CONFIG & CLIENTS
////////////////////////////////////////////////////////////////////////////////

const {
  PORT: PORT_ENV,
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  YOUR_PHONE_NUMBER,
  TWILIO_NUMBER,
  ASSEMBLYAI_API_KEY,
  OPENAI_API_KEY
} = process.env;

const PORT = Number(PORT_ENV) || 3000;
if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN ||
    !YOUR_PHONE_NUMBER   || !TWILIO_NUMBER       ||
    !ASSEMBLYAI_API_KEY  || !OPENAI_API_KEY) {
  console.error('❌ Missing required env vars');
  process.exit(1);
}

const twClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
const openai   = new OpenAI({ apiKey: OPENAI_API_KEY });

// System prompt for later AI responses
const SYSTEM_PROMPT = `
You work at a London sandwich bar taking orders. Upsell the muscle & pickled sandwich (£4).
Drinks £1, cakes £2. Ask for name & pickup time first. Responses ≤20 words.
`.trim();

////////////////////////////////////////////////////////////////////////////////
// EXPRESS + TWILIO ROUTES
////////////////////////////////////////////////////////////////////////////////

const app = express();
app.use(express.urlencoded({ extended: true }));

// TwiML to start streaming on call
app.post('/twiml', (_, res) => {
  res.type('xml').send(`
<Response>
  <Say voice="Polly.Joanna">Hi, this is your sandwich bar. Please speak after the beep.</Say>
  <Connect>
    <Stream url="wss://${_.headers.host}/ws"/>
  </Connect>
  <Pause length="60"/>
</Response>` .trim());
});

// Trigger an outbound call
app.get('/call-me', async (req, res) => {
  try {
    const call = await twClient.calls.create({
      url:    `https://${req.headers.host}/twiml`,
      to:     YOUR_PHONE_NUMBER,
      from:   TWILIO_NUMBER,
      method: 'POST'
    });
    console.log('📞 Outbound call SID:', call.sid);
    res.send('Calling your phone now…');
  } catch (err) {
    console.error('❌ Twilio call error:', err);
    res.status(500).send('Call failed');
  }
});

////////////////////////////////////////////////////////////////////////////////
// WEBSOCKET UPGRADE
////////////////////////////////////////////////////////////////////////////////

const server = http.createServer(app);
const wss    = new WebSocket.Server({ noServer: true });
server.on('upgrade', (req, sock, head) => {
  if (req.url === '/ws') {
    wss.handleUpgrade(req, sock, head, ws => wss.emit('connection', ws, req));
  } else {
    sock.destroy();
  }
});

////////////////////////////////////////////////////////////////////////////////
// MAIN MEDIA-STREAM → ASSEMBLYAI → OPENAI LOGIC
////////////////////////////////////////////////////////////////////////////////

wss.on('connection', (twilioWs) => {
  console.log('📞 Twilio media stream connected');

  // Open AssemblyAI WS
  const aaWs = new WebSocket(
    'wss://api.assemblyai.com/v2/realtime/ws?sample_rate=8000',
    { headers: { Authorization: ASSEMBLYAI_API_KEY } }
  );

  // Buffer incoming audio until AA socket is ready
  let buffer = [];
  let aaReady = false;

  // Send config immediately on AA open
  aaWs.on('open', () => {
    console.log('🔗 AssemblyAI WS open – sending config');
    aaWs.send(JSON.stringify({
      config: {
        encoding:        'mulaw',
        sample_rate:     8000,
        channels:        1,
        language_code:   'en_us',
        interim_results: true
      }
    }));
    aaReady = true;
    // flush any buffered audio
    buffer.forEach(f => aaWs.send(f));
    buffer = [];
  });

  // Throttle interim logs to once per second
  let lastLog = 0;

  // Handle messages from AssemblyAI
  aaWs.on('message', async (raw) => {
    const msg = JSON.parse(raw);
    if (msg.message_type === 'PartialTranscript') {
      const text = msg.text.trim();
      const now  = Date.now();
      if (now - lastLog > 1000) {
        console.clear();
        console.log('… interim:', text);
        lastLog = now;
      }
    }
    else if (msg.message_type === 'FinalTranscript') {
      console.clear();
      console.log('🛑 final:', msg.text.trim());
      lastLog = Date.now();

      // Example: send final transcript to OpenAI
      try {
        const resp = await openai.chat.completions.create({
          model: 'gpt-4o-mini',
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user',   content: msg.text.trim() }
          ],
          max_tokens:  50,
          temperature: 0.7,
        });
        console.log('🤖 AI says:', resp.choices[0].message.content.trim());
      } catch (e) {
        console.error('❌ OpenAI error:', e);
      }
    }
  });

  aaWs.on('error',   e => console.error('❌ AssemblyAI error:', e));
  aaWs.on('close',   () => console.log('⚡ AssemblyAI WS closed'));

  // Forward Twilio audio to AssemblyAI
  twilioWs.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.event === 'media' && msg.media?.payload) {
      const frame = JSON.stringify({ audio_data: msg.media.payload });
      if (aaReady) aaWs.send(frame);
      else         buffer.push(frame);
    }

    if (msg.event === 'stop') {
      console.log('🛑 Twilio stream stopped');
      aaWs.close();
      twilioWs.close();
    }
  });

  twilioWs.on('close', () => {
    console.log('❌ Twilio WS closed');
    aaWs.close();
  });
  twilioWs.on('error', (e) => {
    console.error('❌ Twilio WS error:', e);
    aaWs.close();
  });
});

server.listen(PORT, () => {
  console.log(`✅ Server listening on port ${PORT}`);
  console.log(`👉 GET https://<your-domain>/call-me to test`);
});
