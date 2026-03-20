/**
 * Realtime microphone transcription via WebSocket.
 *
 * Captures audio from the default microphone using SoX (`rec`) and streams it
 * to a realtime transcription server. Supports both vLLM and Mistral protocols.
 *
 * Usage:
 *   npx tsx realtime_microphone.ts [options]
 *
 * Examples:
 *   # vLLM (default protocol)
 *   npx tsx realtime_microphone.ts --base-url ws://localhost:8005/v1/realtime
 *
 *   # Mistral
 *   npx tsx realtime_microphone.ts --protocol mistral --base-url wss://api.mistral.ai --api-key $MISTRAL_API_KEY
 *
 * Environment variables:
 *   VOXTRAL_URL    - WebSocket URL (default: ws://localhost:8000/v1/realtime)
 *   VOXTRAL_MODEL  - Model name (default: voxtral-mini-latest for vLLM)
 *   MISTRAL_API_KEY - API key for Mistral protocol
 *
 * Requirements:
 *   - SoX (`brew install sox` on macOS, `apt install sox` on Linux)
 */
import { spawn, execSync, type ChildProcess } from "node:child_process";
import yargs from "yargs/yargs";
import { hideBin } from "yargs/helpers";
import WsWebSocket from "ws";

const AUDIO_CHUNK_SIZE = 4096;

type Protocol = "vllm" | "mistral";

type Args = {
  model: string;
  sampleRate: number;
  baseUrl: string;
  protocol: Protocol;
  apiKey?: string;
};

// Protocol-specific message types and field names
const protocols = {
  vllm: {
    appendType: "input_audio_buffer.append",
    commitType: "input_audio_buffer.commit",
    deltaEvent: "transcription.delta",
    deltaField: "delta",
  },
  mistral: {
    appendType: "input_audio.append",
    flushType: "input_audio.flush",
    endType: "input_audio.end",
    deltaEvent: "transcription.text.delta",
    deltaField: "text",
  },
} as const;

function parseArgs(): Args {
  const argv = yargs(hideBin(process.argv))
    .usage("Usage: $0 [options]")
    .option("protocol", {
      type: "string",
      choices: ["vllm", "mistral"] as const,
      default: "vllm" as Protocol,
      describe: "Server protocol",
    })
    .option("model", {
      type: "string",
      default: process.env["VOXTRAL_MODEL"],
      describe: "Model ID (defaults per protocol: vllm=voxtral-mini-latest, mistral=voxtral-mini-transcribe-realtime-2602)",
    })
    .option("sample-rate", {
      type: "number",
      default: 16000,
      describe: "Sample rate in Hz",
    })
    .option("base-url", {
      type: "string",
      default:
        process.env["VOXTRAL_URL"] ?? "ws://localhost:8000/v1/realtime",
      describe: "WebSocket URL for the realtime endpoint",
    })
    .option("api-key", {
      type: "string",
      default: process.env["MISTRAL_API_KEY"],
      describe: "API key (required for Mistral protocol)",
    })
    .help()
    .parseSync();

  const protocol = argv.protocol;
  const defaultModel = protocol === "mistral"
    ? "voxtral-mini-transcribe-realtime-2602"
    : "voxtral-mini-latest";

  return {
    protocol,
    model: argv.model ?? defaultModel,
    sampleRate: argv.sampleRate,
    baseUrl: argv.baseUrl,
    apiKey: argv.apiKey,
  };
}

function printDefaultAudioInput(): void {
  try {
    const profiler = execSync("system_profiler SPAudioDataType -json", {
      encoding: "utf-8",
    });
    const devices = JSON.parse(profiler).SPAudioDataType?.[0]?._items ?? [];
    const defaultInput = devices.find(
      (d: Record<string, string>) =>
        d["coreaudio_default_audio_input_device"] === "spaudio_yes",
    );
    if (defaultInput) {
      console.log(`Audio input device: ${defaultInput["_name"]}`);
    }
  } catch {
    // ignore - non-critical
  }
}

function startRecording(sampleRate: number): ChildProcess {
  const recorder = spawn(
    "rec",
    [
      "-q",
      "-t", "raw",
      "-b", "16",
      "-e", "signed-integer",
      "-r", String(sampleRate),
      "-c", "1",
      "-",
    ],
    { stdio: ["ignore", "pipe", "ignore"] },
  );

  recorder.on("error", (err) => {
    const error = err as NodeJS.ErrnoException;
    if (error.code === "ENOENT") {
      console.error(
        "\nError: 'rec' not found. Install SoX: brew install sox (macOS) or apt install sox (Linux)",
      );
      process.exit(1);
    }
    throw err;
  });

  return recorder;
}

function buildWsUrl(args: Args): string {
  if (args.protocol === "mistral") {
    // Mistral encodes model in the URL path
    const base = args.baseUrl.replace(/\/$/, "");
    return `${base}/v1/audio/transcriptions/realtime?model=${encodeURIComponent(args.model)}`;
  }
  return args.baseUrl;
}

async function main(): Promise<void> {
  const args = parseArgs();

  if (args.protocol === "mistral" && !args.apiKey) {
    console.error(
      "Missing API key. Set MISTRAL_API_KEY or pass --api-key.",
    );
    process.exit(1);
  }

  printDefaultAudioInput();

  const wsUrl = buildWsUrl(args);
  console.log(`Connecting to ${wsUrl} (${args.protocol} protocol)`);

  // Use ws package for Mistral (needs auth headers), built-in WebSocket for vLLM
  const ws: WebSocket = args.protocol === "mistral"
    ? new WsWebSocket(wsUrl, {
        headers: { Authorization: `Bearer ${args.apiKey}` },
      }) as unknown as WebSocket
    : new WebSocket(wsUrl);

  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error("WebSocket connection failed"));
  });

  const proto = protocols[args.protocol];

  // Handle initial session setup
  await new Promise<void>((resolve) => {
    ws.onmessage = (event: MessageEvent) => {
      const raw = typeof event.data === "string" ? event.data : String(event.data);
      const data = JSON.parse(raw);
      if (data.type === "session.created") {
        if (args.protocol === "vllm") {
          ws.send(JSON.stringify({ type: "session.update", model: args.model }));
          ws.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
        } else {
          ws.send(JSON.stringify({
            type: "session.update",
            session: {
              audio_format: {
                encoding: "pcm_s16le",
                sample_rate: args.sampleRate,
              },
            },
          }));
        }
        resolve();
      }
    };
  });

  // Start recording
  const recorder = startRecording(args.sampleRate);
  if (!recorder.stdout) {
    console.error("Failed to create audio capture stream");
    process.exit(1);
  }

  console.log("Listening... (Ctrl+C to stop)\n");

  // Stream audio chunks to WebSocket
  recorder.stdout.on("data", (data: Buffer) => {
    if (ws.readyState !== WebSocket.OPEN) return;
    for (let i = 0; i < data.length; i += AUDIO_CHUNK_SIZE) {
      const chunk = data.subarray(i, i + AUDIO_CHUNK_SIZE);
      ws.send(
        JSON.stringify({
          type: proto.appendType,
          audio: Buffer.from(chunk).toString("base64"),
        }),
      );
    }
  });

  // Handle transcription events
  ws.onmessage = (event: MessageEvent) => {
    const raw = typeof event.data === "string" ? event.data : String(event.data);
    const data = JSON.parse(raw);

    if (data.type === proto.deltaEvent) {
      process.stdout.write(data[proto.deltaField]);
    } else if (data.type === "transcription.done") {
      process.stdout.write("\n");
    } else if (data.type === "error") {
      const msg = data.error?.message ?? data.error ?? JSON.stringify(data);
      console.error(`\nTranscription error: ${msg}`);
      process.exitCode = 1;
    }
  };

  ws.onerror = () => {
    console.error("\nWebSocket error");
    process.exitCode = 1;
  };

  process.on("SIGINT", () => {
    process.stdout.write("\x1b[2K\r");
    if (!recorder.killed) recorder.kill("SIGTERM");
    if (ws.readyState === WebSocket.OPEN) {
      if (args.protocol === "vllm") {
        ws.send(
          JSON.stringify({ type: "input_audio_buffer.commit", final: true }),
        );
      } else {
        ws.send(JSON.stringify({ type: "input_audio.end" }));
      }
      ws.close();
    }
    console.log("\nStopped.");
    process.exit(0);
  });
}

await main();
