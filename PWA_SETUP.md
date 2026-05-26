# RXS Event Manager v8 — PWA Setup

You now have **5 files** to deploy. They all need to sit at the **root** of beybladerxs.com (same level as your existing HTML).

## Files

| File | Purpose | Required Location |
|------|---------|-------------------|
| `eventmanager_v8.html` | The main app (rename to `eventmanager.html` to replace v7) | `/eventmanager.html` |
| `manifest.webmanifest` | Tells phones "I'm an installable app" | `/manifest.webmanifest` |
| `sw.js` | Service worker — caches the app for offline use | `/sw.js` (MUST be at root) |
| `icon-192.png` | Home-screen icon (small) | `/icon-192.png` |
| `icon-512.png` | Home-screen icon (large, splash screen) | `/icon-512.png` |
| `icon-512-maskable.png` | Android adaptive icon | `/icon-512-maskable.png` |

## Critical: the service worker MUST be at the site root

`sw.js` cannot live in a subfolder. If you put it at `/pwa/sw.js`, it can only control pages under `/pwa/`. At `/sw.js` it controls the whole site, which is what we want.

## Deploy steps

1. Upload all 6 files to your web root (replacing `eventmanager.html` with v8).
2. Make sure the site is served over **HTTPS**. PWAs do not work over plain HTTP. If you already have a padlock on beybladerxs.com, you're good.
3. Open beybladerxs.com/eventmanager.html in Chrome on your phone.
4. After a few seconds, you should see a blue "📲 Install App" button in the bottom-right corner.
5. Tap it. The app installs to your home screen with the ⚡ icon.

## How offline works

1. Judge opens the installed app **once while online**. The service worker silently downloads the HTML, CSS, and fonts.
2. Signal dies at the venue. The judge keeps using the app — every click auto-saves to the phone's local storage (this was already in your code via `localAutoSave`).
3. The header shows a red "● OFFLINE — SAVING LOCALLY" badge so judges know sync is paused.
4. When signal returns, the badge turns green ("● ONLINE") and your existing `doLiveSync` pushes all queued data to the server.
5. If the judge accidentally closes the app or the phone dies, **the data is still there** — when they reopen, the existing "draft restore" banner asks if they want to recover unsaved changes.

## Updating the app later

When you ship a new version:

1. Edit `eventmanager.html` as usual.
2. **Important:** open `sw.js` and bump `CACHE_VERSION` (e.g. `'rxs-em-v8'` → `'rxs-em-v9'`).
3. Re-upload both files. Installed phones will detect the new version within 60 seconds of opening the app and refresh themselves.

If you forget to bump `CACHE_VERSION`, phones will keep serving the old cached HTML. The version bump is what tells them to re-download.

## Testing the install before the next tournament

Open Chrome DevTools → Application tab → Service Workers. You should see `sw.js` listed as "activated and running." If not, check the browser console for errors (most often: HTTPS missing, or `sw.js` at the wrong path).

To test offline mode: in DevTools → Network tab, set throttling to "Offline" and reload. The app should still load.
