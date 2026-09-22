# NTRIP Load Console

A self-contained NTRIP v1/v2 stream load tester with a browser dashboard. It opens many independent TCP or TLS connections using one credential, optionally sends periodic NMEA GGA positions, and reports live throughput and per-client health.

Use it only against NTRIP casters you own or have explicit permission to load-test.

## Features

- 1–500 simultaneous clients by default (configurable)
- NTRIP Basic authentication and `ICY 200` / HTTP 200 response support
- Per-client GGA generation from latitude and longitude
- Controlled connection ramp-up to avoid an accidental burst
- Live active, connecting, error, throughput, byte, latency, and reconnect metrics
- Searchable connection table and CSV export
- Credentials are kept only in server memory and are never returned by the API
- Single-account mode or CSV account mode with one independent credential per client
- Optional streaming RTCM3 frame parser with CRC-24Q validation and per-message counters
- RTCM 1005/1006 base-station position decoding, ECEF-to-WGS84 conversion, live rover/base map, and baseline distance
- On-demand per-connection RTCM inspector, keeping 500+ connection monitoring payloads compact
- Optional bounded random disconnect/reconnect churn for authorized stress tests
- No database and no runtime npm dependencies

## CSV account mode

Choose **CSV accounts** in the dashboard and load a CSV with these headers:

```csv
label,username,password,latitude,longitude
Rover 01,user01,secret01,52.3676,4.9041
Rover 02,user02,secret02,,
```

`username` and `password` are required columns. `label`, `latitude`, and `longitude` are optional. Each row creates one NTRIP client. When row coordinates are blank, the dashboard's global coordinates are used. CSV contents are sent only to the running service, held in memory for the test, and never returned by the status API.

## RTCM diagnostics

Enable **RTCM diagnostics** before starting a test. The service incrementally validates RTCM3 frames, counts every message type, and decodes types 1005 and 1006 to obtain the base-station ECEF coordinates. Select a connection row or its rover marker to inspect that connection. Only the selected connection's complete message counters are fetched by the browser; the one-second overview remains compact for large tests.

The map uses Leaflet with OpenStreetMap tiles and therefore needs browser internet access. Frame parsing continues if tiles are unavailable. Parsing is off by default so a throughput-only load test does not pay the CRC and bit-decoding cost.

## Random churn

Enable **Random connection churn** to periodically choose a random percentage of active clients, close them intentionally, and reconnect them after the configured downtime. Intentional churn is tracked separately from failures. `MAX_CHURN_PER_TICK` caps the number affected in one cycle (default `50`) so large tests do not accidentally create an unbounded reconnect burst.

## Run locally

Requires Node.js 20 or newer.

```bash
npm test
npm start
```

Open `http://localhost:8080`.

## Deploy on a DigitalOcean droplet

Recommended minimum for 100–250 lightweight streams: a Basic 2 GB / 1 vCPU droplet. Actual sizing depends on correction bitrate, TLS, caster latency, and reconnect frequency.

1. Create an Ubuntu droplet and allow inbound SSH, HTTP, and HTTPS in its firewall.
2. Install Docker and the Compose plugin.
3. Copy this folder to `/opt/ntrip-load-console`.
4. Copy `.env.example` to `.env`; set `MAX_CONNECTIONS` and `START_RATE_PER_SECOND`.
5. Start the service:

```bash
docker compose up -d --build
docker compose logs -f
```

The compose file publishes port `8080` on the droplet. Open `http://YOUR_DROPLET_IP:8080` only from networks allowed by your firewall. This plain HTTP endpoint has no built-in browser login and carries entered NTRIP credentials, so use a restricted firewall rule or put Caddy/Nginx with HTTPS and authentication in front of it. `Caddyfile.example` shows the reverse-proxy shape.

## GitHub deployment

The repository includes two workflows:

- `test.yml` runs the Node tests and builds the Docker image on every push and pull request.
- `deploy.yml` tests, securely copies the project to the droplet, and restarts the Docker Compose service on every push to `main`. It can also be run manually.

Add these GitHub Actions repository secrets:

| Secret | Value |
| --- | --- |
| `DO_HOST` | Droplet IP address or hostname |
| `DO_USER` | SSH user with write access to `/opt/ntrip-load-console` and Docker access |
| `DO_SSH_KEY` | Private Ed25519 deployment key |
| `DO_KNOWN_HOSTS` | Output of `ssh-keyscan -H YOUR_DROPLET_IP`, verified against the droplet host key |

On the droplet, create `/opt/ntrip-load-console/.env` once. The workflow deliberately excludes `.env`, so later deployments do not overwrite secrets or limits. If it is missing, the first deployment creates it from `.env.example`.

For 500+ clients, raise `MAX_CONNECTIONS`, increase the container and host file-descriptor limits, and watch CPU, memory, bandwidth, reconnect rate, and the caster's published session limits. Start with RTCM diagnostics and churn disabled, establish a throughput baseline, and enable them independently.

## Notes

- NTRIP credentials and connection limits are caster-specific. One credential may be restricted to a single session even if the tester is configured for more.
- Each simulated client sends the same configured coordinate. The GGA timestamp is refreshed on every send.
- The dashboard state is intentionally ephemeral; restarting the service stops the test and clears metrics.
- If `ADMIN_TOKEN` is set, all `/api/*` calls require a matching bearer token. The included browser UI does not store or inject that token, so use reverse-proxy authentication for normal browser use.
