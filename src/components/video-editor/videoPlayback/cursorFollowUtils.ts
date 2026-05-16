import type { CursorTelemetryPoint, ZoomFocus } from "../types";

/**
 * Catmull-Rom spline interpolation across 4 surrounding telemetry points.
 * Use this when rendering the cursor highlight overlay at a higher fps than
 * the capture rate — straight-line interpolation produces visible kinks at
 * every telemetry sample. Catmull-Rom passes through every sample but with
 * smooth tangents, so the rendered highlight moves on a curve instead of
 * piecewise-linear segments. Falls back to linear when fewer than 3 points
 * are available.
 */
export function interpolateCursorAtSmooth(
	telemetry: CursorTelemetryPoint[],
	timeMs: number,
): ZoomFocus | null {
	if (telemetry.length === 0) return null;
	if (telemetry.length < 3) return interpolateCursorAt(telemetry, timeMs);

	if (timeMs <= telemetry[0].timeMs) {
		return { cx: telemetry[0].cx, cy: telemetry[0].cy };
	}
	const last = telemetry[telemetry.length - 1];
	if (timeMs >= last.timeMs) {
		return { cx: last.cx, cy: last.cy };
	}

	// Binary-search the segment [lo, hi] that contains timeMs.
	let lo = 0;
	let hi = telemetry.length - 1;
	while (lo < hi - 1) {
		const mid = (lo + hi) >>> 1;
		if (telemetry[mid].timeMs <= timeMs) lo = mid;
		else hi = mid;
	}

	const p1 = telemetry[lo];
	const p2 = telemetry[hi];
	// Clamp P0/P3 to the segment endpoints when we're at the array edges.
	const p0 = lo > 0 ? telemetry[lo - 1] : p1;
	const p3 = hi < telemetry.length - 1 ? telemetry[hi + 1] : p2;

	const span = p2.timeMs - p1.timeMs;
	const t = span > 0 ? (timeMs - p1.timeMs) / span : 0;
	const t2 = t * t;
	const t3 = t2 * t;

	// Standard Catmull-Rom basis:
	//   P(t) = 0.5 * ( 2P1 + (-P0+P2)t + (2P0-5P1+4P2-P3)t² + (-P0+3P1-3P2+P3)t³ )
	const cx =
		0.5 *
		(2 * p1.cx +
			(-p0.cx + p2.cx) * t +
			(2 * p0.cx - 5 * p1.cx + 4 * p2.cx - p3.cx) * t2 +
			(-p0.cx + 3 * p1.cx - 3 * p2.cx + p3.cx) * t3);
	const cy =
		0.5 *
		(2 * p1.cy +
			(-p0.cy + p2.cy) * t +
			(2 * p0.cy - 5 * p1.cy + 4 * p2.cy - p3.cy) * t2 +
			(-p0.cy + 3 * p1.cy - 3 * p2.cy + p3.cy) * t3);

	return { cx, cy };
}

/**
 * Binary-search the sorted telemetry array and linearly interpolate
 * the cursor position at the given playback time.
 */
export function interpolateCursorAt(
	telemetry: CursorTelemetryPoint[],
	timeMs: number,
): ZoomFocus | null {
	if (telemetry.length === 0) return null;

	if (timeMs <= telemetry[0].timeMs) {
		return { cx: telemetry[0].cx, cy: telemetry[0].cy };
	}

	const last = telemetry[telemetry.length - 1];
	if (timeMs >= last.timeMs) {
		return { cx: last.cx, cy: last.cy };
	}

	let lo = 0;
	let hi = telemetry.length - 1;

	while (lo < hi - 1) {
		const mid = (lo + hi) >>> 1;
		if (telemetry[mid].timeMs <= timeMs) {
			lo = mid;
		} else {
			hi = mid;
		}
	}

	const before = telemetry[lo];
	const after = telemetry[hi];
	const span = after.timeMs - before.timeMs;
	const t = span > 0 ? (timeMs - before.timeMs) / span : 0;

	return {
		cx: before.cx + (after.cx - before.cx) * t,
		cy: before.cy + (after.cy - before.cy) * t,
	};
}

/**
 * Exponential smoothing to reduce jitter from high-frequency cursor data.
 * Lower factor = smoother / more lag, higher = more responsive.
 */
export function smoothCursorFocus(raw: ZoomFocus, prev: ZoomFocus, factor: number): ZoomFocus {
	return {
		cx: prev.cx + (raw.cx - prev.cx) * factor,
		cy: prev.cy + (raw.cy - prev.cy) * factor,
	};
}

/**
 * Compute an adaptive smoothing factor that scales with distance:
 * far from target → faster (maxFactor), close → slower (minFactor).
 * This replaces the hard deadzone with a natural deceleration curve.
 */
export function adaptiveSmoothFactor(
	raw: ZoomFocus,
	prev: ZoomFocus,
	minFactor: number,
	maxFactor: number,
	rampDistance: number,
): number {
	const dx = raw.cx - prev.cx;
	const dy = raw.cy - prev.cy;
	const distance = Math.sqrt(dx * dx + dy * dy);
	const t = Math.min(1, distance / rampDistance);
	return minFactor + (maxFactor - minFactor) * t;
}
