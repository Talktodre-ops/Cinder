import { contextBridge, ipcRenderer } from "electron";
import type { RecordingSession, StoreRecordedSessionInput } from "../src/lib/recordingSession";

// node:net is loaded lazily inside videoEncoderConnectTransport so a hostile
// preload sandbox (which blocks Node built-ins) can't kill the entire
// contextBridge bootstrap. If the module can't be loaded, the renderer just
// falls back to the IPC transport.
type NetSocket = import("node:net").Socket;
let netModule: typeof import("node:net") | null = null;
let netModuleAttempted = false;
function tryLoadNet(): typeof import("node:net") | null {
	if (netModuleAttempted) return netModule;
	netModuleAttempted = true;
	try {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		netModule = require("node:net") as typeof import("node:net");
	} catch (err) {
		console.warn("[preload] node:net unavailable; TCP transport disabled:", err);
		netModule = null;
	}
	return netModule;
}

// Asset base URL is passed from the main process via webPreferences.additionalArguments
// (see windows.ts). Sandboxed preloads cannot import node:path / node:url, so we
// can't compute it here.
const ASSET_BASE_URL_ARG_PREFIX = "--asset-base-url=";
const assetBaseUrlArg = process.argv.find((arg) => arg.startsWith(ASSET_BASE_URL_ARG_PREFIX));
const assetBaseUrl = assetBaseUrlArg ? assetBaseUrlArg.slice(ASSET_BASE_URL_ARG_PREFIX.length) : "";

// Forward renderer console output to the main process so logs land in the
// same terminal you launched `npm run dev` from. Useful when DevTools is
// inconvenient (packaged builds) or you just want one tail. Toggle by setting
// process.argv to include "--no-console-forward".
const FORWARD_CONSOLE = !process.argv.includes("--no-console-forward");
if (FORWARD_CONSOLE) {
	const forwardLevel = (level: "log" | "warn" | "error" | "info" | "debug") => {
		const original = (console as unknown as Record<string, (...args: unknown[]) => void>)[level];
		(console as unknown as Record<string, (...args: unknown[]) => void>)[level] = (
			...args: unknown[]
		) => {
			try {
				original.apply(console, args);
			} catch {
				// keep going even if the original throws
			}
			try {
				const serializable = args.map((a) => {
					if (a instanceof Error) return `${a.name}: ${a.message}\n${a.stack ?? ""}`;
					if (typeof a === "object") {
						try {
							return JSON.stringify(a);
						} catch {
							return String(a);
						}
					}
					return String(a);
				});
				ipcRenderer.send("renderer-log", level, serializable);
			} catch {
				// swallow — must not crash renderer
			}
		};
	};
	forwardLevel("log");
	forwardLevel("warn");
	forwardLevel("error");
	forwardLevel("info");
	forwardLevel("debug");
}

contextBridge.exposeInMainWorld("electronAPI", {
	assetBaseUrl,
	hudOverlayHide: () => {
		ipcRenderer.send("hud-overlay-hide");
	},
	hudOverlayClose: () => {
		ipcRenderer.send("hud-overlay-close");
	},
	getSources: async (opts: Electron.SourcesOptions) => {
		return await ipcRenderer.invoke("get-sources", opts);
	},
	switchToEditor: () => {
		return ipcRenderer.invoke("switch-to-editor");
	},
	switchToHud: () => {
		return ipcRenderer.invoke("switch-to-hud");
	},
	startNewRecording: () => {
		return ipcRenderer.invoke("start-new-recording");
	},
	openSourceSelector: () => {
		return ipcRenderer.invoke("open-source-selector");
	},
	selectSource: (source: ProcessedDesktopSource) => {
		return ipcRenderer.invoke("select-source", source);
	},
	getSelectedSource: () => {
		return ipcRenderer.invoke("get-selected-source");
	},
	requestCameraAccess: () => {
		return ipcRenderer.invoke("request-camera-access");
	},
	requestAccessibilityAccess: () => {
		return ipcRenderer.invoke("request-accessibility-access");
	},

	storeRecordedVideo: (videoData: ArrayBuffer, fileName: string) => {
		return ipcRenderer.invoke("store-recorded-video", videoData, fileName);
	},
	storeRecordedSession: (payload: StoreRecordedSessionInput) => {
		return ipcRenderer.invoke("store-recorded-session", payload);
	},

	getRecordedVideoPath: () => {
		return ipcRenderer.invoke("get-recorded-video-path");
	},
	setRecordingState: (recording: boolean, recordingId?: number) => {
		return ipcRenderer.invoke("set-recording-state", recording, recordingId);
	},
	getCursorTelemetry: (videoPath?: string) => {
		return ipcRenderer.invoke("get-cursor-telemetry", videoPath);
	},
	discardCursorTelemetry: (recordingId: number) => {
		return ipcRenderer.invoke("discard-cursor-telemetry", recordingId);
	},
	onStopRecordingFromTray: (callback: () => void) => {
		const listener = () => callback();
		ipcRenderer.on("stop-recording-from-tray", listener);
		return () => ipcRenderer.removeListener("stop-recording-from-tray", listener);
	},
	openExternalUrl: (url: string) => {
		return ipcRenderer.invoke("open-external-url", url);
	},
	saveExportedVideo: (videoData: ArrayBuffer, fileName: string) => {
		return ipcRenderer.invoke("save-exported-video", videoData, fileName);
	},
	autoSaveExportedVideo: (videoData: ArrayBuffer, fileName: string) => {
		return ipcRenderer.invoke("auto-save-exported-video", videoData, fileName);
	},
	openVideoFilePicker: () => {
		return ipcRenderer.invoke("open-video-file-picker");
	},
	setCurrentVideoPath: (path: string) => {
		return ipcRenderer.invoke("set-current-video-path", path);
	},
	setCurrentRecordingSession: (session: RecordingSession | null) => {
		return ipcRenderer.invoke("set-current-recording-session", session);
	},
	getCurrentVideoPath: () => {
		return ipcRenderer.invoke("get-current-video-path");
	},
	getCurrentRecordingSession: () => {
		return ipcRenderer.invoke("get-current-recording-session");
	},
	readBinaryFile: (filePath: string) => {
		return ipcRenderer.invoke("read-binary-file", filePath);
	},
	clearCurrentVideoPath: () => {
		return ipcRenderer.invoke("clear-current-video-path");
	},
	saveProjectFile: (projectData: unknown, suggestedName?: string, existingProjectPath?: string) => {
		return ipcRenderer.invoke("save-project-file", projectData, suggestedName, existingProjectPath);
	},
	loadProjectFile: () => {
		return ipcRenderer.invoke("load-project-file");
	},
	loadCurrentProjectFile: () => {
		return ipcRenderer.invoke("load-current-project-file");
	},
	onMenuLoadProject: (callback: () => void) => {
		const listener = () => callback();
		ipcRenderer.on("menu-load-project", listener);
		return () => ipcRenderer.removeListener("menu-load-project", listener);
	},
	onMenuSaveProject: (callback: () => void) => {
		const listener = () => callback();
		ipcRenderer.on("menu-save-project", listener);
		return () => ipcRenderer.removeListener("menu-save-project", listener);
	},
	onMenuSaveProjectAs: (callback: () => void) => {
		const listener = () => callback();
		ipcRenderer.on("menu-save-project-as", listener);
		return () => ipcRenderer.removeListener("menu-save-project-as", listener);
	},
	getPlatform: () => {
		return ipcRenderer.invoke("get-platform");
	},
	revealInFolder: (filePath: string) => {
		return ipcRenderer.invoke("reveal-in-folder", filePath);
	},
	getShortcuts: () => {
		return ipcRenderer.invoke("get-shortcuts");
	},
	saveShortcuts: (shortcuts: unknown) => {
		return ipcRenderer.invoke("save-shortcuts", shortcuts);
	},
	setLocale: (locale: string) => {
		return ipcRenderer.invoke("set-locale", locale);
	},
	ffmpegProcessAudio: (params: {
		videoPath: string;
		trimRegions: Array<{ startMs: number; endMs: number }>;
		speedRegions: Array<{ startMs: number; endMs: number; speed: number }>;
		durationMs: number;
	}) => {
		return ipcRenderer.invoke("ffmpeg:process-audio", params);
	},
	videoEncoderProbe: () => {
		return ipcRenderer.invoke("videoEncoder:probe");
	},
	videoEncoderStart: (opts: {
		width: number;
		height: number;
		frameRate: number;
		bitrate: number;
	}) => {
		return ipcRenderer.invoke("videoEncoder:start", opts);
	},
	videoEncoderWriteFrame: (sessionId: string, frame: ArrayBuffer, frameIndex?: number) => {
		return ipcRenderer.invoke("videoEncoder:writeFrame", sessionId, frame, frameIndex);
	},
	videoEncoderEnd: (sessionId: string) => {
		return ipcRenderer.invoke("videoEncoder:end", sessionId);
	},
	videoEncoderCancel: (sessionId: string) => {
		return ipcRenderer.invoke("videoEncoder:cancel", sessionId);
	},
	videoEncoderMux: (params: {
		videoPath: string;
		audioPath?: string | null;
		audioBytes?: ArrayBuffer | null;
		outputPath: string;
	}) => {
		return ipcRenderer.invoke("videoEncoder:mux", params);
	},
	videoEncoderReadAndDelete: (filePath: string) => {
		return ipcRenderer.invoke("videoEncoder:readAndDelete", filePath);
	},
	/**
	 * Open a localhost TCP socket to the encoder's transport server. Renderer
	 * uses this to stream raw RGBA frame bytes straight into ffmpeg's stdin,
	 * skipping IPC's structured-clone overhead entirely. The socket guarantees
	 * in-order delivery and applies natural backpressure via socket.write's
	 * return value (false → caller should await drain()).
	 */
	videoEncoderConnectTransport: async (port: number) => {
		const nm = tryLoadNet();
		if (!nm) return null;
		const sock: NetSocket = new nm.Socket();
		// Effective backpressure threshold: only ask the caller to await drain
		// when more than ~4 frames (32 MB at 1080p RGBA) are buffered. Node's
		// default highWaterMark is 16 KB which would force a drain await for
		// every single 8 MB frame and serialize the pipeline on socket flush.
		const SEND_BACKPRESSURE_BYTES = 32 * 1024 * 1024;
		try {
			await new Promise<void>((resolve, reject) => {
				const onError = (err: Error) => {
					sock.removeListener("connect", onConnect);
					reject(err);
				};
				const onConnect = () => {
					sock.removeListener("error", onError);
					resolve();
				};
				sock.once("error", onError);
				sock.once("connect", onConnect);
				sock.connect(port, "127.0.0.1");
			});
		} catch (err) {
			sock.destroy();
			console.warn("[preload] videoEncoderConnectTransport failed:", err);
			return null;
		}

		// Disable Nagle so each frame is shipped immediately rather than
		// coalesced — ffmpeg reads its input as a continuous byte stream so
		// either way works, but no-delay gives lower latency at no cost on a
		// loopback socket.
		sock.setNoDelay(true);

		let socketError: Error | null = null;
		sock.on("error", (err) => {
			socketError = err;
		});

		return {
			/** Returns false when ~32 MB is buffered — caller should await drain(). */
			send: (buf: ArrayBuffer): boolean => {
				if (socketError) throw socketError;
				sock.write(Buffer.from(buf));
				return sock.writableLength < SEND_BACKPRESSURE_BYTES;
			},
			drain: (): Promise<void> => {
				return new Promise<void>((resolve, reject) => {
					if (socketError) return reject(socketError);
					if ((sock.writableLength ?? 0) === 0) return resolve();
					const onDrain = () => {
						sock.removeListener("error", onErr);
						resolve();
					};
					const onErr = (err: Error) => {
						sock.removeListener("drain", onDrain);
						reject(err);
					};
					sock.once("drain", onDrain);
					sock.once("error", onErr);
				});
			},
			close: (): Promise<void> => {
				return new Promise<void>((resolve) => {
					if (sock.destroyed) return resolve();
					// end() sends FIN — main's pipe drains remaining bytes into
					// ffmpeg's stdin before the socket emits 'end' / 'close'.
					sock.end(() => resolve());
				});
			},
		};
	},
	setMicrophoneExpanded: (expanded: boolean) => {
		ipcRenderer.send("hud:setMicrophoneExpanded", expanded);
	},
	setHasUnsavedChanges: (hasChanges: boolean) => {
		ipcRenderer.send("set-has-unsaved-changes", hasChanges);
	},
	showCountdownOverlay: (value: number, runId: number) => {
		return ipcRenderer.invoke("countdown-overlay-show", value, runId);
	},
	setCountdownOverlayValue: (value: number, runId: number) => {
		return ipcRenderer.invoke("countdown-overlay-set-value", value, runId);
	},
	hideCountdownOverlay: (runId: number) => {
		return ipcRenderer.invoke("countdown-overlay-hide", runId);
	},
	onCountdownOverlayValue: (callback: (value: number | null) => void) => {
		const listener = (_event: unknown, value: number | null) => callback(value);
		ipcRenderer.on("countdown-overlay-value", listener);
		return () => ipcRenderer.removeListener("countdown-overlay-value", listener);
	},
	onRequestSaveBeforeClose: (callback: () => Promise<boolean> | boolean) => {
		const listener = async () => {
			try {
				const shouldClose = await callback();
				ipcRenderer.send("save-before-close-done", shouldClose);
			} catch {
				ipcRenderer.send("save-before-close-done", false);
			}
		};
		ipcRenderer.on("request-save-before-close", listener);
		return () => ipcRenderer.removeListener("request-save-before-close", listener);
	},
});
