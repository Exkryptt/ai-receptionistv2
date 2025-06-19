// server.js
require('dotenv').config();
const express   = require('express');
const http      = require('http');
const WebSocket = require('ws');
const twilio    = require('twilio');
const { OpenAI } = require('openai');
const bodyParser = require('body-parser');

////////////////////////////////////////////////////////////////////////////////
// CONFIG & CLIENTS
////////////////////////////////////////////////////////////////////////////////
const {
  PORT:       PORT_ENV,
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

// Example system prompt
const SYSTEM_PROMPT = `
You work at a London sandwich bar taking orders. Upsell the muscle & pickled sandwich (£4).
Drinks £1, cakes £2. Ask for name & pickup time first. Responses ≤20 words.
`.trim();

////////////////////////////////////////////////////////////////////////////////
// EXPRESS + TWILIO ROUTES
////////////////////////////////////////////////////////////////////////////////
const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

// TwiML to answer and start streaming
app.post('/twiml', (req, res) => {
  console.log('🔔 /twiml webhook hit');
  const host = req.headers.host;
  const twiml = new twilio.twiml.VoiceResponse();
  twiml.say('Hi, this is your sandwich bar. Please speak after the beep.', { voice: 'Polly.Joanna' });
  twiml.connect().stream({ url: `wss://${host}/ws` });
  twiml.pause({ length: 60 });
  res.type('text/xml').send(twiml.toString());
  console.log('📜 Sent TwiML:', twiml.toString());
});

// Trigger outbound call
app.get('/call-me', async (req, res) => {
  console.log('🔔 /call-me hit');
  try {
    const call = await twClient.calls.create({
      url:    `https://${req.headers.host}/twiml`,
      to:     YOUR_PHONE_NUMBER,
      from:   TWILIO_NUMBER,
      method: 'POST'
    });
    console.log('📞 Outbound call SID:', call.sid);
    res.send('📞 Calling your phone now…');
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

server.on('upgrade', (req, socket, head) => {
  if (req.url === '/ws') {
    console.log('🔀 Upgrade to WebSocket for /ws');
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  } else {
    socket.destroy();
  }
});

////////////////////////////////////////////////////////////////////////////////
// MEDIA STREAM → ASSEMBLYAI → OPENAI
////////////////////////////////////////////////////////////////////////////////
wss.on('connection', (twilioWs, req) => {
  console.log('📡 Twilio media stream connected');

  // 1) Open AssemblyAI v3 WS
  const aaWs = new WebSocket(
    'wss://streaming.assemblyai.com/v3/ws?sample_rate=8000&format_turns=true',
    { headers: { Authorization: ASSEMBLYAI_API_KEY } }
  );

  let buffer = [];
  let aaReady = false;

  aaWs.on('open', () => {
    console.log('🔗 AssemblyAI WS open – sending Start & marking READY');
    aaWs.send(JSON.stringify({
      type: "Start",
      data: {
        access_token: ASSEMBLYAI_API_KEY,
        sample_rate: 8000,
        format_turns: true
      }
    }));
    aaReady = true;
    console.log(`⏳ Flushing ${buffer.length} buffered frames`);
    buffer.forEach(frame => aaWs.send(frame));
    buffer = [];
  });

  aaWs.on('message', async (data) => {
    let msg;
    try {
      msg = JSON.parse(data);
    } catch (e) {
      console.error('⚠️  Invalid JSON from AA:', data);
      return;
    }

    if (msg.type === 'Turn') {
      console.log('… interim:', msg.text.trim());
    }
    else if (msg.type === 'Termination') {
      console.log('🛑 final:', msg.text.trim());
      try {
        const resp = await openai.chat.completions.create({
          model: 'gpt-4o-mini',
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user',   content: msg.text.trim() }
          ],
          max_tokens: 50,
          temperature: 0.7,
        });
        console.log('🤖 AI says:', resp.choices[0].message.content.trim());
      } catch (e) {
        console.error('❌ OpenAI error:', e);
      }
      aaWs.close();
      twilioWs.close();
    }
  });

  aaWs.on('error', (e) => console.error('❌ AssemblyAI WS error:', e));
  aaWs.on('close', () => console.log('⚡ AssemblyAI WS closed'));

  // 2) Receive Twilio frames
  twilioWs.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg.event === 'media' && msg.media?.payload) {
      const frame = Buffer.from(msg.media.payload, 'base64');
      if (aaReady) {
        aaWs.send(frame);
        console.log(`▶️ forwarded audio ${frame.length} bytes`);
      } else {
        buffer.push(frame);
        console.log(`⏳ buffering audio ${frame.length} bytes`);
      }
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
  console.log(`🚀 Server listening on https://localhost:${PORT}`);
  console.log(`👉 Open https://localhost:${PORT}/call-me to test`);
});
