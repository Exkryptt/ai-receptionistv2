require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const fetch = require('node-fetch');
const { createClient } = require('@deepgram/sdk');
const { OpenAI } = require('openai');
const twilio = require('twilio');
const { twiml } = require('twilio');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ noServer: true });


const dgClient = createClient(process.env.DEEPGRAM_API_KEY);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// ✅ Dynamic TwiML for Twilio
app.all('/twiml', (req, res) => {
  const twiml = `
    <Response>
      <Start>
        <Stream url="wss://${req.headers.host}/ws" track="inbound_track" content-type="audio/l16;rate=16000;channels=1" />
      </Start>
      <Say>Hi, this is your GP clinic assistant. Please begin speaking after the beep.</Say>
      <Pause length="6"/>
      <Redirect method="POST">/stream-skipped</Redirect>
    </Response>
  `;
  res.set('Content-Type', 'text/xml');
  res.send(twiml);
});



app.post('/stream-skipped', (req, res) => {
  console.log('⚠️ Twilio skipped the <Stream> or failed to open WebSocket');
  const response = new twiml.VoiceResponse();
  response.say("Sorry, something went wrong with the call stream.");
  res.type('text/xml').send(response.toString());
});



// ✅ Call trigger
app.get('/call-me', async (req, res) => {
  try {
    const call = await client.calls.create({
      url: 'https://ai-receptionistv2.onrender.com/twiml',
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

// ✅ Main WebSocket handling
wss.on('connection', async (ws) => {
  console.log('📞 Twilio stream connected');

  const dgStream = await dgClient.listen.live({
    model: 'nova',
    interim_results: true,
    language: 'en',
    smart_format: true
  });

  dgStream.on('transcriptReceived', async (data) => {
    const transcript = data.channel?.alternatives[0]?.transcript;
    if (!transcript || !data.is_final) return;
    console.log('🗣', transcript);

    const gpt = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: 'You are a helpful GP receptionist. Respond clearly and concisely.' },
        { role: 'user', content: transcript }
      ]
    });

    const reply = gpt.choices[0].message.content;
    console.log('🤖', reply);

    const audioRes = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${process.env.ELEVENLABS_VOICE_ID}/stream`, {
      method: 'POST',
      headers: {
        'xi-api-key': process.env.ELEVENLABS_API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        text: reply,
        model_id: 'eleven_monolingual_v1',
        voice_settings: {
          stability: 0.4,
          similarity_boost: 0.75
        },
        stream: true
      })
    });

    console.log('🔊 ElevenLabs stream received (not yet streamed back to caller)');
  });

  ws.on('message', (msg) => {
    const parsed = JSON.parse(msg);
    console.log('📩 Raw event:', parsed.event);

    if (parsed.event === 'start') {
      console.log('🟢 Twilio stream started');
    } else if (parsed.event === 'media') {
      const audio = Buffer.from(parsed.media.payload, 'base64');
      dgStream.send(audio);
    } else if (parsed.event === 'stop') {
      console.log('🛑 Twilio stream stopped');
    }
  });

  ws.on('error', (err) => {
    console.error('❌ WebSocket error:', err);
  });

ws.on('close', () => {
  console.log('❌ WebSocket closed');
  if (dgStream) dgStream.finish();
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
app.get('/ping', (req, res) => {
  res.send('pong');
});

console.log('Port from environment:', process.env.PORT);
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});
