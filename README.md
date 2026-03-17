# `pi-voice-ask`

<img width="1408" height="768" alt="image" src="https://github.com/user-attachments/assets/6805597b-4a5c-4ab9-9388-98123034c9d7" />

## Install

```bash
pi install git:github.com/mossbanay/pi-voice-ask
```

## What is this?

This is a minimal extension for [Pi](https://pi.dev/) which adds support for the agent to invoke a tool to ask you a question via TTS using macOS `say` and listens for your reply using [Voxtral realtime](https://mistral.ai/news/voxtral-transcribe-2) from Mistral, my favourite speech to text model. When the phrase "send reply" is transcribed your response is flushed back to the agent and it can continue working.

Here's the prompt I used to build it:

```text
I want to write a new plugin for Pi which allows me to speak to it.
There should be a tool that the agent is able to call to ask me a question.
When it calls that tool, it should run text-to-speech to convert the question
into audio, play it and then listen to my response and wait for a keyword
(e.g. send reply) to indicate that I'm finished and send it back to the agent.
```

I have not reviewed the code that was produced, but I have happily used it to code while making pizza dough.

