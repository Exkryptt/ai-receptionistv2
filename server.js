// server.js
require('dotenv').config();
const express   = require('express');
const http      = require('http');
const WebSocket = require('ws');
const twilio    = require('twilio');
const { Realtime } = require('@assemblyai/realtime-client');
const { OpenAI }   = require('openai');

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
const aiClient = new OpenAI({ apiKey: OPENAI_API_KEY });

////////////////////////////////////////////////////////////////////////////////
// EXPRESS + TWILIO ROUTES
////////////////////////////////////////////////////////////////////////////////

const app = express();
app.use(express.urlencoded({ extended: true }));

// TwiML for inbound streaming
app.post('/twiml', (_, res) => {
  const host = _.headers.host;
  res.type('xml').send(`
<Response>
  <Say>Hi, thank you for calling our sandwich bar.</Say>
  <Pause length="1"/>
  <Connect>
    <Stream url="wss://${host}/ws" track="inbound_track"/>
  </Connect>
</Response>`.trim());
});

// Trigger outbound call
app.get('/call-me', async (_, res) => {
  try {
    const call = await twClient.calls.create({
      url:    `https://${_.headers.host}/twiml`,
      to:     YOUR_PHONE_NUMBER,
      from:   TWILIO_NUMBER,
      method: 'POST'
    });
    console.log('📞 Outbound call SID:', call.sid);
    res.send('Calling you now…');
  } catch (err) {
    console.error('❌ Twilio error:', err);
    res.status(500).send('Call failed');
  }
});

////////////////////////////////////////////////////////////////////////////////
// WEBSOCKET SERVER & STREAMING
////////////////////////////////////////////////////////////////////////////////

const server = http.createServer(app);
const wss    = new WebSocket.Server({ noServer: true });

wss.on('connection', (twilioWs) => {
  console.log('📞 Twilio WS connected');

  // Create AssemblyAI realtime client
  const realtime = new Realtime({
    auth: ASSEMBLYAI_API_KEY,
    encoding: 'mulaw',      // μ-law
    sampleRate: 8000,
    format: 'turns',        // enable end-of-turn detection
    interimResults: true,   // stream partial transcripts
    languageCode: 'en_us'
  });

  // Forward partials & finals to console and OpenAI
  realtime.on('partialTranscript', async (part) => {
    console.log('… interim:', part.text);
    try {
      const stream = await aiClient.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: 'Friendly sandwich bar assistant, ≤20 words.' },
          { role: 'user',   content: part.text }
        ],
        stream: true,
        max_tokens: 30,
        temperature: 0.7
      });
      process.stdout.write('🤖 ');
      stream.on('data', (delta) => process.stdout.write(delta.choices[0].delta?.content||''));
      stream.on('end', () => console.log());
    } catch (e) {
      console.error('❌ OpenAI error:', e);
    }
  });

  realtime.on('finalTranscript', (fin) => {
    console.log('🛑 final:', fin.text);
  });

  realtime.on('error', (err) => {
    console.error('❌ AssemblyAI error:', err);
    twilioWs.close();
  });

  realtime.on('close', () => {
    console.log('⚡ AssemblyAI closed');
  });

  // Start the realtime connection
  realtime.start().then(() => {
    console.log('🔗 AssemblyAI realtime started');
  });

  // Buffer until start() resolves
  let buffer = [];

  // Twilio → AssemblyAI
  twilioWs.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.event === 'media' && msg.media?.payload) {
      const frame = Buffer.from(msg.media.payload, 'base64');
      if (realtime.ready) {
        realtime.sendAudio(frame);
      } else {
        buffer.push(frame);
      }
    }

    if (msg.event === 'start') {
      // flush buffer once ready
      realtime.once('open', () => {
        buffer.forEach(f => realtime.sendAudio(f));
        buffer = [];
      });
    }

    if (msg.event === 'stop') {
      console.log('🛑 Twilio end');
      realtime.stop();
      twilioWs.close();
    }
  });

  twilioWs.on('close', () => {
    console.log('❌ Twilio WS closed');
    realtime.stop();
  });
  twilioWs.on('error', (e) => {
    console.error('❌ Twilio WS error:', e);
    realtime.stop();
  });
});

server.on('upgrade', (req, sock, head) => {
  if (req.url === '/ws') {
    wss.handleUpgrade(req, sock, head, ws => wss.emit('connection', ws, req));
  } else {
    sock.destroy();
  }
});

server.listen(PORT, () => {
  console.log(`✅ Listening on port ${PORT}`);
});
