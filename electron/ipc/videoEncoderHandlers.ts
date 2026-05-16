import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ipcMain } from "electron";
import {
	cancelEncode,
	endEncode,
	muxAudioVideo,
	probeEncoder,
	type StartEncodeOptions,
	startEncode,
	writeFrame,
} from "../ffmpegEncoder";

// ── Ordered parallel write queue ───────────────────────────────────────────
// The renderer pipelines multiple writeFrame IPCs in parallel to keep IPC
// throughput up (sequential 8MB IPC stalls halved export FPS). Each call
// includes its frame index; we buffer arrivals here and drain into ffmpeg's
// stdin strictly in order. Each IPC resolves only once *its* frame is on the
// pipe, which preserves end-to-end backpressure.
interface SessionWriteQueue {
	expected: number;
	buffered: Map<
		number,
		{
			buf: Buffer;
			resolve: () => void;
			reject: (err: Error) => void;
		}
	>;
	draining: boolean;
	broken: Error | null;
}

const writeQueues = new Map<string, SessionWriteQueue>();

async function pumpWriteQueue(sessionId: string, q: SessionWriteQueue): Promise<void> {
	if (q.draining || q.broken) return;
	q.draining = true;
	try {
		while (q.buffered.has(q.expected) && !q.broken) {
			const entry = q.buffered.get(q.expected)!;
			q.buffered.delete(q.expected);
			q.expected++;
			try {
				await writeFrame(sessionId, entry.buf);
				entry.resolve();
			} catch (err) {
				const wrapped = err instanceof Error ? err : new Error(String(err));
				q.broken = wrapped;
				entry.reject(wrapped);
				// Fail every other buffered frame so their renderer-side
				// promises don't hang forever.
				for (const [, e] of q.buffered) {
					e.reject(wrapped);
				}
				q.buffered.clear();
				break;
			}
		}
	} finally {
		q.draining = false;
	}
}

function clearWriteQueue(sessionId: string, err?: Error): void {
	const q = writeQueues.get(sessionId);
	if (!q) return;
	const wrapped = err ?? new Error("session ended");
	for (const [, e] of q.buffered) {
		e.reject(wrapped);
	}
	q.buffered.clear();
	writeQueues.delete(sessionId);
}

export function registerVideoEncoderHandlers(): void {
	ipcMain.handle("videoEncoder:probe", async () => {
		try {
			const encoder = await probeEncoder();
			return { success: true, encoder };
		} catch (error) {
			return { success: false, error: String(error) };
		}
	});

	ipcMain.handle("videoEncoder:start", async (_event, opts: StartEncodeOptions) => {
		try {
			const result = await startEncode(opts);
			return { success: true, ...result };
		} catch (error) {
			console.error("[videoEncoder] start failed:", error);
			return { success: false, error: String(error) };
		}
	});

	// Hot path: one call per frame. The renderer pipelines several of these
	// concurrently and tags each with a monotonic frameIndex; we buffer
	// out-of-order arrivals and drain into ffmpeg's stdin strictly in order
	// via pumpWriteQueue. When frameIndex is omitted we fall back to the
	// legacy sequential write so older callers still work.
	ipcMain.handle(
		"videoEncoder:writeFrame",
		async (_event, sessionId: string, frame: ArrayBuffer, frameIndex?: number) => {
			try {
				if (typeof frameIndex !== "number") {
					await writeFrame(sessionId, Buffer.from(frame));
					return { success: true };
				}

				let q = writeQueues.get(sessionId);
				if (!q) {
					q = { expected: 0, buffered: new Map(), draining: false, broken: null };
					writeQueues.set(sessionId, q);
				}
				if (q.broken) {
					return { success: false, error: q.broken.message };
				}

				return new Promise<{ success: boolean; error?: string }>((resolve) => {
					q.buffered.set(frameIndex, {
						buf: Buffer.from(frame),
						resolve: () => resolve({ success: true }),
						reject: (err) => resolve({ success: false, error: err.message }),
					});
					void pumpWriteQueue(sessionId, q);
				});
			} catch (error) {
				return { success: false, error: String(error) };
			}
		},
	);

	ipcMain.handle("videoEncoder:end", async (_event, sessionId: string) => {
		try {
			clearWriteQueue(sessionId);
			const tempVideoPath = await endEncode(sessionId);
			// Sanity check: NVENC/libx264 will happily exit 0 even when given
			// zero useful input bytes. Surface that here instead of letting the
			// downstream mux fail with a cryptic "Stream map matches no streams".
			try {
				const stat = await fs.stat(tempVideoPath);
				console.log(`[videoEncoder] encoder finished: ${tempVideoPath} (${stat.size}B)`);
				if (stat.size < 1024) {
					throw new Error(
						`Encoder produced an empty file (${stat.size}B). Frames were not delivered to ffmpeg — check renderer transport logs.`,
					);
				}
			} catch (statErr) {
				if (statErr instanceof Error && statErr.message.startsWith("Encoder produced")) {
					return { success: false, error: statErr.message };
				}
				console.warn("[videoEncoder] failed to stat encoded file:", statErr);
			}
			return { success: true, tempVideoPath };
		} catch (error) {
			console.error("[videoEncoder] end failed:", error);
			return { success: false, error: String(error) };
		}
	});

	ipcMain.handle("videoEncoder:cancel", async (_event, sessionId: string) => {
		try {
			clearWriteQueue(sessionId, new Error("session cancelled"));
			await cancelEncode(sessionId);
			return { success: true };
		} catch (error) {
			return { success: false, error: String(error) };
		}
	});

	ipcMain.handle(
		"videoEncoder:mux",
		async (
			_event,
			params: {
				videoPath: string;
				audioPath?: string | null;
				audioBytes?: ArrayBuffer | null;
				outputPath: string;
			},
		) => {
			let tempAudioPath: string | null = null;
			let muxSucceeded = false;
			try {
				let audioPath = params.audioPath ?? null;
				if (!audioPath && params.audioBytes && params.audioBytes.byteLength > 0) {
					tempAudioPath = path.join(os.tmpdir(), `cinder-audio-${Date.now()}.webm`);
					await fs.writeFile(tempAudioPath, Buffer.from(params.audioBytes));
					audioPath = tempAudioPath;
				}
				try {
					const videoStat = await fs.stat(params.videoPath);
					console.log(`[videoEncoder] mux input video: ${params.videoPath} (${videoStat.size}B)`);
				} catch {
					// stat errors handled by ffmpeg below
				}
				await muxAudioVideo(params.videoPath, audioPath, params.outputPath);
				muxSucceeded = true;
				return { success: true };
			} catch (error) {
				console.error("[videoEncoder] mux failed:", error);
				return {
					success: false,
					error: `${String(error)} (preserved video at: ${params.videoPath})`,
				};
			} finally {
				if (tempAudioPath) {
					await fs.unlink(tempAudioPath).catch(() => undefined);
				}
				// Only clean up the temp video on success. On failure we leave it
				// on disk so we can inspect what the encoder actually produced.
				if (muxSucceeded) {
					await fs.unlink(params.videoPath).catch(() => undefined);
				}
			}
		},
	);

	// Read the final muxed file back to the renderer as bytes (so the existing
	// "save exported video" flow can prompt for a path and write it).
	ipcMain.handle("videoEncoder:readAndDelete", async (_event, filePath: string) => {
		try {
			const data = await fs.readFile(filePath);
			await fs.unlink(filePath).catch(() => undefined);
			return {
				success: true,
				data: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
			};
		} catch (error) {
			return { success: false, error: String(error) };
		}
	});
}
