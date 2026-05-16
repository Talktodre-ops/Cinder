# NOTICE

This project is **Cinder**, a fork of [OpenScreen](https://github.com/openscreenapp/Openscreen)
by Siddharth Vaddem, originally released under the MIT License.

Substantial modifications by Anderson Victor (2026), released under the same
MIT License. Highlights of changes from upstream:

- New hardware-accelerated MP4 export pipeline
  (NVENC / QSV / AMF / x264 fallback, via a bundled or system ffmpeg)
- OffscreenCanvas worker pool with parallel PixiJS rendering
- Zero-copy frame transport from renderer to main process via MessagePort
- Pixi `extract.pixels()` fast path bypassing the 2D composite canvas
- Forces the high-performance GPU on hybrid laptops (NVIDIA Optimus etc.)
- Performance instrumentation and live encoder badge in the export UI
- Bundled-ffmpeg path with `ffmpeg-static` fallback
- Renderer console mirrored to the main-process terminal for debugging

Both copyright lines are preserved in [LICENSE](./LICENSE).
