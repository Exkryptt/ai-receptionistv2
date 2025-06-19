// server.js
import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { RealtimeService } from 'assemblyai';
import twilio from 'twilio';
import { OpenAI } from 'openai';
import 'dotenv/config';

////////////////////////////////////////////////////////////////////////////////
// CONFIG & CLIENTS
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
  console.error('❌ Missing env vars (TWILIO_*, ASSEMBLYAI_API_KEY, OPENAI_API_KEY)');
  process.exit(1);
}

const twClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
const openai   = new OpenAI({ apiKey: OPENAI_API_KEY });

////////////////////////////////////////////////////////////////////////////////
// EXPRESS & TWILIO WEBHOOKS
////////////////////////////////////////////////////////////////////////////////
const app = express();
// Parse URL-encoded data (needed for Twilio POSTs)
app.use(express.urlencoded({ extended: false }));

// 1) TwiML endpoint: answer incoming calls & start media stream
app.post('/voice', (req, res) => {
  const host    = req.headers.host;
  const callSid = req.body.CallSid;  // capture the CallSid
  console.log('🔔 /voice webhook hit, CallSid =', callSid);

  const streamUrl = `wss://${host}/stream?callSid=${encodeURIComponent(callSid)}`;
  const twiml = new twilio.twiml.VoiceResponse();
  twiml.say('Please speak after the beep.', { voice: 'alice' });
  twiml.connect().stream({ url: streamUrl });
  twiml.pause({ length: 60 });

  console.log('📜 TwiML sent:', twiml.toString());
  res.type('text/xml').send(twiml.toString());
});

// 2) Outbound call tester (optional)
app.get('/call-me', async (req, res) => {
  const to = req.query.to || '';
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
    console.log('🔀 Upgrading to WebSocket on /stream');
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
  } else {
    socket.destroy();
  }
});

////////////////////////////////////////////////////////////////////////////////
// MEDIA STREAM → ASSEMBLYAI REALTIME → OPENAI → REDIRECT
////////////////////////////////////////////////////////////////////////////////
wss.on('connection', (twilioWs, req) => {
  // Extract callSid from the query string
  const url     = new URL(req.url, `http://${req.headers.host}`);
  const callSid = url.searchParams.get('callSid');
  console.log('📡 Twilio Media Stream connected for CallSid =', callSid);

  // Set up AssemblyAI RealtimeService
  const transcriber = new RealtimeService({
    apiKey:     ASSEMBLYAI_API_KEY,
    encoding:   'pcm_mulaw',
    sampleRate: 8000
  });
  const ready = transcriber.connect();

  transcriber.on('open',  () => console.log('🔗 AssemblyAI WS connected'));
  transcriber.on('error', e => console.error('❌ AssemblyAI error:', e));
  transcriber.on('close', () => console.log('⚡ AssemblyAI WS closed'));

  // Partial transcripts
  transcriber.on('transcript.partial', p => {
    if (p.text) process.stdout.write('\r' + p.text);
  });

  // Final transcript: call OpenAI, redirect call to speak AI, then resume stream
  transcriber.on('transcript.final', async f => {
    const userText = f.text.trim();
    console.log('\n🛑 Final transcript:', userText);

    // 1) Query OpenAI
    let aiText = 'Sorry, something went wrong.';
    try {
      const resp = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: 'You are a helpful assistant.' },
          { role: 'user',   content: userText }
        ]
      });
      aiText = resp.choices[0].message.content.trim();
      console.log('🤖 AI reply:', aiText);
    } catch (err) {
      console.error('❌ OpenAI error:', err);
    }

    // 2) Redirect the live call to play AI reply and reconnect media stream
    const host = req.headers.host;
    const twiml = new twilio.twiml.VoiceResponse();
    twiml.say(aiText, { voice: 'alice' });
    twiml.connect().stream({ url: `wss://${host}/stream?callSid=${encodeURIComponent(callSid)}` });
    twiml.pause({ length: 60 });

    try {
      await twClient.calls(callSid).update({ twiml: twiml.toString() });
      console.log('🔀 Call updated to play AI & resume stream');
    } catch (err) {
      console.error('❌ Call update error:', err);
    }

    // Keep sockets open for next user turn
  });

  // Forward Twilio audio to AssemblyAI
  twilioWs.on('message', async raw => {
    const msg = JSON.parse(raw);
    if (msg.event === 'media') {
      await ready;
      transcriber.sendAudio(Buffer.from(msg.media.payload, 'base64'));
    }
    else if (msg.event === 'stop') {
      console.log('🛑 Twilio stream stop — closing AA stream');
      transcriber.close();  // valid close method
    }
  });

  // Clean up on disconnect
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
