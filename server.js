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
app.use(express.urlencoded({ extended: false }));

// 1) TwiML endpoint: answer calls & start media stream, passing CallSid
app.post('/voice', (req, res) => {
  const host = req.headers.host;
  const callSid = req.body.CallSid;
  const twiml = new twilio.twiml.VoiceResponse();
  twiml.say('Please speak after the beep.', { voice: 'alice' });
  twiml.connect().stream({
    url: `wss://${host}/stream?CallSid=${encodeURIComponent(callSid)}`
  });
  twiml.pause({ length: 60 });
  res.type('text/xml').send(twiml.toString());
});

// 2) Outbound call tester
app.get('/call-me', async (req, res) => {
  try {
    const call = await twClient.calls.create({
      to:   req.query.to || '',   // e.g. ?to=+1XXX
      from: TWILIO_NUMBER,
      url:  `https://${req.headers.host}/voice`,
      method: 'POST'
    });
    res.send(`Calling ${req.query.to}: SID ${call.sid}`);
  } catch (err) {
    console.error(err);
    res.status(500).send('Call failed');
  }
});

////////////////////////////////////////////////////////////////////////////////
// HTTP + WebSocket SERVER
////////////////////////////////////////////////////////////////////////////////
const server = createServer(app);
const wss    = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  if (req.url.startsWith('/stream')) {
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
  } else {
    socket.destroy();
  }
});

////////////////////////////////////////////////////////////////////////////////
// MEDIA STREAM → ASSEMBLYAI REALTIME → OPENAI → CONTINUATION
////////////////////////////////////////////////////////////////////////////////
wss.on('connection', (twilioWs, req) => {
  // Extract CallSid from query
  const url = new URL(req.url, `http://${req.headers.host}`);
  const callSid = url.searchParams.get('CallSid');
  console.log(`📡 Stream connected for CallSid ${callSid}`);

  // 1) Set up AssemblyAI Realtime
  const transcriber = new RealtimeService({
    apiKey:    ASSEMBLYAI_API_KEY,
    encoding:  'pcm_mulaw',
    sampleRate:8000
  });
  const ready = transcriber.connect();

  transcriber.on('open', () => console.log('🔗 AA connected'));
  transcriber.on('error', e => console.error('❌ AA error:', e));
  transcriber.on('close', () => console.log('⚡ AA disconnected'));

  // 2) Partial transcripts (while speaking)
  transcriber.on('transcript.partial', p => {
    if (p.text) process.stdout.write('\r' + p.text);
  });

  // 3) Final transcript: send to OpenAI, speak back, then re-enter stream
  transcriber.on('transcript.final', async f => {
    const userText = f.text.trim();
    console.log('\n🛑 Final:', userText);

    // Send to OpenAI
    let aiText = 'Sorry, error.';
    try {
      const resp = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: 'You are a helpful conversational assistant.' },
          { role: 'user',   content: userText }
        ]
      });
      aiText = resp.choices[0].message.content.trim();
      console.log('🤖 AI:', aiText);
    } catch (e) {
      console.error('❌ OpenAI error:', e);
    }

    // Redirect the live call to play AI reply and re-open stream
    const host = req.headers.host;
    const twiml = new twilio.twiml.VoiceResponse();
    twiml.say(aiText, { voice: 'alice' });
    twiml.connect().stream({
      url: `wss://${host}/stream?CallSid=${encodeURIComponent(callSid)}`
    });
    twiml.pause({ length: 60 });

    try {
      await twClient.calls(callSid).update({ twiml: twiml.toString() });
      console.log('🔀 Call updated to speak AI and resume streaming');
    } catch (e) {
      console.error('❌ Call update error:', e);
    }

    // Do NOT close transcriber or twilioWs here
  });

  // 4) Forward Twilio audio
  twilioWs.on('message', async raw => {
    const msg = JSON.parse(raw);
    if (msg.event === 'media') {
      await ready;
      transcriber.sendAudio(Buffer.from(msg.media.payload, 'base64'));
    }
    else if (msg.event === 'stop') {
      console.log('🛑 Twilio stop — finalizing');
      transcriber.stop();
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
  console.log(`🚀 Listening on port ${PORT}`);
  console.log('👉 POST /voice or GET /call-me?to=+1XXX to test');
});
