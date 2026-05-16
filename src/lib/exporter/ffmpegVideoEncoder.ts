/**
 * Renderer-side wrapper around the main-process ffmpeg encoder. Streams raw
 * RGBA frames over IPC to a child ffmpeg process, which encodes to a temp mp4
 * (video only). A second muxAudioVideo step combines that with the audio.
 *
 * Drop-in alternative to the WebCodecs VideoEncoder + VideoMuxer pair when the
 * Electron main process is available.
 */

export type FfmpegHwEncoder =
	| "h264_nvenc"
	| "h264_qsv"
	| "h264_amf"
	| "h264_videotoolbox"
	| "libx264";

export interface FfmpegEncoderOptions {
	width: number;
	height: number;
	frameRate: number;
	bitrate: number;
}

interface TcpTransport {
	send: (buf: ArrayBuffer) => boolean;
	drain: () => Promise<void>;
	close: () => Promise<void>;
}

export class FfmpegVideoEncoder {
	private sessionId: string | null = null;
	private encoder: FfmpegHwEncoder | null = null;
	private tempVideoPath: string | null = null;
	private fatalError: Error | null = null;
	private closed = false;
	/**
	 * Localhost TCP socket back to the encoder's pipe. When non-null, encode()
	 * writes frames straight to the socket — no IPC, no structured-clone, no
	 * per-frame ack — and the OS handles ordering + backpressure.
	 */
	private tcp: TcpTransport | null = null;
	/** Used only when the TCP transport fails to open (rare). */
	private nextFrameIndex = 0;
	private inFlight = new Set<Promise<void>>();
	private readonly MAX_IPC_IN_FLIGHT = 6;

	get activeEncoder(): FfmpegHwEncoder | null {
		return this.encoder;
	}

	get sessionPath(): string | null {
		return this.tempVideoPath;
	}

	get inFlightActive(): boolean {
		return this.sessionId !== null && !this.closed;
	}

	async start(opts: FfmpegEncoderOptions): Promise<void> {
		if (this.sessionId) throw new Error("FfmpegVideoEncoder already started");

		const result = await window.electronAPI.videoEncoderStart(opts);
		if (!result.success || !result.sessionId || !result.encoder || !result.tempVideoPath) {
			throw new Error(result.error || "Failed to start ffmpeg encoder");
		}
		this.sessionId = result.sessionId;
		this.encoder = result.encoder;
		this.tempVideoPath = result.tempVideoPath;
		this.nextFrameIndex = 0;
		this.inFlight.clear();
		this.tcp = null;

		// Try the localhost TCP transport — it skips Electron's IPC entirely.
		// If for any reason it can't be opened (sandbox-only build, port bind
		// race), we fall through to per-frame IPC which is still correct, just
		// slower.
		if (result.transportPort && window.electronAPI.videoEncoderConnectTransport) {
			try {
				const handle = await window.electronAPI.videoEncoderConnectTransport(result.transportPort);
				if (handle) {
					this.tcp = handle;
					console.log(
						`[FfmpegVideoEncoder] Using TCP loopback transport on port ${result.transportPort}`,
					);
				}
			} catch (err) {
				console.warn("[FfmpegVideoEncoder] TCP transport unavailable, falling back to IPC:", err);
			}
		}

		if (!this.tcp) {
			console.log(
				`[FfmpegVideoEncoder] Using parallel IPC transport (max ${this.MAX_IPC_IN_FLIGHT} in flight)`,
			);
		}
	}

	/**
	 * Submit one frame of RGBA bytes to ffmpeg. On the TCP fast-path the call
	 * is just a socket.write that returns immediately — only awaiting when the
	 * kernel buffer fills and we need to wait for drain. On the IPC fallback
	 * path, multiple writes pipeline in parallel and main re-orders by
	 * frameIndex.
	 */
	encode(rgba: Uint8Array): Promise<void> {
		if (!this.sessionId) throw new Error("FfmpegVideoEncoder not started");
		if (this.fatalError) return Promise.reject(this.fatalError);

		// Slice down to exactly the frame bytes — `rgba` may be a view of a
		// larger underlying buffer.
		const ab = rgba.buffer.slice(rgba.byteOffset, rgba.byteOffset + rgba.byteLength) as ArrayBuffer;

		if (this.tcp) {
			try {
				const ok = this.tcp.send(ab);
				if (!ok) {
					return this.tcp.drain();
				}
				return Promise.resolve();
			} catch (err) {
				const wrapped = err instanceof Error ? err : new Error(String(err));
				this.fatalError = wrapped;
				return Promise.reject(wrapped);
			}
		}

		// IPC fallback path.
		const sessionId = this.sessionId;
		const frameIndex = this.nextFrameIndex++;
		const writeP = window.electronAPI
			.videoEncoderWriteFrame(sessionId, ab, frameIndex)
			.then((result) => {
				if (!result.success) {
					const err = new Error(result.error || "videoEncoder:writeFrame failed");
					this.fatalError = err;
					throw err;
				}
			});

		this.inFlight.add(writeP);
		void writeP.finally(() => this.inFlight.delete(writeP)).catch(() => undefined);

		if (this.inFlight.size >= this.MAX_IPC_IN_FLIGHT) {
			return Promise.race(Array.from(this.inFlight)).catch(() => undefined);
		}
		return Promise.resolve();
	}

	/**
	 * Wait for all outstanding writes, close stdin, return the temp video path.
	 */
	async finish(): Promise<string> {
		if (!this.sessionId) throw new Error("FfmpegVideoEncoder not started");

		if (this.tcp) {
			// Drain any kernel-buffered bytes, then half-close the socket. Main's
			// pipe finishes forwarding to ffmpeg's stdin, and endEncode awaits
			// the socket close before signaling EOF — so every frame lands.
			try {
				await this.tcp.drain();
			} catch (err) {
				console.warn("[FfmpegVideoEncoder] TCP drain error before close:", err);
			}
			try {
				await this.tcp.close();
			} catch (err) {
				console.warn("[FfmpegVideoEncoder] TCP close error:", err);
			}
			this.tcp = null;
		} else {
			// Drain every in-flight IPC write so ffmpeg sees every frame before EOF.
			while (this.inFlight.size > 0) {
				await Promise.race(Array.from(this.inFlight)).catch(() => undefined);
				if (this.fatalError) break;
			}
		}

		const sessionId = this.sessionId;
		this.closed = true;

		const result = await window.electronAPI.videoEncoderEnd(sessionId);
		if (this.fatalError) throw this.fatalError;
		if (!result.success || !result.tempVideoPath) {
			throw new Error(result.error || "ffmpeg encoder failed to finalize");
		}
		this.sessionId = null;
		this.tempVideoPath = result.tempVideoPath;
		return result.tempVideoPath;
	}

	async cancel(): Promise<void> {
		if (!this.sessionId) return;
		const sessionId = this.sessionId;
		this.sessionId = null;
		this.closed = true;
		this.inFlight.clear();
		if (this.tcp) {
			try {
				await this.tcp.close();
			} catch {
				// already cancelling — ignore
			}
			this.tcp = null;
		}
		await window.electronAPI.videoEncoderCancel(sessionId).catch(() => undefined);
	}
}

/**
 * Read RGBA bytes out of an ImageBitmap via an OffscreenCanvas 2d context.
 * This is a GPU→CPU readback; for export it's the unavoidable cost of
 * shipping pixels into ffmpeg's stdin.
 */
export function imageBitmapToRgbaBytes(
	bitmap: ImageBitmap,
	scratchCanvas?: OffscreenCanvas,
): { bytes: Uint8Array; canvas: OffscreenCanvas } {
	const canvas =
		scratchCanvas && scratchCanvas.width === bitmap.width && scratchCanvas.height === bitmap.height
			? scratchCanvas
			: new OffscreenCanvas(bitmap.width, bitmap.height);
	const ctx = canvas.getContext("2d", { willReadFrequently: true });
	if (!ctx) throw new Error("Failed to get 2d context for RGBA readback");
	ctx.drawImage(bitmap, 0, 0);
	const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
	return { bytes: new Uint8Array(imageData.data.buffer), canvas };
}
