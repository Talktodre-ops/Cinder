import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { app } from "electron";

const nodeRequire = createRequire(import.meta.url);

let cachedPath: string | null = null;
let cachedSource: "bundled" | "ffmpeg-static" | null = null;

function exeName(): string {
	return process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
}

/**
 * Look for a custom-bundled ffmpeg under resources/ffmpeg/. Layout per platform:
 *
 *   resources/ffmpeg/win/ffmpeg.exe
 *   resources/ffmpeg/mac/ffmpeg
 *   resources/ffmpeg/linux/ffmpeg
 *
 * Place a Gyan.dev (Windows), evermeet (mac), or BtbN (linux) full build in
 * the appropriate subdir to ship NVENC/QSV/AMF/HEVC/AV1/x264 with explicit
 * version control. If the file isn't present, we fall back to ffmpeg-static.
 */
function findBundledFfmpeg(): string | null {
	const platformDir =
		process.platform === "win32" ? "win" : process.platform === "darwin" ? "mac" : "linux";

	const candidates: string[] = [];
	if (app.isPackaged) {
		// extraResources lands under process.resourcesPath in the packaged build.
		candidates.push(path.join(process.resourcesPath, "ffmpeg", platformDir, exeName()));
		candidates.push(path.join(process.resourcesPath, "ffmpeg", exeName()));
	} else {
		// In dev, resources are at the project root.
		candidates.push(path.join(app.getAppPath(), "resources", "ffmpeg", platformDir, exeName()));
		candidates.push(path.join(app.getAppPath(), "resources", "ffmpeg", exeName()));
	}

	for (const candidate of candidates) {
		try {
			if (fs.statSync(candidate).isFile()) {
				return candidate;
			}
		} catch {
			// not present — try next candidate
		}
	}
	return null;
}

export function getFfmpegPath(): string {
	if (cachedPath) return cachedPath;

	const bundled = findBundledFfmpeg();
	if (bundled) {
		cachedPath = bundled;
		cachedSource = "bundled";
		console.log(`[ffmpeg] Using bundled binary: ${bundled}`);
		return bundled;
	}

	const raw = nodeRequire("ffmpeg-static") as string;
	// In packaged builds the binary lives in app.asar.unpacked — remap the path.
	const resolved = app.isPackaged ? raw.replace("app.asar", "app.asar.unpacked") : raw;
	cachedPath = resolved;
	cachedSource = "ffmpeg-static";
	console.log(`[ffmpeg] Using ffmpeg-static fallback: ${resolved}`);
	return resolved;
}

export function getFfmpegSource(): "bundled" | "ffmpeg-static" | null {
	return cachedSource;
}
