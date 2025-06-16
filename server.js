require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { createClient, LiveTranscriptionEvents } = require('@deepgram/sdk');
const twilio = require('twilio');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ noServer: true });

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
      <Start>
        <!-- Only stream the inbound leg -->
        <Stream url="wss://${req.headers.host}/ws" track="inbound" />
      </Start>
      <Say>
        Hi, this is your GP clinic assistant. Please begin speaking after the beep.
      </Say>
      <Pause length="60"/>
    </Response>
  `;
  res.set('Content-Type', 'text/xml');
  res.send(xml);
});

wss.on('connection', async (ws, req) => {
  console.log('📞 Twilio WebSocket stream connected');

  let dgStream;
  let closed = false;
  const cleanup = () => {
    if (!closed) {
      closed = true;
      try { dgStream.finish(); } catch {}
      console.log('🧹 Deepgram cleanup triggered.');
    }
  };

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

  // Listen for connection open (optional)
  dgStream.on(LiveTranscriptionEvents.Open, () => {
    console.log('🔓 Deepgram socket opened');
  });

  // Listen for interim + final transcripts
  dgStream.on(LiveTranscriptionEvents.Transcript, (data) => {
    const alt = data.channel?.alternatives?.[0];
    if (!alt || !alt.transcript) return;

    if (data.is_final) {
      console.log('🗣 Final:', alt.transcript);
    } else {
      console.log('… Interim:', alt.transcript);
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

  ws.on('message', (msg) => {
    let parsed;
    try {
      parsed = JSON.parse(msg);
    } catch (e) {
      console.error('❌ WS parse error:', e);
      return;
    }

    switch (parsed.event) {
      case 'start':
        console.log('🟢 [Twilio] stream started');
        break;
      case 'media':
        const audio = Buffer.from(parsed.media.payload, 'base64');
        dgStream.send(audio);
        break;
      case 'stop':
        console.log('🛑 [Twilio] stream stopped');
        cleanup();
        break;
      default:
        // ignore 'connected' and other events
        break;
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
    wss.handleUpgrade(req, socket, head, (ws) =>
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
