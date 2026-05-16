/**
 * Auto-zoom generator — turns cursor click telemetry into ZoomRegion[].
 *
 * Inspired by Screen Studio's signature feature: every time the user clicks
 * something during the recording, the editor zooms in on that area. Makes
 * recordings feel cinematic and directs the viewer's eye to what matters.
 *
 * Algorithm:
 *   1. For each click, look up cursor position via telemetry interpolation.
 *   2. Build a candidate ZoomRegion centered on the click with a lead-in,
 *      hold, and lead-out.
 *   3. Merge bursts: clicks within `mergeWindowMs` of each other become one
 *      wider region covering all of them. Two rapid clicks in the same area
 *      shouldn't snap the camera back and forth.
 *   4. Drop tiny regions (typing bursts, accidental clicks) below
 *      `minDurationMs` after merging.
 *   5. Avoid colliding with manually-edited regions. Existing regions win;
 *      generated ones get trimmed or dropped.
 *
 * Output regions are marked `focusMode: "auto"` so the UI / regenerator can
 * tell them apart from user-placed ones.
 */

import type {
	CursorTelemetryPoint,
	ZoomDepth,
	ZoomFocus,
	ZoomRegion,
} from "@/components/video-editor/types";
import { interpolateCursorAt } from "@/components/video-editor/videoPlayback/cursorFollowUtils";

export type AutoZoomIntensity = "subtle" | "standard" | "dramatic";

export interface AutoZoomOptions {
	/** How aggressively to zoom. Maps to ZoomDepth: subtle=2, standard=3, dramatic=4. */
	intensity?: AutoZoomIntensity;
	/** ms BEFORE the click where the zoom-in starts. */
	leadInMs?: number;
	/** ms AFTER the click to stay zoomed before zooming out. */
	holdMs?: number;
	/** Clicks within this window merge into one wider region. */
	mergeWindowMs?: number;
	/** Candidate regions shorter than this (after merging) get filtered out. */
	minDurationMs?: number;
	/** Existing manual regions to avoid colliding with. */
	existingRegions?: ZoomRegion[];
	/** Total recording duration in ms — generated regions get clamped to it. */
	durationMs: number;
}

const INTENSITY_TO_DEPTH: Record<AutoZoomIntensity, ZoomDepth> = {
	subtle: 2, // 1.5×
	standard: 3, // 1.8×
	dramatic: 4, // 2.2×
};

const DEFAULTS = {
	leadInMs: 300,
	holdMs: 1500,
	mergeWindowMs: 2000,
	minDurationMs: 800,
} as const;

/**
 * Generate auto-zoom regions from click telemetry. Pure function — call it
 * with the recording's data, get back an array of ZoomRegion ready to add
 * to the editor's `zoomRegions` state.
 */
export function generateAutoZoomRegions(
	clickTimestamps: number[],
	cursorTelemetry: CursorTelemetryPoint[],
	options: AutoZoomOptions,
): ZoomRegion[] {
	const intensity = options.intensity ?? "standard";
	const leadInMs = options.leadInMs ?? DEFAULTS.leadInMs;
	const holdMs = options.holdMs ?? DEFAULTS.holdMs;
	const mergeWindowMs = options.mergeWindowMs ?? DEFAULTS.mergeWindowMs;
	const minDurationMs = options.minDurationMs ?? DEFAULTS.minDurationMs;
	const existing = options.existingRegions ?? [];
	const depth = INTENSITY_TO_DEPTH[intensity];

	if (clickTimestamps.length === 0 || cursorTelemetry.length === 0) {
		return [];
	}

	// 1. Build raw candidates, sorted by click time.
	const sortedClicks = [...clickTimestamps].sort((a, b) => a - b);

	interface Candidate {
		startMs: number;
		endMs: number;
		focusPoints: ZoomFocus[]; // averaged later
	}

	const candidates: Candidate[] = [];
	for (const click of sortedClicks) {
		const focus = interpolateCursorAt(cursorTelemetry, click);
		if (!focus) continue;
		candidates.push({
			startMs: Math.max(0, click - leadInMs),
			endMs: Math.min(options.durationMs, click + holdMs),
			focusPoints: [focus],
		});
	}

	// 2. Merge bursts. Two candidates merge if the gap between this one's
	//    start and the previous one's end is less than mergeWindowMs.
	const merged: Candidate[] = [];
	for (const c of candidates) {
		const last = merged[merged.length - 1];
		if (last && c.startMs - last.endMs <= mergeWindowMs) {
			// Extend the previous region to cover this click too.
			last.endMs = Math.max(last.endMs, c.endMs);
			last.focusPoints.push(...c.focusPoints);
		} else {
			merged.push({
				startMs: c.startMs,
				endMs: c.endMs,
				focusPoints: [...c.focusPoints],
			});
		}
	}

	// 3. Drop too-short regions (likely typing-burst clicks).
	const longEnough = merged.filter((c) => c.endMs - c.startMs >= minDurationMs);

	// 4. Resolve focus: average the click positions in each merged region so
	//    the camera centers between rapid clicks instead of yanking around.
	//    Bias slightly toward the latest click (it's "where the action is").
	const focused = longEnough.map<Candidate & { focus: ZoomFocus }>((c) => {
		const focus = weightedAverageFocus(c.focusPoints);
		return { ...c, focus };
	});

	// 5. Avoid collisions with existing regions. For each existing region,
	//    trim or remove overlapping candidates. Manual edits always win.
	const sortedExisting = [...existing].sort((a, b) => a.startMs - b.startMs);
	const resolved: Array<Candidate & { focus: ZoomFocus }> = [];
	for (const c of focused) {
		let regionStart = c.startMs;
		let regionEnd = c.endMs;
		let dropped = false;
		for (const ex of sortedExisting) {
			if (ex.endMs <= regionStart) continue; // existing is before; skip
			if (ex.startMs >= regionEnd) break; // existing is after; done
			// Overlap. Trim or drop:
			if (ex.startMs <= regionStart && ex.endMs >= regionEnd) {
				// Existing fully contains candidate — drop it.
				dropped = true;
				break;
			}
			if (ex.startMs <= regionStart) {
				// Existing covers the start — trim candidate's start.
				regionStart = ex.endMs;
			} else if (ex.endMs >= regionEnd) {
				// Existing covers the end — trim candidate's end.
				regionEnd = ex.startMs;
			} else {
				// Existing sits in the middle — split would be ugly, just drop.
				dropped = true;
				break;
			}
		}
		if (dropped) continue;
		if (regionEnd - regionStart < minDurationMs) continue;
		resolved.push({ ...c, startMs: regionStart, endMs: regionEnd });
	}

	// 6. Materialize as ZoomRegion[]. Stable IDs per (start, end) so repeated
	//    generation produces the same IDs and React keys stay stable.
	return resolved.map<ZoomRegion>((c, i) => ({
		id: `auto-zoom-${c.startMs}-${c.endMs}-${i}`,
		startMs: Math.round(c.startMs),
		endMs: Math.round(c.endMs),
		depth,
		focus: c.focus,
		focusMode: "auto",
	}));
}

/**
 * Average a set of focus points, biased toward later clicks in the burst.
 * Later clicks tend to be where the action is — the user clicked once, looked
 * at the result, clicked again. Centering on the later click is usually more
 * informative than a pure mean.
 */
function weightedAverageFocus(points: ZoomFocus[]): ZoomFocus {
	if (points.length === 1) return points[0];
	let sumCx = 0;
	let sumCy = 0;
	let totalWeight = 0;
	for (let i = 0; i < points.length; i++) {
		// Linear weight: 1, 2, 3, ... → latest click weighted most.
		const w = i + 1;
		sumCx += points[i].cx * w;
		sumCy += points[i].cy * w;
		totalWeight += w;
	}
	return { cx: sumCx / totalWeight, cy: sumCy / totalWeight };
}

/**
 * Remove all auto-generated regions (focusMode: "auto") from a region list.
 * Useful when the user wants to regenerate fresh.
 */
export function stripAutoZooms(regions: ZoomRegion[]): ZoomRegion[] {
	return regions.filter((r) => r.focusMode !== "auto");
}
