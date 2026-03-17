/**
 * Voice Extension - Speak questions and listen for spoken responses
 *
 * This extension:
 * - Registers a `voice_ask` tool for the LLM to ask the user questions via voice
 * - Uses macOS `say` for text-to-speech
 * - Uses `rec` (sox) to capture microphone audio as raw PCM16 @ 16kHz
 * - Streams audio to a Voxtral WebSocket server for real-time transcription
 * - Detects "send reply" keyword in the live transcription stream to stop listening
 * - Enter key works as a manual stop fallback
 *
 * Requirements:
 * - macOS (for `say` command)
 * - sox (`brew install sox`)
 * - A running Voxtral-compatible WebSocket server
 *
 * Environment variables:
 * - VOXTRAL_URL  - WebSocket URL (default: ws://localhost:8000/v1/realtime)
 * - VOXTRAL_MODEL - Model name to send in session.update (default: voxtral-mini-latest)
 *
 * Commands:
 * - /voice-check - Verify all dependencies are available
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Key, matchesKey, Text, truncateToWidth } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { type ChildProcess, execSync, spawn } from "node:child_process";

const TRIGGER_PHRASE = "send reply";
const AUDIO_CHUNK_SIZE = 4096; // bytes per WebSocket audio message

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

function getVoxtralUrl(): string {
	return process.env.VOXTRAL_URL || "ws://localhost:8000/v1/realtime";
}

function getVoxtralModel(): string {
	return process.env.VOXTRAL_MODEL || "voxtral-mini-latest";
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

					const url = getVoxtralUrl();
					const model = getVoxtralModel();

					try {
						ws = new WebSocket(url);
					} catch (err: any) {
						state = "error";
						errorMessage = `WebSocket creation failed: ${err.message}`;
						refresh();
						return;
					}

					ws.onopen = () => {
						if (aborted) return;

						// Configure the model
						ws!.send(JSON.stringify({ type: "session.update", model }));

						// Signal start of audio stream
						ws!.send(JSON.stringify({ type: "input_audio_buffer.commit" }));

						// Start recording: raw PCM16, 16kHz, mono, to stdout
						recProcess = spawn("rec", [
							"-q", // quiet
							"-t",
							"raw", // raw output
							"-r",
							"16000", // 16kHz
							"-e",
							"signed-integer",
							"-b",
							"16", // 16-bit
							"-c",
							"1", // mono
							"-", // stdout
						]);

						state = "listening";
						refresh();

						recProcess.stdout?.on("data", (data: Buffer) => {
							if (aborted || !ws || ws.readyState !== WebSocket.OPEN) return;

							// Stream audio in AUDIO_CHUNK_SIZE byte chunks
							for (let i = 0; i < data.length; i += AUDIO_CHUNK_SIZE) {
								const chunk = data.subarray(i, i + AUDIO_CHUNK_SIZE);
								ws.send(
									JSON.stringify({
										type: "input_audio_buffer.append",
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
							// rec stopped (killed or error) - signal end of audio
							if (ws && ws.readyState === WebSocket.OPEN) {
								ws.send(
									JSON.stringify({ type: "input_audio_buffer.commit", final: true }),
								);
							}
						});
					};

					ws.onmessage = (event) => {
						if (aborted) return;

						// Handle both string and Buffer data (Node.js WebSocket sends Buffers)
						let raw: string;
						if (typeof event.data === "string") {
							raw = event.data;
						} else if (Buffer.isBuffer(event.data)) {
							raw = event.data.toString("utf-8");
						} else if (event.data instanceof ArrayBuffer) {
							raw = new TextDecoder().decode(event.data);
						} else {
							// Blob or other - try toString
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

						lastServerMsg = `${data.type}${data.delta ? `: "${data.delta}"` : ""}`;
						refresh();

						if (data.type === "transcription.delta") {
							transcript += data.delta;
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
							errorMessage = `Voxtral error: ${data.message || JSON.stringify(data)}`;
							refresh();
						}
					};

					ws.onerror = (event) => {
						if (aborted || finished) return;
						state = "error";
						errorMessage = `WebSocket error connecting to ${url}`;
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
					add("");

					switch (state) {
						case "speaking":
							add(theme.fg("accent", " Speaking..."));
							break;
						case "connecting":
							add(theme.fg("warning", " Connecting to Voxtral..."));
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

	pi.registerCommand("voice-check", {
		description: "Check if voice dependencies (say, rec, Voxtral server) are available",
		handler: async (_args, ctx) => {
			const hasSay = checkDependency("say");
			const hasRec = checkDependency("rec");
			const voxtralUrl = getVoxtralUrl();

			const ok = (v: boolean) => (v ? "ok" : "MISSING");
			const parts = [`say=${ok(hasSay)}`, `rec=${ok(hasRec)}`, `voxtral=${voxtralUrl}`];

			ctx.ui.notify(`Voice check: ${parts.join(", ")}`, hasSay && hasRec ? "info" : "error");
		},
	});
}
