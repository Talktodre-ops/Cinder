<p align="center">
  <a href="https://cinder.talktodre.org">
    <img src="icons/cinder_logo.webp" alt="Cinder Logo" width="120" height="120" />
  </a>
</p>

<h1 align="center">Cinder</h1>

<p align="center">
  <b>High-Performance, Hardware-Accelerated Screen Recorder & Video Editor</b>
</p>

<p align="center">
  A native-grade desktop application engineered for zero-copy rendering, direct GPU hardware encoding, and ultra-fast 1080p/4K video exports on Windows, macOS, and Linux.
</p>

<p align="center">
  <a href="https://github.com/Talktodre-ops/Cinder/blob/main/LICENSE">
    <img src="https://img.shields.io/github/license/Talktodre-ops/Cinder?style=for-the-badge&color=orange" alt="License" />
  </a>
  <a href="https://github.com/Talktodre-ops/Cinder/releases">
    <img src="https://img.shields.io/github/v/release/Talktodre-ops/Cinder?style=for-the-badge&color=red" alt="Release" />
  </a>
  <img src="https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-blue?style=for-the-badge" alt="Platform" />
  <img src="https://img.shields.io/badge/status-production--ready-success?style=for-the-badge" alt="Status" />
</p>

<p align="center">
  <a href="https://cinder.talktodre.org">Website</a> •
  <a href="#-key-features">Features</a> •
  <a href="#-tech-stack">Tech Stack</a> •
  <a href="#-performance-benchmarks">Performance</a> •
  <a href="#-quick-start">Quick Start</a> •
  <a href="#-deep-dives--case-studies">Docs</a>
</p>

---

## ⚡ Key Features

- **🚀 Direct GPU Hardware Encoding**: Harnesses native GPU hardware encoders (**NVIDIA NVENC**, **Intel QSV**, **AMD AMF**) alongside `libx264` fallback for maximum throughput.
- **⚡ Parallel Worker Pool**: Offloads frame rendering across an **OffscreenCanvas** worker pool powered by PixiJS for concurrent multi-threaded frame processing.
- **🔄 Zero-Copy Frame Transport**: Bypasses traditional `ipcRenderer.invoke` overhead using high-speed `MessageChannelMain` transferable streams from renderer directly to main process.
- **🎨 Full-Featured Video Editor**: Precise timeline editing, webcam overlays, cursor highlights, annotations, and multi-track canvas composition.
- **🖥️ Smart GPU Routing**: Automatic discrete GPU activation on hybrid laptops (`force_high_performance_gpu`) and configurable ANGLE backends (`d3d11` / `vulkan` / `gl`).

---

## 🛠 Tech Stack

| Domain | Technologies |
| --- | --- |
| **Desktop Core** | ![Electron](https://img.shields.io/badge/Electron-47848F?style=flat-square&logo=electron&logoColor=white) ![NodeJS](https://img.shields.io/badge/Node.js-339933?style=flat-square&logo=nodedotjs&logoColor=white) |
| **Frontend & UI** | ![React](https://img.shields.io/badge/React-61DAFB?style=flat-square&logo=react&logoColor=black) ![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?style=flat-square&logo=typescript&logoColor=white) ![TailwindCSS](https://img.shields.io/badge/Tailwind_CSS-38B2AC?style=flat-square&logo=tailwind-css&logoColor=white) |
| **Graphics Engine** | ![PixiJS](https://img.shields.io/badge/PixiJS-E91E63?style=flat-square&logo=pixijs&logoColor=white) ![WebGL2](https://img.shields.io/badge/WebGL2-990000?style=flat-square&logo=webgl&logoColor=white) |
| **Build & Tooling** | ![Vite](https://img.shields.io/badge/Vite-646CFF?style=flat-square&logo=vite&logoColor=white) ![Biome](https://img.shields.io/badge/Biome-60A5FA?style=flat-square&logo=biome&logoColor=white) |
| **Encoding Engine** | ![FFmpeg](https://img.shields.io/badge/FFmpeg-007800?style=flat-square&logo=ffmpeg&logoColor=white) **NVIDIA NVENC** / **Intel QSV** / **AMD AMF** |

---

## 📊 Performance Benchmarks

By bypassing JavaScript software encoding and routing raw RGBA frames directly into custom FFmpeg pipelines with hardware acceleration, Cinder achieves dramatic performance gains over traditional Electron recorders:

| Metric | Upstream Software Encoder | Cinder Hardware Engine | Improvement |
| :--- | :--- | :--- | :--- |
| **Export Speed (1080p)** | ~6 fps | **~25–40+ fps** | 🚀 **~5x–7x Faster** |
| **Encoder Backend** | WebCodecs (Software) | **NVENC / QSV / AMF / x264** | Direct GPU acceleration |
| **Render Parallelism** | Single-threaded | **OffscreenCanvas Worker Pool** | Multi-core scaling |
| **Renderer ↔ Main Hop** | `ipcRenderer.invoke` per frame | **MessagePort Transferable Stream** | Zero-copy byte stream |

<p align="center">
  <img src="docs/screenshots/export-before.png" alt="Before: 6 fps export" width="48%" />
  &nbsp;&nbsp;
  <img src="docs/screenshots/export-after.png" alt="After: 30+ fps with NVENC + worker pool" width="48%" />
</p>

---

## 🏗 Architectural Highlights

A breakdown of core architectural additions engineered into Cinder:

- **`electron/ffmpegEncoder.ts`**: Main-process encoder engine that probes system GPU capabilities, detects hardware support, and pipes raw RGBA buffer streams into native FFmpeg child processes.
- **`electron/ipc/videoEncoderHandlers.ts`**: IPC layer using `MessageChannelMain` transport for zero-copy frame serialization from renderer workers to main process.
- **`src/lib/exporter/workerPool.ts`**: Dynamic producer/consumer worker pool powered by PixiJS for concurrent frame rendering with bounded memory usage.
- **`src/lib/exporter/renderWorker.ts`**: Optimized `rgba` rendering mode utilizing Pixi's `extract.pixels()` fast path (`gl.readPixels`), bypassing 2D canvas composition when overlays are inactive.
- **`electron/main.ts`**: Forces discrete GPU selection on hybrid laptops via Chromium flags (`force_high_performance_gpu`) with customizable ANGLE backends (`d3d11`, `vulkan`, `gl`).
- **`electron/ffmpeg.ts`**: Bundled FFmpeg resolution system probing `resources/ffmpeg/<platform>/` with automatic fallback to `ffmpeg-static`.

---

## 🚀 Quick Start

### Prerequisites

- **Node.js**: v20 or higher
- **Graphics**: NVIDIA, Intel, or AMD GPU recommended (software fallbacks supported on all platforms)

### Installation & Development

1. **Clone the repository:**
   ```bash
   git clone https://github.com/Talktodre-ops/Cinder.git
   cd Cinder
   ```

2. **Install dependencies:**
   ```bash
   npm install
   ```

3. **Start development mode:**
   ```bash
   npm run dev
   ```

4. **Build production binaries:**
   ```bash
   npm run build:win    # Production .exe installer
   ```

### Optional: Custom FFmpeg Bundle

The default `ffmpeg-static` works out-of-the-box. For total binary control, drop a custom release build into `resources/ffmpeg/win/ffmpeg.exe`. See [resources/ffmpeg/README.md](resources/ffmpeg/README.md) for platform guidelines.

---

## 📖 Deep Dives & Case Studies

- 📄 **[Technical Case Study: From 6 FPS to 40 FPS](docs/from-6-to-40-fps.md)** — An in-depth breakdown of how we re-engineered the rendering & encoding pipeline.
- 📐 **[Architecture Diagrams](docs/diagrams/)** — Visual flowcharts detailing the zero-copy pipeline and OffscreenCanvas worker pool design.

---

## 🗺 Project Roadmap

- [x] Hardware GPU encoder auto-detection (**NVENC**, **QSV**, **AMF**)
- [x] Multi-worker `OffscreenCanvas` rendering engine
- [x] High-speed `MessageChannelMain` zero-copy IPC transport
- [ ] Code signing for Windows & macOS binaries
- [ ] Auto-updates via `electron-updater` & GitHub Releases
- [ ] In-app GPU Performance analytics panel
- [ ] Direct pass-through fast path for unedited video segments

---

## 📜 Credits & License

Cinder is open-source software licensed under the **[MIT License](./LICENSE)**.

It is built upon the foundation of [**OpenScreen**](https://github.com/siddharthvaddem/openscreen) by Siddharth Vaddem. Core architecture redesign and hardware acceleration enhancements by Anderson Victor. Full attribution details are preserved in [LICENSE](./LICENSE) and [NOTICE.md](./NOTICE.md).

