/**
 * Staged export pipeline. Replaces the old `drainOne` mess in videoExporter.ts.
 *
 *     StreamingDecoder ──▶ [renderQueue] ──▶ WorkerPool (N workers) ──▶ encoder.encode
 *            │                                                                │
 *            └────────── webcam queue ─────────────────────────────────────────┘
 *
 *  - Each stage has bounded backpressure (decoder pushes wait when queue full).
 *  - Worker pool runs N renders in parallel; results are awaited in submission
 *    order so frames hit ffmpeg in order.
 *  - Audio extraction runs in parallel with the video encode (independent
 *    ffmpeg subprocess reading from the source file).
 *  - Encoder is the TCP-fed FfmpegVideoEncoder — no per-frame IPC.
 *
 * The whole pipeline is one class with a single `run()` entry point so callers
 * don't have to thread through four lifecycle methods.
 */

import type {
	AnnotationRegion,
	CropRegion,
	SpeedRegion,
	TrimRegion,
	WebcamLayoutPreset,
	WebcamSizePreset,
} from "@/components/video-editor/types";
import { BackgroundLoadError } from "@/lib/wallpaper";
import { getPlatform } from "@/utils/platformUtils";
import { AsyncVideoFrameQueue } from "./asyncVideoFrameQueue";
import { FfmpegVideoEncoder, imageBitmapToRgbaBytes } from "./ffmpegVideoEncoder";
import type { RenderResult, WorkerRenderConfig } from "./renderWorker";
import { StreamingVideoDecoder } from "./streamingDecoder";
import type { ExportProgress } from "./types";
import { WorkerPool } from "./workerPool";

export interface PipelineConfig {
	videoUrl: string;
	webcamVideoUrl?: string;
	width: number;
	height: number;
	frameRate: number;
	bitrate: number;
	codec?: string;
	wallpaper: string;
	zoomRegions: import("@/components/video-editor/types").ZoomRegion[];
	trimRegions?: TrimRegion[];
	speedRegions?: SpeedRegion[];
	showShadow: boolean;
	shadowIntensity: number;
	showBlur: boolean;
	motionBlurAmount?: number;
	borderRadius?: number;
	padding?: number;
	cropRegion: CropRegion;
	webcamLayoutPreset?: WebcamLayoutPreset;
	webcamMaskShape?: import("@/components/video-editor/types").WebcamMaskShape;
	webcamSizePreset?: WebcamSizePreset;
	webcamPosition?: { cx: number; cy: number } | null;
	annotationRegions?: AnnotationRegion[];
	previewWidth?: number;
	previewHeight?: number;
	cursorTelemetry?: import("@/components/video-editor/types").CursorTelemetryPoint[];
	cursorHighlight?: import("@/components/video-editor/videoPlayback/cursorHighlight").CursorHighlightConfig;
	cursorClickTimestamps?: number[];
	onProgress?: (progress: ExportProgress) => void;
}

export interface PipelineResult {
	success: boolean;
	blob?: Blob;
	error?: string;
	warnings?: string[];
}

/**
 * In-flight FIFO for the render stage. Each entry is a frame submitted to the
 * worker pool. The encode consumer pops the oldest, awaits its result, sends
 * to ffmpeg, repeat. The bounded length naturally throttles the producer
 * (decoder callback) — push() awaits when the FIFO is full.
 */
class BoundedFifo<T> {
	private items: T[] = [];
	private waitingPushers: Array<() => void> = [];
	private waitingPoppers: Array<(item: T) => void> = [];
	private closed = false;

	constructor(private readonly capacity: number) {}

	get size(): number {
		return this.items.length;
	}

	async push(item: T): Promise<void> {
		if (this.closed) return;
		const popper = this.waitingPoppers.shift();
		if (popper) {
			popper(item);
			return;
		}
		while (this.items.length >= this.capacity && !this.closed) {
			await new Promise<void>((resolve) => this.waitingPushers.push(resolve));
		}
		if (this.closed) return;
		this.items.push(item);
	}

	pop(): Promise<T | null> {
		if (this.items.length > 0) {
			const item = this.items.shift()!;
			const pusher = this.waitingPushers.shift();
			if (pusher) pusher();
			return Promise.resolve(item);
		}
		if (this.closed) return Promise.resolve(null);
		return new Promise<T | null>((resolve) => {
			this.waitingPoppers.push((item) => resolve(item));
		});
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		// Drop any pending push waiters — they'll see closed=true on resume.
		const pushers = this.waitingPushers.splice(0);
		for (const p of pushers) p();
		// Pop waiters get null to signal end-of-stream.
		const poppers = this.waitingPoppers.splice(0);
		for (const p of poppers) (p as unknown as (item: T | null) => void)(null);
	}
}

interface InFlightFrame {
	frameIndex: number;
	promise: Promise<RenderResult>;
}

export class ExportPipeline {
	private cancelled = false;
	private fatalError: Error | null = null;
	private warnings: string[] = [];

	private decoder: StreamingVideoDecoder | null = null;
	private webcamDecoder: StreamingVideoDecoder | null = null;
	private workerPool: WorkerPool | null = null;
	private encoder: FfmpegVideoEncoder | null = null;
	private readbackCanvas: OffscreenCanvas | null = null;

	private completedFrames = 0;
	private totalFrames = 0;
	private frameTimestamps: number[] = [];
	private static readonly FPS_WINDOW = 30;

	/**
	 * Resolved at setup time. `config.frameRate` is a maximum — if the source
	 * recording is 30 fps and the user asks for 60, exporting at 60 just
	 * duplicates every frame and doubles the render+encode work for zero
	 * visual benefit. We clamp to the source rate. Set in runInternal().
	 */
	private effectiveFrameRate = 60;

	constructor(private readonly config: PipelineConfig) {}

	cancel(): void {
		this.cancelled = true;
		this.decoder?.cancel();
		this.webcamDecoder?.cancel();
		void this.encoder?.cancel().catch(() => undefined);
	}

	async run(): Promise<PipelineResult> {
		try {
			const blob = await this.runInternal();
			return {
				success: true,
				blob,
				warnings: this.warnings.length > 0 ? this.warnings : undefined,
			};
		} catch (err) {
			if (err instanceof BackgroundLoadError) throw err;
			if (this.cancelled) return { success: false, error: "Export cancelled" };
			const message = err instanceof Error ? err.message : String(err);
			return { success: false, error: message };
		} finally {
			await this.cleanup();
		}
	}

	private async runInternal(): Promise<Blob> {
		// ── 1. Setup ────────────────────────────────────────────────────────
		const platform = await getPlatform();

		this.decoder = new StreamingVideoDecoder();
		const videoInfo = await this.decoder.loadMetadata(this.config.videoUrl);

		// Clamp the requested export fps to the source fps. A 30 fps recording
		// exported at 60 fps would generate one duplicate frame for every real
		// frame and double the workload of every downstream stage.
		const sourceFps = videoInfo.frameRate || this.config.frameRate;
		this.effectiveFrameRate = Math.min(this.config.frameRate, Math.round(sourceFps));
		if (this.effectiveFrameRate !== this.config.frameRate) {
			console.log(
				`[ExportPipeline] Snapping export fps ${this.config.frameRate} → ${this.effectiveFrameRate} ` +
					`(source is ${sourceFps.toFixed(1)} fps; exporting higher just duplicates frames)`,
			);
		}

		let webcamInfo: Awaited<ReturnType<StreamingVideoDecoder["loadMetadata"]>> | null = null;
		if (this.config.webcamVideoUrl) {
			this.webcamDecoder = new StreamingVideoDecoder();
			webcamInfo = await this.webcamDecoder.loadMetadata(this.config.webcamVideoUrl);
		}

		this.workerPool = new WorkerPool();
		await this.workerPool.initialize(
			this.buildWorkerRenderConfig(
				videoInfo.width,
				videoInfo.height,
				webcamInfo?.width,
				webcamInfo?.height,
				platform,
			),
		);

		this.encoder = new FfmpegVideoEncoder();
		await this.encoder.start({
			width: this.config.width,
			height: this.config.height,
			frameRate: this.effectiveFrameRate,
			bitrate: this.config.bitrate,
		});

		const { totalFrames } = this.decoder.getExportMetrics(
			this.effectiveFrameRate,
			this.config.trimRegions,
			this.config.speedRegions,
		);
		this.totalFrames = totalFrames;

		// ── 2. Run video + webcam + audio concurrently ─────────────────────
		const webcamFrameQueue = this.config.webcamVideoUrl ? new AsyncVideoFrameQueue() : null;

		const webcamDecodePromise = webcamFrameQueue
			? this.runWebcamDecode(webcamFrameQueue)
			: Promise.resolve();

		// Kick off audio extraction in parallel with the video encode — it
		// reads the source file independently, so there's no reason to wait.
		const hasAudio = videoInfo.hasAudio;
		const audioPromise: Promise<ArrayBuffer | null> = hasAudio
			? this.extractAudio(videoInfo.duration)
			: Promise.resolve(null);

		try {
			await this.runVideoPipeline(webcamFrameQueue, videoInfo);
		} finally {
			webcamFrameQueue?.destroy();
			this.webcamDecoder?.cancel();
			await webcamDecodePromise.catch(() => undefined);
		}

		if (this.cancelled) throw new Error("Export cancelled");
		if (this.fatalError) throw this.fatalError;

		// ── 3. Finalize: close encoder, gather audio, mux, read result ─────
		this.reportProgress({
			currentFrame: this.totalFrames,
			totalFrames: this.totalFrames,
			percentage: 100,
			estimatedTimeRemaining: 0,
			phase: "finalizing",
			workerEngine: "worker-pool",
		});

		const tempVideoPath = await this.encoder.finish();

		this.reportProgress({
			currentFrame: this.totalFrames,
			totalFrames: this.totalFrames,
			percentage: 100,
			estimatedTimeRemaining: 0,
			phase: "audio",
			workerEngine: "worker-pool",
		});

		const audioBytes = await audioPromise.catch((err) => {
			console.warn("[ExportPipeline] audio extraction failed, exporting without audio:", err);
			return null;
		});

		if (audioBytes !== null) {
			this.reportProgress({
				currentFrame: this.totalFrames,
				totalFrames: this.totalFrames,
				percentage: 100,
				estimatedTimeRemaining: 0,
				phase: "audio",
				audioEngine: "ffmpeg",
				workerEngine: "worker-pool",
			});
		}

		const finalTempPath = `${tempVideoPath}.final.mp4`;
		const muxResult = await window.electronAPI.videoEncoderMux({
			videoPath: tempVideoPath,
			audioBytes,
			outputPath: finalTempPath,
		});
		if (!muxResult.success) {
			throw new Error(muxResult.error || "ffmpeg mux failed");
		}

		const readResult = await window.electronAPI.videoEncoderReadAndDelete(finalTempPath);
		if (!readResult.success || !readResult.data) {
			throw new Error(readResult.error || "Failed to read final mp4");
		}

		return new Blob([readResult.data], { type: "video/mp4" });
	}

	/**
	 * Main stage: decoder feeds into a bounded in-flight FIFO of render
	 * promises; a consumer drains it in order, awaits each render, then
	 * pushes RGBA into the ffmpeg encoder. The two run in parallel: while
	 * the consumer waits on the oldest worker, the producer keeps submitting
	 * to the rest of the pool.
	 */
	private async runVideoPipeline(
		webcamFrameQueue: AsyncVideoFrameQueue | null,
		_videoInfo: Awaited<ReturnType<StreamingVideoDecoder["loadMetadata"]>>,
	): Promise<void> {
		const pool = this.workerPool!;
		const encoder = this.encoder!;
		// Cap the in-flight FIFO at 2× worker count so each worker always has
		// a fresh job queued without ballooning memory.
		const inFlight = new BoundedFifo<InFlightFrame>(pool.workerCount * 2);
		let frameIndex = 0;
		const frameDurationUs = 1_000_000 / this.effectiveFrameRate;
		const expectedBytesPerFrame = this.config.width * this.config.height * 4;

		// Consumer task: pops oldest frame in submission order, awaits its
		// render result, hands the bytes to ffmpeg. Runs as long as the
		// producer keeps feeding the FIFO.
		const consumer = (async () => {
			while (true) {
				const next = await inFlight.pop();
				if (next === null) return;
				if (this.cancelled || this.fatalError) return;

				let renderResult: RenderResult;
				try {
					renderResult = await next.promise;
				} catch (err) {
					this.fatalError = err instanceof Error ? err : new Error(String(err));
					return;
				}
				if (this.cancelled) {
					if ("bitmap" in renderResult) renderResult.bitmap.close();
					return;
				}

				let rgbaBytes: Uint8Array;
				if ("rgba" in renderResult) {
					rgbaBytes = renderResult.rgba;
				} else {
					// A worker returned a bitmap instead of bytes — readback on
					// the main thread. Shouldn't happen because we ask for rgba,
					// but fall back gracefully.
					const { bytes, canvas } = imageBitmapToRgbaBytes(
						renderResult.bitmap,
						this.readbackCanvas ?? undefined,
					);
					this.readbackCanvas = canvas;
					rgbaBytes = bytes;
				}

				if (rgbaBytes.byteLength !== expectedBytesPerFrame) {
					this.fatalError = new Error(
						`Frame ${next.frameIndex} has ${rgbaBytes.byteLength} bytes, ` +
							`expected ${expectedBytesPerFrame} (${this.config.width}x${this.config.height} RGBA). ` +
							"Worker rendered at wrong size.",
					);
					return;
				}

				try {
					await encoder.encode(rgbaBytes);
				} catch (err) {
					this.fatalError = err instanceof Error ? err : new Error(String(err));
					return;
				}

				this.completedFrames++;
				const { fps, estimatedTimeRemaining } = this.computeFpsAndEta(this.completedFrames);
				this.reportProgress({
					currentFrame: this.completedFrames,
					totalFrames: this.totalFrames,
					percentage: (this.completedFrames / this.totalFrames) * 100,
					estimatedTimeRemaining,
					fps,
					workerEngine: "worker-pool",
				});

				if (this.completedFrames % 60 === 0) {
					const t = pool.getTiming();
					if (t.frames > 0) {
						const avg = (n: number) => (n / t.frames).toFixed(1);
						console.log(
							`[ExportPipeline] worker avg/frame: pixi=${avg(t.totals.pixi)}ms ` +
								`composite=${avg(t.totals.composite)}ms ` +
								`extras=${avg(t.totals.extras)}ms ` +
								`readback=${avg(t.totals.readback)}ms ` +
								`(${t.frames} samples across ${pool.workerCount} workers)`,
						);
					}
				}
			}
		})();

		// Producer: decoder callback prepares bitmaps and submits to the pool.
		// pool.renderFrame transfers the bitmaps to a worker, so once submitted
		// we must NOT close them on this side — the worker owns them.
		const onWarning = (message: string) => this.warnings.push(message);

		try {
			await this.decoder!.decodeAll(
				this.effectiveFrameRate,
				this.config.trimRegions,
				this.config.speedRegions,
				async (videoFrame, _exportTimestampUs, sourceTimestampMs) => {
					let webcamFrame: VideoFrame | null = null;
					let videoBitmap: ImageBitmap | null = null;
					let webcamBitmap: ImageBitmap | null = null;
					try {
						if (this.cancelled || this.fatalError) {
							videoFrame.close();
							return;
						}

						webcamFrame = webcamFrameQueue ? await webcamFrameQueue.dequeue() : null;
						if (this.cancelled) return;

						videoBitmap = await createImageBitmap(videoFrame);
						if (webcamFrame) {
							webcamBitmap = await createImageBitmap(webcamFrame);
						}

						const idx = frameIndex++;
						const timestamp = idx * frameDurationUs;

						const promise = pool.renderFrame({
							frameIndex: idx,
							videoBitmap,
							timestamp,
							sourceTimestampMs,
							webcamBitmap,
							outputFormat: "rgba",
						});
						// Bitmaps were transferred to the worker — null out so
						// the finally block doesn't double-close them.
						videoBitmap = null;
						webcamBitmap = null;

						await inFlight.push({ frameIndex: idx, promise });
					} finally {
						videoFrame.close();
						webcamFrame?.close();
						videoBitmap?.close();
						webcamBitmap?.close();
					}
				},
				onWarning,
			);
		} catch (err) {
			this.fatalError = err instanceof Error ? err : new Error(String(err));
			throw err;
		} finally {
			// Signal end-of-stream to the consumer and wait for it to drain.
			inFlight.close();
			await consumer;
		}

		if (this.fatalError) throw this.fatalError;
	}

	private async runWebcamDecode(queue: AsyncVideoFrameQueue): Promise<void> {
		if (!this.webcamDecoder) return;
		const onWarning = (msg: string) => this.warnings.push(msg);
		try {
			await this.webcamDecoder.decodeAll(
				this.effectiveFrameRate,
				this.config.trimRegions,
				this.config.speedRegions,
				async (webcamFrame) => {
					while (queue.length >= 12 && !this.cancelled) {
						await new Promise((r) => setTimeout(r, 2));
					}
					if (this.cancelled) {
						webcamFrame.close();
						return;
					}
					queue.enqueue(webcamFrame);
				},
				onWarning,
			);
			queue.close();
		} catch (err) {
			queue.fail(err instanceof Error ? err : new Error(String(err)));
		}
	}

	private async extractAudio(durationSec: number): Promise<ArrayBuffer | null> {
		try {
			return await window.electronAPI.ffmpegProcessAudio({
				videoPath: this.config.videoUrl,
				trimRegions: this.config.trimRegions ?? [],
				speedRegions: this.config.speedRegions ?? [],
				durationMs: durationSec * 1000,
			});
		} catch (err) {
			console.warn("[ExportPipeline] ffmpeg audio extraction failed:", err);
			return null;
		}
	}

	private buildWorkerRenderConfig(
		videoWidth: number,
		videoHeight: number,
		webcamWidth: number | undefined,
		webcamHeight: number | undefined,
		platform: string,
	): WorkerRenderConfig {
		return {
			width: this.config.width,
			height: this.config.height,
			wallpaper: this.config.wallpaper,
			zoomRegions: this.config.zoomRegions,
			showShadow: this.config.showShadow,
			shadowIntensity: this.config.shadowIntensity,
			showBlur: this.config.showBlur,
			motionBlurAmount: this.config.motionBlurAmount,
			borderRadius: this.config.borderRadius,
			padding: this.config.padding,
			cropRegion: this.config.cropRegion,
			videoWidth,
			videoHeight,
			webcamSize: webcamWidth && webcamHeight ? { width: webcamWidth, height: webcamHeight } : null,
			webcamLayoutPreset: this.config.webcamLayoutPreset,
			webcamMaskShape: this.config.webcamMaskShape,
			webcamSizePreset: this.config.webcamSizePreset,
			webcamPosition: this.config.webcamPosition,
			annotationRegions: this.config.annotationRegions,
			speedRegions: this.config.speedRegions,
			previewWidth: this.config.previewWidth,
			previewHeight: this.config.previewHeight,
			cursorTelemetry: this.config.cursorTelemetry,
			cursorHighlight: this.config.cursorHighlight,
			cursorClickTimestamps: this.config.cursorClickTimestamps,
			platform,
		};
	}

	private computeFpsAndEta(framesDone: number): {
		fps: number;
		estimatedTimeRemaining: number;
	} {
		const now = Date.now();
		this.frameTimestamps.push(now);
		if (this.frameTimestamps.length > ExportPipeline.FPS_WINDOW) {
			this.frameTimestamps.shift();
		}
		if (this.frameTimestamps.length < 2) {
			return { fps: 0, estimatedTimeRemaining: 0 };
		}
		const windowMs =
			this.frameTimestamps[this.frameTimestamps.length - 1] - this.frameTimestamps[0];
		const fps = ((this.frameTimestamps.length - 1) / windowMs) * 1000;
		const remaining = this.totalFrames - framesDone;
		return {
			fps: Math.round(fps),
			estimatedTimeRemaining: fps > 0 ? remaining / fps : 0,
		};
	}

	private reportProgress(progress: ExportProgress): void {
		const encoderTag = this.encoder?.activeEncoder ?? undefined;
		const enriched: ExportProgress = progress.videoEncoder
			? progress
			: { ...progress, videoEncoder: encoderTag };
		this.config.onProgress?.(enriched);
	}

	private async cleanup(): Promise<void> {
		this.readbackCanvas = null;

		if (this.encoder) {
			try {
				if (this.encoder.inFlightActive) {
					await this.encoder.cancel();
				}
			} catch (err) {
				console.warn("[ExportPipeline] encoder cleanup error:", err);
			}
			this.encoder = null;
		}

		if (this.decoder) {
			try {
				this.decoder.destroy();
			} catch (err) {
				console.warn("[ExportPipeline] decoder cleanup error:", err);
			}
			this.decoder = null;
		}

		if (this.webcamDecoder) {
			try {
				this.webcamDecoder.destroy();
			} catch (err) {
				console.warn("[ExportPipeline] webcam decoder cleanup error:", err);
			}
			this.webcamDecoder = null;
		}

		if (this.workerPool) {
			try {
				this.workerPool.destroy();
			} catch (err) {
				console.warn("[ExportPipeline] worker pool cleanup error:", err);
			}
			this.workerPool = null;
		}
	}
}
