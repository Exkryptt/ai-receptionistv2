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

// Call-Me endpoint for testing
app.get('/call-me', async (req, res) => {
  try {
    const call = await client.calls.create({
      url: `https://${req.headers.host}/twiml`,
      to: process.env.YOUR_PHONE_NUMBER,
      from: process.env.TWILIO_NUMBER,
      method: 'POST',
    });
    console.log(`📞 Outbound call started: ${call.sid}`);
    res.send('Calling your phone now...');
  } catch (err) {
    console.error('❌ Call failed:', err);
    res.status(500).send('Call failed.');
  }
});

// Twilio webhook to initiate the <Stream>
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

wss.on('connection', async (ws, req) => {
  console.log('==> ///////////////////////////////////////////////////////////');
  console.log('📞 Twilio WebSocket stream connected');

  // Create Deepgram live stream
  let dgStream;
  try {
    dgStream = await dgClient.listen.live({
      encoding: 'mulaw',
      sample_rate: 8000,
      interim_results: true,
      language: 'en',
      smart_format: true,
    });
    console.log('🔗 Deepgram live stream started');
  } catch (err) {
    console.error('❌ Failed to start Deepgram stream:', err);
    ws.close();
    return;
  }

  // Deepgram event listeners
  dgStream.on('transcriptReceived', (data) => {
    if (data.channel?.alternatives?.[0]?.transcript && data.is_final) {
      const transcript = data.channel.alternatives[0].transcript;
      console.log('🗣 Final transcript:', transcript);
      // Insert your OpenAI/ElevenLabs logic here
    }
  });
  dgStream.on('error', (err) => console.error('❌ Deepgram error:', err));
  dgStream.on('close', () => console.log('🛑 Deepgram stream closed'));
  dgStream.on('finish', () => console.log('🛑 Deepgram stream finished'));

  // Twilio events from WebSocket
  ws.on('message', (msg) => {
    try {
      const parsed = JSON.parse(msg);
      switch (parsed.event) {
        case 'connected':
          console.log(`[Twilio] Unhandled event: ${msg}`);
          break;
        case 'start':
          console.log(`🟢 [Twilio] stream started: ${msg}`);
          break;
        case 'media':
          // Receive media in base64, decode, send to Deepgram as binary buffer
          const audio = Buffer.from(parsed.media.payload, 'base64');
          console.log(`[media] got ${audio.length} bytes from Twilio`);
          dgStream.write(audio);
          break;
        case 'stop':
          console.log('🛑 [Twilio] stream stopped');
          dgStream.end();
          break;
        default:
          console.log(`[Twilio] Unhandled event: ${msg}`);
      }
    } catch (e) {
      console.error('❌ Error parsing WebSocket message:', e);
    }
  });

  ws.on('error', (err) => {
    console.error('❌ WebSocket error:', err);
    dgStream.end();
  });

  ws.on('close', () => {
    console.log('❌ WebSocket closed');
    dgStream.end();
  });
});

// HTTP upgrade handler for /ws
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
  console.log('==> ///////////////////////////////////////////////////////////');
  console.log('==> Available at your primary URL');
});
