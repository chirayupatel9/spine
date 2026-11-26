# Album Viewer (self-hosted)

Your music collection as one long row of album spines on a wall display, from **Spotify**, your **own music folder**, or a built-in **demo shelf**. Tap a spine and the album opens in place, showing its cover, and starts playing. Tap the open cover for the track list.

It's one small FastAPI server plus a touch-friendly web app. You can install it as an app on an **Android tablet** or on **Windows**. It also runs fullscreen on any screen you mount on a wall.

## What it does

- **Local library.** Album Viewer scans your music folder (mp3, flac, m4a, ogg, opus, wav, aiff, wma) and groups the files into albums using their tags. When tags are missing, it uses folder names (`Artist/Album/01 - Song.mp3`) and file names (`Artist - Song.mp3`). It streams the files to the browser, and you can seek within a track.
- **Automatic cover art**, tried in this order:
  1. Art embedded in the file
  2. `cover.jpg` / `folder.jpg` / `front.png` in the album folder
  3. **iTunes Search** by artist and album, and **by song name** if there's no album or the album search finds nothing
  4. **MusicBrainz + Cover Art Archive**, by album and then by song

  Covers are cached in `data/art`. If one is wrong, open the album and use **⋯ → Fix artwork** to search again with corrected names or upload an image.
- **Spotify.**
  - Your saved albums sync onto the shelf.
  - You can add any album by pasting its link.
  - You can play on any Spotify device (phone, PC, speaker or TV), or make the screen running Album Viewer the speaker.
- **Demo shelf.** One click loads 34 well-known albums from the iTunes catalogue, with real covers and 30-second previews that play on the screen. No account is needed, so you can try it before connecting anything. Remove it again in **Settings → Demo shelf**.
- **The display.**
  - The row sits in a gunmetal bezel on a dark wall, shaped like a 28″ stretched-bar screen. **Settings → Display → Shape** switches between that bar, a wider screen, or filling the window.
  - Each spine takes its colour from the cover, and its thickness from the track count. Scroll the row by swiping, dragging with the mouse, or with the mouse wheel.
  - The playing album stays open on the shelf with a *Now playing* label, and the wall glows faintly in its colour.
- **Arrange.** By artist, decade, recently added, title, **colour** (a rainbow shelf), or **manual order**: hold a spine, then drag it to a new place. The manual order is saved on the server, so every screen shares it. A jump strip under the display (A–Z or decades) scrolls straight to a section.
- You can search, and hide albums.
- **Wall mode** (⤢). The app goes fullscreen, keeps the screen awake, and hides the bars until you tap. On a stretched-bar screen the row fills it; on a tablet the bar is letterboxed unless the shape is set to *Fill the window*.
- **Sign-in is always required** (see below). Every screen stays signed in for a year, or until you choose **Settings → Sign out** or change the password.

## Run it

### Docker (recommended)
```bash
cp .env.example .env        # set MUSIC_PATH, PUBLIC_URL, APP_PASSWORD, Spotify keys
mkdir -p data               # owned by you, so the container (PUID/PGID, 1000 by default) can write to it
docker compose up -d --build
docker compose logs         # shows the generated password if you left APP_PASSWORD empty
```
Then open `PUBLIC_URL` in a browser. The container runs as an ordinary user, not root. If it stops with "can't write to its data folder", run `sudo chown -R 1000:1000 ./data` (or set `PUID`/`PGID` in `.env` to the owner of `./data`).

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
Open http://127.0.0.1:8000, sign in, and select **Load demo shelf** to see it working straight away.

### Signing in
Sign-in is always on. Set `APP_PASSWORD` to choose the password (use 10 or more characters if the app can be reached from the internet). If you don't set one, a password is generated on the first start: it's printed in the log that one time and saved in `data/password.txt`.

After 5 wrong passwords from one address, or 50 in total, in 15 minutes, sign-in is refused until the 15 minutes pass. Screens that are already signed in keep working. Behind a reverse proxy or tunnel, set `FORWARDED_ALLOW_IPS` to the proxy's address, or the Docker network it runs on, so the limit sees each visitor's real address. Never set it to `*`: the app would then believe whatever address a visitor writes into the `X-Forwarded-For` header, and the per-address limit would be easy to dodge.

## Spotify setup (about 10 minutes)

What you need to know first:
- **The Spotify account that owns the app needs Premium.** Spotify's development mode stops working if the owner's Premium lapses.
- **At most 5 Spotify accounts can use your app**, and each must be added by hand (step 5). This is fine for personal use; Spotify describes development mode as for non-commercial use.
- **Playing music needs Premium** on the account that listens: both starting playback from Album Viewer and using the browser as a speaker.

Steps:
1. Go to https://developer.spotify.com/dashboard, sign in, and select **Create app**.
2. Fill in an **App name** (e.g. *Album Viewer*) and a **description**.
3. Under **Redirect URIs**, add your `PUBLIC_URL` followed by `/auth/spotify/callback`, then select **Add**:
   - Running on this computer: `http://127.0.0.1:8000/auth/spotify/callback`
   - Hosted: `https://albums.yourdomain.com/auth/spotify/callback`

   Spotify only accepts `https://` addresses, or plain `http://` with `127.0.0.1`. **`localhost` is not accepted.**
4. If the form asks which APIs you'll use, tick **Web API** and **Web Playback SDK**. Accept the terms and select **Save**.
5. Open the app's **Settings**, then the **Users Management** tab, and add the name and email of every Spotify account that will connect (including your own if it's a different account from the developer one). Accounts that aren't on this list can sign in but get "403" errors.
6. On the app's overview page, copy the **Client ID** and the **Client secret** (you may need to select *View client secret* to reveal it). Keep the secret private; **Rotate** there issues a new one if it ever leaks.
7. Give them to Album Viewer and restart it:
   - Docker: put them in `.env` as `SPOTIFY_CLIENT_ID=` and `SPOTIFY_CLIENT_SECRET=`, then `docker compose up -d`.
   - Windows without Docker, in the same PowerShell window before starting it:
     ```powershell
     $env:SPOTIFY_CLIENT_ID="paste-client-id"; $env:SPOTIFY_CLIENT_SECRET="paste-client-secret"; $env:PUBLIC_URL="http://127.0.0.1:8000"
     ```
   The log then prints the redirect URI it expects. It must match step 3 exactly.
8. Open Album Viewer **at the same address as `PUBLIC_URL`** (`http://127.0.0.1:8000`, not `localhost:8000`, or the sign-in can't complete), then **Settings → Connect Spotify**.

Notes:
- If Spotify blocks the saved-albums endpoint for your app, Album Viewer falls back to building albums from your saved songs. You can also add albums by link.
- Playing in the browser (Settings → "Use this screen as a Spotify speaker") works in Chrome, Edge, Firefox and Safari, on Android and iOS as well as desktop, according to Spotify. It needs full Premium: Spotify's mobile-only plans are excluded. On iPhone and iPad, playback moved to the page from another device doesn't start until you tap. You can also open the Spotify app on the device, pick it from the 🔈 speaker menu, and use Album Viewer as the remote; that keeps playing if the device puts the browser to sleep.

## Hosting it
- **At home (simplest).** Run it on a PC or server in your house. Open `http://<server-ip>:8000` from the tablet for local music. Spotify sign-in needs `PUBLIC_URL` to be https or 127.0.0.1, so use one of the options below for the Spotify part.
- **Only your own devices, over HTTPS: Tailscale Serve.** On the server, `tailscale serve --bg 8000` gives `https://<machine>.<tailnet>.ts.net` with a real certificate, reachable only from devices on your Tailscale. Set `PUBLIC_URL` to that address.
- **Public, through a Cloudflare Tunnel** (no open ports; see below). Gives you `https://albums.yourdomain.com`. Choose a strong `APP_PASSWORD`.
- **VPS.** Put Caddy in front (`albums.yourdomain.com { reverse_proxy localhost:8000 }`) for automatic HTTPS, and set `FORWARDED_ALLOW_IPS`. Your music has to be on the VPS, or synced to it with rclone or Syncthing.

### Public through a Cloudflare Tunnel
This runs the tunnel as a second container next to the app, so it needs no open port and doesn't touch any other tunnel on the machine. On the server, with `cloudflared` signed in to your Cloudflare account (`cloudflared tunnel login`), from the folder with `docker-compose.yml`:
```bash
cloudflared tunnel create album-viewer                                   # prints the tunnel ID
cloudflared tunnel route dns album-viewer albums.yourdomain.com          # adds the DNS record
mkdir -p tunnel && cp ~/.cloudflared/<tunnel-id>.json tunnel/credentials.json && chmod 600 tunnel/*
```
`tunnel/config.yml`:
```yaml
tunnel: <tunnel-id>
credentials-file: /etc/cloudflared/credentials.json
ingress:
  - hostname: albums.yourdomain.com
    service: http://album-viewer:8000
  - service: http_status:404
```
`docker-compose.override.yml` (Compose reads it automatically):
```yaml
services:
  tunnel:
    image: cloudflare/cloudflared:2026.11.2
    restart: unless-stopped
    user: "1000:1000"                 # must be able to read tunnel/
    command: tunnel --config /etc/cloudflared/config.yml run
    volumes: ["./tunnel:/etc/cloudflared:ro"]
    depends_on: { album-viewer: { condition: service_healthy } }
networks:   # pinned, so the line below can name it
  default:
    ipam: { config: [{ subnet: 172.31.240.0/24 }] }
```
In `.env`, set `PUBLIC_URL=https://albums.yourdomain.com` and `FORWARDED_ALLOW_IPS=172.31.240.0/24`, then `docker compose up -d`. If nothing else needs the app's own port, you can also stop publishing it: add `ports: !reset []` under `album-viewer` in the override. `tunnel/` holds the tunnel's secret; git ignores it, and so does `docker-compose.override.yml`.

Keep `data/` backed up: it holds the database (saved order, hidden albums, Spotify sign-in), cached covers and the generated password.

## Install as an app
- **Android tablet.** Open the URL in Chrome, then **⋮ → Add to Home screen / Install app**. It opens fullscreen like a native app. For a wall tablet, use Android's *screen pinning* or a kiosk launcher such as Fully Kiosk Browser. To install it from Google Play instead, see [Android app](#android-app).
- **Windows.** Open the URL in Edge or Chrome, then **⋯ → Apps → Install this site as an app**. For a kiosk screen, run `msedge --kiosk https://albums.yourdomain.com --edge-kiosk-type=fullscreen`.

## Android app
`android/` is a native Android app (Kotlin and Jetpack Compose) that talks to your server:
- **Phones:** the vertical stack of spines with momentum scrolling and an A–Z rail you slide along. Tap a spine to open it into its cover and play it.
- **Tablets and landscape:** the wall shelf in its bezel.
- **Playback:** local and demo albums play in a background service (Media3), with lock-screen and notification controls, artwork, a draggable position bar, and Bluetooth and headphone buttons. Spotify albums are started on your Spotify device through the server.
- **Instant start:** it opens on the last shelf it saw, then refreshes.
- **Sign-in:** your server's address and password, kept in the app's private storage (it uses the same sign-in cookie as the web app).

Build it with JDK 17 and the Android SDK (platform 36). Set `JAVA_HOME` and `ANDROID_HOME`, then in `android/`:
```powershell
.\gradlew.bat bundleRelease assembleRelease
```
Sign the results with your upload key. `zipalign` and `apksigner` are in the SDK's `build-tools` folder; each tool asks for the key's password:
```powershell
jarsigner -sigalg SHA256withRSA -digestalg SHA-256 -keystore upload.keystore -signedjar app-release-bundle.aab app\build\outputs\bundle\release\app-release.aab upload
zipalign -f -p 4 app\build\outputs\apk\release\app-release-unsigned.apk app-release-unsigned-aligned.apk
apksigner sign --ks upload.keystore --ks-key-alias upload --out app-release-signed.apk app-release-unsigned-aligned.apk
```
`app-release-bundle.aab` goes to Google Play; `app-release-signed.apk` installs directly. Create the key once with `keytool -genkeypair -keystore upload.keystore -alias upload -keyalg RSA -keysize 2048 -validity 10000`, and **back up the `.keystore` file and its password**: every update must be signed with it. Raise `versionCode` in `app/build.gradle.kts` for each release.

The app's address is set in `net/Api.kt` (`DEFAULT_SERVER`); you can change it on its sign-in screen. The server's `/.well-known/assetlinks.json` (`ANDROID_PACKAGE`, `ANDROID_CERT_SHA256` in `.env`) was for the earlier web-wrapper version of the app; the native app doesn't need it.

## Tests
```bash
pip install -r requirements-dev.txt
pytest
```
The tests use a throwaway data folder and generated audio files, and never touch the network. GitHub Actions runs them on every push, checks the JavaScript parses, and builds the Docker image and waits for it to report healthy.

## API (if you want to script it)
Every `/api/` call needs the sign-in cookie (`POST /login` with `password`).

| Method | Path | |
|---|---|---|
| GET | `/api/albums` | shelf (`?source=local|spotify|demo&include_hidden=true`) |
| GET | `/api/albums/{id}` | album + tracks |
| PATCH | `/api/albums/{id}` | `{"hidden": true}` |
| POST | `/api/albums/{id}/art` | upload a cover (multipart `file`, `MAX_UPLOAD_MB` max) |
| POST | `/api/albums/{id}/art/search` | `{"artist","album","song"}` online lookup |
| PUT | `/api/order` | manual shelf order (`{"ids": [...]}`) |
| POST | `/api/demo/load` | load the demo shelf (`DELETE /api/demo` removes it) |
| POST | `/api/library/rescan` | rescan the folder (`?force_art=true` to re-find artwork) |
| GET | `/api/local/stream/{track_id}` | audio stream (supports Range) |
| POST | `/api/spotify/sync` / `add` / `play` / `control` / `transfer` | Spotify |
| GET | `/api/status` | scan / sync progress |
| GET | `/healthz` | health check (no sign-in) |

## Layout
```
app/main.py      routes, sign-in, request limits, static files
app/config.py    settings from the environment, generated password
app/library.py   folder scan, tag reading, album grouping
app/artwork.py   embedded/folder/iTunes/MusicBrainz art, spine colours
app/spotify.py   OAuth, saved-album sync, playback control
app/demo.py      demo shelf from the iTunes catalogue (covers + 30-second previews)
web/             the shelf UI (vanilla JS PWA, no build step)
tests/           pytest suite
```
