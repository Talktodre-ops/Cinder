# Cinder: a hardware-accelerated screen recorder for Windows

We built Cinder, a desktop screen recorder and editor, and made its video export
run about seven times faster than the tool it started from. This is a short case
study of the problem, the approach, and the result.

One line: a screen recording that took 13 minutes to export now takes about one.

Live: [cinder.talktodre.org](https://cinder.talktodre.org/) · Code:
[github.com/Talktodre-ops/Cinder](https://github.com/Talktodre-ops/Cinder)

---

## The product

Cinder is a desktop app built on Electron. We designed and built the whole thing:
screen and webcam capture, a timeline editor with zoom, crop, backgrounds, cursor
smoothing, keystroke overlays and annotations, and an export pipeline that writes
a finished MP4. It runs on Windows today, with the encoder path auto-detecting the
right hardware on macOS and Linux as well.

The app is three parts working together: a Chromium renderer for the UI and the
PixiJS preview, a Node.js main process that owns the GPU and the ffmpeg
subprocess, and the operating system underneath doing capture and hardware
encoding.

![System architecture](diagrams/system-architecture.svg)

---

## The problem

Recording was fast. Exporting was not. A 90 second 1080p clip exported at about
six frames per second, so writing the final file took roughly 13 minutes with the
laptop fan at full tilt. For a tool people reach for to make demos and tutorials,
the export wait was the thing that made them dread using it.

The cause was in the architecture, not the code quality. The original pipeline
rendered one frame at a time on a single thread, pulled pixels off the GPU through
a slow 2D-canvas readback, encoded them with a software H.264 encoder, and paid a
full inter-process round-trip for every single frame.

![Old export path](diagrams/export-old.svg)

---

## How we solved it

We rebuilt the export path as a staged pipeline where each stage runs
concurrently and hands work to the next through a bounded queue. Four changes did
the real work, and each one was driven by a measurement rather than a guess.

First, rendering moved onto a pool of OffscreenCanvas workers so several frames
render in parallel instead of one at a time. This needed a producer/consumer
design with a sliding window of in-flight frames, because a naive version left
the extra workers idle and was actually slower than one thread.

Second, we replaced the 2D-canvas readback with a direct `gl.readPixels` fast
path through PixiJS, which skips a whole GPU-to-2D conversion for the common case
of a plain screencast.

Third, we stopped encoding in JavaScript and handed raw frames to the system
ffmpeg, which encodes on the GPU's dedicated video engine: NVENC on NVIDIA, QSV on
Intel, AMF on AMD, with a software fallback. Along the way we found the renderer
was running on the laptop's integrated GPU and shuttling every frame through main
memory to the discrete card, and forcing the discrete GPU cut per-frame readback
from 41 ms to 26 ms on its own.

Fourth, we moved the frame bytes off Electron's IPC and onto a localhost TCP
socket straight into ffmpeg's input, which removed a per-frame copy and
acknowledgement at export rates of thousands of frames.

![New export pipeline](diagrams/export-new.svg)

The data flow below shows one frame's journey through the finished pipeline, with
the four wins marked.

![Export data flow](diagrams/export-dataflow.svg)

---

## The result

The same 1080p export went from about six fps to 40+ fps, and the 13 minute wait
dropped to roughly a minute. The export dialog now shows a hardware-encoder badge,
so the user can see NVENC is doing the work.

<p align="center">
  <img src="screenshots/export-before.png" alt="Before: 6 fps export" width="48%" />
  &nbsp;&nbsp;
  <img src="screenshots/export-after.png" alt="After: 30 fps with NVENC and the worker pool" width="48%" />
</p>

| | Before | After |
| --- | --- | --- |
| Export speed (1080p) | ~6 fps | 40+ fps peak |
| Time for a 90 s clip | ~13 min | ~1 min |
| Rendering | single thread | worker pool (N × PixiJS) |
| Encoder | WebCodecs software | NVENC / QSV / AMF / x264 |
| Frame transport | IPC per frame | TCP loopback, zero-copy |

The remaining ceiling is architectural rather than a bug. On a single GPU the
per-frame readback is a pipeline synchronization cost, not a bandwidth one, which
caps a full-effects export somewhere around 40 to 47 fps. Passing unedited frames
straight through without rendering them is the next step, and for a typical
screencast that skips most of the work.

---

## Stack and role

Electron, TypeScript, React, PixiJS, WebCodecs, Web Workers (OffscreenCanvas), and
ffmpeg with hardware H.264 encoders. We designed the architecture, built the
desktop app, and did the performance work end to end.

Longer engineering writeup: [from-6-to-40-fps.md](from-6-to-40-fps.md).
Diagram sources are in [diagrams/](diagrams/) as PlantUML.
