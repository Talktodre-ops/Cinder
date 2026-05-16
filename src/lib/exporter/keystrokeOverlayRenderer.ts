import type { KeystrokeEvent } from "@/lib/keystrokeTelemetry";

export interface KeystrokeOverlayOptions {
	/**
	 * Layout area the overlay sits inside. Usually the canvas dimensions
	 * (post-zoom). The overlay positions itself bottom-center within these.
	 */
	canvasWidth: number;
	canvasHeight: number;
	/**
	 * Scale factor applied to keycap typography and padding. Pass the same
	 * value the cursor highlight uses so sizes feel proportional.
	 */
	scaleFactor: number;
	/**
	 * Current playback time in milliseconds; keys older than `windowMs` are
	 * dropped, keys within the last `fadeMs` interpolate alpha down.
	 */
	currentTimeMs: number;
}

const DEFAULT_WINDOW_MS = 2400;
const DEFAULT_FADE_MS = 600;
const MAX_VISIBLE_KEYS = 6;

const KEYCAP_BG = "rgba(20, 20, 24, 0.88)";
const KEYCAP_BORDER = "rgba(255, 255, 255, 0.16)";
const KEYCAP_TEXT = "rgba(255, 255, 255, 0.96)";
const PLUS_TEXT = "rgba(255, 255, 255, 0.6)";

/**
 * Draw recently-pressed keys as keycap pills along the bottom-center of the
 * canvas. Modifier combos (Ctrl+Shift+S) render as separate caps joined by
 * "+". Keys fade out as they age toward `windowMs`.
 *
 * Pure Canvas2D — safe to call from the export workers (OffscreenCanvas) and
 * the main thread preview.
 */
export function renderKeystrokeOverlay(
	ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
	keystrokes: readonly KeystrokeEvent[],
	options: KeystrokeOverlayOptions,
): void {
	const visible = pickVisibleKeystrokes(keystrokes, options.currentTimeMs);
	if (visible.length === 0) return;

	const s = Math.max(0.5, options.scaleFactor);
	const keycapHeight = 44 * s;
	const keycapPadX = 16 * s;
	const keycapRadius = 8 * s;
	const chordGap = 18 * s; // between consecutive chords
	const plusGap = 6 * s; // around the "+" glyph
	const fontPx = 20 * s;
	const plusFontPx = 18 * s;
	const bottomMargin = 56 * s;

	ctx.save();
	ctx.font = `600 ${fontPx}px system-ui, -apple-system, "Segoe UI", sans-serif`;
	ctx.textBaseline = "middle";
	ctx.textAlign = "center";

	// First pass: measure each chord's total width so we can right-align the
	// row from oldest (left) to newest (right) anchored at the canvas center.
	const measured = visible.map(({ event, alpha }) => {
		const parts = chordParts(event);
		const widths = parts.map((p) =>
			Math.max(keycapHeight, ctx.measureText(p).width + keycapPadX * 2),
		);
		const chordWidth =
			widths.reduce((a, b) => a + b, 0) + (parts.length - 1) * (plusGap * 2 + plusFontPx);
		return { parts, widths, chordWidth, alpha };
	});

	const totalWidth =
		measured.reduce((sum, m) => sum + m.chordWidth, 0) +
		Math.max(0, measured.length - 1) * chordGap;

	let x = (options.canvasWidth - totalWidth) / 2;
	const y = options.canvasHeight - bottomMargin - keycapHeight / 2;

	for (let i = 0; i < measured.length; i++) {
		const { parts, widths, alpha } = measured[i];
		for (let j = 0; j < parts.length; j++) {
			drawKeycap(ctx, x, y - keycapHeight / 2, widths[j], keycapHeight, keycapRadius, alpha);
			ctx.fillStyle = withAlpha(KEYCAP_TEXT, alpha);
			ctx.fillText(parts[j], x + widths[j] / 2, y + 1 * s);
			x += widths[j];

			if (j < parts.length - 1) {
				x += plusGap;
				ctx.save();
				ctx.font = `500 ${plusFontPx}px system-ui, -apple-system, "Segoe UI", sans-serif`;
				ctx.fillStyle = withAlpha(PLUS_TEXT, alpha);
				ctx.fillText("+", x + plusFontPx / 2, y + 1 * s);
				ctx.restore();
				x += plusFontPx + plusGap;
			}
		}
		if (i < measured.length - 1) x += chordGap;
	}

	ctx.restore();
}

interface VisibleKey {
	event: KeystrokeEvent;
	alpha: number;
}

function pickVisibleKeystrokes(
	keystrokes: readonly KeystrokeEvent[],
	currentTimeMs: number,
): VisibleKey[] {
	const minTime = currentTimeMs - DEFAULT_WINDOW_MS;
	const fadeStart = currentTimeMs - DEFAULT_FADE_MS;

	const out: VisibleKey[] = [];
	// keystrokes is sorted ascending; iterate from the end and stop when we
	// fall out of the window. This is O(visible) regardless of total count.
	for (let i = keystrokes.length - 1; i >= 0; i--) {
		const k = keystrokes[i];
		if (k.timeMs > currentTimeMs) continue; // not yet in time
		if (k.timeMs < minTime) break;
		const alpha =
			k.timeMs >= fadeStart ? 1 : Math.max(0, (k.timeMs - minTime) / (fadeStart - minTime));
		out.unshift({ event: k, alpha });
		if (out.length >= MAX_VISIBLE_KEYS) break;
	}
	return out;
}

function chordParts(event: KeystrokeEvent): string[] {
	const parts: string[] = [];
	const m = event.modifiers;
	// Display order: Ctrl, Alt, Shift, Meta — matches keyboard convention.
	if (m.ctrl) parts.push("Ctrl");
	if (m.alt) parts.push("Alt");
	if (m.shift) parts.push("Shift");
	if (m.meta) parts.push(metaLabel());
	parts.push(event.label);
	return parts;
}

function metaLabel(): string {
	if (typeof navigator !== "undefined") {
		const ua = navigator.userAgent || "";
		if (/Mac|iPhone|iPad/.test(ua)) return "⌘";
		if (/Windows|Win32|Win64/.test(ua)) return "Win";
	}
	return "Meta";
}

function drawKeycap(
	ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
	x: number,
	y: number,
	width: number,
	height: number,
	radius: number,
	alpha: number,
): void {
	ctx.beginPath();
	roundedRectPath(ctx, x, y, width, height, radius);
	ctx.fillStyle = withAlpha(KEYCAP_BG, alpha);
	ctx.fill();

	ctx.lineWidth = 1;
	ctx.strokeStyle = withAlpha(KEYCAP_BORDER, alpha);
	ctx.stroke();
}

function roundedRectPath(
	ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
	x: number,
	y: number,
	w: number,
	h: number,
	r: number,
): void {
	const rr = Math.min(r, w / 2, h / 2);
	ctx.moveTo(x + rr, y);
	ctx.lineTo(x + w - rr, y);
	ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
	ctx.lineTo(x + w, y + h - rr);
	ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
	ctx.lineTo(x + rr, y + h);
	ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
	ctx.lineTo(x, y + rr);
	ctx.quadraticCurveTo(x, y, x + rr, y);
	ctx.closePath();
}

function withAlpha(color: string, alpha: number): string {
	const m = color.match(/^rgba?\(([^)]+)\)$/);
	if (!m) return color;
	const parts = m[1].split(",").map((s) => s.trim());
	const [r, g, b] = parts;
	const baseA = parts[3] !== undefined ? Number(parts[3]) : 1;
	return `rgba(${r}, ${g}, ${b}, ${(baseA * alpha).toFixed(3)})`;
}
