const { createClient, LiveTranscriptionEvents } = require("@deepgram/sdk");
const fetch = require("cross-fetch");

const live = async () => {
  // The API key you created in step 1
  const deepgramApiKey = "73edefb09e4c49c1bd986529f34ce7f91a285357";

  // URL for the real-time streaming audio you would like to transcribe
  const url = "http://stream.live.vc.bbcmedia.co.uk/bbc_world_service";

  // Initialize the Deepgram SDK
  const deepgram = createClient(deepgramApiKey);

  // Create a websocket connection to Deepgram
  const connection = deepgram.listen.live({
    smart_format: true,
    model: 'nova-2',
    language: 'en-US',
  });

  // Listen for the connection to open.
  connection.on(LiveTranscriptionEvents.Open, () => {
    // Listen for any transcripts received from Deepgram and write them to the console.
    connection.on(LiveTranscriptionEvents.Transcript, (data) => {
      console.dir(data, { depth: null });
    });

    // Listen for any metadata received from Deepgram and write it to the console.
    connection.on(LiveTranscriptionEvents.Metadata, (data) => {
      console.dir(data, { depth: null });
    });

    // Listen for the connection to close.
    connection.on(LiveTranscriptionEvents.Close, () => {
      console.log("Connection closed.");
    });

    // Send streaming audio from the URL to Deepgram.
    fetch(url)
      .then((r) => r.body)
      .then((res) => {
        res.on("readable", () => {
          connection.send(res.read());
        });
      });
  });
};

live();
