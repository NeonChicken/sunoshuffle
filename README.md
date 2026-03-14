# Suno Shuffle

A Chrome extension that intelligently shuffles your Suno liked songs with a persistent queue across browser sessions.

## Features

- **Intelligent shuffle** — no two consecutive songs with the same base name. Strips `(Edit)`, `(FAV)`, and `(ULTRAFAV)` suffixes before comparing, so variations of the same song are never played back-to-back.
- **Full library scan** — auto-scrolls your liked songs page to load every song before shuffling, including those hidden behind lazy loading.
- **Persistent queue** — your position in the queue is saved across browser restarts. Recently played songs won't repeat until the entire library has been heard.
- **Cycle tracking** — keeps track of how many times you've cycled through your full library.
- **Floating player overlay** — draggable player with play/pause, skip, previous, progress bar, and cover art. Minimizable and position is remembered.

## Installation

1. Clone or download this repository.
2. Open Chrome and go to `chrome://extensions/`.
3. Enable **Developer mode** (top-right toggle).
4. Click **Load unpacked** and select the repository folder.

## Usage

1. Go to [suno.com/me](https://suno.com/me) and open your **Liked** songs tab (or go to `/playlist/liked`).
2. Click the Suno Shuffle icon in your Chrome toolbar.
3. Click **Start Shuffle** — the extension will scan all your liked songs by auto-scrolling the page, then start playing.
4. Use the floating overlay to control playback from any suno.com page.

### Resuming after closing Chrome

Open any `suno.com` page, click the extension icon, and hit **Resume**. The queue and your position are saved automatically.

### Re-shuffle

Click **Re-shuffle** in the popup to re-randomize the remaining unplayed songs in the current cycle without losing your played history.

### Clear history

Click **Clear queue & history** to wipe everything and start fresh on your next **Start Shuffle**.

## How the shuffle works

Songs are shuffled using a constrained Fisher-Yates algorithm. After the initial shuffle, multiple passes fix any positions where two songs with the same normalized title (suffixes stripped) would play consecutively. This ensures that, for example, *"My Song"*, *"My Song (Edit)"*, and *"My Song (FAV)"* are always separated in the queue.

## Notes

- The extension only works on `suno.com` pages.
- Audio is played directly from Suno's CDN — no API keys or authentication required.
- The extension does not interact with or modify Suno's own player.
