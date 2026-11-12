---
title: Server updates
adminOnly: true
order: 20
---
# Server updates

Open **Admin → Updates** to see the running server version, source revision, installation mode, last successful check and available release. The version in the account menu links here. Checks use the public upstream release service and are cached for one day; **Check now** refreshes them. A failed check preserves its last successful timestamp and disables upgrade selection until availability can be verified.

Stable releases are the default. **Validated main** explicitly opts into development commits whose complete upstream CI workflow has passed. A target must be a newer compatible descendant of the exact running revision. Local changes, unknown revisions, newer custom builds and releases without the managed startup protocol cannot be upgraded automatically. Published releases whose required artifacts are unavailable are not ready. Source installations require source; image installations also require an immutable published image digest.

## Choose how to run

Version checks work with existing checkout, Compose and custom starts. Managed upgrades are optional. Keep using your existing start command if you prefer manual updates.

To adopt host-managed upgrades, use a compatible release with the Updates page and gated startup support. The complete Compose bundle below does not need host build tools. For a host-managed checkout, install Node 24.10 or newer, Git and npm on the host. Compose mode also requires Docker Engine 25 or newer and Docker Compose v2 with `config --format json`, `--no-deps`, and `--pull never` support. The application container must have no Docker socket or Docker control access. The updater runs on the host as the owner of the instance and connects **outbound** to the application's authenticated updater API. It opens no network listener.

Use a dedicated updater credential, created through one-time enrollment. A general administrator API token cannot authenticate the updater. Only full-access administrators can check, enroll or request upgrades; scoped tokens, MCP credentials and peer credentials cannot manage upgrades.

Create a settings file outside your application and persistent data directories. Restrict it to its owner (`chmod 600`). Use absolute paths. Preserve any encryption key supplied through the environment in this settings file's `env` or in the host service's stable environment. Never put credentials in your source checkout, public issue reports or command output.

```json
{
  "instance": "primary",
  "mode": "checkout",
  "dataDir": "/srv/switchboard-data",
  "stateDir": "/srv/switchboard-updater",
  "appUrl": "http://127.0.0.1:8770",
  "initialRelease": "/srv/switchboard",
  "env": {
    "SWITCHBOARD_HOST": "127.0.0.1",
    "SWITCHBOARD_PORT": "8770",
    "SWITCHBOARD_PUBLIC_URL": "https://switchboard.example.com"
  }
}
```

`dataDir` is the full persistent state: database, encryption key, installed extensions, extension state and browser profiles. Persistent state must fit within this directory; external symbolic links are refused. The updater state directory holds the launcher, immutable releases, recovery journal and owner-only full backups. It must be separate from both data and code. Allow disk space for preparation, a full backup, and failed-candidate diagnostics. Keep independent off-host backups as well.

`appUrl` must reach the instance directly during gated startup, including while `/readyz` reports 503. A proxy that hides unhealthy containers is unsuitable. Use a host loopback port mapping for Compose, or a private direct HTTPS endpoint. Loopback HTTP is accepted; remote HTTP is refused.

From the compatible source checkout, install the external launcher:

```sh
node updater/main.ts setup /srv/switchboard-updater-settings.json
```

In **Admin → Updates**, choose **Create enrollment code**, then enroll the installed launcher. Codes expire in ten minutes and work once. The command stores the dedicated credential in the owner-only settings file. Avoid retaining the code in shell history.

```sh
node /srv/switchboard-updater/launcher/main.ts enroll /srv/switchboard-updater-settings.json ONE_TIME_CODE
```

For a checkout, stop your existing application and disable its previous automatic restart service before launching the managed process. This is an explicit adoption step; the launcher will not stop an unmanaged server. Your original checkout and local changes are preserved. Future targets are fetched into separate release directories, installed and built before cutover.

```sh
node /srv/switchboard-updater/launcher/main.ts launch /srv/switchboard-updater-settings.json
```

The launcher owns application starts and stops after adoption. The instance also takes an OS-released database lock to prevent concurrent servers from using its data. Do not run the old start command against that data while managed operation is enabled.

## Complete Compose stack

The release's versioned Compose example bundle includes an application container, a separate updater container, named data/state volumes, matching settings and a management wrapper. Only the trusted updater has Docker access; host Node, Git and npm are not required for the image variant.

Extract the bundle into a Docker-shared folder, retain its version-pinned `.env`, then run `./switchboard up`. Use `./switchboard logs switchboard` to obtain the first administrator setup link and complete setup in the browser. In **Admin → Updates**, create an enrollment code and run `./switchboard enroll ONE_TIME_CODE`. The page shows the updater connected within a few seconds. Codes expire in ten minutes and work once.

Use `./switchboard restart`, `./switchboard down` and `./switchboard up` for stack management. The wrapper includes the saved image pin automatically, so even a full stack restart retains the selected release and does not restart gated. `down` preserves volumes; `down -v` deletes them. Use `./switchboard backup` for a complete snapshot and `./switchboard restore BACKUP_ID` for an explicit restore that preserves current data first. Keep independent off-host copies; backups contain secrets. Follow the bundle's README for exact setup, source-build, backup and recovery commands.

The container controller uses an explicit private service address. Ordinary host controllers still require HTTPS or loopback HTTP. Existing host-managed Compose installations can continue using the configuration below.

## Existing host-managed Compose installations

Use `"mode": "compose"` and a fixed Compose project/service. `env` is for checkout starts; Compose retains its existing service environment and `.env` resolution. Add:

```json
{
  "files": ["/srv/switchboard/compose.yaml"],
  "project": "switchboard",
  "service": "switchboard",
  "directory": "/srv/switchboard",
  "sourceBuild": false
}
```

Place that object under the `compose` key in settings. For a bind mount, `dataDir` must exactly match the host directory mounted writable at `/data`. For a named volume, set `dataDir` to `/data` and add `"dataVolume": "switchboard_data"` inside `compose`, using the exact Docker volume name (including any project prefix). The controller verifies this against the resolved Compose configuration. Compose backups use the immutable previous image as an isolated helper without networking or application environment variables.

Use a host directory shared with Docker for `stateDir`; helper containers must be able to mount its backup and rehearsal directories.

Only one replica of the configured service is supported. Additional writable mounts, Docker socket access, and privileged application containers are refused. Move all persistent state into the configured data mount before adoption. Read-only configuration mounts, networks, labels, volumes and unrelated services are retained. Keep those files and secrets stable outside the release tree.

Set `sourceBuild` to `true` to build pinned source locally instead of pulling a prebuilt image. A source-built Compose upgrade does not depend on a published remote image. Preparation builds or pulls while the old service continues serving. Cutover uses an immutable image override saved in the updater state directory; it never runs `compose down`, rebuilds during outage, or recreates other services.

Start the enrolled controller with:

```sh
node /srv/switchboard-updater/launcher/main.ts run /srv/switchboard-updater-settings.json
```

For future manual Compose commands, include the generated override after your original files, or Compose may switch back to the original image:

```sh
docker compose --project-directory /srv/switchboard -p switchboard -f /srv/switchboard/compose.yaml -f /srv/switchboard-updater/active-compose.json ps
```

## Keep the launcher running

On Linux, a user systemd service can supervise the launcher. Replace the executable and settings paths with your absolute paths; use `run` instead of `launch` for Compose. Enable user lingering if the service must run after logout. `KillMode=process` lets the application survive a controller restart; the data lock and recovery journal prevent concurrent starts.

```ini
[Unit]
Description=Switchboard managed launcher

[Service]
Type=simple
ExecStart=/usr/bin/node /srv/switchboard-updater/launcher/main.ts launch /srv/switchboard-updater-settings.json
Restart=on-failure
RestartSec=5
KillMode=process
UMask=0077
Environment=PATH=/usr/local/bin:/usr/bin:/bin

[Install]
WantedBy=default.target
```

Save as `~/.config/systemd/user/switchboard-updater.service`, then run `systemctl --user daemon-reload` and `systemctl --user enable --now switchboard-updater`.

On macOS, a LaunchAgent runs while its owner is logged in. Save an owner-readable plist in `~/Library/LaunchAgents/`, with absolute paths and the Node executable returned by `command -v node`. Do not use shell substitutions inside the plist. Use `run` for Compose.

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>local.switchboard.updater</string>
  <key>ProgramArguments</key><array>
    <string>/opt/homebrew/bin/node</string>
    <string>/srv/switchboard-updater/launcher/main.ts</string>
    <string>launch</string>
    <string>/srv/switchboard-updater-settings.json</string>
  </array>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>5</integer>
  <key>Umask</key><integer>63</integer>
</dict></plist>
```

Adjust the service PATH so Git, npm and Docker (Compose mode) are available. `setup` installs the launcher files; registering either host service is a separate manual step.

Load it with `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/local.switchboard.updater.plist`. LaunchAgent jobs are per-user; unattended operation after logout needs an appropriately configured system service.

## What happens during an upgrade

1. The controller journals the selected exact commit or digest outside code and backups, prepares the release, and rehearses database migrations on a disposable online database copy. The rehearsal never loads extensions, decrypts credentials or contacts providers.
2. Cancellation is accepted until cutover. Preparation may finish before cancellation takes effect; no deployment follows a cancelled job.
3. Cutover blocks new service requests, pauses core collectors and peer activity, and waits up to 30 seconds for finite requests while their extension resources remain loaded. It then disconnects long-lived streams and sockets, disposes extensions and releases browser profiles. The old process stops entirely before a full persistent-data snapshot is taken. Arbitrary extension-owned producers have no separate pause contract and may continue until disposal; extensions must stop their own workers and release resources when disposed.
4. Backup time is part of the outage. Its duration depends on your data size and storage; there is no fixed downtime promise.
5. The candidate runs migrations and exposes authenticated staged readiness while normal requests and extensions remain gated. `/healthz` reports process liveness; `/readyz` only succeeds after normal operation opens.
6. After staged readiness, the controller durably records the irreversible opening boundary, then permits extension initialization, background work and normal requests. The Updates page reconnects and shows the result and measured durations. Requests to providers are never automatically replayed.

The 30-second limit applies to finite-request draining, not arbitrary extension cleanup. The updater bounds its drain API wait to 60 seconds and then attempts to stop the old service. Checkout mode waits up to 45 seconds after SIGTERM and refuses backup or candidate start if the process is still alive. Compose uses a 45-second stop timeout (Docker may forcibly stop the container after it expires) and verifies that the service is stopped. A cleanup error leaves the checkout process gated with its data lease held; a stalled cleanup or uncertain stop requires owner recovery. No snapshot is accepted while the old service is still running. Detached workers outside the application’s managed lifecycle remain the responsibility of their trusted extension.

## Recovery

Completed job records remain under `history/`; `last-success.json` identifies the last successful upgrade and its backup. The owner-only `journal.json` identifies the previous and candidate releases, job phase, backup and whether normal operation may have opened. Retain the previous release/image and last successful backup. No automatic cleanup deletes these recovery assets.

If startup fails **before** the opening boundary, the controller stops the candidate, preserves failed data, restores the matching full snapshot and previous release/image, checks staged readiness and opens the old release. Old binaries refuse a database schema newer than they support.

A controller restart resumes recovery from the journal and does not replay a deployment. Interrupted preparation is marked failed and can be requested again as a new job. If the journal says `opening` or `recovery-required`, automatic restoration is disabled: the application or an extension may already have written data or performed external actions. A failed rollback also requires owner recovery. The UI deliberately shows only scrubbed diagnostics; inspect local settings, disk space and the journal as the instance owner. Subprocess output is withheld because it may contain secrets.

For explicit recovery:

1. Stop the controller's host service and all application processes/containers for this instance. Prevent automatic restarts. Confirm they have released the data directory.
2. Save a separate owner-only copy of the current data and journal before changing anything. Decide whether preserving current writes or restoring the snapshot is appropriate. Restoration after opening can discard writes. External side effects cannot be undone.
3. Select a release/image matching the chosen database schema. Restore the **entire** matching snapshot, including `secret.key`, extension state and browser profiles, if restoring. Never combine a database from one backup with a key from another.
4. For checkout mode, update the owner-only `current.json` release pointer. For Compose, keep the matching generated image override. Remove a stale `.server-lock` metadata file only after confirming no server remains; the separate SQLite lease prevents concurrent use.
5. Verify readiness with the selected release. After recording your recovery decision separately, archive the old journal and remove its active copy before starting a fresh controller. Enroll again if the restored data predates enrollment. Check the Updates page before requesting another upgrade.

You can disconnect the updater credential from the Updates page while no upgrade is active. This does not stop the application. Disable the host service as well to stop polling.

Reference: [Docker Compose service recreation](https://docs.docker.com/reference/cli/docker/compose/up/), [Docker startup health probes](https://docs.docker.com/reference/dockerfile/#healthcheck), [Node SQLite backup](https://nodejs.org/api/sqlite.html#sqlitebackupsource-destination-options), [systemd services](https://www.freedesktop.org/software/systemd/man/latest/systemd.service.html), [systemd process lifetime settings](https://www.freedesktop.org/software/systemd/man/latest/systemd.kill.html), and [Apple launchd jobs](https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPSystemStartup/Chapters/CreatingLaunchdJobs.html).
