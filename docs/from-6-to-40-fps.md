# Your screen recording took 90 seconds. Why does exporting it take 13 minutes?

You hit export and go make coffee. You come back and the bar says 14 percent.
The laptop fan is spinning like it's rendering a Pixar film, for a clip you shot
in real time. Something is off about that math, and in most screen recorders the
something is the same thing.

This is the story of fixing it. Cinder used to export a 1080p clip at about six
frames per second, so a 90 second recording really did take around 13 minutes.
It now runs at 40+ fps and finishes the same clip in about a minute. Seven times
faster, no new hardware, no rewrite in Rust, no magic. Just hunting down the real
bottleneck, which kept hiding behind two confidently wrong guesses and one
embarrassing discovery about which chip in the laptop was doing the work.

Cinder is a screen recorder I forked from
[OpenScreen](https://github.com/siddharthvaddem/openscreen) for exactly this
reason. The recording side was already good. Exporting was the part that made you
dread hitting the button. If you make demos, tutorials, or bug repros for a
living, you know that wait. Here is everything it took to kill it.

![Before: the same export at 6.0 fps with a 2m 20s ETA, only a Workers badge](screenshots/export-before.png)

*Before. Same 1080p export, 6.0 fps, over two minutes left. The worker pool is on but doing nothing useful yet.*

![After: 30.0 fps steady with an NVENC badge and a 1m 34s ETA on a longer clip](screenshots/export-after.png)

*After. Note the NVENC badge next to the workers badge, and 30 fps steady on a 3,718 frame export (the peaks run higher when the machine is idle).*

## Why the old path was slow

The upstream export path did the obvious thing, which is also the slow thing.

It rendered one frame at a time on the main thread with PixiJS, encoded each
frame with the browser's built in WebCodecs `VideoEncoder`, and muxed the result
into an MP4 with a JavaScript muxer. Every frame took a round trip through
`ipcRenderer.invoke` to reach the encoder, and a `drainOne` loop kept the whole
thing moving one frame at a time with a hard cap on the queue.

Two things made this crawl. First, the render was single threaded, so a machine
with eight cores used one of them. Second, the encoder was configured as
`avc1.640033`, which is H.264 High profile at level 5.1, with
`latencyMode: "quality"`. WebCodecs is allowed to encode that in software even
when you ask for hardware, and in Electron on Windows it quietly did. So the two
heaviest stages of the pipeline, render and encode, were both running on the CPU
one frame at a time. Six fps was the honest result of that design.

## The fix that made it slower

The first move looked easy. Move rendering into a pool of `OffscreenCanvas`
workers so N frames render in parallel. I wrote the worker pool, wired it in, ran
an export, and throughput dropped from 8 fps to 6.

The pool was real. The parallelism was not. The decode loop looked like this:

```js
await decoder.decodeAll(async (videoFrame) => {
  const bitmap = await createImageBitmap(videoFrame);
  const result = await pool.renderFrame({ bitmap, ... }); // waits here
  encoder.encode(result);                                  // then here
});
```

`decodeAll` awaits the callback for every frame. So the pipeline submitted one
frame to the pool, blocked until that exact frame came back, encoded it, and only
then decoded the next. The other workers sat idle the entire time. I had paid the
full cost of the worker machinery (an `ImageBitmap` copy, a `postMessage`, a GPU
readback inside the worker, a transfer back) and bought zero concurrency. Adding
workers to a serial loop just adds overhead.

The fix is a sliding window. Split the loop into a producer and a consumer. The
producer submits render jobs without awaiting them and only blocks when too many
are in flight. The consumer pulls completed frames in order and feeds the
encoder. In Cinder this is a bounded FIFO capped at twice the worker count, so
every worker always has a job waiting without letting memory balloon:

```js
const inFlight = new BoundedFifo(workerCount * 2);

// producer: submit and keep going
const promise = pool.renderFrame({ ... });
await inFlight.push({ frameIndex, promise }); // only blocks when full

// consumer: drain in submission order, encode
const next = await inFlight.pop();
await encoder.encode(await next.promise);
```

The queue is bounded on both ends with real async signaling, no `setTimeout`
polling. Push waits when it is full, pop waits when it is empty, and closing it
wakes everyone. Now the workers actually ran in parallel, and the bottleneck
moved somewhere else. That was the point.

## The encoder was the next wall

With rendering parallel, a new symptom showed up: exports started hot at 40+ fps
and collapsed to 5 within a couple of seconds. That curve is textbook
backpressure. At the start the encoder queue is empty, so the reported fps is
just render throughput. The queue fills fast because rendering is now much faster
than encoding, and once it is full every frame waits on the encoder's sustained
rate. Five fps was the software encoder's real speed with the fast renderer
feeding it.

There were two ways out. The cheap one was to stay on WebCodecs but switch to
`avc1.42E028` (Baseline profile) with `latencyMode: "realtime"`, which encodes
roughly twice as fast and is universally supported. The real one was to stop
using WebCodecs and hand raw frames to a system `ffmpeg` subprocess that talks
to the GPU's dedicated video encoder: NVENC on NVIDIA, QSV on Intel, AMF on AMD,
VideoToolbox on macOS, with `libx264` as the fallback.

Cinder does the real one. The main process probes ffmpeg for the best available
H.264 encoder, spawns it reading raw RGBA on stdin, and writes a temp MP4. On an
RTX 3050 this immediately put a hardware encoder badge in the export dialog and
pushed the peak to 40 fps. Audio is handled by a second ffmpeg process running in
parallel, using a filter graph (`asplit`, `atrim`, `atempo`, `concat`) to apply
trims and speed regions in a few seconds instead of replaying the audio in real
time.

## The wrong GPU

Before the readback story, there was a dumber problem hiding underneath it. I ran
a WebGL probe in the renderer to see which GPU it was actually on:

```js
const gl = document.createElement("canvas").getContext("webgl");
const info = gl.getExtension("WEBGL_debug_renderer_info");
gl.getParameter(info.UNMASKED_RENDERER_WEBGL);
// ANGLE (Intel, Intel(R) UHD Graphics ... Direct3D11)
```

It was on the Intel integrated GPU, not the NVIDIA card. On a laptop with hybrid
graphics that is the default unless you ask otherwise, and it produced something
genuinely stupid: PixiJS rendered on the Intel chip, the frame was read back into
system memory, sent to ffmpeg, and then uploaded to the NVIDIA chip for NVENC to
encode. Two GPUs, with main memory as the courier between them.

The fix is two Chromium switches in the main process before the app is ready:

```js
app.commandLine.appendSwitch("force_high_performance_gpu");
app.commandLine.appendSwitch("enable-features", "UseHighPerformanceGPUForWebGL");
```

After that the probe reported the RTX 3050, per frame readback dropped from 41 ms
to 26 ms, and the peak moved from 24 to 40 fps. Worth checking `chrome://gpu`
after a restart, because Windows per app GPU preferences can still override those
switches.

## The readback wall, and being wrong about it

The numbers were good now but volatile, and one stage still dominated the per
frame timing: readback, the step that copies rendered pixels off the GPU so they
can go to ffmpeg. It was sitting around 26 ms per frame.

That number is suspicious. A 1080p RGBA frame is about 8 MB. At 26 ms that is
roughly 320 MB/s, and PCIe moves gigabytes per second. So the copy was not
bandwidth bound, which meant something else was eating the time.

The first culprit was the readback method. The old path drew the Pixi output onto
a 2D canvas and called `getImageData`, which forces a WebGL to 2D round trip with
a format conversion in the middle. PixiJS can read straight off its own WebGL
framebuffer with `extract.pixels()`, backed by `gl.readPixels`. So I added a fast
path: when a frame has no shadow, webcam, cursor highlight, or annotations, skip
the 2D composite entirely and read the pixels directly from Pixi. For the common
case of a plain screencast with a background, that removed a whole stage.

Then I went hunting for the rest of the readback time and got the diagnosis
wrong. The 2D composite canvas was created with `willReadFrequently: false`,
which lets Chromium keep it on the GPU. Flipping it to `true` backs the canvas
with CPU memory, which should make `getImageData` a plain memcpy. It seemed like
free money. It made the export three times slower.

The reason is a tradeoff I had backwards. `willReadFrequently: true` makes the
one read per frame cheap, but it also flips every draw onto that canvas to
software rendering. The annotation stage draws to that canvas many times per
frame. So I traded one cheap read for a pile of expensive draws, and the extras
stage went from 0.3 ms to 35 ms. Many slow draws cost more than one slow read.
I reverted it.

The honest finding came from testing readback across configurations:

| Backend | Resolution | Readback |
| ------- | ---------- | -------- |
| D3D11   | 1080p      | 27 ms    |
| Vulkan  | 1080p      | 28 ms    |
| Vulkan  | 720p       | 30 ms    |

If readback were bandwidth bound, halving the resolution would roughly halve the
time. It did not move. Changing the ANGLE backend did not move it either. So the
cost is not bytes, it is synchronization. Each `gl.readPixels` forces the GPU to
finish all queued work before it returns, and WebGL exposes a single command
queue no matter how many worker contexts you spin up. One worker's sync stalls
every other worker's pipeline. That puts a hard ceiling on a single GPU:

```
~28 ms sync per frame on one GPU ≈ 35 fps, regardless of worker count
```

This is why the worker count in Cinder tops out at 4 on Windows rather than
scaling with core count. Past two workers the readbacks serialize anyway, and the
extra two only help because they overlap composite and `postMessage` work while
another worker waits on its sync. On macOS with Metal there is no such
serialization, so the pool goes wider.

## Getting the last frames over the wire

The final win came from the transport, not the pixels. Even after the frame bytes
were ready, they still crossed from the renderer to the main process. The original
path used `ipcRenderer.invoke` once per frame, which means a structured clone and
an acknowledgement for every frame. At export rates that is thousands of round
trips carrying 8 MB each.

The first improvement was a `MessageChannelMain` transport that ships the frame
bytes as a transferable, so the buffer moves without being copied. That, with
everything above, got the pipeline into the mid 20s and up to 36 fps.

The last step removed the messaging layer entirely. Cinder opens a localhost TCP
socket straight to the encoder's stdin pipe. Frame bytes go out with a plain
`socket.write` that returns immediately, and the OS handles ordering and
backpressure. No clone, no ack, no per frame IPC. When the kernel buffer fills,
the write signals not to send more and the producer waits for drain, which is
exactly the backpressure you want and it comes for free. The IPC path is still
there as a fallback if the socket cannot bind. Switching the working transport to
TCP took the export from 36 to 47 fps.

## Where it stands

Here is the same 1080p export, start to finish, before and after.

| | Upstream OpenScreen | Cinder |
| --- | --- | --- |
| Export speed (1080p) | ~6 fps | 40+ fps peak |
| Rendering | Single thread, main thread | OffscreenCanvas worker pool |
| Encoder | WebCodecs software H.264 | NVENC / QSV / AMF / VideoToolbox / x264 |
| Frame transport | `ipcRenderer.invoke` per frame | TCP loopback, no per frame IPC |
| Readback | 2D canvas `getImageData` | Pixi `gl.readPixels` fast path |
| Audio | Real time capture | ffmpeg filter graph in parallel |

The pipeline is now four stages with bounded queues between them:

```
StreamingDecoder → [queue] → Worker pool (N) → [queue] → ffmpeg (TCP) → temp.mp4 + audio → mux
```

That 90 second recording that took 13 minutes now exports in about a minute.

The remaining ceiling is architectural, not a bug. On a single GPU the readback
sync caps a full effects export somewhere around 35 to 47 fps depending on the
machine, and the only ways past that are structural: pass unedited segments
straight through without rendering them at all, batch several frames per sync, or
move the readback off the critical path with async fences. Those are real
projects, not one line changes.

The thing I would tell anyone doing this kind of work is that the bottleneck
moved every time I fixed it, and twice I was confidently wrong about where it was.
The worker pool that made things slower, the canvas flag that looked like free
money and cost 3x, the readback that looked like a bandwidth problem and was a
synchronization problem. Measure the stage, change one thing, measure again. The
7x came from doing that five times, not from one clever trick.

## Try it, or take the parts you need

Cinder is open source and MIT licensed. If the export wait is the part of your
current recorder you quietly hate, try it at
[cinder.talktodre.org](https://cinder.talktodre.org/), and the code is on
[GitHub](https://github.com/Talktodre-ops/Cinder). If you're building your own
pixel pipeline in Electron, the useful parts are small and self contained, the
bounded queue, the TCP frame transport, the Pixi `extract.pixels` fast path, and
you're welcome to lift any of them.

And if you read this far hoping I'd cover the last 20 percent, breaking the
readback sync wall to push past 47 fps: that's the next post. It gets into
passing unedited frames straight through without rendering them at all, which for
a normal screencast skips most of the work entirely. That's where the real
ceiling is.
