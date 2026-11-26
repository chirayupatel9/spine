# Spine (self-hosted)

Your music collection as one long row of album spines on a wall display, from **Spotify**, your **own music folder**, or a built-in **demo shelf**. Tap a spine and the album opens in place, showing its cover, and starts playing. Tap the open cover for the track list.

It's one small FastAPI server plus a touch-friendly web app. You can install it as an app on an **Android tablet** or on **Windows**. It also runs fullscreen on any screen you mount on a wall.

## What it does

- **Local library.** Spine scans your music folder (mp3, flac, m4a, ogg, opus, wav, aiff, wma) and groups the files into albums using their tags. When tags are missing, it uses folder names (`Artist/Album/01 - Song.mp3`) and file names (`Artist - Song.mp3`). It streams the files to the browser, and you can seek within a track.
- **Automatic cover art**, tried in this order:
  1. Art embedded in the file
  2. `cover.jpg` / `folder.jpg` / `front.png` in the album folder
  3. **iTunes Search** by artist and album, and **by song name** if there's no album or the album search finds nothing
  4. **MusicBrainz + Cover Art Archive**, by album and then by song

  Covers are cached in `data/art`. If one is wrong, open the album and use **⋯ → Fix artwork** to search again with corrected names or upload an image.
- **Spotify.**
  - Your saved albums sync onto the shelf.
  - You can add any album by pasting its link.
  - You can play on any Spotify device (phone, PC, speaker or TV). On desktop browsers, the screen running Spine can also be the speaker.
- **Demo shelf.** One click loads 34 well-known albums from the iTunes catalogue, with real covers and 30-second previews that play on the screen. No account is needed, so you can try Spine before connecting anything. Remove it again in **Settings → Demo shelf**.
- **The display.**
  - The row sits in a gunmetal bezel on a dark wall, shaped like a 28″ stretched-bar screen. **Settings → Display → Shape** switches between that bar, a wider screen, or filling the window.
  - Each spine takes its colour from the cover, and its thickness from the track count. Scroll the row by swiping, dragging with the mouse, or with the mouse wheel.
  - The playing album stays open on the shelf with a *Now playing* label, and the wall glows faintly in its colour.
- **Arrange.** By artist, decade, recently added, title, **colour** (a rainbow shelf), or **manual order**: hold a spine, then drag it to a new place. The manual order is saved on the server, so every screen shares it. A jump strip under the display (A–Z or decades) scrolls straight to a section.
- You can search, and hide albums.
- **Wall mode** (⤢). Spine goes fullscreen, keeps the screen awake, and hides the bars until you tap. On a stretched-bar screen the row fills it; on a tablet the bar is letterboxed unless the shape is set to *Fill the window*.
- **Optional password** that protects the whole app when it's hosted.

## Run it

### Docker (recommended)
```bash
cp .env.example .env        # set MUSIC_PATH, PUBLIC_URL, APP_PASSWORD, Spotify keys
docker compose up -d --build
```
Then open `PUBLIC_URL` in a browser.

### Without Docker
```bash
pip install -r requirements.txt
MUSIC_DIR=~/Music DATA_DIR=./data PUBLIC_URL=http://127.0.0.1:8000 \
  uvicorn app.main:app --app-dir . --host 0.0.0.0 --port 8000
```

On Windows (PowerShell):
```powershell
python -m venv .venv; .venv\Scripts\pip install -r requirements.txt
$env:MUSIC_DIR="$HOME\Music"; $env:DATA_DIR="data"; .venv\Scripts\python -m uvicorn app.main:app --port 8000
```
Open http://127.0.0.1:8000 and select **Load demo shelf** to see it working straight away.

## Spotify setup (5 minutes)
1. Go to https://developer.spotify.com/dashboard, select **Create app**, and choose **Web API** and **Web Playback SDK**.
2. Add the redirect URI `PUBLIC_URL/auth/spotify/callback`. Spotify only accepts **https** URIs, or `http://127.0.0.1:PORT` for local testing. `localhost` is **not** accepted.
3. Put the Client ID and Client Secret in `.env` and restart Spine.
4. Open **Settings → Connect Spotify**.

Notes:
- Development-mode Spotify apps **require the app owner to have Premium** and allow **up to 5 users**. That's fine for personal use.
- If Spotify blocks the saved-albums endpoint for your app, Spine falls back to building albums from your saved songs. You can also add albums by link.
- Playing in the browser (Settings → "Use this screen as a Spotify speaker") works in **desktop** Chrome, Edge and Firefox. On an Android tablet, keep the Spotify app installed and pick it from the 🔈 speaker menu. Spine then acts as the remote.

## Hosting it
- **At home (simplest).** Run Spine on a PC or server in your house. Open `http://<server-ip>:8000` from the tablet for local music. Spotify login needs `PUBLIC_URL` to be https or 127.0.0.1, so use one of the options below for the Spotify part.
- **HTTPS via Cloudflare Tunnel or Tailscale Funnel.** Gives you `https://spine.yourdomain.com` without opening any ports. Set `PUBLIC_URL` to that address and set `APP_PASSWORD`.
- **VPS.** Put Caddy in front (`spine.yourdomain.com { reverse_proxy localhost:8000 }`) for automatic HTTPS. Your music has to be on the VPS, or synced to it with rclone or Syncthing.

## Install as an app
- **Android tablet.** Open the URL in Chrome, then **⋮ → Add to Home screen / Install app**. It opens fullscreen like a native app. For a wall tablet, use Android's *screen pinning* or a kiosk launcher such as Fully Kiosk Browser.
- **Windows.** Open the URL in Edge or Chrome, then **⋯ → Apps → Install this site as an app**. For a kiosk screen, run `msedge --kiosk https://spine.yourdomain.com --edge-kiosk-type=fullscreen`.

## API (if you want to script it)
| Method | Path | |
|---|---|---|
| GET | `/api/albums` | shelf (`?source=local|spotify|demo&include_hidden=true`) |
| GET | `/api/albums/{id}` | album + tracks |
| PATCH | `/api/albums/{id}` | `{"hidden": true}` |
| POST | `/api/albums/{id}/art` | upload a cover (multipart `file`) |
| POST | `/api/albums/{id}/art/search` | `{"artist","album","song"}` online lookup |
| PUT | `/api/order` | manual shelf order (`{"ids": [...]}`) |
| POST | `/api/demo/load` | load the demo shelf (`DELETE /api/demo` removes it) |
| POST | `/api/library/rescan` | rescan the folder (`?force_art=true` to re-find artwork) |
| GET | `/api/local/stream/{track_id}` | audio stream (supports Range) |
| POST | `/api/spotify/sync` / `add` / `play` / `control` / `transfer` | Spotify |
| GET | `/api/status` | scan / sync progress |

## Layout
```
app/main.py      routes, password gate, static files
app/library.py   folder scan, tag reading, album grouping
app/artwork.py   embedded/folder/iTunes/MusicBrainz art, spine colours
app/spotify.py   OAuth, saved-album sync, playback control
app/demo.py      demo shelf from the iTunes catalogue (covers + 30-second previews)
web/             the shelf UI (vanilla JS PWA, no build step)
```
