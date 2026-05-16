/**
 * WorkerPool — manages a pool of OffscreenCanvas render workers for parallel
 * PixiJS frame rendering during video export.
 *
 * Workers are initialized once with the render config and an OffscreenCanvas.
 * Frames are distributed round-robin across workers. Results are collected
 * in frame order so the encoder receives them sequentially.
 *
 * VideoFrame objects cannot be transferred to workers, so the main thread
 * converts them to ImageBitmaps (which are transferable) before sending.
 */

import type { FrameTiming, RenderJob, RenderResult, WorkerRenderConfig } from "./renderWorker";

export interface WorkerPoolOptions {
	/** Number of workers to spawn. Defaults to navigator.hardwareConcurrency - 1. */
	workerCount?: number;
	/** Maximum number of pending (in-flight) frames per worker. */
	maxPendingPerWorker?: number;
}

interface WorkerEntry {
	worker: Worker;
	/** Frames currently being rendered by this worker, keyed by frameIndex. */
	pending: Map<number, { resolve: (result: RenderResult) => void; reject: (error: Error) => void }>;
}

export interface AggregatedTiming {
	frames: number;
	totals: FrameTiming;
}

export class WorkerPool {
	private workers: WorkerEntry[] = [];
	private config: WorkerRenderConfig | null = null;
	private initialized = false;
	private destroyed = false;
	private timing: AggregatedTiming = {
		frames: 0,
		totals: { pixi: 0, composite: 0, extras: 0, readback: 0 },
	};
	/** Queue of frames waiting for a free worker. */
	private pendingJobs: Array<{
		job: RenderJob;
		resolve: (result: RenderResult) => void;
		reject: (error: Error) => void;
	}> = [];
	/** Results that arrived out of order, keyed by frameIndex. */
	private outOfOrderResults: Map<number, RenderResult> = new Map();
	private initPromise: Promise<void> | null = null;
	private initResolve: (() => void) | null = null;
	private initReject: ((error: Error) => void) | null = null;

	constructor(private options: WorkerPoolOptions = {}) {}

	get isInitialized(): boolean {
		return this.initialized;
	}

	/** Number of workers currently spawned in the pool. */
	get workerCount(): number {
		return this.workers.length;
	}

	/** Snapshot of accumulated per-stage worker timing. */
	getTiming(): AggregatedTiming {
		return {
			frames: this.timing.frames,
			totals: { ...this.timing.totals },
		};
	}

	/** Reset the accumulated timing — useful when switching modes mid-export. */
	resetTiming(): void {
		this.timing = {
			frames: 0,
			totals: { pixi: 0, composite: 0, extras: 0, readback: 0 },
		};
	}

	/**
	 * Initialize the worker pool. Creates OffscreenCanvases and spawns workers.
	 * @param config The render configuration shared by all workers.
	 */
	async initialize(config: WorkerRenderConfig): Promise<void> {
		if (this.initialized) return;
		if (this.initPromise) return this.initPromise;

		this.config = config;
		this.initPromise = new Promise<void>((resolve, reject) => {
			this.initResolve = resolve;
			this.initReject = reject;
		});

		// Platform-aware worker count:
		//   Windows: ANGLE D3D11 serializes gl.readPixels across contexts, so
		//   wall-clock throughput stays roughly flat past N=2 for the readback
		//   itself. Two more workers (N=4) still help because each one can
		//   overlap composite/extras/postMessage work while another waits on a
		//   serialized readback, and we have plenty of cores on a modern box.
		//   macOS Metal: no such serialization. More workers ≈ linearly faster.
		//   Override via options for testing.
		const hwConcurrency = navigator.hardwareConcurrency || 4;
		const isMac =
			typeof navigator !== "undefined" && /\bMac(intosh| OS X)/i.test(navigator.userAgent);
		const maxWorkers = isMac ? 6 : 4;
		const workerCount =
			this.options.workerCount ?? Math.max(2, Math.min(maxWorkers, hwConcurrency - 1));

		console.log(`[WorkerPool] Spawning ${workerCount} render workers`);

		const initPromises: Promise<void>[] = [];

		for (let i = 0; i < workerCount; i++) {
			const promise = this.spawnWorker(i);
			initPromises.push(promise);
		}

		try {
			await Promise.all(initPromises);
			this.initialized = true;
			this.initResolve!();
		} catch (error) {
			// Clean up any workers that did initialize
			for (const entry of this.workers) {
				entry.worker.terminate();
			}
			this.workers = [];
			this.initReject!(error instanceof Error ? error : new Error(String(error)));
		}

		return this.initPromise;
	}

	private async spawnWorker(index: number): Promise<void> {
		// Create an OffscreenCanvas for this worker
		const canvas = new OffscreenCanvas(this.config!.width, this.config!.height);

		// Create the worker using Vite's worker import syntax
		const WorkerConstructor = (await import("./renderWorker?worker")).default;
		const worker = new WorkerConstructor() as Worker;

		const entry: WorkerEntry = {
			worker,
			pending: new Map(),
		};

		this.workers.push(entry);

		return new Promise<void>((resolve, reject) => {
			const timeout = setTimeout(() => {
				reject(new Error(`Worker ${index} initialization timed out`));
			}, 30_000);

			worker.onmessage = (event: MessageEvent) => {
				const msg = event.data;
				if (msg.type === "init-done") {
					clearTimeout(timeout);
					worker.onmessage = this.handleWorkerMessage.bind(this, entry);
					resolve();
				} else if (msg.type === "error") {
					clearTimeout(timeout);
					reject(new Error(`Worker ${index} init error: ${msg.message}`));
				}
			};

			worker.onerror = (error) => {
				clearTimeout(timeout);
				reject(new Error(`Worker ${index} error: ${error.message}`));
			};

			// Transfer the OffscreenCanvas to the worker
			worker.postMessage({ type: "init", config: this.config!, canvas }, [canvas]);
		});
	}

	private handleWorkerMessage(entry: WorkerEntry, event: MessageEvent): void {
		const msg = event.data;

		if (msg.type === "render-done") {
			const result = msg.result as RenderResult;
			const t = msg.timing as FrameTiming | undefined;
			if (t) {
				this.timing.frames++;
				this.timing.totals.pixi += t.pixi;
				this.timing.totals.composite += t.composite;
				this.timing.totals.extras += t.extras;
				this.timing.totals.readback += t.readback;
			}
			const pending = entry.pending.get(result.frameIndex);
			if (pending) {
				entry.pending.delete(result.frameIndex);
				pending.resolve(result);
			}
			this.processQueue();
		} else if (msg.type === "error") {
			console.error(`[WorkerPool] Worker error: ${msg.message}`);
			for (const [, pending] of entry.pending) {
				pending.reject(new Error(msg.message));
			}
			entry.pending.clear();
			this.processQueue();
		}
	}

	/**
	 * Submit a render job to the pool. Returns a promise that resolves with
	 * the rendered ImageBitmap when the frame is complete.
	 *
	 * Frames are guaranteed to resolve in order — if frame 5 completes before
	 * frame 4, it will be buffered until frame 4 is also ready.
	 */
	async renderFrame(job: RenderJob): Promise<RenderResult> {
		if (this.destroyed) {
			throw new Error("WorkerPool has been destroyed");
		}
		if (!this.initialized) {
			throw new Error("WorkerPool not initialized");
		}

		return new Promise<RenderResult>((resolve, reject) => {
			this.pendingJobs.push({ job, resolve, reject });
			this.processQueue();
		});
	}

	private processQueue(): void {
		if (this.destroyed) return;

		while (this.pendingJobs.length > 0) {
			const maxPending = this.options.maxPendingPerWorker ?? 4;
			const availableWorker = this.workers.find((w) => w.pending.size < maxPending);

			if (!availableWorker) break;

			const next = this.pendingJobs.shift();
			if (!next) break;

			availableWorker.pending.set(next.job.frameIndex, {
				resolve: next.resolve,
				reject: next.reject,
			});

			// Transfer ImageBitmaps to avoid copying pixel data (zero-copy)
			const transferables: Transferable[] = [next.job.videoBitmap];
			if (next.job.webcamBitmap) transferables.push(next.job.webcamBitmap);
			availableWorker.worker.postMessage({ type: "render", job: next.job }, transferables);
		}
	}

	/**
	 * Wait for all pending frames to complete and return results in order.
	 * This is used during the final flush of the export pipeline.
	 */
	async flush(): Promise<void> {
		// Wait until all workers have no pending frames and the job queue is empty
		while (this.pendingJobs.length > 0 || this.workers.some((w) => w.pending.size > 0)) {
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
	}

	/**
	 * Reset all workers (destroy and recreate them).
	 */
	async reset(config: WorkerRenderConfig): Promise<void> {
		this.destroy();
		this.initialized = false;
		this.outOfOrderResults.clear();
		this.pendingJobs = [];
		await this.initialize(config);
	}

	/**
	 * Destroy all workers and free resources.
	 */
	destroy(): void {
		this.destroyed = true;
		for (const entry of this.workers) {
			entry.worker.terminate();
		}
		this.workers = [];
		this.outOfOrderResults.clear();
		this.pendingJobs = [];
		this.initPromise = null;
		this.initResolve = null;
		this.initReject = null;
	}
}
