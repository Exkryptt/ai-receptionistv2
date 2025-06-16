// server.js
require('dotenv').config();
const express   = require('express');
const http      = require('http');
const WebSocket = require('ws');
const twilio    = require('twilio');
const { OpenAI } = require('openai');

////////////////////////////////////////////////////////////////////////////////
// CONFIG
////////////////////////////////////////////////////////////////////////////////

const {
  PORT: PORT_ENV,
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  YOUR_PHONE_NUMBER,
  TWILIO_NUMBER,
  ASSEMBLYAI_API_KEY,
  OPENAI_API_KEY
} = process.env;

const PORT = Number(PORT_ENV) || 3000;

if (
  !TWILIO_ACCOUNT_SID ||
  !TWILIO_AUTH_TOKEN   ||
  !YOUR_PHONE_NUMBER   ||
  !TWILIO_NUMBER       ||
  !ASSEMBLYAI_API_KEY  ||
  !OPENAI_API_KEY
) {
  console.error(
    '❌ Missing one of required env vars: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, YOUR_PHONE_NUMBER, TWILIO_NUMBER, ASSEMBLYAI_API_KEY, OPENAI_API_KEY'
  );
  process.exit(1);
}

////////////////////////////////////////////////////////////////////////////////
// CLIENTS
////////////////////////////////////////////////////////////////////////////////

const twClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
const aiClient = new OpenAI({ apiKey: OPENAI_API_KEY });

////////////////////////////////////////////////////////////////////////////////
// EXPRESS + TWILIO ROUTES
////////////////////////////////////////////////////////////////////////////////

const app = express();
app.use(express.urlencoded({ extended: true }));

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

////////////////////////////////////////////////////////////////////////////////
// WEBSOCKET SERVER + STREAMING LOGIC
////////////////////////////////////////////////////////////////////////////////

const server = http.createServer(app);
const wss    = new WebSocket.Server({ noServer: true });

wss.on('connection', (twilioWs) => {
  console.log('📞 Twilio WS connected');

  // Buffer until AA WS is open
  const pendingAudio = [];

  // Open AssemblyAI realtime WebSocket
  const aaWs = new WebSocket(
    'wss://api.assemblyai.com/v2/realtime/ws?sample_rate=8000',
    { headers: { Authorization: ASSEMBLYAI_API_KEY } }
  );

  aaWs.on('open', () => {
    console.log('🔗 AssemblyAI WS open – sending start config & flushing buffered audio…');

    // 1) Send the required "start" config frame:
    aaWs.send(JSON.stringify({
      config: {
        encoding:      'mulaw',
        sample_rate:   8000,
        channels:      1,
        language_code: 'en_us'
      }
    }));

    // 2) Now flush any audio we buffered before it was open:
    for (const chunk of pendingAudio) {
      aaWs.send(chunk);
    }
    pendingAudio.length = 0;
  });

  aaWs.on('message', async (data) => {
    const msg = JSON.parse(data);
    if (msg.message_type === 'PartialTranscript') {
      const partial = msg.text.trim();
      console.log('… interim transcript:', partial);

      // Send partial to OpenAI with streaming
      try {
        const completion = await aiClient.chat.completions.create({
          model:       'gpt-4o-mini',
          messages: [
            { role: 'system', content: 'You are a friendly sandwich bar assistant. Keep replies to 20 words or less.' },
            { role: 'user',   content: partial }
          ],
          max_tokens:  30,
          temperature: 0.7,
          stream:      true
        });

        process.stdout.write('🤖 streaming reply: ');
        completion.on('data', (chunk) => {
          process.stdout.write(chunk.choices[0].delta?.content || '');
        });
        completion.on('end', () => {
          console.log('\n— done streaming');
        });
      } catch (err) {
        console.error('❌ OpenAI error on partial:', err);
      }

    } else if (msg.message_type === 'FinalTranscript') {
      console.log('🛑 final transcript:', msg.text.trim());
    }
  });

  aaWs.on('close', () => console.log('⚡ AssemblyAI WS closed'));
  aaWs.on('error',  (e) => console.error('❌ AssemblyAI WS error:', e));

  // Forward Twilio media -> AssemblyAI
  twilioWs.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.event === 'media' && msg.media?.payload) {
      const payload = JSON.stringify({ audio_data: msg.media.payload });
      if (aaWs.readyState === WebSocket.OPEN) {
        aaWs.send(payload);
      } else {
        pendingAudio.push(payload);
      }
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
  console.log(`✅ Server listening on port ${PORT}`);
});
