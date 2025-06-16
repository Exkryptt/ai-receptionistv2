// server.js
require('dotenv').config();
const express       = require('express');
const http          = require('http');
const WebSocket     = require('ws');
const twilio        = require('twilio');
const { OpenAI }    = require('openai');
const { createClient, LiveTranscriptionEvents } = require('@deepgram/sdk');
const axios         = require('axios');

////////////////////////////////////////////////////////////////////////////////
// CONFIG & CLIENTS
////////////////////////////////////////////////////////////////////////////////

const {
  PORT: ENV_PORT,
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  YOUR_PHONE_NUMBER,
  TWILIO_NUMBER,
  DEEPGRAM_API_KEY,
  OPENAI_API_KEY,
  ELEVENLABS_API_KEY,
  ELEVENLABS_VOICE_ID
} = process.env;

// Coerce PORT to a valid integer, fallback to 3000
const PORT = (() => {
  const p = parseInt(ENV_PORT, 10);
  return Number.isInteger(p) && p > 0 && p < 65536 ? p : 3000;
})();

if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN ||
    !YOUR_PHONE_NUMBER    || !TWILIO_NUMBER      ||
    !DEEPGRAM_API_KEY     || !OPENAI_API_KEY     ||
    !ELEVENLABS_API_KEY   || !ELEVENLABS_VOICE_ID) {
  console.error('⚠️  Missing one or more required environment variables.');
  process.exit(1);
}

const dgClient  = createClient(DEEPGRAM_API_KEY);
const openai    = new OpenAI({ apiKey: OPENAI_API_KEY });
const twilioCli = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

////////////////////////////////////////////////////////////////////////////////
// EXPRESS + TWILIO ROUTES
////////////////////////////////////////////////////////////////////////////////

const app = express();
app.use(express.urlencoded({ extended: true }));

// TwiML for incoming calls
app.post('/twiml', (req, res) => {
  res.type('xml').send(`
    <Response>
      <Say>Hi, this is your GP clinic assistant.</Say>
      <Pause length="1"/>
      <Connect>
        <Stream url="wss://${req.headers.host}/ws"/>
      </Connect>
    </Response>
  `);
});

// Outbound dialing endpoint
app.get('/call-me', async (req, res) => {
  try {
    const call = await twilioCli.calls.create({
      url:    `https://${req.headers.host}/twiml`,
      to:     YOUR_PHONE_NUMBER,
      from:   TWILIO_NUMBER,
      method: 'POST',
    });
    console.log('📞 Outbound call started:', call.sid);
    res.send('Calling now…');
  } catch (err) {
    console.error('❌ Twilio call error:', err);
    res.status(500).send('Call failed');
  }
});

////////////////////////////////////////////////////////////////////////////////
// WEBSOCKET SERVER + AI PIPELINE
////////////////////////////////////////////////////////////////////////////////

const server = http.createServer(app);
const wss    = new WebSocket.Server({ noServer: true });

// Maintain session state per WebSocket
const sessions = new Map();

wss.on('connection', (ws) => {
  console.log('📞 New Twilio media stream connected');

  const session = {
    dgStream:       null,
    lastTranscript: '',
    queue:          Promise.resolve(),
    chatHistory:    [{ role: 'system',
      content: `You work at a London Sandwich Bar and you're answering the phone taking people's takeaway orders. Always ask for caller’s name and pickup time first, upsell the special, keep responses ≤20 words.` }]
  };
  sessions.set(ws, session);

  // Clean up on end
  const cleanup = () => {
    if (session.dgStream) session.dgStream.finish();
    sessions.delete(ws);
    console.log('🧹 Session cleaned up');
  };

  // 1) Open Deepgram STT
  (async () => {
    try {
      session.dgStream = await dgClient.listen.live({
        content_type:    'audio/raw;encoding=mulaw;rate=8000',
        model:           'nova-phonecall',
        language:        'en-US',
        interim_results: true,
        punctuate:       true,
      });
      console.log('🔗 Deepgram STT stream open');
    } catch (e) {
      console.error('❌ Deepgram error', e);
      cleanup();
    }
  })();

  // 2) Handle transcription events
  const onTranscript = async (evt) => {
    const alt = evt.channel?.alternatives?.[0];
    if (!alt?.transcript) return;

    const text = alt.transcript.trim();
    const delta = text.startsWith(session.lastTranscript)
      ? text.slice(session.lastTranscript.length).trim()
      : text;
    session.lastTranscript = text;

    delta.split(/\s+/).filter(Boolean)
      .forEach(w => console.log('🟢 Word:', w));

    if (evt.is_final) {
      console.log('🛑 Final:', text);
      session.lastTranscript = '';

      // Update chat history
      session.chatHistory.push({ role: 'user', content: text });
      if (session.chatHistory.length > 40) session.chatHistory.shift();

      // 3) Call OpenAI GPT
      let reply;
      try {
        const resp = await openai.chat.completions.create({
          model:       'gpt-4o-mini',
          messages:    session.chatHistory,
          temperature: 1,
          max_tokens:  200,
        });
        reply = resp.choices[0].message.content.trim();
        console.log('🤖 GPT reply:', reply);
        session.chatHistory.push({ role: 'assistant', content: reply });
      } catch (e) {
        console.error('❌ OpenAI error', e);
        reply = "Sorry, I'm having trouble.";
      }

      // 4) ElevenLabs TTS
      let audioBuf;
      try {
        const ttsRes = await axios.post(
          `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}`,
          { text: reply },
          {
            headers: {
              'xi-api-key': ELEVENLABS_API_KEY,
              'Accept':     'audio/ulaw;rate=8000'
            },
            responseType: 'arraybuffer'
          }
        );
        audioBuf = Buffer.from(ttsRes.data);
      } catch (e) {
        console.error('❌ ElevenLabs TTS error', e);
        return;
      }

      // 5) Send outbound audio in sequence
      session.queue = session.queue.then(() =>
        new Promise(r => setTimeout(() => {
          ws.send(JSON.stringify({
            event: 'media',
            media: {
              track:   'outbound',
              payload: audioBuf.toString('base64')
            }
          }));
          r();
        }, 100))
      );
    }
  };

  // Attach when DG stream is ready
  const waitForDG = () => new Promise(r => {
    const check = () => session.dgStream ? r() : setTimeout(check, 50);
    check();
  });
  waitForDG().then(() => {
    session.dgStream.on(LiveTranscriptionEvents.Transcript, onTranscript);
    session.dgStream.on(LiveTranscriptionEvents.Error,  err => { console.error('❌ DG stream error', err); cleanup(); });
    session.dgStream.on(LiveTranscriptionEvents.Close,  cleanup);
    session.dgStream.on(LiveTranscriptionEvents.Finish, cleanup);
  });

  // 6) Forward Twilio media to Deepgram
  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg.event === 'media' && msg.media?.payload) {
      const pcm = Buffer.from(msg.media.payload, 'base64');
      session.dgStream?.send(pcm);
    }
    if (msg.event === 'stop') {
      console.log('🛑 Twilio stop');
      cleanup();
    }
  });

  ws.on('close',  () => { console.log('❌ WS closed'); cleanup(); });
  ws.on('error',  () => cleanup());
});

server.on('upgrade', (req, sock, head) => {
  if (req.url === '/ws') {
    wss.handleUpgrade(req, sock, head, ws => wss.emit('connection', ws, req));
  } else sock.destroy();
});

server.listen(PORT, () => {
  console.log(`✅ Server listening on port ${PORT}`);
});
