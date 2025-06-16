// server.js
require('dotenv').config();
const express   = require('express');
const http      = require('http');
const WebSocket = require('ws');
const twilio    = require('twilio');
const { Deepgram, LiveTranscriptionEvents } = require('@deepgram/sdk');

////////////////////////////////////////////////////////////////////////////////
// CONFIG & CLIENTS
////////////////////////////////////////////////////////////////////////////////

const {
  PORT = 3000,
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  YOUR_PHONE_NUMBER,
  TWILIO_NUMBER,
  DEEPGRAM_API_KEY
} = process.env;

if (
  !TWILIO_ACCOUNT_SID ||
  !TWILIO_AUTH_TOKEN ||
  !YOUR_PHONE_NUMBER ||
  !TWILIO_NUMBER ||
  !DEEPGRAM_API_KEY
) {
  console.error(
    '❌ Missing one of TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, YOUR_PHONE_NUMBER, TWILIO_NUMBER, DEEPGRAM_API_KEY'
  );
  process.exit(1);
}

const dg = new Deepgram({ apiKey: DEEPGRAM_API_KEY });
const tw = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

////////////////////////////////////////////////////////////////////////////////
// EXPRESS + TWILIO ROUTES
////////////////////////////////////////////////////////////////////////////////

const app = express();
app.use(express.urlencoded({ extended: true }));

// TwiML for inbound calls: connect + stream inbound_track
app.post('/twiml', (req, res) => {
  res.type('text/xml').send(`
    <Response>
      <Say>Hi, this is your GP clinic assistant.</Say>
      <Pause length="1"/>
      <Connect>
        <Stream url="wss://${req.headers.host}/ws" track="inbound_track"/>
      </Connect>
    </Response>
  `);
});

// Outbound call trigger
app.get('/call-me', async (req, res) => {
  try {
    const call = await tw.calls.create({
      url:    `https://${req.headers.host}/twiml`,
      to:     YOUR_PHONE_NUMBER,
      from:   TWILIO_NUMBER,
      method: 'POST',
    });
    console.log('📞 Outbound call SID:', call.sid);
    res.send('Calling you now…');
  } catch (err) {
    console.error('❌ Twilio /call-me error:', err);
    res.status(500).send('Call failed');
  }
});

////////////////////////////////////////////////////////////////////////////////
// WEBSOCKET SERVER + DEEPGRAM INTEGRATION
////////////////////////////////////////////////////////////////////////////////

const server = http.createServer(app);
const wss    = new WebSocket.Server({ noServer: true });

wss.on('connection', async (ws) => {
  console.log('📞 Twilio WS connected');

  // 1) Open Deepgram live transcription stream
  let closed = false;
  const cleanup = () => {
    if (!closed) {
      closed = true;
      dgStream.finish();
      console.log('🧹 Deepgram stream finished');
    }
  };

  let dgStream;
  try {
    dgStream = dg.transcription.live({
      content_type:    'audio/x-mulaw;rate=8000',
      model:           'nova-phonecall',
      language:        'en-US',
      interim_results: true,
      punctuate:       true,
      channels:        1,
    });
    console.log('🔗 Deepgram STT opened');
  } catch (err) {
    console.error('❌ Deepgram init error:', err);
    ws.close();
    return;
  }

  // 2) Listen for transcripts
  dgStream.on('transcriptReceived', (evt) => {
    const alt = evt.channel?.alternatives?.[0];
    if (!alt?.transcript) return;
    const tag = evt.is_final ? '🛑 FINAL:' : '… interim:';
    console.log(tag, alt.transcript);
    // TODO: feed alt.transcript into your AI logic / TTS
  });

  dgStream.on('error', (err) => {
    console.error('❌ Deepgram error:', err);
    cleanup();
    ws.close();
  });

  dgStream.on('close', () => {
    console.log('⚡ Deepgram stream closed');
    cleanup();
    ws.close();
  });

  // 3) Receive Twilio media —> forward to Deepgram
  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.event === 'media' && msg.media?.payload) {
      const pcm = Buffer.from(msg.media.payload, 'base64');
      dgStream.send(pcm);
    }
    if (msg.event === 'stop') {
      console.log('🛑 Twilio stop event');
      cleanup();
    }
  });

  ws.on('close', () => {
    console.log('❌ WS closed');
    cleanup();
  });
  ws.on('error', (err) => {
    console.error('❌ WS error:', err);
    cleanup();
  });
});

server.on('upgrade', (req, socket, head) => {
  if (req.url === '/ws') {
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
  } else {
    socket.destroy();
  }
});

server.listen(PORT, () => {
  console.log(`✅ Server listening on port ${PORT}`);
});
