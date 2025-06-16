// dg-test-wav2.js
require('dotenv').config();
const fs = require('fs');
const { createClient, LiveTranscriptionEvents } = require('@deepgram/sdk');

(async () => {
  const dg = createClient(process.env.DEEPGRAM_API_KEY);
  const filename = 'test.wav';

  if (!fs.existsSync(filename)) {
    console.error('❌ File not found:', filename);
    process.exit(1);
  }
  const buffer = fs.readFileSync(filename);
  console.log(`▶️ Read ${buffer.length} bytes from ${filename}`);

  // Tell Deepgram it’s a μ-law WAV at 8 kHz:
  const dgStream = await dg.listen.live({
    content_type:    'audio/wav;codec=mulaw;rate=8000',
    model:           'nova-phonecall',
    language:        'en-US',
    interim_results: true,
    punctuate:       true,
    channels:        1,
  });

  dgStream.on(LiveTranscriptionEvents.Transcript, (evt) => {
    const alt = evt.channel.alternatives[0];
    if (!alt.transcript) return;
    const tag = evt.is_final ? '🛑 FINAL:' : '… interim:';
    console.log(tag, alt.transcript);
  });
  dgStream.on('error', console.error);
  dgStream.on('close',  () => console.log('⚡ Deepgram closed'));

  // Send the whole WAV in one go (Deepgram will buffer & chunk internally)
  dgStream.send(buffer);
  dgStream.finish();

  // Give it a couple seconds to flush out the final transcript
  await new Promise(r => setTimeout(r, 2500));
})();
