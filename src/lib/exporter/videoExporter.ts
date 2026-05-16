/**
 * Thin lifecycle shim around ExportPipeline. The pipeline does all the real
 * work; this class exists only to keep the existing public surface used by
 * VideoEditor.tsx (`new VideoExporter(config).export()` + `cancel()`).
 *
 * The legacy WebCodecs / single-thread renderer / encoder-preference retry
 * loop have been removed — this build is Electron-only and uses the ffmpeg
 * subprocess (NVENC / QSV / AMF / VideoToolbox / libx264) end-to-end.
 */

import { BackgroundLoadError } from "@/lib/wallpaper";
import { ExportPipeline, type PipelineConfig } from "./pipeline";
import type { ExportProgress, ExportResult } from "./types";

export type VideoExporterConfig = PipelineConfig;

export class VideoExporter {
	private pipeline: ExportPipeline | null = null;
	private cancelled = false;

	constructor(private readonly config: VideoExporterConfig) {}

	async export(): Promise<ExportResult> {
		if (typeof window === "undefined" || !window.electronAPI?.videoEncoderStart) {
			return {
				success: false,
				error: "Video export requires the Electron app (ffmpeg subprocess unavailable in browser).",
			};
		}

		this.pipeline = new ExportPipeline(this.config);
		try {
			const result = await this.pipeline.run();
			return {
				success: result.success,
				blob: result.blob,
				error: result.error,
				warnings: result.warnings,
			};
		} catch (err) {
			if (err instanceof BackgroundLoadError) throw err;
			if (this.cancelled) return { success: false, error: "Export cancelled" };
			const message = err instanceof Error ? err.message : String(err);
			return { success: false, error: message };
		} finally {
			this.pipeline = null;
		}
	}

	cancel(): void {
		this.cancelled = true;
		this.pipeline?.cancel();
	}
}

export type { ExportProgress, ExportResult };
