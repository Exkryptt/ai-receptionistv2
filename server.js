require('dotenv').config();
const express = require('express');
const http    = require('http');
const WebSocket = require('ws');
const twilio  = require('twilio');
const { OpenAI } = require('openai');
const { createClient, LiveTranscriptionEvents } = require('@deepgram/sdk');

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ noServer: true });

// Initialize clients
const dgClient = createClient(process.env.DEEPGRAM_API_KEY);
const openai   = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// In-memory chat history
const chatHistory = [];

// Your sandwich-bar system prompt
const SYSTEM_PROMPT = `
You work at a London Sandwich Bar and you're answering the phone taking people's takeaway orders.
Be friendly and upsell the special: the muscle and pickled sandwich for £4 each.
Soft drinks £1, cakes £2/slice (6 varieties).
Once you've taken the order, read it back and wish them a nice day.
Keep responses ≤ 20 words.
Always ask for caller’s name and pickup time first.
`.trim();

// TwiML endpoint for incoming calls
app.post('/twiml', (req, res) => {
  res.type('xml').send(`
    <Response>
      <Say>Hi, this is your GP clinic assistant.</Say>
      <Pause length="1"/>
      <Start><Stream url="wss://${req.headers.host}/ws" track="inbound"/></Start>
      <Pause length="30"/>
    </Response>
  `);
});

// Outbound dialing endpoint
app.get('/call-me', async (req, res) => {
  try {
    const client = twilio(
      process.env.TWILIO_ACCOUNT_SID,
      process.env.TWILIO_AUTH_TOKEN
    );
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

// Start HTTP + WS server
server.listen(process.env.PORT||3000, () => {
  console.log(`✅ Listening on port ${server.address().port}`);
});
server.on('upgrade', (req, socket, head) => {
  if (req.url === '/ws') {
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
  } else {
    socket.destroy();
  }
});

wss.on('connection', async (ws) => {
  console.log('📞 Twilio WebSocket connected');

  let dgStream;
  let lastTranscript = '';
  let outboundSeq = Promise.resolve();

  // Cleanup helper
  const cleanup = () => {
    if (dgStream) {
      try { dgStream.finish(); } catch {}
      console.log('🧹 Cleaned up Deepgram');
    }
  };

  // 1) Open Deepgram live transcription
  try {
    dgStream = await dgClient.listen.live({
      content_type:    'audio/raw;encoding=mulaw;rate=8000',
      model:           'nova-phonecall',
      language:        'en-US',
      interim_results: true,
      punctuate:       true,
    });
    console.log('🔗 Deepgram live stream started');
  } catch (e) {
    console.error('❌ Deepgram error:', e);
    ws.close();
    return;
  }

  // 2) Handle transcription events
  dgStream.on(LiveTranscriptionEvents.Transcript, async (evt) => {
    const alt = evt.channel?.alternatives?.[0];
    if (!alt?.transcript) return;

    const text = alt.transcript.trim();
    const delta = text.startsWith(lastTranscript)
      ? text.slice(lastTranscript.length).trim()
      : text;
    lastTranscript = text;

    delta.split(/\s+/).filter(Boolean).forEach(w => console.log('🟢 Word:', w));

    if (evt.is_final) {
      console.log('🛑 Final transcript:', text);
      lastTranscript = '';

      // Build chat messages
      const messages = [
        { role: 'system', content: SYSTEM_PROMPT },
        ...chatHistory,
        { role: 'user',   content: text },
      ];

      try {
        // 3) OpenAI Chat
        const resp = await openai.chat.completions.create({
          model:       'gpt-4o-mini',
          messages,
          max_tokens:  200,
          temperature: 1,
        });
        const reply = resp.choices[0].message.content.trim();
        console.log('🤖 GPT-4o reply:', reply);

        // Update history
        chatHistory.push({ role: 'user',      content: text  });
        chatHistory.push({ role: 'assistant', content: reply });
        if (chatHistory.length > 40) chatHistory.splice(0, chatHistory.length-40);

        // 4) Deepgram TTS
        const ttsRes = await dgClient.speak.request(
          { text: reply },
          { model: 'aura-helios-en', encoding: 'mulaw', container: 'none', sample_rate: 8000 }
        );
        const reader = (await ttsRes.getStream()).getReader();
        const chunks = [];
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
        }
        const audioBuf = Buffer.concat(chunks);

        // 5) Send outbound audio
        outboundSeq = outboundSeq.then(() => new Promise(res => {
          setTimeout(() => {
            ws.send(JSON.stringify({
              event: 'media',
              sequenceNumber: '1',
              media: {
                track:   'outbound',
                payload: audioBuf.toString('base64'),
              },
            }));
            res();
          }, 100);
        }));

      } catch (err) {
        console.error('❌ AI/TTS error:', err);
      }
    }
  });

  dgStream.on(LiveTranscriptionEvents.Error, err => {
    console.error('❌ Deepgram stream error:', err);
    cleanup();
  });
  dgStream.on(LiveTranscriptionEvents.Close, cleanup);
  dgStream.on(LiveTranscriptionEvents.Finish, () => {
    console.log('🛑 Deepgram stream finished');
    cleanup();
  });

  // 6) Forward Twilio media to Deepgram
  ws.on('message', raw => {
    const msg = JSON.parse(raw);
    if (msg.event === 'media' && msg.media?.payload) {
      const pcm = Buffer.from(msg.media.payload, 'base64');
      dgStream.send(pcm);
    }
    if (msg.event === 'stop') {
      console.log('🛑 Twilio stream stopped');
      cleanup();
    }
  });

  ws.on('close', () => {
    console.log('❌ WebSocket closed');
    cleanup();
  });
  ws.on('error', err => {
    console.error('❌ WebSocket error:', err);
    cleanup();
  });
});
