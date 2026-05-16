import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import type { Writable } from "node:stream";
import { app } from "electron";
import { getFfmpegPath } from "./ffmpeg";

export type HwEncoder = "h264_nvenc" | "h264_qsv" | "h264_amf" | "h264_videotoolbox" | "libx264";

// Priority order. videotoolbox is the only HW encoder on Mac so it sits ahead
// of the Windows ones — on a Mac the Windows entries simply won't be found in
// the ffmpeg build and we'll fall through to it.
const ENCODER_PRIORITY: HwEncoder[] = [
	"h264_nvenc",
	"h264_qsv",
	"h264_amf",
	"h264_videotoolbox",
	"libx264",
];

let cachedEncoder: HwEncoder | null = null;

/**
 * Probe ffmpeg for the first available encoder in our priority list.
 * Result is cached for the lifetime of the process.
 */
export async function probeEncoder(): Promise<HwEncoder> {
	if (cachedEncoder) return cachedEncoder;

	const proc = spawn(getFfmpegPath(), ["-hide_banner", "-encoders"], {
		stdio: ["ignore", "pipe", "pipe"],
	});

	let stdout = "";
	proc.stdout.on("data", (d: Buffer) => {
		stdout += d.toString();
	});
	proc.stderr.on("data", () => undefined);

	await once(proc, "close");

	for (const enc of ENCODER_PRIORITY) {
		// ffmpeg lists encoders as " V....D h264_nvenc            ..."
		const re = new RegExp(`^\\s*V[\\.A-Z]+\\s+${enc}\\b`, "m");
		if (re.test(stdout)) {
			cachedEncoder = enc;
			console.log(`[ffmpegEncoder] Selected encoder: ${enc}`);
			return enc;
		}
	}

	// Fallback — every ffmpeg has libx264 in our build, but be defensive.
	cachedEncoder = "libx264";
	console.warn("[ffmpegEncoder] No preferred encoder found, falling back to libx264");
	return cachedEncoder;
}

export interface StartEncodeOptions {
	width: number;
	height: number;
	frameRate: number;
	bitrate: number;
	encoder?: HwEncoder; // override; otherwise probe result is used
}

export interface StartEncodeResult {
	sessionId: string;
	encoder: HwEncoder;
	tempVideoPath: string;
	/**
	 * Localhost TCP port the renderer can connect to and stream raw RGBA frames
	 * to. Bytes received are piped straight to ffmpeg's stdin in-order. This
	 * is faster than per-frame IPC because there's no structured-clone of an
	 * 8MB ArrayBuffer across the process boundary — TCP loopback is just a
	 * kernel-side memcpy.
	 */
	transportPort: number;
}

interface Session {
	id: string;
	proc: ChildProcess;
	tempVideoPath: string;
	encoder: HwEncoder;
	stderrTail: string[];
	stdinClosed: boolean;
	exitPromise: Promise<number | null>;
	/** TCP server listening for the renderer's frame stream. Null until startEncode resolves. */
	transportServer: net.Server | null;
	/** The single accepted socket from the renderer. Null until the renderer connects. */
	transportSocket: net.Socket | null;
	/**
	 * Resolves once the renderer has closed its socket AND all buffered bytes
	 * have been piped to ffmpeg's stdin. endEncode awaits this before calling
	 * proc.stdin.end() so ffmpeg sees every frame before EOF.
	 */
	transportDrainedPromise: Promise<void> | null;
}

const sessions = new Map<string, Session>();

function buildEncoderArgs(encoder: HwEncoder, bitrate: number): string[] {
	// Bitrate in bits per second. ffmpeg accepts numeric.
	switch (encoder) {
		case "h264_nvenc":
			return [
				"-c:v",
				"h264_nvenc",
				"-preset",
				"p4",
				"-tune",
				"hq",
				"-rc",
				"vbr",
				"-cq",
				"23",
				"-b:v",
				String(bitrate),
				"-maxrate",
				String(Math.floor(bitrate * 1.5)),
			];
		case "h264_qsv":
			return [
				"-c:v",
				"h264_qsv",
				"-preset",
				"medium",
				"-global_quality",
				"23",
				"-b:v",
				String(bitrate),
			];
		case "h264_amf":
			return [
				"-c:v",
				"h264_amf",
				"-quality",
				"balanced",
				"-rc",
				"vbr_peak",
				"-b:v",
				String(bitrate),
			];
		case "h264_videotoolbox":
			// macOS hardware encoder (Apple Silicon + Intel Macs with T2/AMD).
			// `-q:v` quality-based (51 = worst, 0 = best); 50 is a sane middle.
			// `-allow_sw 1` lets ffmpeg fall back to software inside videotoolbox
			// if HW gets unhappy mid-stream rather than aborting the export.
			return [
				"-c:v",
				"h264_videotoolbox",
				"-b:v",
				String(bitrate),
				"-allow_sw",
				"1",
				"-realtime",
				"0",
				"-profile:v",
				"high",
			];
		case "libx264":
			// This path runs only when NO hardware encoder is available, so
			// the user is by definition on a CPU-bound machine. Optimize for
			// throughput, not file size:
			//   - `ultrafast` is ~2× faster than `veryfast` for ~30–40% bigger
			//     files at the same CRF. For screen recordings (mostly flat
			//     UI, low motion), the file-size hit is small in absolute
			//     terms and barely visible at CRF 23.
			//   - `tune zerolatency` disables B-frames + lookahead, which
			//     are the slowest parts of x264 and add minimal quality for
			//     this content type.
			//   - `threads 0` auto-fans across cores.
			return [
				"-c:v",
				"libx264",
				"-preset",
				"ultrafast",
				"-tune",
				"zerolatency",
				"-crf",
				"23",
				"-b:v",
				String(bitrate),
				"-threads",
				"0",
			];
	}
}

/**
 * Spawn an ffmpeg process that reads raw RGBA frames on stdin and writes an
 * H.264 mp4 (video only) to a temp file. The returned sessionId is used by
 * writeFrame / endEncode / cancelEncode.
 */
export async function startEncode(opts: StartEncodeOptions): Promise<StartEncodeResult> {
	const encoder = opts.encoder ?? (await probeEncoder());
	const sessionId = `enc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
	const tempVideoPath = path.join(os.tmpdir(), `cinder-${sessionId}.mp4`);

	const args = [
		"-hide_banner",
		"-loglevel",
		"error",
		"-f",
		"rawvideo",
		"-pix_fmt",
		"rgba",
		"-s",
		`${opts.width}x${opts.height}`,
		"-r",
		String(opts.frameRate),
		"-i",
		"pipe:0",
		...buildEncoderArgs(encoder, opts.bitrate),
		"-pix_fmt",
		"yuv420p",
		"-movflags",
		"+faststart",
		"-y",
		tempVideoPath,
	];

	const proc = spawn(getFfmpegPath(), args, {
		stdio: ["pipe", "ignore", "pipe"],
	});

	const stderrTail: string[] = [];
	proc.stderr.on("data", (d: Buffer) => {
		const text = d.toString();
		stderrTail.push(text);
		// Keep only the last ~8KB of stderr to avoid unbounded growth.
		while (stderrTail.join("").length > 8192) stderrTail.shift();
	});

	const exitPromise = new Promise<number | null>((resolve) => {
		proc.once("exit", (code) => resolve(code));
	});

	const session: Session = {
		id: sessionId,
		proc,
		tempVideoPath,
		encoder,
		stderrTail,
		stdinClosed: false,
		exitPromise,
		transportServer: null,
		transportSocket: null,
		transportDrainedPromise: null,
	};
	sessions.set(sessionId, session);

	// If ffmpeg dies before we finish, surface it.
	proc.on("error", (err) => {
		console.error(`[ffmpegEncoder] Process error for ${sessionId}:`, err);
	});

	// Stand up a localhost TCP server. Bind to 127.0.0.1 (not 0.0.0.0) so the
	// port is unreachable from the network. Port 0 = let the OS pick a free
	// port; we return it to the renderer so it can connect exactly one socket.
	const transportServer = net.createServer((socket) => {
		// Accept only one connection per session. If a second one shows up
		// (e.g. an export retry that didn't tear down properly), reject it.
		if (session.transportSocket) {
			socket.destroy();
			return;
		}
		session.transportSocket = socket;

		// Pipe the socket's bytes straight to ffmpeg's stdin. {end: false}
		// keeps stdin open after the socket closes so endEncode can still
		// signal EOF explicitly via stdin.end().
		if (proc.stdin && !proc.stdin.destroyed) {
			socket.pipe(proc.stdin, { end: false });
		}

		// Track when the renderer has fully drained its side. We resolve on
		// 'end' (clean half-close from the renderer) OR 'close' (any teardown).
		session.transportDrainedPromise = new Promise<void>((resolve) => {
			let done = false;
			const finish = () => {
				if (done) return;
				done = true;
				resolve();
			};
			socket.on("end", finish);
			socket.on("close", finish);
			socket.on("error", (err) => {
				console.warn(`[ffmpegEncoder] transport socket error for ${sessionId}:`, err);
				finish();
			});
		});
	});

	await new Promise<void>((resolve, reject) => {
		transportServer.once("error", reject);
		transportServer.listen(0, "127.0.0.1", () => {
			transportServer.removeListener("error", reject);
			resolve();
		});
	});

	const addr = transportServer.address();
	const transportPort = addr && typeof addr === "object" ? addr.port : 0;
	if (!transportPort) {
		transportServer.close();
		throw new Error("Failed to bind localhost transport server");
	}
	session.transportServer = transportServer;

	return { sessionId, encoder, tempVideoPath, transportPort };
}

/**
 * Expose the raw stdin Writable for a session so a transport (e.g. MessagePort
 * relay) can stream bytes directly without an ipc round trip per frame.
 */
export function getSessionStdin(sessionId: string): Writable | null {
	const session = sessions.get(sessionId);
	if (!session) return null;
	const stdin = session.proc.stdin;
	if (!stdin || stdin.destroyed || session.stdinClosed) return null;
	return stdin;
}

/**
 * Write one frame's worth of RGBA bytes to ffmpeg stdin. Resolves once the
 * data has been flushed to the pipe (handles backpressure naturally).
 */
export async function writeFrame(sessionId: string, frame: Buffer): Promise<void> {
	const session = sessions.get(sessionId);
	if (!session) throw new Error(`Unknown session: ${sessionId}`);
	if (session.stdinClosed) throw new Error(`Session ${sessionId} stdin already closed`);

	const stdin = session.proc.stdin;
	if (!stdin || stdin.destroyed) {
		throw new Error(
			`ffmpeg stdin unavailable. stderr tail: ${session.stderrTail.join("").slice(-800)}`,
		);
	}

	const ok = stdin.write(frame);
	if (!ok) {
		await once(stdin, "drain");
	}
}

/**
 * Close ffmpeg's stdin and wait for the encode to finish. Returns the path
 * to the temp video file. Caller is responsible for muxing / deleting.
 */
export async function endEncode(sessionId: string): Promise<string> {
	const session = sessions.get(sessionId);
	if (!session) throw new Error(`Unknown session: ${sessionId}`);

	// If the renderer used the TCP transport, wait for every queued byte to
	// pipe into ffmpeg's stdin before we signal EOF. Without this wait, the
	// last frames buffered in the socket get dropped and the output mp4 ends
	// short (or has a missing video stream entirely).
	if (session.transportDrainedPromise) {
		try {
			await session.transportDrainedPromise;
		} catch (err) {
			console.warn(`[ffmpegEncoder] transport drain error for ${sessionId}:`, err);
		}
	}

	if (session.transportServer) {
		session.transportServer.close();
	}

	if (!session.stdinClosed && session.proc.stdin && !session.proc.stdin.destroyed) {
		session.proc.stdin.end();
		session.stdinClosed = true;
	}

	const exitCode = await session.exitPromise;
	sessions.delete(sessionId);

	if (exitCode !== 0) {
		const tail = session.stderrTail.join("").slice(-1200);
		throw new Error(`ffmpeg exited with code ${exitCode}. stderr: ${tail}`);
	}

	return session.tempVideoPath;
}

/**
 * Kill an in-progress encode and delete its temp file.
 */
export async function cancelEncode(sessionId: string): Promise<void> {
	const session = sessions.get(sessionId);
	if (!session) return;

	if (session.transportSocket && !session.transportSocket.destroyed) {
		session.transportSocket.destroy();
	}
	if (session.transportServer) {
		session.transportServer.close();
	}

	try {
		session.proc.kill("SIGKILL");
	} catch {
		// already dead
	}
	sessions.delete(sessionId);
	await fs.unlink(session.tempVideoPath).catch(() => undefined);
}

/**
 * Final mux: combine the temp video file with an audio file into the final mp4.
 * Audio is re-encoded to AAC (mp4 doesn't support opus widely).
 */
export async function muxAudioVideo(
	videoPath: string,
	audioPath: string | null,
	outputPath: string,
): Promise<void> {
	const args = ["-hide_banner", "-loglevel", "error", "-y", "-i", videoPath];

	// Explicit -map so a missing video stream errors loudly instead of being
	// silently dropped — ffmpeg's default stream selection will happily pick
	// just the audio if the video input has no video track, producing an
	// audio-only "video" file.
	if (audioPath) {
		args.push(
			"-i",
			audioPath,
			"-map",
			"0:v:0",
			"-map",
			"1:a:0",
			"-c:v",
			"copy",
			"-c:a",
			"aac",
			"-b:a",
			"192k",
			"-shortest",
		);
	} else {
		args.push("-map", "0:v:0", "-c:v", "copy", "-an");
	}

	args.push("-movflags", "+faststart", outputPath);

	const proc = spawn(getFfmpegPath(), args, { stdio: ["ignore", "ignore", "pipe"] });
	let stderr = "";
	proc.stderr.on("data", (d: Buffer) => {
		stderr += d.toString();
		if (stderr.length > 8192) stderr = stderr.slice(-8192);
	});

	const [code] = (await once(proc, "close")) as [number | null];
	if (code !== 0) {
		throw new Error(`ffmpeg mux failed with code ${code}. stderr: ${stderr.slice(-1200)}`);
	}
}

/**
 * Best-effort cleanup of any leftover sessions on app quit.
 */
app.on("will-quit", () => {
	for (const session of sessions.values()) {
		try {
			session.transportSocket?.destroy();
			session.transportServer?.close();
			session.proc.kill("SIGKILL");
		} catch {
			// ignore
		}
		void fs.unlink(session.tempVideoPath).catch(() => undefined);
	}
	sessions.clear();
});
