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
- **Everyone has a shelf of their own.** People sign in with Google or Spotify and see their own Spotify albums and playlists, music on their own computer or phone, and the demo shelf, with their own order and hidden albums. The server's music folder stays yours.
- **Spotify.**
  - Your saved albums and your playlists sync onto the shelf; a **Playlists** tab shows just the playlists.
  - You can add any album or playlist by pasting its link.
  - Music plays on the screen you're using. The speaker button on the player shows where it's playing and moves Spotify to any of your Spotify speakers (phone, computer, speaker or TV). On Android it opens the phone's own list of outputs (Bluetooth and so on) for your own music.
- **YouTube and YouTube Music.**
  - Anyone signed in can connect their YouTube in Settings (read only). Their playlists, including the ones they made in YouTube Music, and their liked music come onto the shelf.
  - Add any album, playlist or song by searching or pasting a YouTube or YouTube Music link.
  - In the browser it plays in YouTube's own player, as whoever is signed in to YouTube there (Chrome), so YouTube Premium means no ads. The video has to stay on screen: it sits where the record is in the full-screen player, and floats above the bar otherwise. Closing it pauses the music. The Android app hands YouTube to the YouTube Music app instead.
- **Music on your computer.** In Chrome or Edge, **Settings → Music on this computer** reads a folder of music on that computer and puts its albums on your shelf (from their tags, or their folders). Nothing is uploaded: it plays from the disk, and the browser keeps the folder for next time. Other browsers can open a folder for one visit. On Android, the app shows the music on the phone.
- **Demo shelf.** One click loads 34 well-known albums from the iTunes catalogue, with real covers and 30-second previews that play on the screen. No account is needed, so you can try it before connecting anything. Remove it again in **Settings → Demo shelf**.
- **The display.**
  - The row sits in a gunmetal bezel on a dark wall, shaped like a 28″ stretched-bar screen. **Settings → Display → Shape** switches between that bar, a wider screen, or filling the window.
  - Each spine takes its colour from the cover, and its thickness from the track count. Scroll the row by swiping, dragging with the mouse, or with the mouse wheel.
  - The spine under the cursor lifts out of the shelf, its neighbours a little less; on a touch screen, the one under your finger lifts.
  - The playing album stays open on the shelf with a *Now playing* label. Its record slides out of the sleeve and turns while it plays (tap the record to pause), and the wall glows faintly in its colour.
- **Now playing.** Tap the player bar, or swipe it up, for the full-screen player: the cover and its spinning record, a seek bar you can drag, shuffle, repeat (the album or one track) and what's up next. Swipe down, press Back or Escape to put it away. Shuffle, repeat and seeking work for Spotify too.
- **Arrange.** By artist, decade, recently added, title, **colour** (a rainbow shelf), or **manual order**: hold a spine, then drag it to a new place. The manual order is saved on the server, so every screen shares it. A jump strip under the display (A–Z or decades) scrolls straight to a section; on a phone it's a rail down the side, and in orders without letters it becomes a handle you drag.
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
Sign-in is always on. Each person signs in with **Google** or **Spotify** and gets a shelf of their own. The admin is the Google account named in `ADMIN_EMAIL`: only it sees the server's music folder and manages the library and the demo shelf. On a server from before accounts, the admin also keeps the Spotify connection, hidden albums and manual order that were there.

Setting up Google sign-in (about 5 minutes):
1. In https://console.cloud.google.com, create a project (for example *Album Viewer*).
2. Open **Google Auth Platform** (*APIs & Services → OAuth consent screen*). Give the app a name and a support email, choose the **External** audience, and add your domain (for example `yourdomain.com`) under **Branding → Authorized domains**. Album Viewer asks only for `openid`, `email` and `profile`, which need no review by Google.
3. Under **Audience**, select **Publish app** so anyone with a Google account can sign in. While it says *Testing*, only the test users you list there can.
4. Under **Clients**, create a client of type **Web application** with the redirect URI `PUBLIC_URL` + `/auth/google/callback`, for example `https://albums.yourdomain.com/auth/google/callback`.
5. Put its **Client ID** and **Client secret** in `.env` as `GOOGLE_CLIENT_ID=` and `GOOGLE_CLIENT_SECRET=`, and your Google address as `ADMIN_EMAIL=`, then `docker compose up -d`.

Spotify sign-in works for the people you've added to your Spotify app (see [Spotify setup](#spotify-setup-about-10-minutes)). Someone who signed in with Google can connect Spotify in Settings, and then sign in with either.

Once Google sign-in is set up, the password is no longer used. Without it, sign-in needs a password, which signs you in as the admin. Set `APP_PASSWORD` to choose the password (use 10 or more characters if the app can be reached from the internet). If you don't set one, a password is generated on the first start: it's printed in the log that one time and saved in `data/password.txt`.

After 5 wrong passwords from one address, or 50 in total, in 15 minutes, sign-in is refused until the 15 minutes pass. Screens that are already signed in keep working. Behind a reverse proxy or tunnel, set `FORWARDED_ALLOW_IPS` to the proxy's address, or the Docker network it runs on, so the limit sees each visitor's real address. Never set it to `*`: the app would then believe whatever address a visitor writes into the `X-Forwarded-For` header, and the per-address limit would be easy to dodge.

## Spotify setup (about 10 minutes)

What you need to know first:
- **The Spotify account that owns the app needs Premium.** Spotify's development mode stops working if the owner's Premium lapses.
- **At most 5 Spotify accounts can use your app**, and each must be added by hand (step 5). Friends can't add themselves: Spotify refuses everyone else, and lifting the limit ("extended quota") is only for registered businesses with hundreds of thousands of users. Friends who aren't on the list can still sign in with Google and use the music on their own computer or phone. This is fine for personal use; Spotify describes development mode as for non-commercial use.
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
8. Open Album Viewer **at the same address as `PUBLIC_URL`** (`http://127.0.0.1:8000`, not `localhost:8000`, or the sign-in can't complete), then **Settings → Connect Spotify**, or **Continue with Spotify** on the sign-in page.

Notes:
- If Spotify blocks the saved-albums endpoint for your app, Album Viewer falls back to building albums from your saved songs. You can also add albums by link.
- Spotify shares a playlist's tracks only with its owner and collaborators. Playlists you just follow still go on the shelf and play, but their track list stays empty.
- Spotify plays in the browser you're using (Settings → "Play Spotify in this browser", on by default), in Chrome, Edge, Firefox and Safari, on Android and iOS as well as desktop, according to Spotify. It needs full Premium: Spotify's mobile-only plans are excluded, and without Premium Spotify plays on another of your speakers instead. On iPhone and iPad, playback moved to the page from another device doesn't start until you tap. You can also pick the Spotify app on the device from the speaker button; that keeps playing if the device puts the browser to sleep. The Android app plays Spotify in the phone's Spotify app; if Spotify isn't open, the speaker list opens it.

## YouTube setup (about 5 minutes, once Google sign-in works)

YouTube uses the same Google OAuth client as sign-in. Connecting it is a second Google sign-in that asks for one more permission, `youtube.readonly`.

1. In the same Google Cloud project, open **APIs & Services → Library**, find **YouTube Data API v3**, and select **Enable**.
2. In **Google Auth Platform → Data access**, select **Add or remove scopes**, tick `.../auth/youtube.readonly` (*View your YouTube account*), select **Update**, write why under *How will the scopes be used?*, and **Save**.
3. That's all: Settings now shows **Connect YouTube**. `YOUTUBE=0` in `.env` hides it.

What you need to know:
- **Google checks apps that read YouTube.** Until it has, everyone who connects sees "Google hasn't verified this app" (they choose *Advanced → Go to …*), and at most 100 people can connect. To lift that, submit the app under **Google Auth Platform → Verification Center**. It's free, and it needs a short screen recording, uploaded to YouTube as unlisted, showing the consent screen (with your client ID in the address bar) and the YouTube features in use.
- **YouTube's rules decide how it plays.** Its player must be on screen while it plays (at least 200×200 pixels, with nothing over it), audio can't be played without the video, and nothing may play from a hidden player. That's why the video floats above the bar, and why the Android app hands YouTube to the YouTube Music app.
- **YouTube's API has a daily allowance** of 10,000 units for the whole server: a search costs 100, most reads 1. Album Viewer syncs each person's playlists every 6 hours, reads a playlist's videos only when it's opened, and allows 25 searches a day per person and 50 in all. More allowance can be requested from YouTube for free.
- Saved albums in YouTube Music can't come across: there's no official YouTube Music API, and Google's YouTube API sees only a person's own playlists and likes. Paste an album's link instead (in YouTube Music: **Share** on the album).
- What comes from YouTube is refreshed at least every 30 days, as YouTube requires, and deleted when someone disconnects or takes back the access on their Google account.

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

### Updating itself
The server can put whatever reaches `main` live by itself. `deploy/bad-omen/` has a systemd user timer that runs `autodeploy.sh` every 2 minutes in your clone (`~/album-viewer`):
- It only ever fast-forwards, and it won't touch a clone with local edits or a `main` that was rewritten.
- When server code changed, it pulls, rebuilds and restarts the container, then waits up to a minute for `/healthz`. If the new version isn't healthy, it goes back to the one that was running and leaves the broken commit alone until a newer one arrives.
- Changes that only touch the Android app, tests or docs are pulled without a rebuild.

Set it up once, as the user that runs Album Viewer (it uses `http://127.0.0.1:8090/healthz`; change `HEALTH_URL` in the service if your port differs):
```sh
bash ~/album-viewer/deploy/bad-omen/install.sh
journalctl --user -u album-viewer-deploy -e    # what it did
```
It pulls from GitHub (nothing reaches into your server), so it works behind a tunnel or a firewall. `https://<your address>/healthz` says which commit is live (`version`).

## Install as an app
- **Android tablet.** Open the URL in Chrome, then **⋮ → Add to Home screen / Install app**. It opens fullscreen like a native app. For a wall tablet, use Android's *screen pinning* or a kiosk launcher such as Fully Kiosk Browser. To install it from Google Play instead, see [Android app](#android-app).
- **Windows.** Open the URL in Edge or Chrome, then **⋯ → Apps → Install this site as an app**. For a kiosk screen, run `msedge --kiosk https://albums.yourdomain.com --edge-kiosk-type=fullscreen`.

## Android app
`android/` is a native Android app (Kotlin and Jetpack Compose) that talks to your server:
- **Phones:** the vertical stack of spines with momentum scrolling and an A–Z rail you slide along (in orders without letters, a handle you drag). The spine under your finger lifts. Tap a spine to open it into its cover and play it; its record slides out of the sleeve and turns while it plays. Hold one, then drag it to rearrange the shelf. The order is saved on the server, so every screen shares it; holding an album while another arrangement is showing switches to your own order, starting from what's on screen.
- **Tablets and landscape:** the wall shelf in its bezel.
- **Now playing:** tap the player bar, or swipe it up, for the full-screen player: the cover with its record rising out of the sleeve and turning while it plays, a progress line that wiggles while the music plays, shuffle, repeat (the album or one track), where it's playing, and Up next. Swipe down or press Back to put it away.
- **Playback:** your own music and the demo shelf play in a background service (Media3), with lock-screen and notification controls, artwork, a draggable position bar, and Bluetooth and headphone buttons. Spotify plays in the phone's Spotify app; if Spotify isn't open, the app opens it and starts the album when you come back. The speaker button in the player moves Spotify to any of your Spotify speakers, or, for your own music, opens Android's list of outputs.
- **Instant start:** it opens on the last shelf it saw, then refreshes.
- **Widget:** a home-screen widget (4 × 1) shows what's playing, with previous, play/pause and next, for your own music and for Spotify.
- **Spotify on the phone:** if Spotify isn't running, the app starts it in the background and plays there, without switching to it; only if that fails does it open Spotify.
- **Sign-in:** Google or Spotify in a browser tab, or the server's password where Google sign-in isn't set up. The session is kept in the app's private storage.

### Releasing to Google Play automatically
Every change to `android/` that reaches `main` is built, signed with your upload key and released to the **internal testing** track by `.github/workflows/android.yml`; testers' phones then update from Play on their own. The version code is the number of commits, so it goes up by itself. **Actions → android → Run workflow** on GitHub releases without a new change.

How it's set up (once):
- **Google Play** takes releases from a service account, `play-publisher` in the *Album Viewer* Google Cloud project. In Play Console (**Users and permissions**) it may only view Album Viewer and release it to testing tracks.
- **GitHub signs in as that service account without a key** (workload identity federation): the project trusts GitHub's sign-in tokens for this repository only (an identity pool `github` with a provider `spine` whose condition is `assertion.repository == "chirayupatel9/spine"`), and the repository may act as `play-publisher` (*Workload Identity User*). The names are in the workflow; none of it is secret.
- **The upload key and its password** are the repository's secrets `ANDROID_KEYSTORE_BASE64` and `ANDROID_KEYSTORE_PASSWORD`. To set them again (a new key, say), run `pwsh -NoProfile -File android/release-secrets.ps1`: it signs you in to GitHub, asks for the password once, checks it opens the key, and hands both to GitHub. If the key ever leaks, Play Console can reset the upload key; the key Play signs the app with stays with Google.

Until the two secrets exist, the workflow only checks that the app builds.

### Building and signing by hand

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
`app-release-bundle.aab` goes to Google Play; `app-release-signed.apk` installs directly. Create the key once with `keytool -genkeypair -keystore upload.keystore -alias upload -keyalg RSA -keysize 2048 -validity 10000`, and **back up the `.keystore` file and its password**: every update must be signed with it. The version code is the number of commits (`git rev-list --count HEAD`), so a build after a new commit is always newer.

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
| GET | `/api/me` | who is signed in |
| GET | `/api/albums` | your shelf (`?source=local|spotify|youtube|demo|playlist&include_hidden=true`) |
| GET | `/api/albums/{id}` | album + tracks |
| PATCH | `/api/albums/{id}` | `{"hidden": true}` |
| POST | `/api/albums/{id}/art` | upload a cover (multipart `file`, `MAX_UPLOAD_MB` max) |
| POST | `/api/albums/{id}/art/search` | `{"artist","album","song"}` online lookup |
| GET / PUT | `/api/order` | your manual shelf order (`{"ids": [...]}`) |
| POST | `/api/demo/load` | load the demo shelf (`DELETE /api/demo` removes it) |
| POST | `/api/library/rescan` | rescan the folder (`?force_art=true` to re-find artwork) |
| GET | `/api/local/stream/{track_id}` | audio stream (supports Range) |
| POST | `/api/spotify/sync` / `add` / `play` / `transfer` | Spotify |
| POST | `/api/spotify/control` | `{"action": "pause" \| "resume" \| "next" \| "previous" \| "seek" \| "shuffle" \| "repeat", "value": ...}` (seek: ms; shuffle: true/false; repeat: off, context or track) |
| POST | `/api/youtube/add` | `{"link": "https://music.youtube.com/playlist?list=..."}`, or a search result's `{"id", "kind"}` |
| GET | `/api/youtube/search` | `?q=` albums, playlists and songs on YouTube (rationed) |
| POST | `/api/youtube/sync` / `disconnect` | YouTube |
| GET | `/api/status` | scan / sync progress |
| GET | `/healthz` | health check (no sign-in) |

## Layout
```
app/main.py      routes, sign-in, request limits, static files
app/config.py    settings from the environment, generated password
app/library.py   folder scan, tag reading, album grouping
app/artwork.py   embedded/folder/iTunes/MusicBrainz art, spine colours
app/spotify.py   OAuth, saved-album sync, playback control
app/youtube.py   connecting YouTube (read only), playlist and liked-music sync, search, adding by link
app/demo.py      demo shelf from the iTunes catalogue (covers + 30-second previews)
web/             the shelf UI (vanilla JS PWA, no build step)
tests/           pytest suite
```
