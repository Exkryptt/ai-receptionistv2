require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { createClient } = require('@deepgram/sdk');
const { OpenAI } = require('openai');
const twilio = require('twilio');
const bodyParser = require('body-parser');

const PORT = process.env.PORT || 10000;
const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ noServer: true });

const dgClient = createClient(process.env.DEEPGRAM_API_KEY);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

app.use(express.static('public'));
app.use(bodyParser.urlencoded({ extended: false }));

// --- μ-law decoder functions ---
function mulawDecode(uVal) {
  uVal = ~uVal;
  let t = ((uVal & 0x0F) << 3) + 0x84;
  t <<= ((uVal & 0x70) >> 4);
  return ((uVal & 0x80) ? (0x84 - t) : (t - 0x84));
}
function decodeMuLawBuffer(muLawBuf) {
  const pcm = Buffer.alloc(muLawBuf.length * 2);
  for (let i = 0; i < muLawBuf.length; i++) {
    const s = mulawDecode(muLawBuf[i]);
    pcm.writeInt16LE(s, i * 2);
  }
  return pcm;
}

// --- TwiML endpoint for Twilio calls ---
app.post('/twiml', (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();
  twiml.start().stream({
    url: `${process.env.STREAM_URL || 'wss://ai-receptionistv2.onrender.com/ws'}`
  });
  twiml.say('Hello, you are speaking to the AI receptionist.');
  res.type('text/xml');
  res.send(twiml.toString());
});

// --- Upgrade HTTP to WebSocket for /ws ---
server.on('upgrade', (request, socket, head) => {
  if (request.url === '/ws') {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  } else {
    socket.destroy();
  }
});

// --- Main WebSocket Handler ---
wss.on('connection', async (ws) => {
  console.log('📞 WebSocket connected');
  // Create Deepgram live stream
  const dgStream = await dgClient.listen.live({
    model: 'nova',
    encoding: 'linear16',
    sample_rate: 8000,
    interim_results: true,
    smart_format: true,
    language: 'en'
  });

  // Relay Deepgram transcript to console (or handle as needed)
  dgStream.on('transcriptReceived', (transcript) => {
    if (transcript.channel && transcript.channel.alternatives && transcript.channel.alternatives[0].transcript) {
      const msg = transcript.channel.alternatives[0].transcript;
      if (msg.length) console.log('💬 Deepgram:', msg);
    }
  });
  dgStream.on('error', (err) => {
    console.error('❌ Deepgram error:', err);
  });

  ws.on('message', (msg) => {
    try {
      const parsed = JSON.parse(msg);
      if (parsed.event === 'media') {
        const mulawBuf = Buffer.from(parsed.media.payload, 'base64');
        const pcm = decodeMuLawBuffer(mulawBuf);
        if (pcm.length > 0) dgStream.send(pcm);
      }
      if (parsed.event === 'start') {
        console.log('🟢 Twilio stream started');
      }
      if (parsed.event === 'stop') {
        console.log('🛑 Twilio stream stopped');
        dgStream.finish();
      }
    } catch (e) {
      console.error('❌ WebSocket message parse error:', e);
    }
  });

  ws.on('close', () => {
    console.log('❌ WebSocket closed');
    dgStream.finish();
  });
});

server.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
  console.log(`🔗 ws://localhost:${PORT}/ws or wss://ai-receptionistv2.onrender.com/ws`);
});
