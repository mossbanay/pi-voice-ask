# `pi-voice-ask`

<img width="1408" height="768" alt="image" src="https://github.com/user-attachments/assets/6805597b-4a5c-4ab9-9388-98123034c9d7" />

## Install

```bash
pi install git:github.com/mossbanay/pi-voice-ask
```

## Quickstart (Mistral cloud)

```bash
export MISTRAL_API_KEY=your-api-key-here
pi install git:github.com/mossbanay/pi-voice-ask
```

Or for a local vLLM server:

```bash
export VOICE_PROTOCOL=vllm
export VOXTRAL_URL=ws://localhost:8000/v1/realtime
pi install git:github.com/mossbanay/pi-voice-ask
```

Note: Settings configured via `/voice-config` are persisted to `~/.pi-voice-config.json`.

## What is this?

This is a minimal extension for [Pi](https://pi.dev/) which adds support for the agent to invoke a tool to ask you a question via TTS using macOS `say` and listens for your reply using [Voxtral realtime](https://mistral.ai/news/voxtral-transcribe-2) from Mistral, my favourite speech to text model. When the phrase "send reply" is transcribed your response is flushed back to the agent and it can continue working.

Supports two transcription backends:

- **vLLM** — a local Voxtral server (default)
- **Mistral** — the Mistral cloud API with authentication

## Configuration

Configuration can be set via environment variables or changed at runtime using the `/voice-config` command inside Pi.

### Environment variables

| Variable | Description | Default |
|---|---|---|
| `VOICE_PROTOCOL` | `"vllm"` or `"mistral"` | `mistral` |
| `VOXTRAL_URL` | WebSocket URL for the transcription server | `wss://api.mistral.ai` (Mistral) or `ws://localhost:8000/v1/realtime` (vLLM) |
| `VOXTRAL_MODEL` | Model name | `voxtral-mini-transcribe-realtime-2602` (Mistral) or `voxtral-mini-latest` (vLLM) |
| `MISTRAL_API_KEY` | API key (required for Mistral protocol) | — |

### Runtime configuration

Use `/voice-config` inside Pi to interactively change the protocol, URL, model, or API key without restarting. Runtime settings override environment variables and can be reset back to defaults.

### Example: Mistral cloud API

```bash
export VOICE_PROTOCOL=mistral
export MISTRAL_API_KEY=your-api-key-here
pi
```

Or configure at runtime:

```
/voice-config
# → Select "Protocol: vllm" → choose "mistral"
# → Select "API Key: (not set)" → enter your key
```

## Commands

| Command | Description |
|---|---|
| `/voice-config` | Interactively configure protocol, URL, model, and API key |
| `/voice-check` | Verify that all dependencies (`say`, `rec`, server) are available |

## How it works

1. The agent calls the `voice_ask` tool with a question
2. The question is spoken aloud using macOS `say`
3. A WebSocket connection is opened to the transcription server
4. Your microphone audio is captured via SoX (`rec`) and streamed as base64-encoded PCM16 chunks
5. Transcription deltas are displayed in real-time
6. Say **"send reply"** to finish, press **Enter** to send immediately, or **Esc** to cancel
7. The transcribed response is returned to the agent

## Origin story

Here's the prompt used to build the original version:

> I want to write a new plugin for Pi which allows me to speak to it. There should be a tool that the agent is able to call to ask me a question. When it calls that tool, it should run text-to-speech to convert the question into audio, play it and then listen to my response and wait for a keyword (e.g. send reply) to indicate that I'm finished and send it back to the agent.

I have not reviewed the code that was produced, but I have happily used it to code while making pizza dough.
