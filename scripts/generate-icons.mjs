/**
 * Generate all platform icons from public/cinder_logo.webp.
 *
 * Outputs:
 *   icons/icons/png/{16,24,32,48,64,128,256,512,1024}x{...}.png
 *   icons/icons/win/icon.ico   (multi-resolution: 16/24/32/48/64/128/256)
 *   public/cinder.png          (tray icon — 256×256)
 *
 * macOS .icns is intentionally NOT regenerated here — Mac build is disabled
 * until Apple Developer signing is configured. The existing icon.icns can
 * stay as a placeholder; replace it once we revive the Mac job.
 *
 * Run: `node scripts/generate-icons.mjs`
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pngToIco from "png-to-ico";
import sharp from "sharp";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const SOURCE = join(ROOT, "public", "cinder_logo.webp");
const PNG_OUT_DIR = join(ROOT, "icons", "icons", "png");
const ICO_OUT = join(ROOT, "icons", "icons", "win", "icon.ico");
const TRAY_OUT = join(ROOT, "public", "cinder.png");

const PNG_SIZES = [16, 24, 32, 48, 64, 128, 256, 512, 1024];
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];

async function main() {
	console.log(`[icons] Reading source: ${SOURCE}`);
	const meta = await sharp(SOURCE).metadata();
	console.log(`[icons] Source: ${meta.width}×${meta.height} (${meta.format})`);

	// The source is wide (16:9 ish) with the flame centered. Crop a
	// centered square so the flame fills the icon without distortion.
	const side = Math.min(meta.width ?? 0, meta.height ?? 0);
	if (side <= 0) throw new Error("Could not read source dimensions");

	const left = Math.round(((meta.width ?? side) - side) / 2);
	const top = Math.round(((meta.height ?? side) - side) / 2);
	const square = sharp(SOURCE).extract({ left, top, width: side, height: side });

	await mkdir(PNG_OUT_DIR, { recursive: true });

	// Resize once per target size from the cropped square — sharp's resize
	// uses Lanczos3 by default, which is the right choice for downscaling
	// a high-detail source like this.
	const pngBuffers = new Map();
	for (const size of PNG_SIZES) {
		const buf = await square.clone().resize(size, size, { fit: "cover" }).png().toBuffer();
		pngBuffers.set(size, buf);
		const out = join(PNG_OUT_DIR, `${size}x${size}.png`);
		await writeFile(out, buf);
		console.log(`[icons] wrote ${out} (${(buf.length / 1024).toFixed(1)}KB)`);
	}

	// Tray icon — 256×256 is plenty (Electron downscales as needed for
	// macOS menu bar / Windows system tray).
	await writeFile(TRAY_OUT, pngBuffers.get(256));
	console.log(`[icons] wrote ${TRAY_OUT}`);

	// Multi-resolution ICO. png-to-ico reads PNG buffers and packs them
	// into a single .ico — Windows picks the right size at display time.
	const icoBuf = await pngToIco(ICO_SIZES.map((s) => pngBuffers.get(s)));
	await writeFile(ICO_OUT, icoBuf);
	console.log(`[icons] wrote ${ICO_OUT} (${(icoBuf.length / 1024).toFixed(1)}KB)`);

	console.log("[icons] done");
}

main().catch((err) => {
	console.error("[icons] failed:", err);
	process.exit(1);
});
