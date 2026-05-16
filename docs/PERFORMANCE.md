# How Cinder's MP4 export got ~10× faster

A diagnostic-driven optimization log: 4 fps → 30+ fps for 1080p H.264 export, with
no algorithmic shortcuts. Every change was justified by a measurement, and a few
"obvious" optimizations didn't help — those are documented here too.

This is meant as a worked example for anyone building Electron apps that move pixels.

---

## Starting point

Upstream OpenScreen exports MP4 by:

1. Running a single PixiJS renderer on the renderer process main thread
2. Drawing each frame to a 2D canvas with shadow / webcam / cursor / annotation overlays
3. Pulling pixels out via `getImageData` and feeding a WebCodecs `VideoEncoder`
4. Muxing chunks via `mp4-muxer` in JS

Measured throughput on a Windows 11 / NVIDIA RTX 3050 / 16 GB RAM laptop: **~6 fps**
for a 1080p export. A 99-second recording took 13 minutes. That was the baseline.

The export dialog showed a "Workers: Off" badge — the existing code had a worker pool
scaffold, but the badge was always Off in practice. First task: figure out why.

---

## Phase 1 — Wire the worker pool correctly

The pool spawned, but the produce/consume code looked like this:

```ts
await streamingDecoder.decodeAll(..., async (videoFrame) => {
  const bitmap = await createImageBitmap(videoFrame);
  const result = await pool.renderFrame({ bitmap, ... });   // ← per-frame await
  encoder.encode(result);
});
```

That `await pool.renderFrame(…)` makes the producer block until *that exact frame*
comes back from a worker. The pool fans out to N workers, but only one frame is in
flight at a time. The other N-1 workers sit idle.

Fix: replace the per-frame await with a sliding-window pipeline:

```ts
const inFlight: Promise<RenderResult>[] = [];
const MAX_IN_FLIGHT = pool.workerCount * 2;

await streamingDecoder.decodeAll(..., async (videoFrame) => {
  const bitmap = await createImageBitmap(videoFrame);
  inFlight.push(pool.renderFrame({ bitmap, ... }));
  if (inFlight.length >= MAX_IN_FLIGHT) {
    const next = await inFlight.shift()!;   // FIFO, preserves order
    encoder.encode(next);
  }
});
// drain remaining
while (inFlight.length > 0) encoder.encode(await inFlight.shift()!);
```

Frames are submitted without waiting; the encoder drains them in order. Now N
workers actually run in parallel.

**6 fps → 8 fps.** Underwhelming.

---

## Phase 2 — Find the real bottleneck

The `Workers: On` badge was now lighting up, but throughput barely moved. Time to
stop guessing.

Added per-stage timing inside each worker (`pixi`, `composite`, `extras`, `readback`)
and aggregated across workers, printed every 60 frames. A typical line:

```
worker avg/frame: pixi=1.5ms composite=0.5ms extras=0.0ms readback=82ms
```

So 97% of per-frame time was readback. Specifically `compositeCtx.getImageData` on
the 2D composite canvas. Drawing a WebGL canvas (PixiJS output) onto a 2D canvas
defers a GPU→CPU sync until the first CPU read — which is exactly when getImageData
fires. The "composite" timing was misleadingly low because the actual GPU work
hadn't happened yet.

The next several phases all chase this readback cost from different angles.

---

## Phase 3 — Replace WebCodecs with hardware ffmpeg

WebCodecs `VideoEncoder` in Chromium *can* be hardware-accelerated, but in practice
on Windows + ANGLE the path is unpredictable: same code falls back to libavcodec
software encoding for some H.264 profile/level combos with no warning. We were on
software encode without realizing it.

Replaced the JS encode + JS muxer pair with:

- `electron/ffmpegEncoder.ts` — main-process module that runs `ffmpeg -encoders`
  once, picks the first match in a priority list (`h264_nvenc → h264_qsv →
  h264_amf → libx264`), spawns ffmpeg with that encoder reading raw RGBA on stdin.
- `electron/ipc/videoEncoderHandlers.ts` — IPC: `start / writeFrame / end / cancel
  / mux`. Plus a final mux pass that combines the temp video file with audio
  produced by the existing `AudioProcessor`.

The renderer-side `FfmpegVideoEncoder` is a drop-in replacement for the WebCodecs
encoder, with a transparent IPC fallback if the native path isn't available.

Visible result: an `NVENC` badge in the export dialog. Encoder is now genuinely
hardware-accelerated, no Chromium black box.

This alone didn't move fps — the encoder was never the bottleneck — but it lit up
the path for everything that follows.

---

## Phase 4 — Move the GPU readback into the workers

Even with workers rendering in parallel, the readback (`imageBitmapToRgbaBytes`)
happened serially on the renderer's main thread before the bytes went to ffmpeg.
Workers raced to produce ImageBitmaps and then queued waiting for the consumer to
read each one back.

Fix: gave `RenderJob` an `outputFormat: "bitmap" | "rgba"` field. When `"rgba"`,
the worker does its own `getImageData` on its own composite canvas and posts the
`Uint8Array` back as a transferable. Per-worker readback now runs in parallel.

```
Before:  6 fps → 8 fps (workers scaffolded but readback serial)
After:   8 fps → 23 fps (parallel readback, 2 workers)
```

**3× win.**

---

## Phase 5 — Skip IPC for the hot path: MessagePort

`ipcRenderer.invoke('videoEncoder:writeFrame', sessionId, arrayBuffer)` works, but
each call structured-clones the buffer and waits for an IPC round-trip ack. At
30+ fps and 8 MB/frame that's a non-trivial cost.

Replaced with `MessageChannelMain`: when the encoder session starts, the main
process creates a channel, sends one port to the renderer via
`event.sender.postMessage(channel, msg, [port2])`, and pipes incoming messages
straight to ffmpeg's stdin. The renderer transfers the ArrayBuffer
(`port.postMessage(buf, [buf])`) — zero-copy across processes, no per-frame ack.

If the transport fails to open, the IPC fallback kicks in transparently. The
console logs which path is in use:

```
[FfmpegVideoEncoder] Using MessagePort transport
```

Modest but measurable win on top of Phase 4.

---

## Phase 6 — Force the discrete GPU

The console probe revealed the renderer was on the Intel iGPU, not the NVIDIA
dGPU:

```js
const c = document.createElement('canvas').getContext('webgl');
c.getParameter(c.getExtension('WEBGL_debug_renderer_info').UNMASKED_RENDERER_WEBGL);
// ANGLE (Intel, Intel(R) UHD Graphics ... Direct3D11)
```

So this absurdity was happening:

```
Intel iGPU renders → readback to system RAM → IPC → ffmpeg → upload to NVIDIA dGPU → encode
```

Two GPUs bouncing data through main memory. Fix in `electron/main.ts`, before
`app.ready`:

```ts
app.commandLine.appendSwitch("force_high_performance_gpu");
app.commandLine.appendSwitch("enable-features", "UseHighPerformanceGPUForWebGL");
```

After restart:

```
ANGLE (NVIDIA, NVIDIA GeForce RTX 3050 Laptop GPU ...)
```

Per-worker readback dropped from 41 ms → 26 ms. Fps moved from 24 → 40 peak.

Note: Windows per-app GPU preferences in Settings can still override these
switches, so check `chrome://gpu` after restart to confirm.

---

## Phase 7 — Skip the 2D composite entirely

With workers, MessagePort, dGPU, and NVENC all working, readback was still
~26 ms — most of the per-frame budget. Why?

Because `compositeCtx.getImageData` does *three* slow things: WebGL→2D drawImage
sync, 2D backbuffer readback, and a BGRA→RGBA byte-swap. The right answer is to
not go through a 2D canvas at all.

Refactor: when no shadow / webcam / cursor / annotations are enabled (the common
case), render the entire frame inside PixiJS — including the wallpaper background
as a Pixi `Sprite` at z=0 of the stage — and use Pixi's `extract.pixels()` for the
readback. That's `gl.readPixels` directly on the WebGL framebuffer, no detour.

Worker logs surface which path is active per init:

```
[renderWorker] init: bgInPixi=true, fastPath=true
  (shadow=false, webcam=false, cursorHighlight=false, annotations=false)
```

Per-frame timing collapses to:

```
worker avg/frame: pixi=0.5ms composite=0.0ms extras=0.0ms readback=27ms
```

That `composite=0.0ms` confirms we skipped it. The readback dropped some too.

---

## Phase 8 — Things I tried that didn't help

Honest reporting matters more than only counting wins:

### Bumping worker count to 4

Hypothesis: more workers = more parallel readback. Reality: ANGLE D3D11 serializes
`gl.readPixels` across all WebGL contexts on the same D3D11 device. Per-worker
readback time scales 1/N exactly — total wall throughput is flat. **Reverted to
2 workers** (less in-flight memory for the same throughput).

### ANGLE Vulkan backend

`app.commandLine.appendSwitch("use-angle", "vulkan")` switched to Vulkan ANGLE.
Confirmed via the renderer probe: `ANGLE (NVIDIA, Vulkan 1.4.329 ...)`. Per-frame
readback was identical to D3D11 (~28 ms vs ~27 ms), but the **40 fps peaks went
away** — Vulkan stabilized at 24 fps steady. Best guess: Vulkan synchronizes more
aggressively, removing the burst capability we had on D3D11. Reverted.

### Lower export resolution

Tested 1080p → 720p. Pixel count drops 2.25×. Readback dropped from 28 ms to 30 ms
— *essentially flat*. That's the diagnostic that proves the readback wall isn't
bandwidth (which would scale linearly with bytes). It's per-call sync overhead.

The implication: per-pixel cost is small; the GPU pipeline flush on each
`gl.readPixels` is the real wall. Fixing this requires either batched readback
(N frames, one readback) or async readback via `gl.fenceSync` + WebGL2 PBOs —
both significant refactors and deferred for now.

---

## Where we landed

Final pipeline for a typical 1080p export:

```
WebCodecs decoder (renderer)
    → createImageBitmap (renderer main thread, ~3 ms)
    → submit to worker pool (transferable; up to MAX_IN_FLIGHT = 4 in flight)

Worker N (×2):
    → PixiJS render to WebGL framebuffer (~0.5 ms)
    → app.renderer.extract.pixels(stage)  ← gl.readPixels (~27 ms)
    → postMessage(rgba.buffer, [rgba.buffer])   ← zero-copy

Renderer (drainOne, FIFO):
    → port.postMessage(rgba, [rgba])      ← zero-copy MessagePort to main

Main:
    → ffmpeg.stdin.write(buf)
    → ffmpeg encodes via h264_nvenc to a temp .mp4 file

Finalize:
    → ffmpeg muxes temp video + audio (from AudioProcessor) into final .mp4
    → renderer reads final file as a Blob, save dialog
```

Result: **~25–40 fps for 1080p exports** depending on system state (idle peak ~40,
under load ~25). A 99-second recording exports in ~1 minute. From 13 minutes.

---

## What I'd do next

In rough order of effort/payoff:

1. **Pass-through fast path for unedited segments.** If a frame's timeline state has
   no active zoom / crop / effects, send the original decoded VideoFrame directly
   to ffmpeg — skip the worker entirely. For typical screencasts this could double
   throughput again.
2. **Batched readback.** Render N frames into a tall texture, single `gl.readPixels`
   for all of them. Amortizes the per-call sync cost. Estimated 2× win.
3. **WebGPU migration.** WebGPU has `mapAsync` for true async readback — frame N's
   render can overlap with frame N-1's readback. Requires Pixi's WebGPU path to
   stabilize in Electron.
4. **Native CUDA module.** Skip the CPU entirely: pass GPU memory handles from
   PixiJS straight to NVENC. 5–10× ceiling but a real engineering project.

---

## The point

The biggest single takeaway isn't any particular fix — it's that **none of these
were guesses**. Every change was preceded by a measurement and followed by a
measurement. The 27 ms readback floor wasn't visible until the per-stage timing
was added. The iGPU surprise wasn't visible until the WebGL probe was run. The
ANGLE D3D11 serialization wasn't visible until 2 workers vs 4 workers were
benchmarked head to head.

This is how performance work should look: instrument, measure, fix, re-measure.
Repeat until the wall you hit is the one you actually expected.
