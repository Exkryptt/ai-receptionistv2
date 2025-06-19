// server.js
require('dotenv').config();
const express   = require('express');
const http      = require('http');
const WebSocket = require('ws');
const twilio    = require('twilio');

////////////////////////////////////////////////////////////////////////////////
// CONFIG
////////////////////////////////////////////////////////////////////////////////
const {
  PORT = 3000,
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_NUMBER,
} = process.env;

if (!TWILIO_ACCOUNT_SID ||
    !TWILIO_AUTH_TOKEN ||
    !TWILIO_NUMBER) {
  console.error("❌ Missing TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN or TWILIO_NUMBER");
  process.exit(1);
}

const twClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

////////////////////////////////////////////////////////////////////////////////
// EXPRESS SETUP
////////////////////////////////////////////////////////////////////////////////
const app = express();
app.use(express.urlencoded({ extended: false }));

// 1) TwiML endpoint
app.post('/voice', (req, res) => {
  const host = req.headers.host;
  const twiml = new twilio.twiml.VoiceResponse();
  // Say greeting, then open media stream to /stream
  twiml.say('Hello! Please speak after the beep.', { voice: 'alice' });
  twiml.connect().stream({ url: `wss://${host}/stream` });
  res.type('text/xml').send(twiml.toString());
});

// 2) (Optional) outbound test
app.get('/call-me', async (req, res) => {
  const to = req.query.to;
  if (!to) return res.status(400).send("Please ?to=yourNumber");
  try {
    const call = await twClient.calls.create({
      to,
      from: TWILIO_NUMBER,
      url:  `https://${req.headers.host}/voice`
    });
    res.send(`Calling ${to}: SID ${call.sid}`);
  } catch (e) {
    console.error(e);
    res.status(500).send("Call failed");
  }
});

////////////////////////////////////////////////////////////////////////////////
// HTTP & WS SERVER
////////////////////////////////////////////////////////////////////////////////
const server = http.createServer(app);
const wss    = new WebSocket.Server({ noServer: true });

// Upgrade `/stream` to WebSocket
server.on('upgrade', (req, socket, head) => {
  if (req.url === '/stream') {
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
  } else {
    socket.destroy();
  }
});

// 3) Handle Twilio media stream frames
wss.on('connection', (twilioWs) => {
  console.log('🔗 Twilio Media Stream connected');

  // AssemblyAI socket
  const aaWs = new WebSocket(
    'wss://streaming.assemblyai.com/v3/ws?sample_rate=8000&format_turns=true',
    { headers: { Authorization: process.env.ASSEMBLYAI_API_KEY } }
  );

  let aaReady = false;
  const buffer = [];

  // When AA socket opens, send Start and mark ready
  aaWs.on('open', () => {
    console.log('→ AA WS open, sending Start');
    aaWs.send(JSON.stringify({
      type: "Start",
      data: {
        access_token: process.env.ASSEMBLYAI_API_KEY,
        sample_rate: 8000,
        format_turns: true
      }
    }));
    aaReady = true;
    // flush any buffered frames
    buffer.forEach(b => aaWs.send(b));
    buffer.length = 0;
  });

  // Handle AA messages: interim & final
  aaWs.on('message', msg => {
    const data = JSON.parse(msg);
    if (data.type === 'Turn') {
      console.log('… interim:', data.text.trim());
    } else if (data.type === 'Termination') {
      console.log('🛑 final:', data.text.trim());
      // close both sockets
      aaWs.close();
      twilioWs.close();
    }
  });

  aaWs.on('error', e => console.error('AA WS error:', e));
  aaWs.on('close', () => console.log('⚡ AA WS closed'));

  // Forward Twilio frames into AA
  twilioWs.on('message', raw => {
    const frame = JSON.parse(raw);
    if (frame.event === 'start') {
      console.log('📤 Received start event');
    }
    if (frame.event === 'media' && frame.media?.payload) {
      const audio = Buffer.from(frame.media.payload, 'base64');
      if (aaReady) {
        aaWs.send(audio);
      } else {
        buffer.push(audio);
      }
    }
    if (frame.event === 'stop') {
      console.log('🛑 Twilio stream stopped – sending AA Stop');
      aaWs.send(JSON.stringify({ type: "Stop" }));
    }
  });

  twilioWs.on('close', () => console.log('❌ Twilio WS closed'));
});

// Start it all
server.listen(PORT, () => {
  console.log(`🚀 Listening on https://localhost:${PORT}`);
  console.log(`👉 POST a call to /voice or try /call-me?to=<yourNumber>`);
});
