require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { createClient, LiveTranscriptionEvents } = require('@deepgram/sdk');
const twilio = require('twilio');

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ noServer: true });

const dgClient = createClient(process.env.DEEPGRAM_API_KEY);
const client   = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

app.use(express.urlencoded({ extended: true }));

app.get('/call-me', async (req, res) => {
  try {
    const call = await client.calls.create({
      url:   `https://${req.headers.host}/twiml`,
      to:    process.env.YOUR_PHONE_NUMBER,
      from:  process.env.TWILIO_NUMBER,
      method:'POST',
    });
    console.log(`📞 Outbound call started: ${call.sid}`);
    res.send('Calling your phone now…');
  } catch (err) {
    console.error('❌ Call failed:', err);
    res.status(500).send('Call failed.');
  }
});

app.all('/twiml', (req, res) => {
  const xml = `
    <Response>
      <!-- 1) Greet the user -->
      <Say>Hi, this is your GP clinic assistant. Please begin speaking after the beep.</Say>
      <!-- 2) Short pause to let greeting finish -->
      <Pause length="1"/>
      <!-- 3) THEN start streaming inbound audio -->
      <Start>
        <Stream url="wss://${req.headers.host}/ws" />
      </Start>
      <!-- 4) Keep the stream open for up to 60 seconds -->
      <Pause length="60"/>
    </Response>
  `;
  res.set('Content-Type', 'text/xml');
  res.send(xml);
});

wss.on('connection', async (ws) => {
  console.log('📞 Twilio WebSocket connected');

  let dgStream;
  let closed = false;
  const cleanup = () => {
    if (!closed) {
      closed = true;
      try { dgStream.finish(); } catch {}
      console.log('🧹 Deepgram cleanup triggered.');
    }
  };

  // 1) Open Deepgram live transcription
  try {
    dgStream = await dgClient.listen.live({
      content_type:    'audio/raw;encoding=mulaw;rate=8000',
      model:           'phonecall',
      language:        'en-US',
      interim_results: true,
      punctuate:       true,
    });
    console.log('🔗 Deepgram live stream started (v3 listen.live)');
  } catch (err) {
    console.error('❌ Deepgram stream error:', err);
    ws.close();
    return;
  }

  // 2) Track last interim transcript to diff words
  let lastTranscript = '';
  dgStream.on(LiveTranscriptionEvents.Transcript, (data) => {
    const alt = data.channel?.alternatives?.[0];
    if (!alt || !alt.transcript) return;

    const transcript = alt.transcript;
    const newText = transcript.startsWith(lastTranscript)
      ? transcript.slice(lastTranscript.length)
      : transcript;
    lastTranscript = transcript;

    newText.trim().split(/\s+/).filter(Boolean).forEach(word => {
      console.log('🟢 Word:', word);
    });

    if (data.is_final) {
      console.log('🛑 Final utterance complete');
      lastTranscript = '';
    }
  });

  dgStream.on(LiveTranscriptionEvents.Error, (err) => {
    console.error('❌ Deepgram error:', err);
    cleanup();
  });
  dgStream.on(LiveTranscriptionEvents.Close, cleanup);
  dgStream.on(LiveTranscriptionEvents.Finish, () =>
    console.log('🛑 Deepgram stream finished')
  );

  // 3) Handle incoming Twilio WS messages
  ws.on('message', (raw) => {
    // Log everything for debugging
    console.log('🥡 RAW TWILIO MSG:', raw.toString());

    let msg;
    try {
      msg = JSON.parse(raw);
    } catch (e) {
      console.error('❌ Invalid JSON from Twilio:', e);
      return;
    }

    // Only forward actual audio frames
    if (msg.event === 'media' && msg.media?.payload) {
      console.log(`[media] got ${msg.media.payload.length} chars of base64`);
      const audio = Buffer.from(msg.media.payload, 'base64');
      dgStream.send(audio);
    }

    if (msg.event === 'stop') {
      console.log('🛑 [Twilio] stream stopped');
      cleanup();
    }
  });

  ws.on('error', (err) => {
    console.error('❌ WebSocket error:', err);
    cleanup();
  });
  ws.on('close', () => {
    console.log('❌ WebSocket closed');
    cleanup();
  });
});

server.on('upgrade', (req, socket, head) => {
  if (req.url === '/ws') {
    wss.handleUpgrade(req, socket, head, ws =>
      wss.emit('connection', ws, req)
    );
  } else {
    socket.destroy();
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
  console.log('==> Available at your primary URL');
});
