# Updating to v1.2.1

Preserve the directories in this archive. Browser files belong in `public/`, tests in `test/`, the deployment script in `scripts/`, and workflow files in `.github/workflows/`.

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
grep 'All streams' public/index.html
docker compose ps
```

The expected version is `1.2.1`.
