require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { createClient } = require('@deepgram/sdk');
const twilio = require('twilio');
const { twiml } = require('twilio');
const fetch = require('node-fetch'); // v2 for compatibility

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ noServer: true });

// Deepgram setup
const dgClient = createClient(process.env.DEEPGRAM_API_KEY);

// Twilio setup
const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

// Middlewares
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// Outbound call (for demo/testing)
app.get('/call-me', async (req, res) => {
  try {
    const call = await client.calls.create({
      url: `https://${req.headers.host}/twiml`,
      to: process.env.YOUR_PHONE_NUMBER,
      from: process.env.TWILIO_NUMBER,
      method: 'POST'
    });
    console.log(`📞 Outbound call started: ${call.sid}`);
    res.send('Calling your phone now...');
  } catch (err) {
    console.error('❌ Call failed:', err);
    res.status(500).send('Call failed.');
  }
});

// Twilio webhook to start <Stream>
app.all('/twiml', (req, res) => {
  const xml = `
    <Response>
      <Start>
        <Stream url="wss://${req.headers.host}/ws" track="inbound_track" />
      </Start>
      <Say>Hi, this is your GP clinic assistant. Please begin speaking after the beep.</Say>
      <Pause length="60"/>
    </Response>
  `;
  res.set('Content-Type', 'text/xml');
  res.send(xml);
});

// Handle Twilio stream skips/failures
app.post('/stream-skipped', (req, res) => {
  console.log('⚠️ Twilio skipped the <Stream> or failed to open WebSocket');
  const response = new twiml.VoiceResponse();
  response.say("Sorry, something went wrong with the call stream.");
  res.type('text/xml').send(response.toString());
});

// Health check
app.get('/ping', (req, res) => res.send('pong'));

// Mu-law decoding (pure JS, no npm needed)
function mulawDecode(muLawByte) {
  const MULAW_MAX = 0x1FFF;
  const MULAW_BIAS = 33;
  muLawByte = ~muLawByte;
  let sign = (muLawByte & 0x80) ? -1 : 1;
  let exponent = (muLawByte >> 4) & 0x07;
  let mantissa = muLawByte & 0x0F;
  let sample = ((mantissa << 3) + MULAW_BIAS) << exponent;
  return sign * (sample - MULAW_BIAS);
}

// WebSocket for Twilio <Stream>
wss.on('connection', async (ws) => {
  console.log('📞 Twilio stream connected');

  // Connect to Deepgram live streaming
  const dgStream = await dgClient.listen.live({
    model: 'nova',
    interim_results: true,
    language: 'en',
    smart_format: true
  });

  dgStream.on('transcriptReceived', (data) => {
    if (data.channel?.alternatives?.[0]?.transcript && data.is_final) {
      const transcript = data.channel.alternatives[0].transcript;
      console.log('🗣 Final transcript:', transcript);
      // TODO: Plug in OpenAI/ElevenLabs pipeline here if needed
    }
  });

  dgStream.on('error', (err) => console.error('❌ Deepgram error:', err));
  dgStream.on('close', () => console.log('🛑 Deepgram stream closed'));
  dgStream.on('finish', () => console.log('🛑 Deepgram stream finished'));

  ws.on('message', (msg) => {
    try {
      const parsed = JSON.parse(msg);
      if (parsed.event === 'start') {
        console.log('🟢 Twilio stream started');
      } else if (parsed.event === 'media') {
        // Decode base64 payload (μ-law)
        const muLawAudio = Buffer.from(parsed.media.payload, 'base64');
        // Decode μ-law to PCM
        const pcmSamples = Buffer.alloc(muLawAudio.length * 2);
        for (let i = 0; i < muLawAudio.length; i++) {
          const sample = mulawDecode(muLawAudio[i]);
          pcmSamples.writeInt16LE(sample, i * 2);
        }
        dgStream.send(pcmSamples);
      } else if (parsed.event === 'stop') {
        console.log('🛑 Twilio stream stopped');
        dgStream.finish();
      }
    } catch (e) {
      console.error('❌ Error parsing WebSocket message:', e);
    }
  });

  ws.on('error', (err) => console.error('❌ WebSocket error:', err));
  ws.on('close', () => {
    console.log('❌ WebSocket closed');
    dgStream.finish();
  });
});

// WebSocket upgrade
server.on('upgrade', (req, socket, head) => {
  if (req.url === '/ws') {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  } else {
    socket.destroy();
  }
});

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});
