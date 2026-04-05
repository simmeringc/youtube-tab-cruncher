<h1 style="display: flex; align-items: center; gap: 12px;">
  <img src="assets/logo.png" alt="" height="40">
  <span>YouTube Tab Cruncher</span>
</h1>

A Chrome extension for sorting through your YouTube tabs. It walks through each tab, shows you the video, and adds it to a playlist you pick. Then it closes the tab. You keep the videos, lose the clutter.

<img src="assets/screenshot1.png" alt="Reviewing a video" width="800">

## The problem

You find an interesting YouTube video. You open it in a new tab. A recommendation catches your eye, another tab. By Friday you have 40 YouTube tabs across three windows, Chrome is grinding, and half of them have been sleeping so long you've forgotten what they are.

You could go through them one by one, decide what to keep, add each to the right playlist, close the tab. But that takes forever, so you don't, and next week you have 60.

This extension does that process for you. Pick a playlist, hit Go, and it walks through your tabs with a short countdown on each one. You watch them go by and only intervene when something needs a different playlist or doesn't belong anywhere. Everything else gets filed and closed automatically.

## How it works

1. **Scan** - Click the extension icon, pick a default playlist, hit Scan Tabs
2. **Preview** - See how many YouTube tabs and non-YouTube tabs you have before committing
3. **Review** - The extension activates each tab one by one with a countdown timer. The video is paused so nothing autoplays. If the video is already in a playlist, a warning banner tells you
4. **Act** - When the timer runs out, the video is added to your default playlist and the tab closes. Or you can Pause, Skip, Continue early, redirect to a different playlist, or remove the video from all playlists entirely
5. **Done** - A results screen shows everything that happened. Every video links back to YouTube, and you can re-add any video to a different playlist with one click

The extension stops when it hits a non-YouTube tab (like the YouTube homepage, or any other site). You handle those tabs yourself, then click Resume to keep going.

## Features

- Side panel UI that stays visible as tabs iterate
- Configurable review timer (1-15 seconds), adjustable while running
- Detects which playlists already contain each video
- Incremental cache that only re-fetches playlists whose contents changed
- Tab preview with YouTube vs. non-YouTube counts before processing starts
- Toast notifications on adds, skips, and errors
- Live quota monitor showing remaining API units and estimated adds left
- Stops automatically with a clear error when the YouTube API quota runs out
- `Alt+P` keyboard shortcut to pause, configurable in `chrome://extensions/shortcuts`
- Remembers your last playlist selection
- Closes tabs after processing to free memory
- Remove a video from all your playlists in one click

## Prerequisites

- Google Chrome (Developer mode enabled)
- A Google account with YouTube playlists
- A Google Cloud project (free tier, no billing required)

This is a local extension. It's not published to the Chrome Web Store. You load it directly from a folder on your computer.

## Setup

Setup is a bit of a back-and-forth between Google Cloud Console and Chrome because Google needs your extension ID, and Chrome assigns that ID when you load the extension. Here's the order that works:

### Step 1: Create a Google Cloud project

1. Go to [Google Cloud Console](https://console.cloud.google.com/) and create a new project
2. Go to **APIs & Services > Library**, search for **YouTube Data API v3**, and enable it

### Step 2: Configure OAuth consent

1. Go to **APIs & Services > OAuth consent screen**
2. Choose **External** as the user type
3. Fill in the required fields (app name, your email)
4. On the Scopes step, add `https://www.googleapis.com/auth/youtube`
5. On the Test users step, add your own Gmail address
6. Save. Leave the app in "Testing" mode (do not publish)

### Step 3: Load the extension in Chrome (to get the extension ID)

```bash
git clone <this repo>
cd youtube-tab-cruncher
cp .env.example .env
echo "OAUTH_CLIENT_ID=placeholder" > .env   # temporary, we'll fix this
./setup.sh
```

1. Go to `chrome://extensions/`
2. Enable **Developer mode** (top right toggle)
3. Click **Load unpacked** and select the `youtube-tab-cruncher` folder
4. Copy the **extension ID** shown on the card (looks like `abcdefghijklmnop...`)

### Step 4: Create the OAuth credential

1. Back in Google Cloud Console, go to **APIs & Services > Credentials**
2. Click **Create Credentials > OAuth 2.0 Client ID**
3. Application type: **Chrome Extension**
4. Paste your extension ID into the **Item ID** field
5. Click Create and copy the **Client ID** (looks like `123456789-xxxxx.apps.googleusercontent.com`)

### Step 5: Wire it up

```bash
echo "OAUTH_CLIENT_ID=your_actual_client_id_here.apps.googleusercontent.com" > .env
./setup.sh
```

Go to `chrome://extensions/` and click the reload button on the extension card.

### Step 6: Use it

1. Click the extension icon in your toolbar to open the side panel
2. Click **Sign in with Google**
3. You'll see an "unverified app" warning since the app is in testing mode. Click **Advanced**, then **Go to [app name] (unsafe)**. This is normal for local development
4. Select a default playlist, set your review time, and click **Scan Tabs**

## API quota

This extension uses the YouTube Data API v3, which Google provides for free with a daily quota of 10,000 units. The quota resets at midnight Pacific time. No billing is required.

### Unit costs

| Operation | Units | Notes |
|---|---|---|
| List playlists | 1 | Fetching your playlist names and item counts |
| List playlist items | 1 | Scanning a playlist's videos (per page of 50) |
| Add video to playlist | 50 | Adding a video during processing |
| Remove video from playlist | 51 | Looking up the item ID (1) then deleting it (50) |

With 10,000 units per day you can add about 200 videos, or scan hundreds of playlists, or some mix of both. The playlist cache reduces scan costs on repeat runs since unchanged playlists are loaded locally.

### Monitoring

The extension tracks its own API usage and shows a live quota bar at the bottom of every screen:

```
8,450 / 10,000 units remaining (~169 adds left)
```

The bar turns yellow at 70% usage and red at 90%. This is an estimate based on known unit costs. To see exact usage from Google, go to [Google Cloud Console > APIs > YouTube Data API v3 > Quotas](https://console.cloud.google.com/apis/api/youtube.googleapis.com/quotas).

When the quota runs out, processing stops with a countdown timer showing when it resets, plus links to check your usage and request a quota increase.

### Increasing your quota

If 200 adds per day isn't enough, you can request a quota increase from Google at no cost. Go to the [quotas page](https://console.cloud.google.com/apis/api/youtube.googleapis.com/quotas) and click "Edit Quotas."

## Configuration

| Setting | Where | Default |
|---|---|---|
| Review countdown | Setup screen | 3 seconds |
| Pause shortcut | `chrome://extensions/shortcuts` | `Alt+P` |
| Default playlist | Setup screen | Remembered between sessions |
| Playlist cache | Setup screen | Persists until cleared |

## Troubleshooting

**"This app isn't verified" warning when signing in**
Normal. Your app is in testing mode. Click Advanced > Go to [app name] (unsafe). This only appears once.

**403 error / quota exceeded**
You've used all 10,000 API units for the day. The extension shows a countdown timer to when it resets (midnight Pacific). Come back tomorrow or request a quota increase.

**Extension ID changed**
Chrome assigns a new ID if you move the extension folder or reload from a different path. Update the Item ID in your Google Cloud OAuth credential to match the new ID.

**Videos still playing after tab switches**
The extension injects a pause script into YouTube tabs, but YouTube's autoplay can sometimes fight it. The script retries for 5 seconds. If videos still play, try increasing your review timer to give the pause script more time.

**"Failed while: loading your playlists"**
Usually a quota or auth issue. Try signing in again. If you see a 403, it's quota. If you see a 401, your token expired and re-signing in will fix it.

**Cache seems stale**
The extension compares playlist item counts to decide whether to re-fetch. If someone added and removed the same number of items, the count won't change and stale data persists. Click "Clear cache" on the setup screen and re-scan.

## Project structure

```
manifest.template.json     # MV3 manifest with client ID placeholder
setup.sh                   # Reads .env and generates manifest.json
background/
  service-worker.js        # Message router, Chrome event listeners
  state-machine.js         # Tab iteration state machine
  youtube-api.js           # OAuth, YouTube Data API, playlist cache
  tab-manager.js           # Tab querying, video ID extraction
content/
  pause-video.js           # Injected into YouTube tabs to pause playback
panel/
  panel.html               # Side panel UI
  panel.css                # Styles (CSS custom properties)
  panel.js                 # UI logic, rendering, event handlers
```

The service worker runs a state machine (`idle > loading > preview > reviewing > paused/stopped > complete`) that persists to `chrome.storage.session` and pushes state updates to the side panel over a `chrome.runtime.connect` port.

Playlist data is cached per-playlist in `chrome.storage.local`. On each run, the extension fetches the playlist list and compares item counts against the cache. Only playlists with changed counts get re-fetched. The cache persists until you clear it manually.