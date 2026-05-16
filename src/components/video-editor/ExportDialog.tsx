import { Cpu, Download, Loader2, Music, X, Zap } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { useScopedT } from "@/contexts/I18nContext";
import type { ExportProgress } from "@/lib/exporter";

interface ExportDialogProps {
	isOpen: boolean;
	onClose: () => void;
	progress: ExportProgress | null;
	isExporting: boolean;
	error: string | null;
	onCancel?: () => void;
	exportFormat?: "mp4" | "gif";
	exportedFilePath?: string;
	onShowInFolder?: () => void;
}

function formatEta(seconds: number): string {
	if (seconds <= 0) return "0s";
	const h = Math.floor(seconds / 3600);
	const m = Math.floor((seconds % 3600) / 60);
	const s = Math.floor(seconds % 60);
	if (h > 0) return `${h}h ${m}m`;
	if (m > 0) return `${m}m ${s}s`;
	return `${s}s`;
}

export function ExportDialog({
	isOpen,
	onClose,
	progress,
	isExporting,
	error,
	onCancel,
	exportFormat = "mp4",
	exportedFilePath,
	onShowInFolder,
}: ExportDialogProps) {
	const t = useScopedT("dialogs");
	const [showSuccess, setShowSuccess] = useState(false);

	useEffect(() => {
		if (isExporting) {
			setShowSuccess(false);
		}
	}, [isExporting]);

	useEffect(() => {
		if (isOpen && !isExporting && !progress) {
			setShowSuccess(false);
		}
	}, [isOpen, isExporting, progress]);

	useEffect(() => {
		if (!isExporting && progress && progress.percentage >= 100 && !error) {
			setShowSuccess(true);
			const timer = setTimeout(() => {
				setShowSuccess(false);
				onClose();
			}, 2000);
			return () => clearTimeout(timer);
		}
	}, [isExporting, progress, error, onClose]);

	if (!isOpen) return null;

	const formatLabel = exportFormat === "gif" ? "GIF" : "Video";

	const isCompiling =
		isExporting && progress && progress.percentage >= 100 && exportFormat === "gif";
	const isFinalizing = progress?.phase === "finalizing";
	const isAudioPhase = progress?.phase === "audio";
	const renderProgress = progress?.renderProgress;

	const getTitle = () => {
		if (error) return t("export.failed");
		if (isAudioPhase) return t("export.processingAudioTitle");
		if (isFinalizing && exportFormat === "mp4") return t("export.finalizingVideoTitle");
		if (isCompiling || isFinalizing) return t("export.compilingGif");
		return t("export.exportingFormat", { format: formatLabel });
	};

	const getSubtitle = () => {
		if (error) return t("export.tryAgain");
		if (isAudioPhase) return t("export.processingAudioDesc");
		if (isCompiling || isFinalizing) {
			if (exportFormat === "mp4") return t("export.finalizingVideo");
			if (renderProgress !== undefined && renderProgress > 0)
				return t("export.compilingGifProgress", { progress: String(renderProgress) });
			return t("export.compilingGifWait");
		}
		if (progress && progress.estimatedTimeRemaining > 0) {
			const pct = progress.percentage;
			if (pct >= 95) return t("export.almostDone");
			return t("export.remainingShort", { time: formatEta(progress.estimatedTimeRemaining) });
		}
		if (!progress || progress.currentFrame === 0) return t("export.startingExport");
		return t("export.takeMoment");
	};

	const getAudioEngineBadge = () => {
		const engine = progress?.audioEngine;
		if (!engine) return null;
		if (engine === "ffmpeg") {
			return (
				<span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-emerald-500/20 border border-emerald-500/30 text-emerald-400 text-[10px] font-semibold tracking-wide">
					<Zap className="w-2.5 h-2.5" />
					{t("export.ffmpegEngine")}
				</span>
			);
		}
		if (engine === "realtime") {
			return (
				<span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-blue-500/20 border border-blue-500/30 text-blue-400 text-[10px] font-semibold tracking-wide">
					<Music className="w-2.5 h-2.5" />
					{t("export.realtimeEngine")}
				</span>
			);
		}
		return (
			<span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-purple-500/20 border border-purple-500/30 text-purple-400 text-[10px] font-semibold tracking-wide">
				<Cpu className="w-2.5 h-2.5" />
				{t("export.webCodecsEngine")}
			</span>
		);
	};

	const getWorkerEngineBadge = () => {
		const engine = progress?.workerEngine;
		if (!engine) return null;
		if (engine === "worker-pool") {
			return (
				<span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-violet-500/20 border border-violet-500/30 text-violet-400 text-[10px] font-semibold tracking-wide">
					<Cpu className="w-2.5 h-2.5" />
					{t("export.workerPoolActive")}
				</span>
			);
		}
		return (
			<span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-white/5 border border-white/10 text-slate-500 text-[10px] font-semibold tracking-wide">
				<Cpu className="w-2.5 h-2.5" />
				{t("export.workerPoolOff")}
			</span>
		);
	};

	const getVideoEncoderBadge = () => {
		const enc = progress?.videoEncoder;
		if (!enc) return null;
		const styles: Record<string, { ring: string; text: string; label: string }> = {
			h264_nvenc: {
				ring: "bg-emerald-500/20 border-emerald-500/30",
				text: "text-emerald-400",
				label: "NVENC",
			},
			h264_qsv: { ring: "bg-sky-500/20 border-sky-500/30", text: "text-sky-400", label: "QSV" },
			h264_amf: {
				ring: "bg-orange-500/20 border-orange-500/30",
				text: "text-orange-400",
				label: "AMF",
			},
			h264_videotoolbox: {
				ring: "bg-fuchsia-500/20 border-fuchsia-500/30",
				text: "text-fuchsia-400",
				label: "VideoToolbox",
			},
			libx264: {
				ring: "bg-amber-500/20 border-amber-500/30",
				text: "text-amber-400",
				label: "x264 (CPU)",
			},
			"webcodecs-hw": {
				ring: "bg-purple-500/20 border-purple-500/30",
				text: "text-purple-400",
				label: "WebCodecs HW",
			},
			"webcodecs-sw": {
				ring: "bg-slate-500/20 border-slate-500/30",
				text: "text-slate-400",
				label: "WebCodecs SW",
			},
		};
		const s = styles[enc];
		if (!s) return null;
		return (
			<span
				className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full border ${s.ring} ${s.text} text-[10px] font-semibold tracking-wide`}
			>
				<Zap className="w-2.5 h-2.5" />
				{s.label}
			</span>
		);
	};

	return (
		<>
			<div
				className="fixed inset-0 bg-black/80 backdrop-blur-md z-50 animate-in fade-in duration-200"
				onClick={isExporting ? undefined : onClose}
			/>
			<div className="fixed top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 z-[60] bg-[#09090b] rounded-2xl shadow-2xl border border-white/10 p-8 w-[90vw] max-w-md animate-in zoom-in-95 duration-200">
				{/* Header */}
				<div className="flex items-start justify-between mb-6">
					<div className="flex items-center gap-4 flex-1 min-w-0">
						{showSuccess ? (
							<>
								<div className="w-12 h-12 rounded-full bg-[#34B27B]/20 flex items-center justify-center ring-1 ring-[#34B27B]/50 shrink-0">
									<Download className="w-6 h-6 text-[#34B27B]" />
								</div>
								<div className="flex flex-col gap-2">
									<span className="text-xl font-bold text-slate-200 block">
										{t("export.complete")}
									</span>
									<span className="text-sm text-slate-400">
										{t("export.yourFormatReady", { format: formatLabel.toLowerCase() })}
									</span>
									{exportedFilePath && (
										<Button
											variant="secondary"
											onClick={onShowInFolder}
											className="mt-2 w-fit px-3 py-1 text-sm rounded-md bg-white/10 hover:bg-white/20 text-slate-200"
										>
											{t("export.showInFolder")}
										</Button>
									)}
									{exportedFilePath && (
										<span className="text-xs text-slate-500 break-all max-w-xs mt-1">
											{exportedFilePath.split("/").pop()}
										</span>
									)}
								</div>
							</>
						) : (
							<>
								{isExporting ? (
									<div className="w-12 h-12 rounded-full bg-[#34B27B]/10 flex items-center justify-center shrink-0">
										<Loader2 className="w-6 h-6 text-[#34B27B] animate-spin" />
									</div>
								) : (
									<div className="w-12 h-12 rounded-full bg-white/5 flex items-center justify-center border border-white/10 shrink-0">
										<Download className="w-6 h-6 text-slate-200" />
									</div>
								)}
								<div className="min-w-0 flex-1">
									<span className="text-xl font-bold text-slate-200 block">{getTitle()}</span>
									<span className="text-sm text-slate-400">{getSubtitle()}</span>
									{/* Engine badges row */}
									{isExporting && progress && (
										<div className="flex items-center gap-2 mt-2 flex-wrap">
											{getWorkerEngineBadge()}
											{getVideoEncoderBadge()}
											{isAudioPhase && getAudioEngineBadge()}
										</div>
									)}
								</div>
							</>
						)}
					</div>
					{!isExporting && (
						<Button
							variant="ghost"
							size="icon"
							onClick={onClose}
							className="hover:bg-white/10 text-slate-400 hover:text-white rounded-full shrink-0 ml-2"
						>
							<X className="w-5 h-5" />
						</Button>
					)}
				</div>

				{error && (
					<div className="mb-6 animate-in slide-in-from-top-2">
						<div className="bg-red-500/10 border border-red-500/20 rounded-xl p-4 flex items-start gap-3">
							<div className="p-1 bg-red-500/20 rounded-full">
								<X className="w-3 h-3 text-red-400" />
							</div>
							<p className="text-sm text-red-400 leading-relaxed">{error}</p>
						</div>
					</div>
				)}

				{isExporting && progress && (
					<div className="space-y-5">
						{/* Progress bar */}
						<div className="space-y-2">
							<div className="flex justify-between text-xs font-medium text-slate-400 uppercase tracking-wider">
								<span>
									{isAudioPhase
										? t("export.processingAudioTitle")
										: isCompiling || isFinalizing
											? t("export.compiling")
											: t("export.renderingFrames")}
								</span>
								<span className="font-mono text-slate-200">
									{isAudioPhase ? (
										<span className="flex items-center gap-2">
											<Loader2 className="w-3 h-3 animate-spin" />
											{t("export.processing")}
										</span>
									) : isCompiling || isFinalizing ? (
										renderProgress !== undefined && renderProgress > 0 ? (
											`${renderProgress}%`
										) : (
											<span className="flex items-center gap-2">
												<Loader2 className="w-3 h-3 animate-spin" />
												{t("export.processing")}
											</span>
										)
									) : (
										`${progress.percentage.toFixed(0)}%`
									)}
								</span>
							</div>
							<div className="h-2 bg-white/5 rounded-full overflow-hidden border border-white/5">
								{isAudioPhase ? (
									<div className="h-full w-full relative overflow-hidden">
										<div
											className="absolute h-full w-1/3 bg-[#34B27B] shadow-[0_0_10px_rgba(52,178,123,0.3)]"
											style={{ animation: "indeterminate 1.5s ease-in-out infinite" }}
										/>
										<style>{`
                      @keyframes indeterminate {
                        0% { transform: translateX(-100%); }
                        100% { transform: translateX(400%); }
                      }
                    `}</style>
									</div>
								) : isCompiling || isFinalizing ? (
									renderProgress !== undefined && renderProgress > 0 ? (
										<div
											className="h-full bg-[#34B27B] shadow-[0_0_10px_rgba(52,178,123,0.3)] transition-all duration-300 ease-out"
											style={{ width: `${renderProgress}%` }}
										/>
									) : (
										<div className="h-full w-full relative overflow-hidden">
											<div
												className="absolute h-full w-1/3 bg-[#34B27B] shadow-[0_0_10px_rgba(52,178,123,0.3)]"
												style={{ animation: "indeterminate 1.5s ease-in-out infinite" }}
											/>
										</div>
									)
								) : (
									<div
										className="h-full bg-[#34B27B] shadow-[0_0_10px_rgba(52,178,123,0.3)] transition-all duration-300 ease-out"
										style={{ width: `${Math.min(progress.percentage, 100)}%` }}
									/>
								)}
							</div>
						</div>

						{/* 3-column stats */}
						{!isAudioPhase && !isCompiling && !isFinalizing && (
							<div className="grid grid-cols-3 gap-3">
								<div className="bg-white/5 rounded-xl p-3 border border-white/5">
									<div className="text-[10px] text-slate-500 uppercase tracking-wider mb-1">
										{t("export.frames")}
									</div>
									<div className="text-slate-200 font-mono font-medium text-sm tabular-nums">
										{progress.currentFrame.toLocaleString()} /{" "}
										{progress.totalFrames.toLocaleString()}
									</div>
								</div>
								<div className="bg-white/5 rounded-xl p-3 border border-white/5">
									<div className="text-[10px] text-slate-500 uppercase tracking-wider mb-1">
										{t("export.speed")}
									</div>
									<div className="text-slate-200 font-mono font-medium text-sm tabular-nums">
										{progress.fps != null && progress.fps > 0
											? t("export.fpsValue", { fps: progress.fps.toFixed(1) })
											: "—"}
									</div>
								</div>
								<div className="bg-white/5 rounded-xl p-3 border border-white/5">
									<div className="text-[10px] text-slate-500 uppercase tracking-wider mb-1">
										{t("export.eta")}
									</div>
									<div className="text-slate-200 font-mono font-medium text-sm tabular-nums">
										{progress.estimatedTimeRemaining > 0
											? t("export.etaValue", {
													time: formatEta(progress.estimatedTimeRemaining),
												})
											: "—"}
									</div>
								</div>
							</div>
						)}

						{/* Audio phase stats */}
						{isAudioPhase && (
							<div className="grid grid-cols-2 gap-3">
								<div className="bg-white/5 rounded-xl p-3 border border-white/5">
									<div className="text-[10px] text-slate-500 uppercase tracking-wider mb-1">
										{t("export.format")}
									</div>
									<div className="text-slate-200 font-medium text-sm">{formatLabel}</div>
								</div>
								<div className="bg-white/5 rounded-xl p-3 border border-white/5">
									<div className="text-[10px] text-slate-500 uppercase tracking-wider mb-1">
										Audio Engine
									</div>
									<div className="flex items-center gap-1.5">
										{progress.audioEngine === "ffmpeg" ? (
											<>
												<Zap className="w-3.5 h-3.5 text-emerald-400" />
												<span className="text-emerald-400 font-semibold text-sm">
													{t("export.ffmpegEngine")}
												</span>
											</>
										) : progress.audioEngine === "realtime" ? (
											<>
												<Music className="w-3.5 h-3.5 text-blue-400" />
												<span className="text-blue-400 font-semibold text-sm">
													{t("export.realtimeEngine")}
												</span>
											</>
										) : progress.audioEngine === "webcodecs" ? (
											<>
												<Cpu className="w-3.5 h-3.5 text-purple-400" />
												<span className="text-purple-400 font-semibold text-sm">
													{t("export.webCodecsEngine")}
												</span>
											</>
										) : (
											<span className="text-slate-500 text-sm">—</span>
										)}
									</div>
								</div>
							</div>
						)}

						{/* Compiling/finalizing stats */}
						{(isCompiling || isFinalizing) && !isAudioPhase && (
							<div className="grid grid-cols-2 gap-3">
								<div className="bg-white/5 rounded-xl p-3 border border-white/5">
									<div className="text-[10px] text-slate-500 uppercase tracking-wider mb-1">
										{t("export.status")}
									</div>
									<div className="text-slate-200 font-medium text-sm">
										{isFinalizing && exportFormat === "mp4"
											? t("export.finalizing")
											: t("export.compilingStatus")}
									</div>
								</div>
								<div className="bg-white/5 rounded-xl p-3 border border-white/5">
									<div className="text-[10px] text-slate-500 uppercase tracking-wider mb-1">
										{t("export.format")}
									</div>
									<div className="text-slate-200 font-medium text-sm">{formatLabel}</div>
								</div>
							</div>
						)}

						{onCancel && (
							<div className="pt-1">
								<Button
									onClick={onCancel}
									variant="destructive"
									className="w-full py-6 bg-red-500/10 text-red-400 border border-red-500/20 hover:bg-red-500/20 hover:border-red-500/30 transition-all rounded-xl"
								>
									{t("export.cancelExport")}
								</Button>
							</div>
						)}
					</div>
				)}

				{showSuccess && (
					<div className="text-center py-4 animate-in zoom-in-95">
						<p className="text-lg text-slate-200 font-medium">
							{t("export.savedSuccessfully", { format: formatLabel })}
						</p>
					</div>
				)}
			</div>
		</>
	);
}
