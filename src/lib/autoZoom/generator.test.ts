import { describe, expect, it } from "vitest";
import type { CursorTelemetryPoint } from "@/components/video-editor/types";
import { generateAutoZoomRegions, stripAutoZooms } from "./generator";

function makeTelemetry(points: Array<[number, number, number]>): CursorTelemetryPoint[] {
	return points.map(([timeMs, cx, cy]) => ({ timeMs, cx, cy }));
}

describe("generateAutoZoomRegions", () => {
	it("returns empty when there are no clicks", () => {
		const out = generateAutoZoomRegions([], makeTelemetry([[0, 0.5, 0.5]]), { durationMs: 10_000 });
		expect(out).toEqual([]);
	});

	it("returns empty when there's no cursor telemetry", () => {
		const out = generateAutoZoomRegions([1000], [], { durationMs: 10_000 });
		expect(out).toEqual([]);
	});

	it("creates one region per isolated click", () => {
		const telemetry = makeTelemetry([
			[0, 0.5, 0.5],
			[5000, 0.5, 0.5],
			[10_000, 0.5, 0.5],
		]);
		const out = generateAutoZoomRegions([1000, 5000], telemetry, {
			durationMs: 10_000,
		});
		expect(out.length).toBe(2);
		// Region 1: click at 1000ms → start ≈ 700, end ≈ 2500
		expect(out[0].startMs).toBe(700);
		expect(out[0].endMs).toBe(2500);
		// Region 2: click at 5000ms → start ≈ 4700, end ≈ 6500
		expect(out[1].startMs).toBe(4700);
		expect(out[1].endMs).toBe(6500);
	});

	it("merges bursts of clicks into one wider region", () => {
		const telemetry = makeTelemetry([
			[0, 0.5, 0.5],
			[5000, 0.5, 0.5],
		]);
		// Three clicks close together: 1000, 1500, 2000 — should merge.
		const out = generateAutoZoomRegions([1000, 1500, 2000], telemetry, { durationMs: 10_000 });
		expect(out.length).toBe(1);
		expect(out[0].startMs).toBe(700);
		// End extends to last click + holdMs = 2000 + 1500
		expect(out[0].endMs).toBe(3500);
	});

	it("filters out regions shorter than minDurationMs", () => {
		const telemetry = makeTelemetry([[0, 0.5, 0.5]]);
		// Click at 100ms with tiny duration override → should be dropped.
		const out = generateAutoZoomRegions([100], telemetry, {
			durationMs: 10_000,
			leadInMs: 0,
			holdMs: 100,
			minDurationMs: 800,
		});
		expect(out).toEqual([]);
	});

	it("clamps generated regions to the recording duration", () => {
		const telemetry = makeTelemetry([[0, 0.5, 0.5]]);
		// Click at 9000ms → candidate would normally be [8700, 10500]; ends
		// up clamped to 10_000. Stays above minDurationMs so it isn't filtered.
		const out = generateAutoZoomRegions([9000], telemetry, {
			durationMs: 10_000,
		});
		expect(out.length).toBe(1);
		expect(out[0].endMs).toBeLessThanOrEqual(10_000);
	});

	it("avoids overlapping existing manual regions", () => {
		const telemetry = makeTelemetry([[0, 0.5, 0.5]]);
		const existing = [
			{
				id: "manual",
				startMs: 500,
				endMs: 2500,
				depth: 3 as const,
				focus: { cx: 0.1, cy: 0.1 },
			},
		];
		// Click at 1000ms would normally produce [700, 2500] — fully contained
		// by the existing region → should be dropped.
		const out = generateAutoZoomRegions([1000], telemetry, {
			durationMs: 10_000,
			existingRegions: existing,
		});
		expect(out).toEqual([]);
	});

	it("trims candidates that partially overlap an existing region", () => {
		const telemetry = makeTelemetry([
			[0, 0.5, 0.5],
			[5000, 0.5, 0.5],
		]);
		// Click at 1500ms → candidate [1200, 3000]. Existing covers [600, 1500]
		// which overlaps the candidate's start → trim candidate.startMs up to
		// 1500 (= existing.endMs).
		const existing = [
			{
				id: "manual",
				startMs: 600,
				endMs: 1500,
				depth: 3 as const,
				focus: { cx: 0, cy: 0 },
			},
		];
		const out = generateAutoZoomRegions([1500], telemetry, {
			durationMs: 10_000,
			existingRegions: existing,
		});
		expect(out.length).toBe(1);
		expect(out[0].startMs).toBe(1500);
		expect(out[0].endMs).toBe(3000);
	});

	it("marks generated regions with focusMode='auto'", () => {
		const out = generateAutoZoomRegions([2000], makeTelemetry([[0, 0.5, 0.5]]), {
			durationMs: 10_000,
		});
		expect(out[0].focusMode).toBe("auto");
	});

	it("biases focus toward the latest click in a burst", () => {
		const telemetry = makeTelemetry([
			[0, 0.1, 0.1],
			[1000, 0.1, 0.1],
			[2000, 0.9, 0.9],
		]);
		// Burst at 1000 and 2000. Cursor at 1000 = 0.1, at 2000 = 0.9.
		// Weighted average: (0.1×1 + 0.9×2) / 3 = 1.9/3 ≈ 0.633
		const out = generateAutoZoomRegions([1000, 2000], telemetry, {
			durationMs: 10_000,
		});
		expect(out.length).toBe(1);
		expect(out[0].focus.cx).toBeCloseTo(0.633, 2);
		expect(out[0].focus.cy).toBeCloseTo(0.633, 2);
	});

	it("uses intensity to set zoom depth", () => {
		const telemetry = makeTelemetry([[0, 0.5, 0.5]]);
		const subtle = generateAutoZoomRegions([1000], telemetry, {
			durationMs: 10_000,
			intensity: "subtle",
		});
		const dramatic = generateAutoZoomRegions([1000], telemetry, {
			durationMs: 10_000,
			intensity: "dramatic",
		});
		expect(subtle[0].depth).toBe(2);
		expect(dramatic[0].depth).toBe(4);
	});
});

describe("stripAutoZooms", () => {
	it("removes only auto-generated regions", () => {
		const regions = [
			{
				id: "m1",
				startMs: 0,
				endMs: 1000,
				depth: 3 as const,
				focus: { cx: 0.5, cy: 0.5 },
			},
			{
				id: "a1",
				startMs: 2000,
				endMs: 3000,
				depth: 3 as const,
				focus: { cx: 0.5, cy: 0.5 },
				focusMode: "auto" as const,
			},
			{
				id: "m2",
				startMs: 4000,
				endMs: 5000,
				depth: 3 as const,
				focus: { cx: 0.5, cy: 0.5 },
				focusMode: "manual" as const,
			},
		];
		expect(stripAutoZooms(regions)).toEqual([regions[0], regions[2]]);
	});
});
