require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const fetch = require('node-fetch');
const { createClient } = require('@deepgram/sdk');
const { OpenAI } = require('openai');
const twilio = require('twilio');
const { twiml } = require('twilio');
const prism = require('prism-media');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ noServer: true });

const dgClient = createClient(process.env.DEEPGRAM_API_KEY);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// TwiML for Twilio — keeps stream open
app.all('/twiml', (req, res) => {
  const twimlResponse = `
    <Response>
      <Start>
        <Stream url="wss://${req.headers.host}/ws" track="inbound_track" content-type="audio/l16;rate=16000;channels=1" />
      </Start>
      <Say>Hi, this is your GP clinic assistant. Please begin speaking after the beep.</Say>
      <Pause length="60"/>
    </Response>
  `;
  res.set('Content-Type', 'text/xml');
  res.send(twimlResponse);
});

app.post('/stream-skipped', (req, res) => {
  console.log('⚠️ Twilio skipped the <Stream> or failed to open WebSocket');
  const response = new twiml.VoiceResponse();
  response.say("Sorry, something went wrong with the call stream.");
  res.type('text/xml').send(response.toString());
});

// Outbound call trigger endpoint
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

wss.on('connection', async (ws) => {
  console.log('📞 Twilio stream connected');

  // Deepgram streaming client with auto detect (removed encoding, sample_rate, channels)
  const dgStream = await dgClient.listen.live({
    model: 'nova',
    interim_results: true,
    language: 'en',
    smart_format: true
  });

  dgStream.on('transcriptReceived', (data) => {
    console.log('📄 Deepgram transcriptReceived event:', JSON.stringify(data, null, 2));
    if (data.channel?.alternatives?.[0]?.transcript && data.is_final) {
      console.log('🗣 Final transcript:', data.channel.alternatives[0].transcript);
    }
  });

  dgStream.on('error', (err) => {
    console.error('❌ Deepgram streaming error:', err);
  });

  dgStream.on('close', () => {
    console.log('🛑 Deepgram stream closed');
  });

  dgStream.on('finish', () => {
    console.log('🛑 Deepgram stream finished');
  });

  // Throttle media events to once per second
  let lastSentTimestamp = 0;

  ws.on('message', (msg) => {
    try {
      const parsed = JSON.parse(msg);
      if (parsed.event === 'start') {
        console.log('🟢 Twilio stream started');
      } else if (parsed.event === 'media') {
        const now = Date.now();
        if (now - lastSentTimestamp > 1000) {
          lastSentTimestamp = now;
          const audio = Buffer.from(parsed.media.payload, 'base64');
          try {
            dgStream.send(audio);
            console.log('🔊 Sent audio chunk to Deepgram');
          } catch (err) {
            console.error('❌ Error sending audio to Deepgram:', err);
          }
        }
      } else if (parsed.event === 'stop') {
        console.log('🛑 Twilio stream stopped');
      }
    } catch (e) {
      console.error('❌ Error parsing WebSocket message:', e);
    }
  });

  ws.on('error', (err) => {
    console.error('❌ WebSocket error:', err);
  });

  ws.on('close', () => {
    console.log('❌ WebSocket closed');
    if (dgStream) dgStream.finish();
  });

  // Respond to Deepgram transcripts with OpenAI and ElevenLabs TTS (unchanged)
  dgStream.on('transcriptReceived', async (data) => {
    if (!data.is_final) return;

    const transcript = data.channel?.alternatives?.[0]?.transcript;
    if (!transcript) return;

    console.log('🗣 Transcript (final):', transcript);

    try {
      const gpt = await openai.chat.completions.create({
        model: 'gpt-4o',
        messages: [
          { role: 'system', content: 'You are a helpful GP receptionist. Respond clearly and concisely.' },
          { role: 'user', content: transcript }
        ]
      });

      const reply = gpt.choices[0].message.content;
      console.log('🤖 GPT reply:', reply);

      const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${process.env.ELEVENLABS_VOICE_ID}/stream`, {
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

      if (!response.ok) {
        console.error('❌ ElevenLabs TTS request failed:', response.statusText);
        return;
      }

      const ffmpeg = new prism.FFmpeg({
        args: [
          '-analyzeduration', '0',
          '-loglevel', '0',
          '-f', 'wav',
          '-i', 'pipe:0',
          '-f', 's16le',
          '-ar', '16000',
          '-ac', '1',
          'pipe:1'
        ],
      });

      response.body.pipe(ffmpeg);

      ffmpeg.on('data', (chunk) => {
        const base64Audio = chunk.toString('base64');
        const message = JSON.stringify({
          event: 'media',
          media: { payload: base64Audio }
        });
        ws.send(message);
      });

      ffmpeg.on('end', () => {
        console.log('🔊 Finished sending TTS audio');
      });

      ffmpeg.on('error', (err) => {
        console.error('❌ FFmpeg error:', err);
      });
    } catch (err) {
      console.error('❌ Error in GPT or TTS pipeline:', err);
    }
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

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});
