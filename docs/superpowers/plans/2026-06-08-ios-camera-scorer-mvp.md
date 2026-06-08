# iOS Camera + Scorer MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port the tested Android camera-and-scorer workflow to a native SwiftUI iPhone app for the June 13, 2026 tournament.

**Architecture:** Keep the existing AVFoundation recorder and place a SwiftUI scoring layer above its preview so saved video remains clean. Add focused Swift files for settings, API/models, scoring state, navigation, and screens; mirror the Android/API contract rather than redesigning behavior. Test scoring and JSON payload logic separately from camera hardware, then compile and run on one real iPhone before installing on the remaining devices.

**Tech Stack:** Swift 5, SwiftUI, AVFoundation, PhotoKit, URLSession, XCTest, XcodeGen, GitHub Actions macOS runner.

---

## Read First

- `docs/superpowers/specs/2026-06-08-ios-camera-scorer-mvp-design.md`
- `docs/rxs-companion/phase1-eventmanager-api-report.md`
- `companion/android/app/src/main/java/com/rxs/recorder/data/Rxs.kt`
- `companion/android/app/src/main/java/com/rxs/recorder/ui/AppRoot.kt`
- `companion/android/app/src/main/java/com/rxs/recorder/ui/ScoreOverlay.kt`
- `companion/android/app/src/main/java/com/rxs/recorder/ui/CameraScreen.kt`
- `companion/ios/Sources/CameraController.swift`
- `companion/ios/Sources/CameraCapabilities.swift`
- `companion/ios/Sources/ContentView.swift`

Do not modify the tested Android implementation. Do not add offline mesh,
team scoring, create-at-stadium, deck-cycle locking, or App Store distribution.

## File Structure

- Create `companion/ios/Sources/Models.swift`: Codable event/result models and pure scoring rules.
- Create `companion/ios/Sources/AppSettings.swift`: persisted server URL and admin credentials.
- Create `companion/ios/Sources/RxsAPI.swift`: login, events, event state, and match PUT requests.
- Create `companion/ios/Sources/ScoringStore.swift`: mutable match state, undo, debounce, sync status.
- Create `companion/ios/Sources/AppRoot.swift`: route ownership and top-level navigation.
- Create `companion/ios/Sources/SetupView.swift`: server/admin connection screen.
- Create `companion/ios/Sources/EventPickerView.swift`: event list and refresh.
- Create `companion/ios/Sources/MatchPickerView.swift`: solo match list and refresh.
- Create `companion/ios/Sources/ScoreOverlayView.swift`: landscape scoring controls.
- Modify `companion/ios/Sources/ContentView.swift`: camera route accepting match/API/navigation inputs.
- Modify `companion/ios/Sources/CameraCapabilities.swift`: prefer 1080p/60.
- Modify `companion/ios/Sources/CameraController.swift`: safe lifecycle and back-navigation support.
- Modify `companion/ios/Sources/RXSRecorderApp.swift`: launch `AppRoot`.
- Modify `companion/ios/project.yml`: add XCTest target and update version.
- Create `companion/ios/Tests/ModelsTests.swift`: scoring, parsing, and payload tests.
- Create `companion/ios/Tests/ScoringStoreTests.swift`: finish and undo state tests.
- Create `.github/workflows/ios-prototype.yml`: macOS compile/test workflow.
- Modify `companion/ios/README.md`: Mac setup, free signing, device test, six-device checklist.

### Task 1: Add the iOS Test Target

**Files:**
- Modify: `companion/ios/project.yml`
- Create: `companion/ios/Tests/ModelsTests.swift`

- [ ] **Step 1: Add a deliberately failing smoke test**

Create:

```swift
import XCTest
@testable import RXSRecorder

final class ModelsTests: XCTestCase {
    func testScoringContractExists() {
        XCTAssertEqual(Scoring.points(for: ["S"]), 1)
    }
}
```

- [ ] **Step 2: Add the test target to XcodeGen**

Add to `targets`:

```yaml
  RXSRecorderTests:
    type: bundle.unit-test
    platform: iOS
    sources:
      - path: Tests
    dependencies:
      - target: RXSRecorder
    settings:
      base:
        GENERATE_INFOPLIST_FILE: YES
```

Set `MARKETING_VERSION` to `"0.2-ios-mvp"` on the app target.

- [ ] **Step 3: Generate and run to verify the intended failure**

Run on macOS:

```bash
cd companion/ios
xcodegen generate
xcodebuild test \
  -project RXSRecorder.xcodeproj \
  -scheme RXSRecorder \
  -destination 'platform=iOS Simulator,name=iPhone 15'
```

Expected: compilation fails because `Scoring` does not exist yet. If the named
simulator differs, use `xcrun simctl list devices available` and substitute an
installed iPhone simulator.

- [ ] **Step 4: Commit the test harness**

```bash
git add companion/ios/project.yml companion/ios/Tests/ModelsTests.swift
git commit -m "test(ios): add XCTest target for camera scorer"
```

### Task 2: Implement Models, Scoring Rules, Parsing, and PUT Encoding

**Files:**
- Create: `companion/ios/Sources/Models.swift`
- Modify: `companion/ios/Tests/ModelsTests.swift`

- [ ] **Step 1: Expand failing contract tests**

Cover these exact assertions:

```swift
func testFinishPointsAndThresholds() {
    XCTAssertEqual(Scoring.points(for: ["S", "O", "B", "E", "L"]), 8)
    XCTAssertEqual(Scoring.threshold(round: "F"), 7)
    XCTAssertEqual(Scoring.threshold(round: "SF"), 5)
    XCTAssertEqual(Scoring.threshold(round: "R1"), 4)
}

func testEventStateGroupsSoloRowsByMatchSid() throws {
    let data = Data(#"""
    {
      "builds":{"alice":["A1","A2"],"bob":["B1","B2"]},
      "beyResults":[
        {"player":"alice","round":"R1","_matchSid":"R1|alice|bob|0",
         "builds":[{"build":"A1","finishes":["O"],"deployed":true}],"win":false},
        {"player":"bob","round":"R1","_matchSid":"R1|alice|bob|0",
         "builds":[{"build":"B1","finishes":["L"],"deployed":true}],"win":false}
      ]
    }
    """#.utf8)
    let state = try EventState.decode(data)
    XCTAssertEqual(state.matches.count, 1)
    XCTAssertEqual(state.matches[0].sid, "R1|alice|bob|0")
    XCTAssertEqual(state.matches[0].p1.points, 2)
}

func testPutPayloadUsesMergeModeAndTwoRows() throws {
    let match = SoloMatch.fixture()
    let payload = try MatchPayload.encode(
        eventId: "event-1", match: match, submitted: true,
        username: "judge", password: "secret"
    )
    let object = try XCTUnwrap(
        JSONSerialization.jsonObject(with: payload) as? [String: Any]
    )
    XCTAssertEqual(object["mergeMode"] as? Bool, true)
    XCTAssertEqual((object["beyResults"] as? [[String: Any]])?.count, 2)
    XCTAssertEqual(
        (object["beyResults"] as? [[String: Any]])?.first?["_submitted"] as? Bool,
        true
    )
}
```

Add a test-only `SoloMatch.fixture()` extension in the test file.

- [ ] **Step 2: Run the tests and confirm failure**

Use the Task 1 `xcodebuild test` command.

Expected: failure for missing models, parser, and payload encoder.

- [ ] **Step 3: Implement the pure model layer**

Create public/internal app types matching Android:

```swift
enum Scoring {
    static let finishPoints = ["S": 1, "O": 2, "E": 3, "B": 2, "L": 0]

    static func points(for finishes: [String]) -> Int {
        finishes.reduce(0) { $0 + (finishPoints[$1] ?? 0) }
    }

    static func threshold(round: String) -> Int {
        switch round {
        case "F": return 7
        case "SF": return 5
        default: return 4
        }
    }
}

struct Bey: Codable, Equatable, Identifiable {
    var id = UUID()
    var build: String
    var finishes: [String] = []
    var deployed = false

    enum CodingKeys: String, CodingKey { case build, finishes, deployed }
}

struct Side: Codable, Equatable {
    var player: String
    var entryId: String?
    var displayLabel: String?
    var builds: [Bey]
    var win: Bool

    var name: String { displayLabel?.isEmpty == false ? displayLabel! : player }
    var points: Int {
        builds.flatMap(\.finishes).reduce(0) {
            $0 + (Scoring.finishPoints[$1] ?? 0)
        }
    }
}

struct SoloMatch: Equatable, Identifiable {
    var id: String { sid }
    var sid: String
    var round: String
    var p1: Side
    var p2: Side
    var submitted: Bool
    var label: String { "\(round) - \(p1.name) vs \(p2.name)" }
}
```

Also implement:

- `EventSummary` decoding `id`, `title`, `type`, and `joiners`.
- Private `ResultRow` decoding `_matchSid`, `_submitted`, builds, identity fields.
- `EventState.decode(_:)` that ignores team rows, preserves first-seen sid order,
  and groups the first two rows for each sid into `SoloMatch`.
- `MatchPayload.encode(...)` using `JSONSerialization`, with
  `adminUsername`, `adminPassword`, `eventId`, `beyResults`, `builds`,
  `mergeMode: true`, and `revivedSids: []`.
- `_submitted` only when the `submitted` argument is true.

Do not encode the generated `Bey.id`.

- [ ] **Step 4: Run tests**

Expected: all `ModelsTests` pass.

- [ ] **Step 5: Commit**

```bash
git add companion/ios/Sources/Models.swift companion/ios/Tests/ModelsTests.swift
git commit -m "feat(ios): add RXS models and scoring contract"
```

### Task 3: Add Settings and the RXS API Client

**Files:**
- Create: `companion/ios/Sources/AppSettings.swift`
- Create: `companion/ios/Sources/RxsAPI.swift`
- Modify: `companion/ios/Tests/ModelsTests.swift`

- [ ] **Step 1: Add URL normalization tests**

```swift
func testNormalizeServerURL() {
    XCTAssertEqual(
        AppSettings.normalizeServerURL("beybladerxs.pages.dev/path"),
        "https://beybladerxs.pages.dev"
    )
    XCTAssertEqual(
        AppSettings.normalizeServerURL("http://example.com/"),
        "https://example.com"
    )
}
```

- [ ] **Step 2: Run and confirm failure**

Expected: `AppSettings` is missing.

- [ ] **Step 3: Implement settings**

Use `UserDefaults` with keys `rxs.url`, `rxs.user`, and `rxs.pass`. Default the
server URL to `https://beybladerxs.pages.dev`. Match Android normalization:
trim whitespace, force HTTPS, and remove path/trailing slash.

Expose:

```swift
@MainActor final class AppSettings: ObservableObject {
    @Published var serverURL: String
    @Published var adminUsername: String
    @Published var adminPassword: String
    var isConfigured: Bool { /* all fields non-empty */ }
    func save()
    static func normalizeServerURL(_ raw: String) -> String
}
```

- [ ] **Step 4: Implement `RxsAPI`**

Use an injected `URLSession` and `AppSettings`:

```swift
final class RxsAPI {
    init(settings: AppSettings, session: URLSession = .shared)
    func login(url: String, username: String, password: String) async throws
    func events() async throws -> [EventSummary]
    func eventState(eventId: String) async throws -> EventState
    func putMatch(eventId: String, match: SoloMatch, submitted: Bool) async throws
}
```

Requirements:

- Timeouts of approximately 15 seconds for requests.
- `Content-Type: application/json` on POST/PUT.
- Throw a readable server `error` field for non-2xx responses.
- Append `_t` to event-state GET requests.
- Read `X-BEY-CONCURRENCY`; throw a clear unsafe-concurrency error when it is
  `best-effort-kv`.
- Never let an API error stop or alter `CameraController`.

- [ ] **Step 5: Run tests**

Expected: model/settings tests pass. Network behavior is verified later against
the real server because no HTTP mocking dependency is introduced for the MVP.

- [ ] **Step 6: Commit**

```bash
git add companion/ios/Sources/AppSettings.swift companion/ios/Sources/RxsAPI.swift companion/ios/Tests/ModelsTests.swift
git commit -m "feat(ios): add settings and RXS API client"
```

### Task 4: Build the Connect, Event, and Match Flow

**Files:**
- Create: `companion/ios/Sources/AppRoot.swift`
- Create: `companion/ios/Sources/SetupView.swift`
- Create: `companion/ios/Sources/EventPickerView.swift`
- Create: `companion/ios/Sources/MatchPickerView.swift`
- Modify: `companion/ios/Sources/RXSRecorderApp.swift`

- [ ] **Step 1: Implement route ownership**

Use:

```swift
enum AppRoute {
    case setup
    case events
    case matches(EventSummary)
    case camera(EventSummary, SoloMatch)
}
```

`AppRoot` owns one `AppSettings`, one `RxsAPI`, and `@State var route`. Start at
events when settings are configured, otherwise setup.

- [ ] **Step 2: Implement `SetupView`**

Match Android behavior:

- Server URL, username, secure password.
- Default live URL.
- Disable Connect while fields are empty or a request is running.
- Normalize URL before login.
- Save only after successful login.
- Show the API error without leaving the screen.

- [ ] **Step 3: Implement event and match pickers**

Both screens need:

- Black/dark UI matching Android's tested flow.
- Loading, empty, error, Retry, and Refresh states.
- Settings navigation from the event list.
- Back navigation from matches.
- Match rows showing `submitted` or current score.
- Only solo matches returned by `EventState`.

- [ ] **Step 4: Launch `AppRoot`**

Replace `ContentView()` in `RXSRecorderApp` with `AppRoot()`.

- [ ] **Step 5: Compile in the simulator**

Run:

```bash
xcodebuild build \
  -project companion/ios/RXSRecorder.xcodeproj \
  -scheme RXSRecorder \
  -destination 'platform=iOS Simulator,name=iPhone 15'
```

Expected: `** BUILD SUCCEEDED **`. Camera functionality is not validated in the simulator.

- [ ] **Step 6: Commit**

```bash
git add companion/ios/Sources/AppRoot.swift companion/ios/Sources/SetupView.swift companion/ios/Sources/EventPickerView.swift companion/ios/Sources/MatchPickerView.swift companion/ios/Sources/RXSRecorderApp.swift
git commit -m "feat(ios): add login event and match navigation"
```

### Task 5: Implement the Tested Scoring Engine and Undo

**Files:**
- Create: `companion/ios/Sources/ScoringStore.swift`
- Create: `companion/ios/Tests/ScoringStoreTests.swift`

- [ ] **Step 1: Write state-transition tests**

Test these behaviors:

```swift
@MainActor final class ScoringStoreTests: XCTestCase {
    func testFinishAddsWinnerCodeAndOpponentLoss() {
        let store = ScoringStore(match: .fixture(), eventId: "e", api: nil)
        store.apply(winner: .p1, finish: "O")
        XCTAssertEqual(store.match.p1.builds[0].finishes, ["O"])
        XCTAssertEqual(store.match.p2.builds[0].finishes, ["L"])
        XCTAssertEqual(store.match.p1.points, 2)
    }

    func testThresholdDeclaresWinner() {
        var match = SoloMatch.fixture(round: "R1")
        match.p1.builds[0].finishes = ["E"]
        let store = ScoringStore(match: match, eventId: "e", api: nil)
        store.apply(winner: .p1, finish: "S")
        XCTAssertTrue(store.match.p1.win)
    }

    func testUndoRestoresPreviousSnapshot() {
        let store = ScoringStore(match: .fixture(), eventId: "e", api: nil)
        store.apply(winner: .p1, finish: "B")
        store.undo()
        XCTAssertEqual(store.match.p1.points, 0)
        XCTAssertEqual(store.match.p2.builds[0].finishes, [])
    }
}
```

- [ ] **Step 2: Run and confirm failure**

Expected: `ScoringStore` is missing.

- [ ] **Step 3: Implement `ScoringStore`**

Use:

```swift
enum MatchSide { case p1, p2 }
enum SyncStatus: Equatable {
    case idle, waiting, syncing, synced, submitting, submitted, failed(String)
}

@MainActor final class ScoringStore: ObservableObject {
    @Published private(set) var match: SoloMatch
    @Published var deployedP1: Int
    @Published var deployedP2: Int
    @Published private(set) var syncStatus: SyncStatus = .idle

    func selectBey(side: MatchSide, index: Int)
    func apply(winner: MatchSide, finish: String)
    func undo()
    func submit() async
}
```

Implementation requirements:

- Snapshot the complete match and deployed indices before every finish.
- Ignore finishes once a winner is decided.
- Add the finish to the winner's selected Bey and `L` to the loser's selected Bey.
- Mark both selected Beys deployed.
- Set winner at `Scoring.threshold(round:)`.
- Debounce non-final writes by 600 ms using a cancellable `Task`.
- Undo restores a snapshot and schedules another write.
- Submit cancels debounce, marks submitted, and immediately writes.
- On failure, retain the local score and expose `.failed(message)`.
- Allow `api: nil` for pure unit tests.

- [ ] **Step 4: Run all tests**

Expected: scoring and model tests pass.

- [ ] **Step 5: Commit**

```bash
git add companion/ios/Sources/ScoringStore.swift companion/ios/Tests/ScoringStoreTests.swift
git commit -m "feat(ios): add scoring state undo and live sync"
```

### Task 6: Change Camera Preference to 1080p/60

**Files:**
- Modify: `companion/ios/Sources/CameraCapabilities.swift`
- Modify: `companion/ios/Sources/CameraController.swift`
- Modify: `companion/ios/Sources/ContentView.swift`

- [ ] **Step 1: Change the format preference**

Replace the selection order with:

```swift
if let f = find(1920, 1080, 60) {
    chosenFormat = f
    chosen = RecordingProfile(width: 1920, height: 1080, fps: 60)
} else if let f = find(1920, 1080, 30) {
    chosenFormat = f
    chosen = RecordingProfile(width: 1920, height: 1080, fps: 30)
} else {
    let best = all.max {
        (Int($0.0) * Int($0.1)) < (Int($1.0) * Int($1.1))
    }!
    chosenFormat = best.3
    chosen = RecordingProfile(
        width: best.0, height: best.1, fps: Int(min(best.2, 30))
    )
}
```

Update comments and README claims so 4K/60 is no longer the default.

- [ ] **Step 2: Make camera configuration idempotent**

Guard `configure()` against duplicate inputs/outputs and duplicate observer
registration. Add `shutdown()` that stops recording if necessary, stops the
session on its queue, invalidates the timer, and removes observers.

- [ ] **Step 3: Protect back navigation**

Change the camera view API to:

```swift
struct ContentView: View {
    let event: EventSummary
    let match: SoloMatch
    let api: RxsAPI
    let onBack: () -> Void
}
```

When recording, Back must show a confirmation before stopping/leaving. When not
recording, Back returns immediately.

- [ ] **Step 4: Compile and commit**

Run simulator build and tests. Expected: success.

```bash
git add companion/ios/Sources/CameraCapabilities.swift companion/ios/Sources/CameraController.swift companion/ios/Sources/ContentView.swift companion/ios/README.md
git commit -m "feat(ios): default recording to 1080p60"
```

### Task 7: Add the Camera Scoring Overlay

**Files:**
- Create: `companion/ios/Sources/ScoreOverlayView.swift`
- Modify: `companion/ios/Sources/ContentView.swift`
- Modify: `companion/ios/Sources/AppRoot.swift`

- [ ] **Step 1: Build the overlay**

`ScoreOverlayView` receives `@ObservedObject var store: ScoringStore`.

It must show:

- Left and right 124-point-wide translucent player panels.
- Player name and large points.
- One tappable chip per Bey, with a clear selected state.
- Large `S`, `O`, `B`, `E` buttons on each player's side.
- Center-top total score, winner, sync status, Undo, and Submit.
- Disabled finish controls after winner detection.
- Safe-area padding for iPhone 11 through iPhone 15 landscape layouts.

Use the Android colors and wording as the reference. Do not redesign the flow.

- [ ] **Step 2: Integrate with camera**

In `ContentView`:

- Create one `@StateObject` `ScoringStore` for the selected match.
- Draw `CameraPreview` first.
- Draw recording HUD and `ScoreOverlayView` above it.
- Keep the record button accessible at bottom center.
- Ensure the movie output still records only AVFoundation connections.
- Show sync failure as text without blocking record/stop.

- [ ] **Step 3: Route the selected match**

`AppRoot` must create the camera route using the selected event and match and
return to that event's match list on Back.

- [ ] **Step 4: Run tests and simulator build**

Expected: tests pass and build succeeds. Simulator only validates layout and
navigation, not capture.

- [ ] **Step 5: Commit**

```bash
git add companion/ios/Sources/ScoreOverlayView.swift companion/ios/Sources/ContentView.swift companion/ios/Sources/AppRoot.swift
git commit -m "feat(ios): overlay scoring controls on camera"
```

### Task 8: Add macOS CI Compile and Test

**Files:**
- Create: `.github/workflows/ios-prototype.yml`

- [ ] **Step 1: Add workflow**

Use:

```yaml
name: iOS prototype compile

on:
  workflow_dispatch:
  push:
    branches: [main]
    paths:
      - "companion/ios/**"
      - ".github/workflows/ios-prototype.yml"

jobs:
  test:
    runs-on: macos-15
    steps:
      - uses: actions/checkout@v4
      - name: Install XcodeGen
        run: brew install xcodegen
      - name: Generate project
        working-directory: companion/ios
        run: xcodegen generate
      - name: Select available simulator
        id: simulator
        run: |
          DEVICE=$(xcrun simctl list devices available -j | \
            python3 -c 'import json,sys; d=json.load(sys.stdin)["devices"]; print(next(x["name"] for xs in d.values() for x in xs if x["name"].startswith("iPhone")))')
          echo "name=$DEVICE" >> "$GITHUB_OUTPUT"
      - name: Test
        run: |
          xcodebuild test \
            -project companion/ios/RXSRecorder.xcodeproj \
            -scheme RXSRecorder \
            -destination 'platform=iOS Simulator,name=${{ steps.simulator.outputs.name }}' \
            CODE_SIGNING_ALLOWED=NO
```

- [ ] **Step 2: Push or dispatch and inspect result**

Expected: workflow completes successfully. If the runner's Xcode does not
support deployment target 16, use an available simulator runtime without
raising the app's minimum target.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/ios-prototype.yml
git commit -m "ci(ios): compile and test Swift prototype"
```

### Task 9: First Real-iPhone Gate

**Files:**
- Modify: `companion/ios/README.md`
- Modify only the Swift files implicated by actual device failures.

- [ ] **Step 1: Prepare the Mac**

```bash
git pull
cd companion/ios
brew install xcodegen
xcodegen generate
open RXSRecorder.xcodeproj
```

In Xcode, choose a unique bundle ID if necessary, select a free Personal Team,
connect one iPhone, enable Developer Mode, trust the Mac, and press Run.

- [ ] **Step 2: Run the acceptance flow**

Verify on one real iPhone:

1. Login succeeds.
2. Events and matches load.
3. Camera reports 1080p/60, or honestly falls back to 1080p/30.
4. Recording starts with microphone audio.
5. Finish taps, selected Beys, points, winner, Undo, and Submit are correct.
6. Event Manager receives scores.
7. Network failure shows an error but recording continues.
8. Stop saves the clip to Photos.
9. The saved clip contains no scoring UI.
10. Back cannot accidentally discard an active recording.

- [ ] **Step 3: Fix only observed blockers**

For every device failure:

- Reproduce it.
- Add a unit test when the failure is in models/scoring/payload logic.
- Make the smallest correction.
- Re-run tests and the device flow.

- [ ] **Step 4: Document the tested device**

Record iPhone model, iOS version, actual resolution/FPS, clip duration, audio,
heat warning, storage behavior, and sync outcome in `companion/ios/README.md`.

- [ ] **Step 5: Commit**

```bash
git add companion/ios companion/ios/README.md
git commit -m "fix(ios): close real-device MVP blockers"
```

### Task 10: Install and Smoke-Test Six iPhones

**Files:**
- Modify: `companion/ios/README.md`

- [ ] **Step 1: Validate provisioning before promising six devices**

Use the available free Apple Accounts and Xcode signing configuration. Confirm
the actual device-registration/signing behavior shown by Xcode. Do not assume
that changing Macs alone changes account provisioning limits.

- [ ] **Step 2: Install on each iPhone**

For every device:

1. Connect to the Mac.
2. Select the correct signing team.
3. Select that iPhone as destination.
4. Press Run.
5. Trust/enable Developer Mode if prompted.
6. Complete one login, event load, match load, score tap, and short recording.

- [ ] **Step 3: Install the fallback PWA**

On every device, open the live Event Manager in Safari and use Share -> Add to
Home Screen. Confirm it can load the tournament event and score a test match.

- [ ] **Step 4: Record the refresh process**

Document which Apple Account/team signs each device and the date each build
expires. Include the weekly refresh procedure: reconnect, open project, select
device/team, and Run.

- [ ] **Step 5: Final verification**

Run:

```bash
xcodebuild test \
  -project companion/ios/RXSRecorder.xcodeproj \
  -scheme RXSRecorder \
  -destination 'platform=iOS Simulator,name=iPhone 15'
git status --short
```

Expected: tests pass. Only intentional files are modified.

## Self-Review

- Spec scope is covered: login/navigation, solo scoring, undo/submit, live sync,
  clean recording, 1080p/60 preference, safe fallback, real-device testing,
  six-device rollout, and PWA fallback.
- Explicitly excluded work remains excluded: offline networking, team scoring,
  create-at-stadium, deck-cycle enforcement, and Android redesign.
- Models and names are consistent across tasks: `SoloMatch`, `Side`, `Bey`,
  `RxsAPI`, `ScoringStore`, `MatchSide`, and `SyncStatus`.
- The plan does not claim hardware success from simulator or CI results; a real
  iPhone acceptance gate is mandatory.
