# RXS Recorder — iOS prototype (Phase 2b)

Recorder-**only** prototype for the "RXS Camera + Scorer" companion. **No scoring yet**
(Phase 6). Goal: capture rear-camera video + mic with AVFoundation, honestly report the
device's real formats, and save a clean clip to Photos — ready for the Phase 3–5 device
comparison on real Beyblade battles.

## What it does
- **Runtime capability query** (`AVCaptureDevice.formats`): resolutions + max FPS per format,
  HDR flag; high-speed/slow-motion formats listed **separately** (never used for normal record).
- **Explicit format + frame-rate selection:** sets `activeFormat` + `activeVideoMin/MaxFrameDuration`
  to pin a constant rate. Preference **1080p/60 → 1080p/30 → largest-available** (4K is
  intentionally not preferred for the scorer MVP — keeps files/heat sane on iPhone 11-15).
- **Records** via `AVCaptureMovieFileOutput`; **saves clean** clip to **Photos** via PhotoKit
  (normally shareable to TikTok/IG/YouTube; the file is the camera+mic only — overlay never burned in).
- **HUD:** REC timer, requested + chosen resolution, mic state, free storage.
- **Controls:** tap-to-focus (+exposure), pinch-to-zoom. Landscape-locked.
- **Detects:** low storage (warn <1 GB, block start <200 MB), recording errors, session
  interruption/runtime errors, **thermal state** (overheating).

## Build & run
**Option A — XcodeGen (recommended):**
```
cd companion/ios
brew install xcodegen        # if needed
xcodegen generate
open RXSRecorder.xcodeproj
```
**Option B — manual:** New Xcode iOS App project (SwiftUI). Delete its default files, drag in
everything under `Sources/`, set the target's Info.plist to `Sources/Info.plist` (or copy the
`NS*UsageDescription` + landscape keys into the generated one).

Then: set your signing Team, pick a **real device** (camera APIs don't run in the Simulator),
build, run, grant Camera/Microphone/Photos-Add.

> Built on Windows without Xcode → **not compiled here**; first build is on your Mac. Targets
> iOS 16+. If signing/bundle-id complains, set them in Signing & Capabilities.

## Phase 3–5 — what to measure on-device (for the test report)
Record a real battle, compare against the Apple Camera app:
- Selected vs **actual** resolution/FPS — verify with `ffprobe -show_streams clip.mov` or the
  Files/Photos info. Confirm no silent downgrade; **disable, don't downgrade**, unsupported modes.
- Dropped frames, focus/exposure, stabilization, **audio sync** over a 10-min clip, device
  heat (thermal HUD), storage use, and that the clip opens in Photos and **shares normally**.
- Document iPhone results separately from the HONOR X7d.

## Known limitations (prototype)
- Exposure lock / stabilization toggle / lens (ultra-wide/tele) switching not yet in the UI —
  capabilities are read; controls land with the scoring build. Tap-focus + pinch-zoom only now.
- `MIC ●` reflects "audio input present + recording," not a live level meter.
- Lock Screen / Action Button / Control Center / Camera Control launch = later (per spec), not here.
- No in-app gallery / frame-step review yet (Phase 8).
