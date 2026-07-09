# RXS Camera + Scorer — iOS MVP

Native SwiftUI port of the **tested Android** camera-and-scorer for the **June 13, 2026**
tournament. Judges log in, pick an event and a solo match, record the battle (rear camera +
mic, **1080p/60** preferred), and score it from the same device. Scores push live to the
Event Manager via the existing API. The Event Manager PWA stays the fallback on every phone.

> **Android is the frozen behavioral/visual reference. This port mirrors it — it does not
> redesign it.** Out of scope (postponed): offline outbox, team scoring, create-at-stadium,
> deck-cycle enforcement, App Store / paid TestFlight.

## What it does
- **Connect** (`POST /api/login`, admin user/pass stored on-device) → **Pick event**
  (`GET /api/events`) → **Pick match** (`GET /api/beyresults?eventId=…`, solo rows grouped by
  `_matchSid`) → **Camera + scoring**.
- **Scoring** mirrors `eventmanager.html`: `S=1, O=2, B=2, E=3, L=0`; solo thresholds
  `F=7, SF=5, else 4`. A finish adds the code to the winner's deployed Bey and `L` to the
  loser's; reaching threshold declares the winner. **Undo** restores the previous snapshot.
  **Submit** marks the match final.
- **Live sync**: each finish/undo schedules a debounced (600 ms) merge-mode
  `PUT /api/beyresults` of just that match's two rows. A failed write keeps the local score
  and shows **`sync failed`** — **recording is never interrupted by a network error.**
- **Clean video**: `AVCaptureMovieFileOutput` records the camera+mic connections only; the
  SwiftUI scoring overlay is drawn on the preview and is **never burned into the saved clip.**
- Saves a clean clip to **Photos** (PhotoKit). Honest format reporting: prefers **1080p/60**,
  falls back to **1080p/30**, then largest-available (fps capped 30).
- Back is **protected while recording** (confirmation before stop/leave).

## Source map (`Sources/`)
| File | Role |
|---|---|
| `Models.swift` | Codable models + pure scoring rules + event-state parsing + PUT encoding |
| `AppSettings.swift` | Persisted server URL + admin creds; URL normalization |
| `RxsAPI.swift` | login / events / event-state / match PUT (15 s timeout, `X-BEY-CONCURRENCY` gate) |
| `ScoringStore.swift` | Mutable match state, undo snapshots, debounced sync, submit |
| `AppRoot.swift` | Routes: setup → events → matches → camera |
| `SetupView` / `EventPickerView` / `MatchPickerView` | Connect + pickers (dark UI) |
| `ScoreOverlayView.swift` | Landscape scoring controls overlaid on the camera |
| `ContentView.swift` | Camera route (recorder + overlay + back protection) |
| `CameraController.swift` / `CameraCapabilities.swift` / `CameraPreview.swift` | AVFoundation recorder (kept) |
| `Tests/` | `ModelsTests`, `ScoringStoreTests` (XCTest; run on macOS) |

## Automated verification
Unit tests cover scoring points/thresholds, winner detection, undo snapshots, event-state
grouping, and PUT payload encoding — independent of camera hardware. CI compiles + tests on a
macOS runner (`.github/workflows/ios-prototype.yml`, `workflow_dispatch` or push to `companion/ios/**`).

> This repo was authored on Windows (no Xcode), so **nothing here was compiled locally.** The
> first compile happens on macOS CI; the first capture test happens on a real iPhone (below).

## First real-iPhone test (Mac + Xcode)
```bash
git pull
cd companion/ios
brew install xcodegen        # if needed
xcodegen generate
open RXSRecorder.xcodeproj
```
In Xcode:
1. Select the **RXSRecorder** target → **Signing & Capabilities**.
2. Pick your **free Personal Team** (Apple ID). If the bundle id `com.rxs.recorder` is taken,
   change it to something unique (e.g. `com.<you>.rxsrecorder`).
3. Connect one iPhone (≈ iPhone 11–15). On the phone: **Settings → Privacy & Security →
   Developer Mode → On**, reboot, and **Trust** this Mac when prompted.
4. Choose that iPhone as the run destination and press **Run**. Grant Camera, Microphone, and
   Photos-Add when asked.

### Acceptance flow (must pass before expanding to six devices)
1. Login succeeds.
2. Events and matches load.
3. Camera reports **1080p/60**, or honestly falls back to **1080p/30**.
4. Recording starts with microphone audio.
5. Finish taps, selected Beys, points, winner, Undo, and Submit are correct.
6. Event Manager (or another device) receives the live scores.
7. A network failure shows an error **but recording continues**.
8. Stop saves the clip to Photos (with audio).
9. The saved clip contains **no scoring UI**.
10. Back cannot accidentally discard an active recording.
11. Record long enough to check heat, storage, and stability.

Record the tested device's results below.

## Six-device rollout
1. **Validate signing limits first.** Free Personal Teams cap registered devices and app id
   slots; confirm the actual behavior Xcode shows before promising six phones. Use additional
   free Apple Accounts if you hit the limit (note which account signs which phone).
2. For each iPhone: connect → select the correct signing team → select the device → **Run** →
   enable Developer Mode / Trust if prompted → run one login + event + match + score tap +
   short recording.
3. **Install the PWA fallback on every phone**: open the live Event Manager in Safari →
   **Share → Add to Home Screen** → confirm it loads the tournament event and can score a test
   match.
4. **Weekly refresh** (free builds expire ~7 days): reconnect the phone, `open RXSRecorder.xcodeproj`,
   select the device + team, press **Run**. Track each phone's signing account and expiry date.

### Device log (fill in on-device)
| iPhone model | iOS | Actual res/FPS | Clip length | Audio | Heat | Storage | Sync | Signing account | Build expires |
|---|---|---|---|---|---|---|---|---|---|
| _pending real-device test_ | | | | | | | | | |

## Known limitations (MVP)
- No offline outbox / no team scoring / no create-at-stadium / no deck-cycle enforcement.
- Admin credentials are stored in `UserDefaults` (prototype). Keychain / scoped per-judge token
  is a follow-up before wider deployment (shared-admin-secret risk noted in the Phase 1 report).
- `X-BEY-CONCURRENCY: best-effort-kv` surfaces an unsafe-multi-judge error (matches the web gate);
  confirm `BEY_STATE_DO` is bound in production before multi-judge live scoring.
- Exposure lock / lens switching / in-app review are not in this build (tap-focus + pinch-zoom only).
