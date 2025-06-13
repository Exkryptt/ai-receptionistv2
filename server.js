require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { createClient } = require('@deepgram/sdk');
const twilio = require('twilio');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ noServer: true });

const dgClient = createClient(process.env.DEEPGRAM_API_KEY);
const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

app.use(express.urlencoded({ extended: true }));

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

wss.on('connection', async (ws) => {
  console.log('📞 Twilio stream connected');

  // 🔑 This is the fix: Use encoding: 'mulaw', sample_rate: 8000
  const dgStream = await dgClient.listen.live({
    model: 'nova',
    interim_results: true,
    encoding: 'mulaw',
    sample_rate: 8000,
    channels: 1,
    language: 'en',
    smart_format: true
  });

  dgStream.on('transcriptReceived', (data) => {
    if (data.channel?.alternatives?.[0]?.transcript && data.is_final) {
      const transcript = data.channel.alternatives[0].transcript;
      console.log('🗣 Final transcript:', transcript);
      // Plug your OpenAI/ElevenLabs logic here
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
        // SEND RAW MULAW TO DEEPGRAM:
        const muLawAudio = Buffer.from(parsed.media.payload, 'base64');
        dgStream.send(muLawAudio);
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

server.on('upgrade', (req, socket, head) => {
  if (req.url === '/ws') {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  } else {
    socket.destroy();
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});
