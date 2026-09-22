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
- No database and no runtime npm dependencies

## CSV account mode

Choose **CSV accounts** in the dashboard and load a CSV with these headers:

```csv
label,username,password,latitude,longitude
Rover 01,user01,secret01,52.3676,4.9041
Rover 02,user02,secret02,,
```

`username` and `password` are required columns. `label`, `latitude`, and `longitude` are optional. Each row creates one NTRIP client. When row coordinates are blank, the dashboard's global coordinates are used. CSV contents are sent only to the running service, held in memory for the test, and never returned by the status API.

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

The compose file binds the app only to localhost. Put Caddy or Nginx in front of it for HTTPS and authentication. `Caddyfile.example` shows the smallest Caddy setup. Generate the password hash with `caddy hash-password`, replace the placeholder, point DNS at the droplet, and reload Caddy.

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

For 500+ clients, increase the container `nofile` limit and the host's file-descriptor limits, raise `MAX_CONNECTIONS` gradually, and watch CPU, memory, bandwidth, and the caster's published session limits.

## Notes

- NTRIP credentials and connection limits are caster-specific. One credential may be restricted to a single session even if the tester is configured for more.
- Each simulated client sends the same configured coordinate. The GGA timestamp is refreshed on every send.
- The dashboard state is intentionally ephemeral; restarting the service stops the test and clears metrics.
- If `ADMIN_TOKEN` is set, all `/api/*` calls require a matching bearer token. The included browser UI does not store or inject that token, so use reverse-proxy authentication for normal browser use.
