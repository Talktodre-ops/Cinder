import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ipcMain } from "electron";
import { getFfmpegPath } from "../ffmpeg";

interface TrimRegion {
	startMs: number;
	endMs: number;
}

interface SpeedRegion {
	startMs: number;
	endMs: number;
	speed: number;
}

interface AudioProcessParams {
	videoPath: string;
	trimRegions: TrimRegion[];
	speedRegions: SpeedRegion[];
	durationMs: number;
}

export function registerFfmpegHandlers(): void {
	ipcMain.handle("ffmpeg:process-audio", async (_event, params: AudioProcessParams) => {
		const { videoPath, trimRegions, speedRegions, durationMs } = params;

		const sourcePath = videoPath.startsWith("file://") ? fileURLToPath(videoPath) : videoPath;

		const tempOutput = path.join(os.tmpdir(), `cinder-audio-${Date.now()}.webm`);

		try {
			const filterGraph = buildAudioFilterGraph(trimRegions, speedRegions, durationMs);

			const args: string[] = ["-i", sourcePath, "-vn"];

			if (filterGraph) {
				args.push("-filter_complex", filterGraph, "-map", "[outa]");
			} else {
				args.push("-map", "0:a");
			}

			args.push("-c:a", "libopus", "-b:a", "128k", "-f", "webm", "-y", tempOutput);

			await runFfmpeg(getFfmpegPath(), args);

			const data = await fs.readFile(tempOutput);
			// Slice to own the buffer — Node Buffers may share a pool with an offset.
			return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
		} finally {
			fs.unlink(tempOutput).catch(() => undefined);
		}
	});
}

// ---------------------------------------------------------------------------
// Filter graph construction
// ---------------------------------------------------------------------------

function buildKeepSegments(
	trimRegions: TrimRegion[],
	speedRegions: SpeedRegion[],
	durationMs: number,
): Array<{ startMs: number; endMs: number; speed: number }> {
	// Compute non-trimmed intervals
	const sortedTrims = [...trimRegions].sort((a, b) => a.startMs - b.startMs);
	const keepIntervals: Array<{ startMs: number; endMs: number }> = [];
	let cursor = 0;

	for (const trim of sortedTrims) {
		if (cursor < trim.startMs) {
			keepIntervals.push({ startMs: cursor, endMs: trim.startMs });
		}
		cursor = Math.max(cursor, trim.endMs);
	}
	if (cursor < durationMs) {
		keepIntervals.push({ startMs: cursor, endMs: durationMs });
	}

	// Split each keep interval by speed region boundaries
	const segments: Array<{ startMs: number; endMs: number; speed: number }> = [];

	for (const interval of keepIntervals) {
		const boundaries = new Set<number>([interval.startMs, interval.endMs]);

		for (const sr of speedRegions) {
			if (sr.startMs > interval.startMs && sr.startMs < interval.endMs) {
				boundaries.add(sr.startMs);
			}
			if (sr.endMs > interval.startMs && sr.endMs < interval.endMs) {
				boundaries.add(sr.endMs);
			}
		}

		const sorted = [...boundaries].sort((a, b) => a - b);

		for (let i = 0; i < sorted.length - 1; i++) {
			const start = sorted[i];
			const end = sorted[i + 1];
			const mid = (start + end) / 2;
			const active = speedRegions.find((sr) => mid >= sr.startMs && mid < sr.endMs);
			segments.push({ startMs: start, endMs: end, speed: active ? active.speed : 1 });
		}
	}

	return segments;
}

function buildAtempoChain(speed: number): string {
	if (Math.abs(speed - 1) < 0.0001) return "anull";

	const parts: string[] = [];
	let remaining = speed;

	// Chain 0.5x filters for very slow speeds (atempo minimum is 0.5)
	while (remaining < 0.5 - 0.0001) {
		parts.push("atempo=0.5");
		remaining /= 0.5;
	}

	// Chain 100x filters for extreme fast speeds (atempo maximum is 100)
	while (remaining > 100 + 0.0001) {
		parts.push("atempo=100");
		remaining /= 100;
	}

	if (Math.abs(remaining - 1) > 0.0001) {
		parts.push(`atempo=${remaining.toFixed(6)}`);
	}

	return parts.join(",") || "anull";
}

function buildAudioFilterGraph(
	trimRegions: TrimRegion[],
	speedRegions: SpeedRegion[],
	durationMs: number,
): string | null {
	const segments = buildKeepSegments(trimRegions, speedRegions, durationMs);

	if (segments.length === 0) return null;

	// Single segment covering full duration with no speed change — no filter needed
	if (
		segments.length === 1 &&
		segments[0].startMs === 0 &&
		segments[0].endMs >= durationMs &&
		Math.abs(segments[0].speed - 1) < 0.0001
	) {
		return null;
	}

	if (segments.length === 1) {
		const { startMs, endMs, speed } = segments[0];
		const startS = (startMs / 1000).toFixed(6);
		const endS = (endMs / 1000).toFixed(6);
		return `[0:a]atrim=start=${startS}:end=${endS},asetpts=PTS-STARTPTS,${buildAtempoChain(speed)}[outa]`;
	}

	// Multiple segments: split input stream, process each, then concatenate
	const n = segments.length;
	const splitLabels = segments.map((_, i) => `[split${i}]`).join("");
	const parts: string[] = [`[0:a]asplit=${n}${splitLabels}`];
	const segLabels: string[] = [];

	for (let i = 0; i < segments.length; i++) {
		const { startMs, endMs, speed } = segments[i];
		const startS = (startMs / 1000).toFixed(6);
		const endS = (endMs / 1000).toFixed(6);
		const label = `[s${i}]`;
		segLabels.push(label);
		parts.push(
			`[split${i}]atrim=start=${startS}:end=${endS},asetpts=PTS-STARTPTS,${buildAtempoChain(speed)}${label}`,
		);
	}

	parts.push(`${segLabels.join("")}concat=n=${n}:v=0:a=1[outa]`);
	return parts.join(";");
}

// ---------------------------------------------------------------------------
// FFmpeg process runner
// ---------------------------------------------------------------------------

async function runFfmpeg(ffmpegPath: string, args: string[]): Promise<void> {
	return new Promise((resolve, reject) => {
		const proc = spawn(ffmpegPath, args, { stdio: ["ignore", "pipe", "pipe"] });
		let stderr = "";

		proc.stderr?.on("data", (d: Buffer) => {
			stderr += d.toString();
		});

		proc.on("close", (code) => {
			if (code === 0) {
				resolve();
			} else {
				reject(new Error(`FFmpeg exited with code ${code}: ${stderr.slice(-800)}`));
			}
		});

		proc.on("error", (err) => {
			reject(new Error(`Failed to spawn FFmpeg: ${err.message}`));
		});
	});
}
