// server.js
import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { RealtimeService } from 'assemblyai';
import twilio from 'twilio';
import { OpenAI } from 'openai';
import 'dotenv/config';

////////////////////////////////////////////////////////////////////////////////
// CONFIG
////////////////////////////////////////////////////////////////////////////////
const PORT = Number(process.env.PORT) || 3000;
const {
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_NUMBER,
  ASSEMBLYAI_API_KEY,
  OPENAI_API_KEY
} = process.env;

if (!TWILIO_ACCOUNT_SID ||
    !TWILIO_AUTH_TOKEN   ||
    !TWILIO_NUMBER       ||
    !ASSEMBLYAI_API_KEY  ||
    !OPENAI_API_KEY) {
  console.error('❌ Missing required env vars');
  process.exit(1);
}

const twClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
const openai   = new OpenAI({ apiKey: OPENAI_API_KEY });

////////////////////////////////////////////////////////////////////////////////
// EXPRESS & TWILIO WEBHOOKS
////////////////////////////////////////////////////////////////////////////////
const app = express();
app.use(express.urlencoded({ extended: false }));

app.post('/voice', (req, res) => {
  const host    = req.headers.host;
  const callSid = req.body.CallSid;
  console.log('🔔 /voice hit, CallSid =', callSid);

  const streamUrl = `wss://${host}/stream?callSid=${encodeURIComponent(callSid)}`;
  const twiml = new twilio.twiml.VoiceResponse();
  twiml.say('Please speak after the beep.', { voice: 'alice' });
  twiml.connect().stream({ url: streamUrl });
  twiml.pause({ length: 60 });

  console.log('📜 TwiML sent:', twiml.toString());
  res.type('text/xml').send(twiml.toString());
});

app.get('/call-me', async (req, res) => {
  const to = req.query.to;
  if (!to) return res.status(400).send('Missing ?to=+1XXX');
  try {
    const call = await twClient.calls.create({
      to,
      from: TWILIO_NUMBER,
      url:  `https://${req.headers.host}/voice`,
      method: 'POST'
    });
    console.log('📞 Outbound call SID:', call.sid);
    res.send(`Calling ${to}: SID ${call.sid}`);
  } catch (err) {
    console.error('❌ /call-me error:', err);
    res.status(500).send('Call failed');
  }
});

////////////////////////////////////////////////////////////////////////////////
// HTTP & WEBSOCKET SERVER
////////////////////////////////////////////////////////////////////////////////
const server = createServer(app);
const wss    = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  if (req.url.startsWith('/stream')) {
    const parsed = new URL(req.url, `http://${req.headers.host}`);
    const callSid = parsed.searchParams.get('callSid');
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.callSid = callSid;         // attach callSid
      ws.host    = req.headers.host; // attach host
      wss.emit('connection', ws, req);
    });
  } else {
    socket.destroy();
  }
});

////////////////////////////////////////////////////////////////////////////////
// MEDIA STREAM → ASSEMBLYAI → OPENAI → REDIRECT
////////////////////////////////////////////////////////////////////////////////
wss.on('connection', (twilioWs) => {
  const callSid = twilioWs.callSid;
  const host    = twilioWs.host;
  console.log('📡 Media Stream connected for CallSid =', callSid);

  const transcriber = new RealtimeService({
    apiKey:     ASSEMBLYAI_API_KEY,
    encoding:   'pcm_mulaw',
    sampleRate: 8000
  });
  const ready = transcriber.connect();

  transcriber.on('open',  () => console.log('🔗 AssemblyAI WS connected'));
  transcriber.on('error', e => console.error('❌ AssemblyAI error:', e));
  transcriber.on('close', () => console.log('⚡ AssemblyAI WS closed'));

  // Simplified interim logs
  transcriber.on('transcript.partial', p => {
    if (p.text) console.log(`🌱 Interim: ${p.text}`);
  });

  transcriber.on('transcript.final', async f => {
    console.log('\n🛑 Final transcript:', f.text.trim());

    // 1) Query OpenAI
    let aiText = 'Sorry, something went wrong.';
    try {
      const resp = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: 'You are SolarLink, an AI sales closer specializing in residential solar-panel installations. Your job is to guide callers from initial inquiry through booking an appointment. You greet customers warmly, ask precise questions to qualify their site (location, roof angle, shading, budget), address any concerns, recommend the optimal panel layout, and then seamlessly transition to scheduling a site survey or installation date. Keep responses concise (under 25 words), professional, and always drive toward booking the appointment. Use friendly but confident language.' },
          { role: 'user',   content: f.text.trim() }
        ]
      });
      aiText = resp.choices[0].message.content.trim();
      console.log('🤖 AI reply:', aiText);
    } catch (err) {
      console.error('❌ OpenAI error:', err);
    }

    // 2) Redirect call to play AI reply & resume streaming
    const twiml = new twilio.twiml.VoiceResponse();
    twiml.say(aiText, { voice: 'alice', bargeIn: true });
    twiml.connect().stream({ url: `wss://${host}/stream?callSid=${encodeURIComponent(callSid)}` });
    twiml.pause({ length: 60 });

    try {
      await twClient.calls(callSid).update({ twiml: twiml.toString() });
      console.log('🔀 Call updated to play AI & resume stream');
    } catch (err) {
      console.error('❌ Call update error:', err);
    }
  });

  twilioWs.on('message', async raw => {
    const msg = JSON.parse(raw);
    if (msg.event === 'media') {
      await ready;
      transcriber.sendAudio(Buffer.from(msg.media.payload, 'base64'));
    } else if (msg.event === 'stop') {
      console.log('🛑 Twilio stop → closing AA stream');
      transcriber.close();
    }
  });

  twilioWs.on('close', () => {
    console.log('❌ Twilio WS closed');
    transcriber.close();
  });
  twilioWs.on('error', e => {
    console.error('❌ Twilio WS error:', e);
    transcriber.close();
  });
});

////////////////////////////////////////////////////////////////////////////////
// START SERVER
////////////////////////////////////////////////////////////////////////////////
server.listen(PORT, () => {
  console.log(`🚀 Server listening on port ${PORT}`);
  console.log('👉 POST /voice or GET /call-me?to=+1XXX to test');
});
