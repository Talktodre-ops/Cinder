/**
 * Web Worker for parallel PixiJS frame rendering on OffscreenCanvas.
 *
 * The main thread sends render jobs (ImageBitmap + timestamp + webcam ImageBitmap),
 * this worker renders them using PixiJS and returns the result as an ImageBitmap.
 *
 * PixiJS v8 supports OffscreenCanvas via the `canvas` option in app.init().
 */

// Force the OffscreenCanvas adapter before any PixiJS code runs.
// PixiJS's auto-detection uses self.WorkerGlobalScope, which is absent in
// Electron workers, so it falls back to BrowserAdapter (calls document.createElement)
// and crashes. Both DOMAdapter and WebWorkerAdapter are exported from pixi.js core.
import {
	Application,
	BlurFilter,
	Container,
	DOMAdapter,
	Graphics,
	Rectangle,
	Sprite,
	Texture,
	WebWorkerAdapter,
} from "pixi.js";

DOMAdapter.set(WebWorkerAdapter);

import { MotionBlurFilter } from "pixi-filters/motion-blur";
import type {
	AnnotationRegion,
	CropRegion,
	SpeedRegion,
	WebcamLayoutPreset,
	WebcamSizePreset,
	ZoomDepth,
	ZoomRegion,
} from "@/components/video-editor/types";
import { ZOOM_DEPTH_SCALES } from "@/components/video-editor/types";
import {
	AUTO_FOLLOW_RAMP_DISTANCE,
	AUTO_FOLLOW_SMOOTHING_FACTOR,
	AUTO_FOLLOW_SMOOTHING_FACTOR_MAX,
	DEFAULT_FOCUS,
	ZOOM_SCALE_DEADZONE,
	ZOOM_TRANSLATION_DEADZONE_PX,
} from "@/components/video-editor/videoPlayback/constants";
import {
	adaptiveSmoothFactor,
	interpolateCursorAtSmooth,
	smoothCursorFocus,
} from "@/components/video-editor/videoPlayback/cursorFollowUtils";
import {
	type CursorHighlightConfig,
	clickEmphasisAlpha,
	drawCursorHighlightCanvas,
} from "@/components/video-editor/videoPlayback/cursorHighlight";
import { clampFocusToStage as clampFocusToStageUtil } from "@/components/video-editor/videoPlayback/focusUtils";
import { findDominantRegion } from "@/components/video-editor/videoPlayback/zoomRegionUtils";
import {
	applyZoomTransform,
	computeFocusFromTransform,
	computeZoomTransform,
	createMotionBlurState,
	type MotionBlurState,
} from "@/components/video-editor/videoPlayback/zoomTransform";
import {
	computeCompositeLayout,
	getWebcamLayoutPresetDefinition,
	type Size,
	type StyledRenderRect,
} from "@/lib/compositeLayout";
import { BackgroundLoadError, classifyWallpaper, resolveImageWallpaperUrl } from "@/lib/wallpaper";
import { drawCanvasClipPath } from "@/lib/webcamMaskShapes";
import { renderAnnotations } from "./annotationRenderer";
import {
	getLinearGradientPoints,
	getRadialGradientShape,
	parseCssGradient,
	resolveLinearGradientAngle,
} from "./gradientParser";
import { renderKeystrokeOverlay } from "./keystrokeOverlayRenderer";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface WorkerRenderConfig {
	width: number;
	height: number;
	wallpaper: string;
	zoomRegions: ZoomRegion[];
	showShadow: boolean;
	shadowIntensity: number;
	showBlur: boolean;
	motionBlurAmount?: number;
	borderRadius?: number;
	padding?: number;
	cropRegion: CropRegion;
	videoWidth: number;
	videoHeight: number;
	webcamSize?: Size | null;
	webcamLayoutPreset?: WebcamLayoutPreset;
	webcamMaskShape?: import("@/components/video-editor/types").WebcamMaskShape;
	webcamSizePreset?: WebcamSizePreset;
	webcamPosition?: { cx: number; cy: number } | null;
	annotationRegions?: AnnotationRegion[];
	speedRegions?: SpeedRegion[];
	previewWidth?: number;
	previewHeight?: number;
	cursorTelemetry?: import("@/components/video-editor/types").CursorTelemetryPoint[];
	cursorHighlight?: CursorHighlightConfig;
	cursorClickTimestamps?: number[];
	keystrokes?: import("@/lib/keystrokeTelemetry").KeystrokeEvent[];
	showKeystrokes?: boolean;
	platform: string;
}

export interface RenderJob {
	frameIndex: number;
	videoBitmap: ImageBitmap;
	timestamp: number; // microseconds
	sourceTimestampMs: number;
	webcamBitmap?: ImageBitmap | null;
	/**
	 * "bitmap" → return an ImageBitmap (default; cheap when the consumer can use
	 *   the GPU bitmap directly, e.g. WebCodecs VideoFrame).
	 * "rgba"   → run getImageData on the worker side and return the raw RGBA
	 *   bytes. Use this for the ffmpeg stdin path so the GPU→CPU readback is
	 *   parallelized across all workers instead of bottlenecked on the main
	 *   thread of the renderer.
	 */
	outputFormat?: "bitmap" | "rgba";
}

export type RenderResult =
	| { frameIndex: number; bitmap: ImageBitmap }
	| { frameIndex: number; rgba: Uint8Array; width: number; height: number };

// ─── Worker Messages ─────────────────────────────────────────────────────────

type WorkerMessage =
	| { type: "init"; config: WorkerRenderConfig; canvas: OffscreenCanvas }
	| { type: "render"; job: RenderJob }
	| { type: "reset" }
	| { type: "destroy" };

type WorkerResponse =
	| { type: "init-done" }
	| { type: "render-done"; result: RenderResult; timing?: FrameTiming }
	| { type: "error"; message: string }
	| { type: "destroy-done" };

export interface FrameTiming {
	pixi: number; // PixiJS scene render
	composite: number; // 2D canvas composite (background + WebGL→2D + shadow)
	extras: number; // cursor highlight + annotations
	readback: number; // getImageData (rgba mode) or transferToImageBitmap (bitmap mode)
}

// ─── Worker State ────────────────────────────────────────────────────────────

let app: Application | null = null;
let cameraContainer: Container | null = null;
let videoContainer: Container | null = null;
let videoSprite: Sprite | null = null;
let backgroundSprite: OffscreenCanvas | null = null;
/** PixiJS sprite version of backgroundSprite, added to stage when bgInPixi=true. */
let pixiBackgroundSprite: Sprite | null = null;
/** True when background is rendered inside the Pixi scene (not on the 2D canvas). */
let bgInPixi = false;
/**
 * True when the entire frame can be produced by Pixi alone — no 2D composite,
 * no shadow, no webcam, no cursor highlight, no annotations. Lets us skip the
 * 2D round-trip and use renderer.extract.pixels() for readback (5–10× faster
 * than getImageData on a 2D canvas that contains a WebGL drawImage).
 */
let fastPath = false;
let maskGraphics: Graphics | null = null;
let blurFilter: BlurFilter | null = null;
let motionBlurFilter: MotionBlurFilter | null = null;
let shadowCanvas: OffscreenCanvas | null = null;
let shadowCtx: OffscreenCanvasRenderingContext2D | null = null;
let compositeCanvas: OffscreenCanvas | null = null;
let compositeCtx: OffscreenCanvasRenderingContext2D | null = null;
let rasterCanvas: OffscreenCanvas | null = null;
let rasterCtx: OffscreenCanvasRenderingContext2D | null = null;
let config: WorkerRenderConfig | null = null;
let animationState: {
	scale: number;
	focusX: number;
	focusY: number;
	progress: number;
	x: number;
	y: number;
	appliedScale: number;
} | null = null;
let layoutCache: {
	stageSize: { width: number; height: number };
	videoSize: { width: number; height: number };
	baseScale: number;
	baseOffset: { x: number; y: number };
	maskRect: { x: number; y: number; width: number; height: number };
	webcamRect: StyledRenderRect | null;
} | null = null;
let currentVideoTime = 0;
let motionBlurState: MotionBlurState = createMotionBlurState();
let smoothedAutoFocus: { cx: number; cy: number } | null = null;
let prevAnimationTimeMs: number | null = null;
let prevTargetProgress = 0;
let isLinux = false;

// ─── Background Setup ────────────────────────────────────────────────────────

async function setupBackground(cfg: WorkerRenderConfig): Promise<void> {
	const wallpaper = cfg.wallpaper;
	// Workers have no document — use OffscreenCanvas directly.
	const bgCanvas = new OffscreenCanvas(cfg.width, cfg.height);
	const bgCtx = bgCanvas.getContext("2d") as OffscreenCanvasRenderingContext2D;

	const classified = classifyWallpaper(wallpaper);

	if (classified.kind === "color") {
		bgCtx.fillStyle = classified.value;
		bgCtx.fillRect(0, 0, cfg.width, cfg.height);
	} else if (classified.kind === "gradient") {
		const parsedGradient = parseCssGradient(classified.value);
		if (!parsedGradient) {
			throw new BackgroundLoadError(classified.value);
		}
		const gradient =
			parsedGradient.type === "linear"
				? (() => {
						const points = getLinearGradientPoints(
							resolveLinearGradientAngle(parsedGradient.descriptor),
							cfg.width,
							cfg.height,
						);
						return bgCtx.createLinearGradient(points.x0, points.y0, points.x1, points.y1);
					})()
				: (() => {
						const shape = getRadialGradientShape(parsedGradient.descriptor, cfg.width, cfg.height);
						return bgCtx.createRadialGradient(
							shape.cx,
							shape.cy,
							0,
							shape.cx,
							shape.cy,
							shape.radius,
						);
					})();

		parsedGradient.stops.forEach((stop) => {
			gradient.addColorStop(stop.offset, stop.color);
		});

		bgCtx.fillStyle = gradient;
		bgCtx.fillRect(0, 0, cfg.width, cfg.height);
	} else {
		// Workers have no <img> element — use fetch + createImageBitmap instead.
		const imageUrl = resolveImageWallpaperUrl(classified.path);
		let bitmap: ImageBitmap;
		try {
			const response = await fetch(imageUrl);
			if (!response.ok) throw new Error(`HTTP ${response.status}`);
			const blob = await response.blob();
			bitmap = await createImageBitmap(blob);
		} catch (err) {
			throw new BackgroundLoadError(imageUrl, err);
		}

		const imgAspect = bitmap.width / bitmap.height;
		const canvasAspect = cfg.width / cfg.height;

		let drawWidth: number;
		let drawHeight: number;
		let drawX: number;
		let drawY: number;

		if (imgAspect > canvasAspect) {
			drawHeight = cfg.height;
			drawWidth = drawHeight * imgAspect;
			drawX = (cfg.width - drawWidth) / 2;
			drawY = 0;
		} else {
			drawWidth = cfg.width;
			drawHeight = drawWidth / imgAspect;
			drawX = 0;
			drawY = (cfg.height - drawHeight) / 2;
		}

		bgCtx.drawImage(bitmap, drawX, drawY, drawWidth, drawHeight);
		bitmap.close();
	}

	backgroundSprite = bgCanvas;
}

// ─── Layout Update ───────────────────────────────────────────────────────────

function updateLayout(webcamBitmap?: ImageBitmap | null): void {
	if (!app || !videoSprite || !maskGraphics || !videoContainer || !config) return;

	const { width, height } = config;
	const { cropRegion, borderRadius = 0, padding = 0 } = config;
	const videoWidth = config.videoWidth;
	const videoHeight = config.videoHeight;

	const cropStartX = cropRegion.x;
	const cropStartY = cropRegion.y;
	const cropEndX = cropRegion.x + cropRegion.width;
	const cropEndY = cropRegion.y + cropRegion.height;

	const croppedVideoWidth = videoWidth * (cropEndX - cropStartX);
	const croppedVideoHeight = videoHeight * (cropEndY - cropStartY);

	const effectivePadding = config.webcamLayoutPreset === "vertical-stack" ? 0 : padding;
	const paddingScale = 1.0 - (effectivePadding / 100) * 0.4;
	const viewportWidth = width * paddingScale;
	const viewportHeight = height * paddingScale;

	const compositeLayout = computeCompositeLayout({
		canvasSize: { width, height },
		maxContentSize: { width: viewportWidth, height: viewportHeight },
		screenSize: { width: croppedVideoWidth, height: croppedVideoHeight },
		webcamSize: webcamBitmap ? config.webcamSize : null,
		layoutPreset: config.webcamLayoutPreset,
		webcamSizePreset: config.webcamSizePreset,
		webcamPosition: config.webcamPosition,
		webcamMaskShape: config.webcamMaskShape,
	});
	if (!compositeLayout) return;

	const screenRect = compositeLayout.screenRect;

	let scale: number;
	if (compositeLayout.screenCover) {
		scale = Math.max(screenRect.width / croppedVideoWidth, screenRect.height / croppedVideoHeight);
	} else {
		scale = screenRect.width / croppedVideoWidth;
	}

	videoSprite.width = videoWidth * scale;
	videoSprite.height = videoHeight * scale;

	const croppedDisplayWidth = croppedVideoWidth * scale;
	const croppedDisplayHeight = croppedVideoHeight * scale;
	const coverOffsetX = (screenRect.width - croppedDisplayWidth) / 2;
	const coverOffsetY = (screenRect.height - croppedDisplayHeight) / 2;

	const cropPixelX = cropStartX * videoWidth * scale;
	const cropPixelY = cropStartY * videoHeight * scale;
	videoSprite.x = -cropPixelX + coverOffsetX;
	videoSprite.y = -cropPixelY + coverOffsetY;

	videoContainer.x = screenRect.x;
	videoContainer.y = screenRect.y;

	const previewWidth = config.previewWidth ?? config.width;
	const previewHeight = config.previewHeight ?? config.height;
	const canvasScaleFactor = Math.min(width / previewWidth, height / previewHeight);
	const scaledBorderRadius =
		compositeLayout.screenBorderRadius != null
			? compositeLayout.screenBorderRadius
			: compositeLayout.screenCover
				? 0
				: borderRadius * canvasScaleFactor;

	maskGraphics.clear();
	maskGraphics.roundRect(0, 0, screenRect.width, screenRect.height, scaledBorderRadius);
	maskGraphics.fill({ color: 0xffffff });

	layoutCache = {
		stageSize: { width, height },
		videoSize: { width: croppedVideoWidth, height: croppedVideoHeight },
		baseScale: scale,
		baseOffset: { x: compositeLayout.screenRect.x, y: compositeLayout.screenRect.y },
		maskRect: compositeLayout.screenRect,
		webcamRect: compositeLayout.webcamRect,
	};
}

// ─── Animation State Update ──────────────────────────────────────────────────

function clampFocusToStage(
	focus: { cx: number; cy: number },
	depth: ZoomDepth,
): { cx: number; cy: number } {
	if (!layoutCache) return focus;
	return clampFocusToStageUtil(focus, depth, layoutCache.stageSize);
}

function updateAnimationState(timeMs: number): number {
	if (!cameraContainer || !layoutCache || !config) return 0;

	const { region, strength, blendedScale, transition } = findDominantRegion(
		config.zoomRegions,
		timeMs,
		{ connectZooms: true, cursorTelemetry: config.cursorTelemetry },
	);

	const defaultFocus = DEFAULT_FOCUS;
	let targetScaleFactor = 1;
	let targetFocus = { ...defaultFocus };
	let targetProgress = 0;

	if (region && strength > 0) {
		const zoomScale = blendedScale ?? ZOOM_DEPTH_SCALES[region.depth];
		const regionFocus = clampFocusToStage(region.focus, region.depth);

		targetScaleFactor = zoomScale;
		targetFocus = regionFocus;
		targetProgress = strength;

		if (region.focusMode === "auto" && !transition) {
			const raw = targetFocus;
			const dtMs = prevAnimationTimeMs != null ? timeMs - prevAnimationTimeMs : 0;
			const framesElapsed = dtMs > 0 ? dtMs / (1000 / 60) : 1;
			const isZoomingIn = targetProgress < 0.999 && targetProgress >= prevTargetProgress;
			if (targetProgress >= 0.999) {
				const prev = smoothedAutoFocus ?? raw;
				const baseFactor = adaptiveSmoothFactor(
					raw,
					prev,
					AUTO_FOLLOW_SMOOTHING_FACTOR,
					AUTO_FOLLOW_SMOOTHING_FACTOR_MAX,
					AUTO_FOLLOW_RAMP_DISTANCE,
				);
				const factor = 1 - Math.pow(1 - baseFactor, Math.max(1, framesElapsed));
				const smoothed = smoothCursorFocus(raw, prev, factor);
				smoothedAutoFocus = smoothed;
				targetFocus = smoothed;
			} else if (isZoomingIn) {
				smoothedAutoFocus = raw;
			} else {
				const prev = smoothedAutoFocus ?? raw;
				const baseFactor = adaptiveSmoothFactor(
					raw,
					prev,
					AUTO_FOLLOW_SMOOTHING_FACTOR,
					AUTO_FOLLOW_SMOOTHING_FACTOR_MAX,
					AUTO_FOLLOW_RAMP_DISTANCE,
				);
				const factor = 1 - Math.pow(1 - baseFactor, Math.max(1, framesElapsed));
				const smoothed = smoothCursorFocus(raw, prev, factor);
				smoothedAutoFocus = smoothed;
				targetFocus = smoothed;
			}
		} else if (region.focusMode !== "auto") {
			smoothedAutoFocus = null;
		}
		prevTargetProgress = targetProgress;

		if (transition) {
			const startTransform = computeZoomTransform({
				stageSize: layoutCache.stageSize,
				baseMask: layoutCache.maskRect,
				zoomScale: transition.startScale,
				zoomProgress: 1,
				focusX: transition.startFocus.cx,
				focusY: transition.startFocus.cy,
			});
			const endTransform = computeZoomTransform({
				stageSize: layoutCache.stageSize,
				baseMask: layoutCache.maskRect,
				zoomScale: transition.endScale,
				zoomProgress: 1,
				focusX: transition.endFocus.cx,
				focusY: transition.endFocus.cy,
			});

			const interpolatedTransform = {
				scale:
					startTransform.scale + (endTransform.scale - startTransform.scale) * transition.progress,
				x: startTransform.x + (endTransform.x - startTransform.x) * transition.progress,
				y: startTransform.y + (endTransform.y - startTransform.y) * transition.progress,
			};

			targetScaleFactor = interpolatedTransform.scale;
			targetFocus = computeFocusFromTransform({
				stageSize: layoutCache.stageSize,
				baseMask: layoutCache.maskRect,
				zoomScale: interpolatedTransform.scale,
				x: interpolatedTransform.x,
				y: interpolatedTransform.y,
			});
			targetProgress = 1;
		}
	}

	const state = animationState!;
	const prevScale = state.appliedScale;
	const prevX = state.x;
	const prevY = state.y;

	state.scale = targetScaleFactor;
	state.focusX = targetFocus.cx;
	state.focusY = targetFocus.cy;
	state.progress = targetProgress;

	const projectedTransform = computeZoomTransform({
		stageSize: layoutCache.stageSize,
		baseMask: layoutCache.maskRect,
		zoomScale: state.scale,
		zoomProgress: state.progress,
		focusX: state.focusX,
		focusY: state.focusY,
	});

	const appliedScale =
		Math.abs(projectedTransform.scale - prevScale) < ZOOM_SCALE_DEADZONE
			? projectedTransform.scale
			: projectedTransform.scale;
	const appliedX =
		Math.abs(projectedTransform.x - prevX) < ZOOM_TRANSLATION_DEADZONE_PX
			? projectedTransform.x
			: projectedTransform.x;
	const appliedY =
		Math.abs(projectedTransform.y - prevY) < ZOOM_TRANSLATION_DEADZONE_PX
			? projectedTransform.y
			: projectedTransform.y;

	state.x = appliedX;
	state.y = appliedY;
	state.appliedScale = appliedScale;

	prevAnimationTimeMs = timeMs;

	return Math.max(
		Math.abs(appliedScale - prevScale),
		Math.abs(appliedX - prevX) / Math.max(1, layoutCache.stageSize.width),
		Math.abs(appliedY - prevY) / Math.max(1, layoutCache.stageSize.height),
	);
}

// ─── Readback (Linux workaround) ─────────────────────────────────────────────

function readbackVideoCanvas(): OffscreenCanvas {
	const glCanvas = app!.canvas as unknown as OffscreenCanvas;
	const gl =
		(glCanvas.getContext("webgl2") as WebGL2RenderingContext | null) ??
		(glCanvas.getContext("webgl") as WebGLRenderingContext | null);

	if (!gl || !rasterCanvas || !rasterCtx) {
		return glCanvas;
	}

	const w = glCanvas.width;
	const h = glCanvas.height;
	const buf = new Uint8Array(w * h * 4);
	gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);

	const rowSize = w * 4;
	const temp = new Uint8Array(rowSize);
	for (let top = 0, bot = h - 1; top < bot; top++, bot--) {
		const tOff = top * rowSize;
		const bOff = bot * rowSize;
		temp.set(buf.subarray(tOff, tOff + rowSize));
		buf.copyWithin(tOff, bOff, bOff + rowSize);
		buf.set(temp, bOff);
	}

	const imageData = new ImageData(new Uint8ClampedArray(buf.buffer), w, h);
	rasterCtx.putImageData(imageData, 0, 0);

	return rasterCanvas;
}

// ─── Composite with Shadows ──────────────────────────────────────────────────

function compositeWithShadows(webcamBitmap?: ImageBitmap | null): void {
	if (!compositeCanvas || !compositeCtx || !app || !config) return;

	const videoCanvas = isLinux ? readbackVideoCanvas() : (app.canvas as unknown as OffscreenCanvas);

	const ctx = compositeCtx;
	const w = compositeCanvas.width;
	const h = compositeCanvas.height;

	ctx.clearRect(0, 0, w, h);

	// If bg lives in the Pixi scene, the videoCanvas drawImage below will already
	// include the background — don't double-draw it here.
	if (backgroundSprite && !bgInPixi) {
		const bgCanvas = backgroundSprite;
		if (config.showBlur) {
			ctx.save();
			ctx.filter = "blur(6px)";
			ctx.drawImage(bgCanvas, 0, 0, w, h);
			ctx.restore();
		} else {
			ctx.drawImage(bgCanvas, 0, 0, w, h);
		}
	}

	if (config.showShadow && config.shadowIntensity > 0 && shadowCanvas && shadowCtx) {
		const shadowCtxLocal = shadowCtx;
		shadowCtxLocal.clearRect(0, 0, w, h);
		shadowCtxLocal.save();

		const intensity = config.shadowIntensity;
		const baseBlur1 = 48 * intensity;
		const baseBlur2 = 16 * intensity;
		const baseBlur3 = 8 * intensity;
		const baseAlpha1 = 0.7 * intensity;
		const baseAlpha2 = 0.5 * intensity;
		const baseAlpha3 = 0.3 * intensity;
		const baseOffset = 12 * intensity;

		shadowCtxLocal.filter = `drop-shadow(0 ${baseOffset}px ${baseBlur1}px rgba(0,0,0,${baseAlpha1})) drop-shadow(0 ${baseOffset / 3}px ${baseBlur2}px rgba(0,0,0,${baseAlpha2})) drop-shadow(0 ${baseOffset / 6}px ${baseBlur3}px rgba(0,0,0,${baseAlpha3}))`;
		shadowCtxLocal.drawImage(videoCanvas, 0, 0, w, h);
		shadowCtxLocal.restore();
		ctx.drawImage(shadowCanvas, 0, 0, w, h);
	} else {
		ctx.drawImage(videoCanvas, 0, 0, w, h);
	}

	const webcamRect = layoutCache?.webcamRect ?? null;
	if (webcamBitmap && webcamRect) {
		const preset = getWebcamLayoutPresetDefinition(config.webcamLayoutPreset);
		const shape = webcamRect.maskShape ?? config.webcamMaskShape ?? "rectangle";
		const sourceWidth = webcamBitmap.width || webcamRect.width;
		const sourceHeight = webcamBitmap.height || webcamRect.height;
		const sourceAspect = sourceWidth / sourceHeight;
		const targetAspect = webcamRect.width / webcamRect.height;
		const sourceCropWidth =
			sourceAspect > targetAspect ? Math.round(sourceHeight * targetAspect) : sourceWidth;
		const sourceCropHeight =
			sourceAspect > targetAspect ? sourceHeight : Math.round(sourceWidth / targetAspect);
		const sourceCropX = Math.max(0, Math.round((sourceWidth - sourceCropWidth) / 2));
		const sourceCropY = Math.max(0, Math.round((sourceHeight - sourceCropHeight) / 2));
		ctx.save();
		drawCanvasClipPath(
			ctx as unknown as CanvasRenderingContext2D,
			webcamRect.x,
			webcamRect.y,
			webcamRect.width,
			webcamRect.height,
			shape,
			webcamRect.borderRadius,
		);
		if (preset.shadow) {
			ctx.shadowColor = preset.shadow.color;
			ctx.shadowBlur = preset.shadow.blur;
			ctx.shadowOffsetX = preset.shadow.offsetX;
			ctx.shadowOffsetY = preset.shadow.offsetY;
		}
		ctx.fillStyle = "#000000";
		ctx.fill();
		ctx.clip();
		ctx.drawImage(
			webcamBitmap as unknown as CanvasImageSource,
			sourceCropX,
			sourceCropY,
			sourceCropWidth,
			sourceCropHeight,
			webcamRect.x,
			webcamRect.y,
			webcamRect.width,
			webcamRect.height,
		);
		ctx.restore();
	}
}

// ─── Render a Single Frame ───────────────────────────────────────────────────

async function renderFrame(
	videoBitmap: ImageBitmap,
	timestamp: number,
	webcamBitmap?: ImageBitmap | null,
	timing?: FrameTiming,
	outputFormat: "bitmap" | "rgba" = "bitmap",
): Promise<void> {
	if (!app || !videoContainer || !cameraContainer || !config) {
		throw new Error("Worker renderer not initialized");
	}

	currentVideoTime = timestamp / 1000000;

	if (!videoSprite) {
		const texture = Texture.from(videoBitmap as unknown as import("pixi.js").TextureSourceLike);
		videoSprite = new Sprite(texture);
		videoContainer.addChild(videoSprite);
	} else {
		const oldTexture = videoSprite.texture;
		const newTexture = Texture.from(videoBitmap as unknown as import("pixi.js").TextureSourceLike);
		videoSprite.texture = newTexture;
		oldTexture.destroy(true);
	}

	updateLayout(webcamBitmap);

	const timeMs = currentVideoTime * 1000;
	const TICKS_PER_FRAME = 1;

	let maxMotionIntensity = 0;
	for (let i = 0; i < TICKS_PER_FRAME; i++) {
		const motionIntensity = updateAnimationState(timeMs);
		maxMotionIntensity = Math.max(maxMotionIntensity, motionIntensity);
	}

	const lc = layoutCache;
	if (!lc) {
		throw new Error("Layout cache not initialized");
	}

	applyZoomTransform({
		cameraContainer,
		blurFilter,
		motionBlurFilter,
		stageSize: lc.stageSize,
		baseMask: lc.maskRect,
		zoomScale: animationState!.scale,
		zoomProgress: animationState!.progress,
		focusX: animationState!.focusX,
		focusY: animationState!.focusY,
		motionIntensity: maxMotionIntensity,
		isPlaying: true,
		motionBlurAmount: config.motionBlurAmount ?? 0,
		motionBlurState,
		frameTimeMs: timeMs,
	});

	let stageStart = timing ? performance.now() : 0;
	app.renderer.render(app.stage);
	if (timing) {
		const now = performance.now();
		timing.pixi += now - stageStart;
		stageStart = now;
	}

	// Fast path: rgba output + nothing that needs the 2D canvas. Skip the
	// composite + cursor + annotations entirely; the WebGL framebuffer already
	// holds the final frame and the rgba branch will gl.readPixels it.
	const skip2D = fastPath && outputFormat === "rgba";

	if (!skip2D) {
		compositeWithShadows(webcamBitmap);
	}
	if (timing) {
		const now = performance.now();
		timing.composite += now - stageStart;
		stageStart = now;
	}

	if (
		!skip2D &&
		config.cursorHighlight?.enabled &&
		config.cursorTelemetry &&
		config.cursorTelemetry.length > 0 &&
		compositeCtx
	) {
		const emphasisAlpha = clickEmphasisAlpha(
			timeMs,
			config.cursorClickTimestamps,
			config.cursorHighlight,
		);
		const cursorPoint =
			emphasisAlpha > 0 ? interpolateCursorAtSmooth(config.cursorTelemetry, timeMs) : null;
		if (cursorPoint) {
			const cx = cursorPoint.cx + config.cursorHighlight.offsetXNorm;
			const cy = cursorPoint.cy + config.cursorHighlight.offsetYNorm;
			const stageX = lc.baseOffset.x + cx * config.videoWidth * lc.baseScale;
			const stageY = lc.baseOffset.y + cy * config.videoHeight * lc.baseScale;
			const appliedScale = animationState!.appliedScale;
			const canvasX = stageX * appliedScale + animationState!.x;
			const canvasY = stageY * appliedScale + animationState!.y;
			const previewW = config.previewWidth ?? config.width;
			const previewH = config.previewHeight ?? config.height;
			const cursorScale = (config.width / previewW + config.height / previewH) / 2;
			drawCursorHighlightCanvas(
				compositeCtx as unknown as CanvasRenderingContext2D,
				canvasX,
				canvasY,
				{
					...config.cursorHighlight,
					opacity: config.cursorHighlight.opacity * emphasisAlpha,
				},
				appliedScale * cursorScale,
			);
		}
	}

	if (!skip2D && config.annotationRegions && config.annotationRegions.length > 0 && compositeCtx) {
		const previewWidth = config.previewWidth ?? config.width;
		const previewHeight = config.previewHeight ?? config.height;
		const scaleX = config.width / previewWidth;
		const scaleY = config.height / previewHeight;
		const scaleFactor = (scaleX + scaleY) / 2;

		await renderAnnotations(
			compositeCtx as unknown as CanvasRenderingContext2D,
			config.annotationRegions,
			config.width,
			config.height,
			timeMs,
			scaleFactor,
		);
	}

	if (
		!skip2D &&
		config.showKeystrokes &&
		config.keystrokes &&
		config.keystrokes.length > 0 &&
		compositeCtx
	) {
		const previewWidth = config.previewWidth ?? config.width;
		const previewHeight = config.previewHeight ?? config.height;
		const scaleFactor = (config.width / previewWidth + config.height / previewHeight) / 2;
		renderKeystrokeOverlay(compositeCtx as unknown as CanvasRenderingContext2D, config.keystrokes, {
			canvasWidth: config.width,
			canvasHeight: config.height,
			scaleFactor,
			currentTimeMs: timeMs,
		});
	}

	if (timing) {
		timing.extras += performance.now() - stageStart;
	}
}

// ─── Initialize Worker ───────────────────────────────────────────────────────

async function initializeWorker(cfg: WorkerRenderConfig, canvas: OffscreenCanvas): Promise<void> {
	config = cfg;
	isLinux = cfg.platform === "linux";

	animationState = {
		scale: 1,
		focusX: DEFAULT_FOCUS.cx,
		focusY: DEFAULT_FOCUS.cy,
		progress: 0,
		x: 0,
		y: 0,
		appliedScale: 1,
	};

	// Initialize PixiJS on the OffscreenCanvas
	app = new Application();
	await app.init({
		canvas: canvas as unknown as HTMLCanvasElement,
		width: cfg.width,
		height: cfg.height,
		backgroundAlpha: 0,
		antialias: true,
		resolution: 1,
		autoDensity: false, // Workers have no window.devicePixelRatio
	});

	cameraContainer = new Container();
	videoContainer = new Container();
	app.stage.addChild(cameraContainer);
	cameraContainer.addChild(videoContainer);

	await setupBackground(cfg);

	// Decide if we can take the fast path: render the entire frame in PixiJS
	// and read pixels back via WebGL extract instead of going through a 2D
	// composite canvas. Disqualifying features below all need 2D compositing.
	const hasAnnotations = !!(cfg.annotationRegions && cfg.annotationRegions.length > 0);
	bgInPixi = !cfg.showShadow; // shadow needs to slot between bg and video on 2D
	fastPath = bgInPixi && !cfg.webcamSize && !cfg.cursorHighlight?.enabled && !hasAnnotations;

	if (bgInPixi && backgroundSprite) {
		// Wrap the OffscreenCanvas wallpaper in a Pixi Texture and add as the
		// bottommost child of the stage so PixiJS produces a fully composed frame.
		const bgTexture = Texture.from(
			backgroundSprite as unknown as import("pixi.js").TextureSourceLike,
		);
		pixiBackgroundSprite = new Sprite(bgTexture);
		pixiBackgroundSprite.width = cfg.width;
		pixiBackgroundSprite.height = cfg.height;
		app.stage.addChildAt(pixiBackgroundSprite, 0);
	}

	console.log(
		`[renderWorker] init: bgInPixi=${bgInPixi}, fastPath=${fastPath}` +
			` (shadow=${cfg.showShadow}, webcam=${!!cfg.webcamSize}, ` +
			`cursorHighlight=${!!cfg.cursorHighlight?.enabled}, annotations=${hasAnnotations})`,
	);

	blurFilter = new BlurFilter();
	blurFilter.quality = 5;
	blurFilter.resolution = app.renderer.resolution;
	blurFilter.blur = 0;
	motionBlurFilter = new MotionBlurFilter([0, 0], 5, 0);
	videoContainer.filters = [blurFilter, motionBlurFilter];

	compositeCanvas = new OffscreenCanvas(cfg.width, cfg.height);
	// Keep this GPU-backed (`willReadFrequently: false`) on every platform
	// except Linux. The export draws many ops per frame (video, shadow,
	// annotations, cursor) and reads once via getImageData. Flipping the
	// canvas to CPU-backed makes every drawImage/fill slow (verified: a
	// 1080p slow-path frame went from ~21 ms to ~68 ms total when we set
	// this to true) — the one slow read is cheaper than many slow draws.
	// Linux keeps the CPU backing because there's a separate GPU readback
	// bug there that produces empty frames; performance is a secondary
	// concern when correctness fails outright.
	compositeCtx = compositeCanvas.getContext("2d", {
		willReadFrequently: isLinux,
	}) as OffscreenCanvasRenderingContext2D | null;
	if (!compositeCtx) {
		throw new Error("Failed to get 2D context for composite canvas");
	}

	rasterCanvas = new OffscreenCanvas(cfg.width, cfg.height);
	rasterCtx = rasterCanvas.getContext("2d") as OffscreenCanvasRenderingContext2D | null;
	if (!rasterCtx) {
		throw new Error("Failed to get 2D context for raster canvas");
	}

	if (cfg.showShadow) {
		shadowCanvas = new OffscreenCanvas(cfg.width, cfg.height);
		shadowCtx = shadowCanvas.getContext("2d", {
			willReadFrequently: false,
		}) as OffscreenCanvasRenderingContext2D | null;
		if (!shadowCtx) {
			throw new Error("Failed to get 2D context for shadow canvas");
		}
	}

	maskGraphics = new Graphics();
	videoContainer.addChild(maskGraphics);
	videoContainer.mask = maskGraphics;
}

// ─── Destroy Worker ──────────────────────────────────────────────────────────

function destroyWorker(): void {
	if (videoSprite) {
		videoSprite.destroy();
		videoSprite = null;
	}
	if (pixiBackgroundSprite) {
		pixiBackgroundSprite.destroy();
		pixiBackgroundSprite = null;
	}
	backgroundSprite = null;
	bgInPixi = false;
	fastPath = false;
	if (app) {
		app.destroy(true, {
			children: true,
			texture: true,
			textureSource: true,
		});
		app = null;
	}
	cameraContainer = null;
	videoContainer = null;
	maskGraphics = null;
	blurFilter = null;
	motionBlurFilter = null;
	shadowCanvas = null;
	shadowCtx = null;
	compositeCanvas = null;
	compositeCtx = null;
	rasterCanvas = null;
	rasterCtx = null;
	config = null;
	animationState = null;
	layoutCache = null;
	motionBlurState = createMotionBlurState();
	smoothedAutoFocus = null;
	prevAnimationTimeMs = null;
	prevTargetProgress = 0;
}

// ─── Message Handler ─────────────────────────────────────────────────────────

self.onmessage = async (event: MessageEvent<WorkerMessage>) => {
	const msg = event.data;

	try {
		switch (msg.type) {
			case "init": {
				await initializeWorker(msg.config, msg.canvas);
				const response: WorkerResponse = { type: "init-done" };
				self.postMessage(response);
				break;
			}

			case "render": {
				const { job } = msg;
				const timing: FrameTiming = { pixi: 0, composite: 0, extras: 0, readback: 0 };
				const fmt = job.outputFormat ?? "bitmap";
				await renderFrame(job.videoBitmap, job.timestamp, job.webcamBitmap, timing, fmt);

				if (!compositeCanvas) {
					throw new Error("Composite canvas not initialized");
				}

				const readbackStart = performance.now();

				if (fmt === "rgba") {
					let rgba: Uint8Array;
					let outWidth: number;
					let outHeight: number;

					if (fastPath && app) {
						// Fast path: gl.readPixels via Pixi extract — bypasses the 2D
						// canvas roundtrip entirely. Returns a Uint8ClampedArray; we
						// reinterpret the same buffer as Uint8Array to transfer it.
						//
						// `frame` clips extraction to the canvas dimensions. Without
						// it, extract.pixels(stage) returns the stage's bounding box,
						// which grows past cfg.height whenever a zoom region scales
						// content past the canvas edges — producing oversized frames
						// that ffmpeg rejects ("frame N has X bytes, expected Y").
						const out = app.renderer.extract.pixels({
							target: app.stage,
							frame: new Rectangle(0, 0, config!.width, config!.height),
						});
						const pixels = out.pixels as Uint8ClampedArray;
						rgba = new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength);
						outWidth = out.width;
						outHeight = out.height;
					} else {
						// Slow path: 2D canvas readback (used when shadow / webcam /
						// cursor / annotations need the 2D composite).
						if (!compositeCtx) {
							throw new Error("Composite 2d context not initialized");
						}
						const imageData = compositeCtx.getImageData(
							0,
							0,
							compositeCanvas.width,
							compositeCanvas.height,
						);
						rgba = new Uint8Array(imageData.data.buffer);
						outWidth = compositeCanvas.width;
						outHeight = compositeCanvas.height;
					}

					const result: RenderResult = {
						frameIndex: job.frameIndex,
						rgba,
						width: outWidth,
						height: outHeight,
					};
					timing.readback = performance.now() - readbackStart;
					const response: WorkerResponse = { type: "render-done", result, timing };
					(self.postMessage as (message: unknown, transfer: Transferable[]) => void)(response, [
						rgba.buffer,
					]);
				} else {
					// Hand off the composite canvas backbuffer as an ImageBitmap with no copy.
					// transferToImageBitmap() detaches the current backbuffer; PixiJS will
					// fully redraw the next frame so the cleared canvas is fine.
					const bitmap = compositeCanvas.transferToImageBitmap();
					const result: RenderResult = {
						frameIndex: job.frameIndex,
						bitmap,
					};
					timing.readback = performance.now() - readbackStart;
					const response: WorkerResponse = { type: "render-done", result, timing };
					(self.postMessage as (message: unknown, transfer: Transferable[]) => void)(response, [
						bitmap,
					]);
				}
				break;
			}

			case "reset": {
				destroyWorker();
				const response: WorkerResponse = { type: "init-done" };
				self.postMessage(response);
				break;
			}

			case "destroy": {
				destroyWorker();
				const response: WorkerResponse = { type: "destroy-done" };
				self.postMessage(response);
				break;
			}
		}
	} catch (error) {
		const response: WorkerResponse = {
			type: "error",
			message: error instanceof Error ? error.message : String(error),
		};
		self.postMessage(response);
	}
};
