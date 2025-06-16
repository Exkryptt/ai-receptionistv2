// server.js
require('dotenv').config();
const express   = require('express');
const http      = require('http');
const WebSocket = require('ws');
const twilio    = require('twilio');
const { OpenAI } = require('openai');

//───────────────────────────────────────────────────────────────────────────────
// CONFIG
//───────────────────────────────────────────────────────────────────────────────

const {
  PORT = 3000,
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  YOUR_PHONE_NUMBER,
  TWILIO_NUMBER,
  ASSEMBLYAI_API_KEY,
  OPENAI_API_KEY
} = process.env;

if (!TWILIO_ACCOUNT_SID ||
    !TWILIO_AUTH_TOKEN   ||
    !YOUR_PHONE_NUMBER   ||
    !TWILIO_NUMBER       ||
    !ASSEMBLYAI_API_KEY  ||
    !OPENAI_API_KEY
) {
  console.error('❌ Missing one of required env vars: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, YOUR_PHONE_NUMBER, TWILIO_NUMBER, ASSEMBLYAI_API_KEY, OPENAI_API_KEY');
  process.exit(1);
}

//───────────────────────────────────────────────────────────────────────────────
// CLIENTS
//───────────────────────────────────────────────────────────────────────────────

const twClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
const aiClient = new OpenAI({ apiKey: OPENAI_API_KEY });

//───────────────────────────────────────────────────────────────────────────────
// EXPRESS + TWILIO ROUTES
//───────────────────────────────────────────────────────────────────────────────

const app = express();
app.use(express.urlencoded({ extended: true }));

// TwiML endpoint for both inbound & outbound calls
app.post('/twiml', (_, res) => {
  res.type('text/xml').send(`
    <Response>
      <Say>Hi, thank you for calling our sandwich bar.</Say>
      <Pause length="1"/>
      <Connect>
        <Stream url="wss://${_.headers.host}/ws" track="inbound_track"/>
      </Connect>
    </Response>
  `);
});

// Trigger an outbound call to YOUR_PHONE_NUMBER
app.get('/call-me', async (_, res) => {
  try {
    const call = await twClient.calls.create({
      url:    `https://${_.headers.host}/twiml`,
      to:     YOUR_PHONE_NUMBER,
      from:   TWILIO_NUMBER,
      method: 'POST'
    });
    console.log('📞 Outbound call SID:', call.sid);
    res.send('Calling you now…');
  } catch (err) {
    console.error('❌ Twilio call error:', err);
    res.status(500).send('Call failed');
  }
});

//───────────────────────────────────────────────────────────────────────────────
// WEBSOCKET SERVER
//───────────────────────────────────────────────────────────────────────────────

const server = http.createServer(app);
const wss    = new WebSocket.Server({ noServer: true });

wss.on('connection', (twilioWs) => {
  console.log('📞 Twilio WS connected');

  // 1) Open AssemblyAI WebSocket
  const aaWs = new WebSocket('wss://api.assemblyai.com/v2/realtime/ws?sample_rate=8000', {
    headers: { Authorization: ASSEMBLYAI_API_KEY }
  });

  let convo = [
    { role: 'system', content: 'You are a friendly sandwich bar assistant. Keep replies to 20 words or less.' }
  ];

  aaWs.on('open', () => {
    console.log('🔗 AssemblyAI WS open');
  });

  aaWs.on('message', async (data) => {
    const msg = JSON.parse(data);
    if (msg.message_type === 'PartialTranscript') {
      const partial = msg.text.trim();
      console.log('… interim transcript:', partial);

      // 2) Immediately fire off an OpenAI stream for this partial:
      const userMsg = { role: 'user', content: partial };
      const messages = convo.concat(userMsg);

      try {
        const completion = await aiClient.chat.completions.create({
          model:       'gpt-4o-mini',
          messages,
          max_tokens:  30,
          temperature: 0.7,
          stream:      true
        });

        let aiReply = '';
        process.stdout.write('🤖 streaming reply: ');
        completion.on('data', (chunk) => {
          const delta = chunk.choices[0].delta?.content || '';
          process.stdout.write(delta);
          aiReply += delta;
        });
        completion.on('end', () => {
          console.log('\n— done streaming');
          // Note: not updating convo yet on partials; wait for final transcript
        });
      } catch (err) {
        console.error('❌ OpenAI error on partial:', err);
      }

    } else if (msg.message_type === 'FinalTranscript') {
      const final = msg.text.trim();
      console.log('🛑 final transcript:', final);

      // 3) Update convo and optionally fire off a non‐streaming full reply
      convo.push({ role: 'user', content: final });
      // …you could do a final OpenAI turn here if desired…
    }
  });

  aaWs.on('close', () => console.log('⚡ AssemblyAI WS closed'));
  aaWs.on('error',  (e) => console.error('❌ AssemblyAI WS error:', e));

  // 4) Pipe Twilio audio into AssemblyAI
  twilioWs.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.event === 'media' && msg.media?.payload) {
      // Twilio gives you µ-law 8kHz base64
      aaWs.send(JSON.stringify({ audio_data: msg.media.payload }));
    }
    if (msg.event === 'stop') {
      console.log('🛑 Twilio end');
      aaWs.close();
      twilioWs.close();
    }
  });

  twilioWs.on('close', () => {
    console.log('❌ Twilio WS closed');
    aaWs.close();
  });
  twilioWs.on('error', (e) => {
    console.error('❌ Twilio WS error:', e);
    aaWs.close();
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
  console.log(`✅ Listening on port ${PORT}`);
});
