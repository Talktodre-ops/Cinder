# Bundled ffmpeg

Place full ffmpeg builds with hardware-encoder support here. The packaged app
prefers binaries in this directory over `node_modules/ffmpeg-static` when
present (`electron/ffmpeg.ts` does the lookup).

## Expected layout

```
resources/ffmpeg/
├── win/ffmpeg.exe          # Windows
├── mac/ffmpeg              # macOS (universal or arm64)
└── linux/ffmpeg            # Linux x64
```

## Recommended sources

| Platform | Source                                              | Encoders included            |
|----------|-----------------------------------------------------|------------------------------|
| Windows  | https://www.gyan.dev/ffmpeg/builds/ (full build)    | NVENC, QSV, AMF, x264, x265  |
| macOS    | https://evermeet.cx/ffmpeg/                         | VideoToolbox, x264, x265     |
| Linux    | https://github.com/BtbN/FFmpeg-Builds/releases      | NVENC, VAAPI, x264, x265     |

After downloading, extract `ffmpeg(.exe)` (no need for ffprobe) into the
appropriate subdirectory.

## Verifying

Run the app and check the console — `electron/ffmpeg.ts` logs which path it's
using:

- `[ffmpeg] Using bundled binary: <path>` ← good
- `[ffmpeg] Using ffmpeg-static fallback: <path>` ← bundled binary not found

## License

ffmpeg is GPL/LGPL. Distributing a GPL build (with `--enable-gpl` and codecs
like `libx264`) places the *whole app* under GPLv3. Verify the build's license
matches your distribution policy before shipping.

The directory is committed empty so the path exists for `electron-builder`'s
`extraResources` copy. Binaries themselves are intentionally **not** checked
into git — keep them out via `.gitignore` (already configured at the repo
root) and either ship them via your build CI or include a download step in
your release process.
