/**
 * Voice Extension - Speak questions and listen for spoken responses
 *
 * This extension:
 * - Registers a `voice_ask` tool for the LLM to ask the user questions via voice
 * - Uses macOS `say` for text-to-speech
 * - Uses `rec` (sox) to capture microphone audio as raw PCM16 @ 16kHz
 * - Streams audio to a realtime WebSocket server for transcription
 * - Supports both vLLM and Mistral protocols
 * - Detects "send reply" keyword in the live transcription stream to stop listening
 * - Enter key works as a manual stop fallback
 *
 * Requirements:
 * - macOS (for `say` command)
 * - sox (`brew install sox`)
 * - A running Voxtral-compatible WebSocket server (vLLM) or Mistral API access
 *
 * Environment variables:
 * - VOICE_PROTOCOL - "vllm" (default) or "mistral"
 * - VOXTRAL_URL - WebSocket URL (default: ws://localhost:8000/v1/realtime)
 * - VOXTRAL_MODEL - Model name (default per protocol)
 * - MISTRAL_API_KEY - API key (required for Mistral protocol)
 *
 * Commands:
 * - /voice-check - Verify all dependencies are available
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Key, matchesKey, Text, truncateToWidth } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { type ChildProcess, execSync, spawn } from "node:child_process";
import WsWebSocket from "ws";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const TRIGGER_PHRASE = "send reply";
const AUDIO_CHUNK_SIZE = 4096; // bytes per WebSocket audio message
const SAMPLE_RATE = 16000;

type Protocol = "vllm" | "mistral";

const protocolConfig = {
	vllm: {
		appendType: "input_audio_buffer.append",
		commitType: "input_audio_buffer.commit",
		deltaEvent: "transcription.delta",
		deltaField: "delta",
		defaultModel: "voxtral-mini-latest",
		defaultUrl: "ws://localhost:8000/v1/realtime",
	},
	mistral: {
		appendType: "input_audio.append",
		deltaEvent: "transcription.text.delta",
		deltaField: "text",
		defaultModel: "voxtral-mini-transcribe-realtime-2602",
		defaultUrl: "wss://api.mistral.ai",
	},
} as const;

interface VoiceDetails {
	question: string;
	answer: string | null;
	cancelled?: boolean;
}

const VoiceAskParams = Type.Object({
	question: Type.String({ description: "The question to speak aloud and wait for a voice response" }),
	voice: Type.Optional(
		Type.String({ description: 'macOS voice to use (e.g. "Samantha", "Daniel"). Defaults to system voice.' }),
	),
});

// Config file path - persists to ~/.pi-voice-config.json
const CONFIG_PATH = path.join(os.homedir(), ".pi-voice-config.json");

// Runtime config — overrides environment variables when set
let runtimeConfig: {
	protocol?: Protocol;
	url?: string;
	model?: string;
	apiKey?: string;
} = {};

/** Load saved config from JSON file */
function loadConfig(): void {
	try {
		if (fs.existsSync(CONFIG_PATH)) {
			const data = fs.readFileSync(CONFIG_PATH, "utf-8");
			const config = JSON.parse(data);
			runtimeConfig = {
				protocol: config.protocol as Protocol | undefined,
				url: config.url,
				model: config.model,
				apiKey: config.apiKey,
			};
		}
	} catch (err) {
		// Silently ignore load errors - will use environment/defaults
	}
}

/** Save current config to JSON file */
function saveConfig(): void {
	try {
		fs.writeFileSync(
			CONFIG_PATH,
			JSON.stringify(
				{
					protocol: runtimeConfig.protocol,
					url: runtimeConfig.url,
					model: runtimeConfig.model,
					apiKey: runtimeConfig.apiKey,
				},
				null,
				2,
			),
		);
	} catch (err) {
		// Silently ignore save errors
	}
}

// Load saved config on startup
loadConfig();

function getProtocol(): Protocol {
	if (runtimeConfig.protocol) return runtimeConfig.protocol;
	const p = process.env.VOICE_PROTOCOL?.toLowerCase();
	if (p === "mistral") return "mistral";
	return "vllm";
}

function getBaseUrl(protocol: Protocol): string {
	return runtimeConfig.url || process.env.VOXTRAL_URL || protocolConfig[protocol].defaultUrl;
}

function getModel(protocol: Protocol): string {
	return runtimeConfig.model || process.env.VOXTRAL_MODEL || protocolConfig[protocol].defaultModel;
}

function getApiKey(): string | undefined {
	return runtimeConfig.apiKey || process.env.MISTRAL_API_KEY;
}

function buildWsUrl(protocol: Protocol, baseUrl: string, model: string): string {
	if (protocol === "mistral") {
		const base = baseUrl.replace(/\/$/, "");
		return `${base}/v1/audio/transcriptions/realtime?model=${encodeURIComponent(model)}`;
	}
	return baseUrl;
}

function checkDependency(cmd: string): boolean {
	try {
		execSync(`which ${cmd}`, { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

function speak(text: string, voice?: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const args = voice ? ["-v", voice, text] : [text];
		const proc = spawn("say", args);
		proc.on("close", (code) => {
			if (code === 0) resolve();
			else reject(new Error(`say exited with code ${code}`));
		});
		proc.on("error", reject);
	});
}

/** Check if accumulated transcript ends with the trigger phrase */
function hasTriggerPhrase(text: string): boolean {
	return new RegExp(`\\b${TRIGGER_PHRASE}[.!?,]*\\s*$`, "i").test(text);
}

/** Strip trigger phrase from end of transcript */
function stripTriggerPhrase(text: string): string {
	return text.replace(new RegExp(`\\b${TRIGGER_PHRASE}[.!?,]*\\s*$`, "i"), "").trim();
}

function createWebSocket(protocol: Protocol, url: string): WebSocket {
	if (protocol === "mistral") {
		const apiKey = getApiKey();
		return new WsWebSocket(url, {
			headers: { Authorization: `Bearer ${apiKey}` },
		}) as unknown as WebSocket;
	}
	return new WebSocket(url);
}

function sendSessionSetup(ws: WebSocket, protocol: Protocol, model: string): void {
	if (protocol === "vllm") {
		ws.send(JSON.stringify({ type: "session.update", model }));
		ws.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
	} else {
		ws.send(JSON.stringify({
			type: "session.update",
			session: {
				audio_format: {
					encoding: "pcm_s16le",
					sample_rate: SAMPLE_RATE,
				},
			},
		}));
	}
}

function sendFinalCommit(ws: WebSocket, protocol: Protocol): void {
	if (ws.readyState !== WebSocket.OPEN) return;
	if (protocol === "vllm") {
		ws.send(JSON.stringify({ type: "input_audio_buffer.commit", final: true }));
	} else {
		ws.send(JSON.stringify({ type: "input_audio.end" }));
	}
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "voice_ask",
		label: "Voice Ask",
		description:
			'Ask the user a question using voice. The question is spoken aloud via text-to-speech, then the microphone records the user\'s spoken response with real-time transcription. The user says "send reply" when finished, or presses Enter. Returns the transcribed response.',
		promptSnippet:
			"You have a voice_ask tool available. Use it when you want to have a spoken conversation with the user. The question will be read aloud and the user's voice response will be transcribed and returned to you.",
		parameters: VoiceAskParams,

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			if (!checkDependency("say")) {
				return {
					content: [{ type: "text", text: 'Error: "say" command not found. This tool requires macOS.' }],
					details: { question: params.question, answer: null } as VoiceDetails,
				};
			}
			if (!checkDependency("rec")) {
				return {
					content: [
						{ type: "text", text: 'Error: "rec" command not found. Install sox: brew install sox' },
					],
					details: { question: params.question, answer: null } as VoiceDetails,
				};
			}
			if (!ctx.hasUI) {
				return {
					content: [{ type: "text", text: "Error: voice_ask requires interactive mode" }],
					details: { question: params.question, answer: null } as VoiceDetails,
				};
			}

			const protocol = getProtocol();
			if (protocol === "mistral" && !getApiKey()) {
				return {
					content: [{ type: "text", text: "Error: MISTRAL_API_KEY is required for Mistral protocol. Set it in your environment." }],
					details: { question: params.question, answer: null } as VoiceDetails,
				};
			}

			const result = await ctx.ui.custom<{ answer: string } | null>((tui, theme, _kb, done) => {
				let state: "speaking" | "connecting" | "listening" | "error" = "speaking";
				let transcript = "";
				let recProcess: ChildProcess | null = null;
				let ws: WebSocket | null = null;
				let errorMessage = "";
				let lastServerMsg = "";
				let cachedLines: string[] | undefined;
				let aborted = false;
				let finished = false;

				const proto = protocolConfig[protocol];
				const model = getModel(protocol);
				const sampleRate = SAMPLE_RATE;
				const baseUrl = getBaseUrl(protocol);
				const wsUrl = buildWsUrl(protocol, baseUrl, model);

				function refresh() {
					cachedLines = undefined;
					tui.requestRender();
				}

				function finish(result: { answer: string } | null) {
					if (finished) return;
					finished = true;
					cleanup();
					done(result);
				}

				function cleanup() {
					if (recProcess && !recProcess.killed) {
						recProcess.kill("SIGTERM");
						recProcess = null;
					}
					if (ws && ws.readyState <= WebSocket.OPEN) {
						ws.close();
						ws = null;
					}
				}

				if (signal) {
					signal.addEventListener("abort", () => {
						aborted = true;
						finish(null);
					});
				}

				// Step 1: Speak the question via TTS
				speak(params.question, params.voice)
					.then(() => {
						if (aborted) return;
						state = "connecting";
						refresh();
						connectAndStream();
					})
					.catch((err) => {
						state = "error";
						errorMessage = `TTS failed: ${err.message}`;
						refresh();
					});

				function connectAndStream() {
					if (aborted) return;

					try {
						ws = createWebSocket(protocol, wsUrl);
					} catch (err: any) {
						state = "error";
						errorMessage = `WebSocket creation failed: ${err.message}`;
						refresh();
						return;
					}

					ws.onopen = () => {
						if (aborted) return;
						// Wait for session.created before sending setup
					};

					ws.onmessage = (event) => {
						if (aborted) return;

						let raw: string;
						if (typeof event.data === "string") {
							raw = event.data;
						} else if (Buffer.isBuffer(event.data)) {
							raw = event.data.toString("utf-8");
						} else if (event.data instanceof ArrayBuffer) {
							raw = new TextDecoder().decode(event.data);
						} else {
							raw = String(event.data);
						}

						let data: any;
						try {
							data = JSON.parse(raw);
						} catch {
							lastServerMsg = `[parse error] ${raw.slice(0, 100)}`;
							refresh();
							return;
						}

						if (data.type === "session.created") {
							sendSessionSetup(ws!, protocol, model);
							startRecording();
							return;
						}

						lastServerMsg = `${data.type}${data[proto.deltaField] ? `: "${data[proto.deltaField]}"` : ""}`;
						refresh();

						if (data.type === proto.deltaEvent) {
							transcript += data[proto.deltaField];
							refresh();

							// Check for trigger phrase in real-time
							if (hasTriggerPhrase(transcript)) {
								const cleaned = stripTriggerPhrase(transcript);
								finish({ answer: cleaned || transcript });
							}
						} else if (data.type === "transcription.done") {
							// Server signaled transcription is complete
							if (!finished) {
								const cleaned = stripTriggerPhrase(transcript);
								finish({ answer: cleaned || transcript || "..." });
							}
						} else if (data.type === "error") {
							state = "error";
							errorMessage = `Server error: ${data.error?.message ?? data.message ?? JSON.stringify(data)}`;
							refresh();
						}
					};

					ws.onerror = () => {
						if (aborted || finished) return;
						state = "error";
						errorMessage = `WebSocket error connecting to ${wsUrl}`;
						refresh();
					};

					ws.onclose = () => {
						if (aborted || finished) return;
						// If connection closed unexpectedly and we have transcript, return it
						if (transcript.trim()) {
							const cleaned = stripTriggerPhrase(transcript);
							finish({ answer: cleaned });
						}
					};
				}

				function startRecording() {
					if (aborted || !ws) return;

					recProcess = spawn("rec", [
						"-q",
						"-t", "raw",
						"-r", String(SAMPLE_RATE),
						"-e", "signed-integer",
						"-b", "16",
						"-c", "1",
						"-",
					]);

					state = "listening";
					refresh();

					recProcess.stdout?.on("data", (data: Buffer) => {
						if (aborted || !ws || ws.readyState !== WebSocket.OPEN) return;

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

					recProcess.on("error", (err) => {
						if (aborted) return;
						state = "error";
						errorMessage = `Recording failed: ${err.message}`;
						refresh();
					});

					recProcess.on("close", () => {
						// rec stopped - signal end of audio
						if (ws && ws.readyState === WebSocket.OPEN) {
							sendFinalCommit(ws, protocol);
						}
					});
				}

				function stopAndFinish() {
					// Kill rec so it triggers the close handler which sends final commit
					if (recProcess && !recProcess.killed) {
						recProcess.kill("SIGTERM");
						recProcess = null;
					}

					// Wait briefly for any final transcription deltas, then finish
					setTimeout(() => {
						if (!finished) {
							const cleaned = stripTriggerPhrase(transcript);
							finish({ answer: cleaned || transcript || "..." });
						}
					}, 1000);
				}

				function handleInput(data: string) {
					if (matchesKey(data, Key.escape)) {
						aborted = true;
						finish(null);
						return;
					}

					if (matchesKey(data, Key.enter) && state === "listening") {
						stopAndFinish();
						return;
					}
				}

				function render(width: number): string[] {
					if (cachedLines) return cachedLines;

					const lines: string[] = [];
					const add = (s: string) => lines.push(truncateToWidth(s, width));

					add(theme.fg("accent", "-".repeat(width)));
					add(theme.fg("text", " Voice Ask"));
					add("");
					add(theme.fg("muted", ` Q: ${params.question}`));
					add(theme.fg("dim", ` [${protocol}] ${getModel(protocol)}`));
					add("");

					switch (state) {
						case "speaking":
							add(theme.fg("accent", " Speaking..."));
							break;
						case "connecting":
							add(theme.fg("warning", ` Connecting to ${protocol === "mistral" ? "Mistral" : "Voxtral"}...`));
							break;
						case "listening": {
							add(theme.fg("success", " Listening..."));
							if (lastServerMsg) {
								add(theme.fg("dim", `   [ws] ${lastServerMsg}`));
							}
							if (transcript.length > 0) {
								add("");
								add(theme.fg("muted", " Transcript:"));
								// Word-wrap the transcript
								const words = transcript.split(" ");
								let line = "   ";
								for (const word of words) {
									if (line.length + word.length + 1 > width - 2) {
										add(theme.fg("text", line));
										line = "   " + word;
									} else {
										line += (line.length > 3 ? " " : "") + word;
									}
								}
								if (line.length > 3) add(theme.fg("text", line));
							} else {
								add(theme.fg("dim", "   (no transcription yet)"));
							}
							break;
						}
						case "error":
							add(theme.fg("error", ` Error: ${errorMessage}`));
							break;
					}

					add("");
					add(
						theme.fg(
							"dim",
							` Say "${TRIGGER_PHRASE}" to finish, Enter to send now, Esc to cancel`,
						),
					);
					add(theme.fg("accent", "-".repeat(width)));

					cachedLines = lines;
					return lines;
				}

				return {
					handleInput,
					render,
					invalidate: () => {
						cachedLines = undefined;
					},
				};
			});

			if (!result) {
				return {
					content: [{ type: "text", text: "User cancelled the voice interaction" }],
					details: { question: params.question, answer: null, cancelled: true } as VoiceDetails,
				};
			}

			return {
				content: [{ type: "text", text: `User said: ${result.answer}` }],
				details: { question: params.question, answer: result.answer } as VoiceDetails,
			};
		},

		renderCall(args, theme) {
			const text = theme.fg("toolTitle", theme.bold("voice_ask ")) + theme.fg("muted", args.question);
			return new Text(text, 0, 0);
		},

		renderResult(result, _options, theme) {
			const details = result.details as VoiceDetails | undefined;
			if (!details) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "", 0, 0);
			}

			if (details.cancelled || details.answer === null) {
				return new Text(theme.fg("warning", "Cancelled"), 0, 0);
			}

			return new Text(theme.fg("success", ">> ") + theme.fg("text", details.answer), 0, 0);
		},
	});

	pi.registerCommand("voice-config", {
		description: "Configure voice extension settings (protocol, URL, model, API key)",
		handler: async (_args, ctx) => {
			const protocol = getProtocol();
			const options = [
				`Protocol: ${protocol}`,
				`URL: ${getBaseUrl(protocol)}`,
				`Model: ${getModel(protocol)}`,
				`API Key: ${getApiKey() ? "***set***" : "(not set)"}`,
				"Reset to defaults",
			];

			const action = await ctx.ui.select("Voice Config", options);
			if (!action) return;

			if (action.startsWith("Protocol:")) {
				const choices = ["vllm", "mistral"];
				const choice = await ctx.ui.select("Select protocol", choices);
				if (choice === "vllm" || choice === "mistral") {
					runtimeConfig.protocol = choice;
					// Reset URL and model so they pick up the new protocol defaults
					runtimeConfig.url = undefined;
					runtimeConfig.model = undefined;
					saveConfig();
					ctx.ui.notify(`Protocol set to ${choice}`, "info");
				}
			} else if (action.startsWith("URL:")) {
				const url = await ctx.ui.input("WebSocket URL", getBaseUrl(getProtocol()));
				if (url) {
					runtimeConfig.url = url;
					saveConfig();
					ctx.ui.notify(`URL set to ${url}`, "info");
				}
			} else if (action.startsWith("Model:")) {
				const model = await ctx.ui.input("Model name", getModel(getProtocol()));
				if (model) {
					runtimeConfig.model = model;
					saveConfig();
					ctx.ui.notify(`Model set to ${model}`, "info");
				}
			} else if (action.startsWith("API Key:")) {
				const key = await ctx.ui.input("API Key");
				if (key) {
					runtimeConfig.apiKey = key;
					saveConfig();
					ctx.ui.notify("API key updated", "info");
				}
			} else if (action === "Reset to defaults") {
				runtimeConfig.protocol = undefined;
				runtimeConfig.url = undefined;
				runtimeConfig.model = undefined;
				runtimeConfig.apiKey = undefined;
				saveConfig();
				ctx.ui.notify("Voice config reset to environment/defaults", "info");
			}
		},
	});

	pi.registerCommand("voice-check", {
		description: "Check if voice dependencies (say, rec, transcription server) are available",
		handler: async (_args, ctx) => {
			const protocol = getProtocol();
			const hasSay = checkDependency("say");
			const hasRec = checkDependency("rec");
			const baseUrl = getBaseUrl(protocol);
			const model = getModel(protocol);
			const hasKey = protocol === "mistral" ? !!getApiKey() : true;

			const ok = (v: boolean) => (v ? "ok" : "MISSING");
			const parts = [
				`protocol=${protocol}`,
				`say=${ok(hasSay)}`,
				`rec=${ok(hasRec)}`,
				`model=${model}`,
				`url=${baseUrl}`,
			];
			if (protocol === "mistral") {
				parts.push(`api-key=${ok(hasKey)}`);
			}

			const allOk = hasSay && hasRec && hasKey;
			ctx.ui.notify(`Voice check: ${parts.join(", ")}`, allOk ? "info" : "error");
		},
	});
}
