# Suno Shuffle

A Chrome extension that intelligently shuffles your Suno liked songs with a persistent queue across browser sessions.

## Features

- **Intelligent shuffle** — no two consecutive songs with the same base name. Strips `(Edit)`, `(FAV)`, and `(ULTRAFAV)` suffixes before comparing, so variations of the same song are never played back-to-back.
- **Full list scan** — auto-scrolls the playlist (or your Liked songs) and waits for more songs to load at the bottom, so long lists are picked up completely.
- **Persistent queue** — your position in the queue is saved across browser restarts. Recently played songs won't repeat until the entire library has been heard.
- **Cycle tracking** — keeps track of how many times you've cycled through your full library.
- **Player overlay** — replaces Suno's bottom player bar while shuffling: cover art, seekable progress, play/pause, next/previous, volume and what's up next. Draggable, minimizable to a single row, position remembered. Suno's bar can be shown again with the toggle in the overlay header.
- **Media keys** — keyboard next/previous keys go through the shuffle instead of Suno's own queue.
- **Plays nice with Suno** — start a song yourself in Suno and the shuffle pauses (with a *Resume* button) instead of fighting you.

## Installation

1. Clone or download this repository.
2. Open Chrome and go to `chrome://extensions/`.
3. Enable **Developer mode** (top-right toggle).
4. Click **Load unpacked** and select the repository folder.

## Usage

1. Go to [suno.com/playlist/liked](https://suno.com/playlist/liked).
2. Click the Suno Shuffle icon in your Chrome toolbar.
3. Click **Shuffle this page** — the extension scans the list by auto-scrolling, then starts playing.
   Tip: on long lists, scroll to the bottom yourself first so every song is loaded; the scan is then almost instant.
4. Use the overlay to control playback. You can browse other Suno pages; the next song switches back to your list.

### Resuming after closing Chrome

Open any `suno.com` page, click the extension icon, and hit **Resume**. The queue and your position are saved automatically.

### Re-shuffle

Press **Shuffle this page** again to rescan and re-randomize. Songs already played in the current cycle are skipped until the whole list has been heard.

### Clear history

Click **Clear history** to wipe everything and start fresh on your next **Start Shuffle**.

## Building a release

1. Bump `version` in `manifest.json`.
2. In PowerShell, from the repo folder:
   ```powershell
   .uild.ps1 -KeyPath "path	o\privatekey.pem"
   ```
   This stages only the runtime files in `dist\suno-shuffle-<version>\`, zips them, and signs
   `dist\Suno Shuffle v<version>.crx` with your key (for Verified CRX Uploads).
   Without `-KeyPath` it only builds the zip.
3. Upload the `.crx` in the Chrome Web Store Developer Dashboard.

## How the shuffle works

Songs are shuffled using a constrained Fisher-Yates algorithm. After the initial shuffle, multiple passes fix any positions where two songs with the same normalized title (suffixes stripped) would play consecutively. This ensures that, for example, *"My Song"*, *"My Song (Edit)"*, and *"My Song (FAV)"* are always separated in the queue.

## Notes

- The extension only works on `suno.com` pages.
- Playback goes through Suno's own player: the extension presses the song's row Play button on the list you started from (playlist or library), then follows the player for progress and end-of-track. No API keys or extra authentication required.
- You stay on your list. If you browse elsewhere, the next song switches the tab back to that list (client-side, no reload); a song's own page is only used as a last resort.
