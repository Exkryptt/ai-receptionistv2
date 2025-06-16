// dg-final-test.js
require('dotenv').config();
const fs = require('fs');
const { createClient } = require('@deepgram/sdk');

(async () => {
  const dg = createClient(process.env.DEEPGRAM_API_KEY);

  const filename = 'test.wav';
  if (!fs.existsSync(filename)) {
    console.error('❌ File not found:', filename);
    process.exit(1);
  }

  const buffer = fs.readFileSync(filename);
  console.log(`▶️ Read ${buffer.length} bytes from ${filename}`);

  // v3: use dg.transcription.live(), not dg.listen.live()
  const dgStream = await dg.transcription.live({
    // for µ-law WAV:
    content_type:    'audio/wav;codec=mulaw;rate=8000',
    model:           'nova-phonecall',
    language:        'en-US',
    interim_results: true,
    punctuate:       true,
    channels:        1,
  });
  console.log('🔗 Deepgram live stream opened');

  dgStream.on('transcriptReceived', (evt) => {
    const alt = evt.channel?.alternatives?.[0];
    if (!alt?.transcript) return;
    const tag = evt.is_final ? '🛑 FINAL: ' : '… interim: ';
    console.log(tag + alt.transcript);
  });
  dgStream.on('error', (err) => console.error('❌ Deepgram error:', err));
  dgStream.on('close', () => console.log('⚡ Deepgram stream closed'));

  // Send the whole WAV in one go
  dgStream.send(buffer);
  dgStream.finish();

  // Wait for final transcript
  await new Promise(r => setTimeout(r, 3000));
})();
