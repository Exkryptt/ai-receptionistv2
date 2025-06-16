require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { Configuration, OpenAIApi } = require('openai');
const { createClient, LiveTranscriptionEvents } = require('@deepgram/sdk');

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ noServer: true });

// Deepgram & OpenAI clients
const dgClient = createClient(process.env.DEEPGRAM_API_KEY);
const oaConfig = new Configuration({ apiKey: process.env.OPENAI_API_KEY });
const openai   = new OpenAIApi(oaConfig);

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

// TwiML endpoint for Twilio
app.post('/twiml', (req, res) => {
  res.type('xml').send(`
    <Response>
      <Say>Hi, this is your GP clinic assistant.</Say>
      <Pause length="1"/>
      <Start><Stream url="wss://${req.headers.host}/ws"/></Start>
      <Pause length="30"/>
    </Response>
  `);
});
app.get('/call-me', async (req, res) => {
  try {
    const client = require('twilio')(
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
server.on('upgrade', (req, sock, head) => {
  if (req.url === '/ws') {
    wss.handleUpgrade(req, sock, head, ws => wss.emit('connection', ws, req));
  } else {
    sock.destroy();
  }
});

wss.on('connection', async (ws) => {
  console.log('📞 Twilio WS connected');

  let dgStream;
  let lastTranscript = '';
  let outboundSeq = Promise.resolve();

  const cleanup = () => {
    if (dgStream) dgStream.finish();
    console.log('🧹 Cleaned up');
  };

  // 1) open Deepgram listen.live
  try {
    dgStream = await dgClient.listen.live({
      content_type:    'audio/raw;encoding=mulaw;rate=8000',
      model:           'nova-phonecall',
      language:        'en-US',
      interim_results: true,
      punctuate:       true,
    });
    console.log('🔗 DG live opened');
  } catch (e) {
    console.error('❌ DG error', e);
    ws.close();
    return;
  }

  // 2) handle STT events
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
      console.log('🛑 Final:', text);
      lastTranscript = '';

      // build messages
      const messages = [
        { role: 'system', content: SYSTEM_PROMPT },
        ...chatHistory,
        { role: 'user',   content: text },
      ];

      try {
        // 3) OpenAI Chat
        const resp = await openai.createChatCompletion({
          model: 'gpt-4o-mini',
          messages,
          max_tokens: 200,
          temperature: 1,
        });
        const reply = resp.data.choices[0].message.content.trim();
        console.log('🤖 GPT-4o reply:', reply);

        // update history
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
        while(true) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
        }
        const audioBuf = Buffer.concat(chunks);

        // 5) send back as outbound media
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
        console.error('❌ AI/TTS error', err);
      }
    }
  });

  dgStream.on(LiveTranscriptionEvents.Error, err => {
    console.error('❌ DG stream error', err);
    cleanup();
  });
  dgStream.on(LiveTranscriptionEvents.Close, cleanup);
  dgStream.on(LiveTranscriptionEvents.Finish, () => {
    console.log('🛑 DG stream finished');
    cleanup();
  });

  // 6) Twilio media → DG
  ws.on('message', raw => {
    const msg = JSON.parse(raw);
    switch (msg.event) {
      case 'media':
        const pcm = Buffer.from(msg.media.payload, 'base64');
        dgStream.send(pcm);
        break;
      case 'stop':
        console.log('🛑 Twilio stop');
        cleanup();
        break;
    }
  });

  ws.on('close', () => {
    console.log('❌ WS closed');
    cleanup();
  });
  ws.on('error', err => {
    console.error('❌ WS error', err);
    cleanup();
  });
});
