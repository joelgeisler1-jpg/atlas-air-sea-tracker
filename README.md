# ATLAS TRACKER — aircraft + vessel map

A **mobile-friendly map** for exploring aircraft observed by ADS-B and ship positions observed by AIS, with independent layer switches, text search, target inspection, configurable refresh, and short **in-session trails**. The map starts near Adelaide, South Australia, but can be panned anywhere on Earth. The application is **not a global all-vehicles-at-once feed**: aircraft use a 250-nautical-mile radius search around the current map centre, and AIS subscribes to the current local viewport.

![Data flow](https://img.shields.io/badge/GitHub%20Pages-static%20UI-49d3e1) ![Backend](https://img.shields.io/badge/Render-Node.js%20backend-94abdd)

## What you need

1. A GitHub account, to publish the front end using [GitHub Pages](https://docs.github.com/en/pages/quickstart).
2. A [Render](https://render.com/) account, to host the optional live-data backend. Render's free instance can spin down when idle and may take about a minute to wake up.
3. A **free AISstream API key** from <https://www.aisstream.io/> to receive real-time vessel messages. AISstream **does not permit direct browser connections**: its key must be server-side.
4. The ADS-B backend uses the adsb.lol point endpoint as its primary source and automatically falls back to <https://opendata.adsb.fi/> if the primary request fails. Each attempt has a 6.5-second timeout, including response parsing, leaving headroom within the frontend’s 20-second timeout. Successful responses identify the source in the `provider` field. Both providers receive an explicit Atlas User-Agent. See <https://api.adsb.lol/docs>. The provider may rate-limit or change access, and asks users to contact them before production use. Their data is licensed under **ODbL**.

There is no service credential in the downloaded project. Demo mode is conspicuously labelled **SIMULATED** until the backend URL is configured.

## Deploy — GitHub Pages + Render

### A. Create the GitHub repository

1. Create a new **public** GitHub repository, for example `atlas-air-sea`.
2. Upload the project source files, maintaining their paths. Exclude `node_modules/`, local `.env` files, and logs; use `.gitignore` when publishing with Git. From a Mac/PC, extracting the ZIP and using GitHub's *Add file → Upload files* to drag the whole project contents is simplest. You can also push from a command line with `git`.
3. In **Settings → Pages → Build and deployment**, select **Deploy from a branch**, select `main` and `/(root)`, and save.
4. Your static app will be at `https://YOUR_USERNAME.github.io/atlas-air-sea/`. At this point the map runs in clearly marked synthetic **demo mode**.

### B. Deploy the secure backend on Render

1. Sign in at <https://dashboard.render.com/> and connect your GitHub account.
2. Create **New → Blueprint** and choose the same repository. Render reads `render.yaml` and uses `backend/` for the Node web service. Alternatively, create a **Web Service** with root directory `backend`, build command `npm ci --omit=dev`, and start command `npm start`.
3. Set the secret environment variables in Render, **not in the repo**:
   - `AISSTREAM_API_KEY` = your actual key from aisstream.io.
   - `ALLOWED_ORIGIN` = `https://YOUR_USERNAME.github.io` (only the origin; **do not append `/atlas-air-sea`**).
   - `MAX_AIS_VIEWERS` = `3` (default). The provider limits connections; this sample service deliberately permits only three concurrent browser clients using one shared provider connection.
4. Deploy; note the public backend address, for example `https://atlas-air-sea-backend.onrender.com`.
5. Confirm `https://YOUR-BACKEND.onrender.com/api/health` returns JSON, including `"ok":true` and `"aisConfigured":true`. The health response does not reveal your key. Diagnostics include `upstreamConnected` (WebSocket open), `aisSubscribed` (a successful `SubscriptionConfirmation` received), `lastAisMessageAt` (Unix milliseconds of the latest valid vessel report, or `null`), and `lastAisError` (latest upstream error or close code/reason, or `null`). Error details are redacted before they reach logs or health responses. Message/error history remains available through reconnects; connection flags reset when the socket closes. If `ALLOWED_ORIGIN` is set, open this URL directly or use a terminal; a browser fetch from a different origin is rejected.

### C. Join the front end to the backend

1. In your GitHub repo, open `config.js`, select the pencil **Edit** icon, and set `API_BASE` to your own HTTPS Render address, **without** the final slash. Example:

   ```js
   window.ATLAS_CONFIG = Object.freeze({
     API_BASE: 'https://atlas-air-sea-backend.onrender.com',
     AIRCRAFT_REFRESH_MS: 20000,
     MIN_LIVE_ZOOM: 6,
   });
   ```

2. Commit the change. Reload your GitHub Pages app. The status should say **LIVE FEEDS**. Wait for the AIS stream to receive new vessel messages; it does not return a historical snapshot upon connection.

**iPhone:** Use Safari to open the Pages link and choose **Share → Add to Home Screen**. The site then behaves like a convenient home-screen web app (it still needs a network connection). The downloaded ZIP is also editable with your preferred code editor.

## Local run / developer notes

- The GitHub Pages files (`index.html`, `styles.css`, `config.js`, `app.js`) do not require a build step. Serve the root directory with a local HTTP server (for example, `python3 -m http.server 8080`) and open `http://localhost:8080` for the static demo. Internet access is needed for Leaflet and map tiles.
- On a computer with Node.js 20+, run `cd backend && npm ci && npm start`. The backend starts on `http://localhost:3000`. Add a `backend/.env` only if you load it yourself; this Node example deliberately reads environment variables, not `.env` files. To set a local key, export environment variables from a shell or use a secret manager. Never check them into version control.
- To run tests: `cd backend && npm test` (Node's built-in test runner).
- `ALLOWED_ORIGIN` is enforced on browser HTTP requests and AIS WebSocket upgrades. If this variable is unset, the backend is open to requests from any browser origin. Set it for public deployment.
- Keep the backend URL in the browser config, but **never** your AISstream API key. GitHub Pages content is public.

## User interface

- **Aircraft:** on/off. Aircraft use a 250 NM *radius* query; the dashed ring shows the approximate query area. Their positions are polled every 20 seconds, subject to provider limits.
- **Marine:** on/off. Vessels are streamed as position reports *arrive* in the current viewport, with a maximum allowed area of **8° latitude × 12° longitude**. Zoom in if needed.
- **Search:** narrows displayed targets by callsign, identifier, registration, aircraft type or ship name.
- **Tap a marker:** displays the identifier, ground speed, heading, altitude (for aircraft) and latest received position fields where available.
- **Trails:** are collected **only while this browser session remains open**; neither provider's historical tracks are queried.
- **Demo:** if the backend is not configured the app displays **synthetic** targets. Once a backend is configured, the Demo button can toggle between synthetic and live data.
- **Quick navigation:** Adelaide, Singapore, Rotterdam, New York. The map works anywhere, subject to receiver/provider coverage.

## Important limitations

- This is a personal exploration dashboard, **not** an aviation or marine safety system. Data coverage, completeness and freshness depend on ground receivers, relays, and provider availability. Aircraft or ships can be absent or delayed.
- A single AISstream account currently has a limit of three subscribed connections and three connections per originating IP. The backend shares **one upstream connection** among at most three viewers by combining their geographic bounding boxes. For more viewers, design an aggregated service and validate provider terms and throughput.
- Opening the AIS layer does **not** retrieve all vessels already in the region. It adds and updates vessels on new AIS reports. Vessel positions are removed after 20 minutes without updates.
- The backend does not persist tracking history or ingest truly global data. Building persistent global coverage would require separate feed agreements, rate limiting, data retention, spatial indexing and scalable infrastructure.
- `adsb.lol` API data is under the **Open Database License (ODbL 1.0)**. Respect attribution, share-alike where applicable, and the provider's usage policies. AISstream data and service access are governed by its own terms.
- OpenStreetMap standard tiles need no API key. They require internet access and visible attribution, and are intended for modest interactive use under the [OSMF tile usage policy](https://operations.osmfoundation.org/policies/tiles/). Browser caching and referrer defaults must be preserved; bulk downloads and offline prefetching are not supported. Opening a local file may not send the required referrer, so use a local HTTP server for development. For substantial public traffic, use a suitable hosted or self-hosted tile service.
- Free Render instances may sleep after a period of inactivity, so the first live request may be slow.
- Backend error handling and sample tests are included, but access to real provider endpoints needs to be validated from your deployed service (the build environment for this package cannot make outbound live-provider requests).

## Files

```text
index.html             Map interface and controls
styles.css             Responsive dark theme
config.js              Public backend URL (NOT secret credentials)
app.js                 Map, filtering, trails, polling and WebSocket client
render.yaml            Optional Render deployment blueprint
backend/server.js      Aircraft REST proxy + shared AIS WebSocket relay
backend/lib.js         Provider message normalization and geographic checks
backend/package.json   Node dependencies and test command
backend/.env.example   Template for server-side environment settings
.gitignore             Excludes secrets and installed dependencies
backend/package-lock.json Locked backend dependency versions
tests/*.test.js        Normalization, HTTP/WebSocket and frontend regression tests
```

## Original upstream documentation

- [adsb.lol API](https://api.adsb.lol/docs)
- [AISstream API](https://www.aisstream.io/documentation)
- [GitHub Pages](https://docs.github.com/en/pages/quickstart)
- [Render WebSockets](https://render.com/docs/websocket)
- [Render Free Web Service](https://render.com/docs/free)
