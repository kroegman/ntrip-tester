# Updating to v1.2

Preserve the directories in this archive. In particular, the browser files belong in `public/`, tests in `test/`, the deployment script in `scripts/`, and workflow files in `.github/workflows/`.

After pushing the update to GitHub, run on the droplet:

```bash
cd /opt/ntrip-load-console
git pull --ff-only
chmod +x scripts/deploy.sh
./scripts/deploy.sh
```

Verify:

```bash
grep '"version"' package.json
grep 'RTCM diagnostics' public/index.html
docker compose ps
```

The expected version is `1.2.0`. The Compose configuration exposes port `8080`; restrict that port in UFW and the DigitalOcean Cloud Firewall to trusted source addresses unless an authenticated HTTPS reverse proxy protects the dashboard.
