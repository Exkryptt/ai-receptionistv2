// server.js
import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { RealtimeService } from 'assemblyai';
import twilio from 'twilio';
import 'dotenv/config';

////////////////////////////////////////////////////////////////////////////////
// CONFIG & CLIENTS
////////////////////////////////////////////////////////////////////////////////
// Coerce the PORT into a number; Render will supply process.env.PORT
const PORT = Number(process.env.PORT) || 3000;

const {
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_NUMBER,
  YOUR_PHONE_NUMBER,
  ASSEMBLYAI_API_KEY
} = process.env;

if (!TWILIO_ACCOUNT_SID ||
    !TWILIO_AUTH_TOKEN   ||
    !TWILIO_NUMBER       ||
    !YOUR_PHONE_NUMBER   ||
    !ASSEMBLYAI_API_KEY) {
  console.error('❌ Missing one of TWILIO_* or ASSEMBLYAI_API_KEY in env');
  process.exit(1);
}

const twClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

////////////////////////////////////////////////////////////////////////////////
// EXPRESS & TWILIO WEBHOOKS
////////////////////////////////////////////////////////////////////////////////
const app = express();
app.use(express.urlencoded({ extended: false }));

// 1) TwiML endpoint: answer calls & start media stream
app.post('/voice', (req, res) => {
  console.log('🔔 /voice webhook hit');
  const host = req.headers.host;
  const twiml = new twilio.twiml.VoiceResponse();
  twiml.say('Please speak after the beep.', { voice: 'alice' });
  twiml.connect().stream({ url: `wss://${host}/stream` });
  twiml.pause({ length: 60 });
  res.type('text/xml').send(twiml.toString());
  console.log('📜 TwiML sent:', twiml.toString());
});

// 2) Outbound call tester
app.get('/call-me', async (req, res) => {
  console.log('🔔 /call-me hit');
  try {
    const call = await twClient.calls.create({
      to:   YOUR_PHONE_NUMBER,
      from: TWILIO_NUMBER,
      url:  `https://${req.headers.host}/voice`,
      method: 'POST'
    });
    console.log('📞 Call SID:', call.sid);
    res.send(`Calling ${YOUR_PHONE_NUMBER}…`);
  } catch (err) {
    console.error('❌ Twilio call error:', err);
    res.status(500).send('Call failed');
  }
});

////////////////////////////////////////////////////////////////////////////////
// HTTP + WebSocket SERVER
////////////////////////////////////////////////////////////////////////////////
const server = createServer(app);
const wss    = new WebSocketServer({ noServer: true });

// Upgrade HTTP to WebSocket on /stream
server.on('upgrade', (req, socket, head) => {
  if (req.url === '/stream') {
    console.log('🔀 Upgrading to WS on /stream');
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
  } else {
    socket.destroy();
  }
});

////////////////////////////////////////////////////////////////////////////////
// MEDIA STREAM → ASSEMBLYAI REALTIME
////////////////////////////////////////////////////////////////////////////////
wss.on('connection', (twilioWs) => {
  console.log('📡 Twilio Media Stream connected');

  // 1) Initialize AssemblyAI RealtimeService
  const transcriber = new RealtimeService({
    apiKey: ASSEMBLYAI_API_KEY,
    encoding: 'pcm_mulaw',
    sampleRate: 8000
  });
  const ready = transcriber.connect();

  // 2) Handle partial transcripts
  transcriber.on('transcript.partial', (p) => {
    if (p.text) process.stdout.write('\r' + p.text);
  });

  // 3) Handle final transcript
  transcriber.on('transcript.final', (f) => {
    console.log('\n🛑 Final:', f.text);
    transcriber.close();
    twilioWs.close();
  });

  transcriber.on('open', () => console.log('🔗 AssemblyAI connected'));
  transcriber.on('error', (e) => console.error('❌ AA error:', e));
  transcriber.on('close', () => console.log('⚡ AssemblyAI disconnected'));

  // 4) Forward Twilio audio frames
  twilioWs.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.event) {
      case 'start':
        console.log('▶️ Twilio stream start');
        break;
      case 'media':
        await ready;
        transcriber.sendAudio(Buffer.from(msg.media.payload, 'base64'));
        break;
      case 'stop':
        console.log('🛑 Twilio stream stop');
        transcriber.stop();
        break;
    }
  });

  twilioWs.on('close', () => console.log('❌ Twilio WS closed'));
  twilioWs.on('error', (e) => console.error('❌ Twilio WS error:', e));
});

////////////////////////////////////////////////////////////////////////////////
// START SERVER
////////////////////////////////////////////////////////////////////////////////
server.listen(PORT, () => {
  console.log(`🚀 Listening on port ${PORT}`);
  console.log(`👉 POST /voice for inbound calls, GET  /call-me to test`);
});
