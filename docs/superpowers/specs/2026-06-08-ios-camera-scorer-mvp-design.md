# iOS Camera + Scorer MVP

**Date:** 2026-06-08  
**Target event:** Saturday, 2026-06-13 (Philippines)  
**Status:** Approved design

## Goal

Port the tested Android camera-and-scoring workflow to iPhone so judges can
record a Beyblade match and score it from the same device. Target installation
is six iPhones, approximately iPhone 11 through iPhone 15, using free Xcode
development signing. The existing Event Manager PWA remains the fallback.

## Scope

The iOS MVP includes:

- Admin connection/login using the existing RXS API.
- Event selection.
- Solo match selection.
- Rear-camera recording with microphone audio.
- A scoring overlay matching the tested Android behavior.
- Spin, Over, Burst, and Extreme finish buttons.
- Deployed-Bey selection.
- Correct points and round win thresholds.
- Undo and Submit.
- Debounced live score synchronization.
- Visible recording and synchronization status.
- Clean video saved to Photos without scoring controls burned into it.
- Default recording preference of 1080p at 60 FPS.

The app may fall back to 1080p/30 when a device cannot provide a stable
1080p/60 format. It must report the selected format honestly.

## Non-Goals

The following are postponed until after the tournament:

- Cross-platform offline synchronization.
- Bluetooth or peer-to-peer score networking.
- A local Wi-Fi tournament server.
- A complete offline outbox.
- Team-match scoring.
- Create-at-stadium.
- Exact three-Bey deck-cycle enforcement.
- Full recording gallery or advanced review tools.
- Cosmetic redesign of the tested Android app.
- App Store or paid TestFlight distribution.

## User Flow

The iOS app follows the same workflow as Android:

`Connect -> Pick Event -> Pick Match -> Camera + Scoring -> Review/Photos`

Android is the behavioral and visual reference. The port should preserve its
terminology, button placement, score behavior, and status feedback where iOS
layout constraints allow.

## Architecture

### Navigation

A SwiftUI app root owns four routes:

1. Setup
2. Event list
3. Match list
4. Camera and scoring

The existing recorder-only `ContentView` becomes the camera route rather than
the entire application.

### API and Models

The Swift client mirrors the existing Android `RxsApi` and data models:

- `POST /api/login`
- `GET /api/events`
- `GET /api/beyresults?eventId=...`
- `PUT /api/beyresults`

Matches are reconstructed by grouping result rows by `_matchSid`. Writes use
the existing merge-mode payload and include admin credentials, event ID,
builds, and the two result rows for the selected match.

The port must preserve:

- `S = 1`, `O = 2`, `B = 2`, `E = 3`, and `L = 0`.
- Solo thresholds: Final = 7, Semifinal = 5, all other rounds = 4.
- Finish on the winner's deployed Bey and `L` on the opponent's deployed Bey.
- The same `_matchSid`, player, build, submitted, and win fields as the web and
  Android clients.

### Camera

The existing AVFoundation recorder remains responsible for capture. It records
camera and microphone connections directly to a movie file, while SwiftUI draws
the scoring controls above the preview. This separation keeps the saved video
clean.

Format selection changes to prefer:

1. 1920x1080 at 60 FPS
2. 1920x1080 at 30 FPS
3. Best stable fallback supported by the device

Recording must continue even when a score synchronization request fails.

### Scoring State

The selected match owns local mutable score state while its camera screen is
open. Every finish tap:

1. Saves an undo snapshot.
2. Applies the finish and opponent loss.
3. Recalculates points and winner state.
4. Updates the overlay immediately.
5. Schedules a debounced server push.

Undo restores the previous score snapshot and schedules another push. Submit
marks the match final and sends an immediate write.

Full persistent offline recovery is out of scope. A failed request leaves the
current screen state intact and shows a retryable error. Recording is never
stopped by a networking error.

## Interface

The landscape camera screen contains:

- Player panels on the left and right.
- Large player scores.
- Clearly highlighted deployed Bey.
- Large `S`, `O`, `B`, and `E` finish controls.
- Center-top match score, winner, sync status, Undo, and Submit.
- Recording timer and record/stop control.
- Back navigation protected against accidental exit while recording.

Controls must respect iPhone safe areas and remain usable on the iPhone 11
through iPhone 15 screen range. The MVP favors large touch targets and
readability over decorative polish.

## Installation

The first real-device build must happen as early as possible on a Mac with
Xcode. Each iPhone must enable Developer Mode, trust the development setup, and
receive a signed build.

Free development signing expires and requires periodic refresh from Xcode.
Provisioning limits must be validated during the first setup before relying on
the planned six-device arrangement. Additional free Apple Accounts may be used
if required.

Every iPhone must also have the existing Event Manager PWA added to its Home
Screen as the fallback scorer.

## Error Handling

- Login failure: remain on Setup and show the server response.
- Event or match fetch failure: show Retry without losing configuration.
- Score write failure: retain local score state and display `sync failed`.
- Unsupported 1080p/60: select 1080p/30 and display the actual format.
- Camera, microphone, or Photos denial: explain which permission is required.
- Low storage: preserve the existing warning and recording block behavior.
- Recording interruption: retain the existing AVFoundation interruption/error
  handling.

## Verification

### Automated

- Unit-test finish points, thresholds, winner detection, undo snapshots, and
  API payload encoding independently of SwiftUI.
- Compile the generated Xcode project on macOS.
- Keep the existing Android and Event Manager tests unchanged.

### Real iPhone

At least one real iPhone must pass this flow before expanding to six devices:

1. Connect and log in.
2. Pick an event and match.
3. Start recording.
4. Score multiple finishes and use Undo.
5. Confirm another device or Event Manager receives the live score.
6. Reach the correct win threshold and Submit.
7. Stop recording.
8. Confirm the video appears in Photos with audio.
9. Confirm no scoring controls appear in the saved video.
10. Record long enough to check heat, storage, and stability.

After that, install and smoke-test each of the six iPhones individually.

## Delivery Order

1. Prepare the Mac, Xcode, signing, and one real iPhone.
2. Add Swift API models and login/event/match navigation.
3. Port and test the scoring engine without camera dependencies.
4. Integrate the scoring overlay with the existing camera.
5. Compile and test on one real iPhone immediately.
6. Fix device-specific camera, layout, signing, and permission issues.
7. Install and smoke-test the remaining iPhones.
8. Confirm the PWA fallback on all six devices.

## Success Criteria

The MVP is ready for tournament use when at least one real iPhone can record a
clean 1080p video while scoring and submitting a solo match correctly, and the
same signed build can be installed and smoke-tested on the intended devices.
Failure to complete the native rollout does not block the event because the PWA
remains available for scoring.
