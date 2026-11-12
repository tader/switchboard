---
title: Server updates
adminOnly: true
order: 20
---
# Server updates

Update Switchboard from **Admin → Server updates**. Installed plugins have their own [plugin updates](/admin/plugins).

**Check for updates** works without an updater. To install a release from the page, connect an updater using the steps for your installation below.

## Choose your setup

- **Docker Compose:** [Start the stack and enroll the updater](#docker-compose).
- **Local Mac:** [Use Switchboard for macOS](#macos-app), if you have an app build.
- **Git checkout:** [Install a host launcher](#git-checkout) with Node, Git and npm.
- **Existing custom stack or host service:** Follow [Advanced updater setup](/docs/guides/updater-host-setup).

Keep an independent backup of your server data before changing how an existing installation starts. Retain its database, encryption key, installed extensions, extension state and browser profiles together.

## Docker Compose

These steps use the complete example stack, which includes both Switchboard and its updater. For an existing custom stack, use [host-managed Compose instructions](/docs/guides/updater-host-setup#existing-host-managed-compose-installations) to retain your existing data mounts and configuration.

### 1. Get the complete bundle

Download a `switchboard-compose-…tar.gz` example bundle from the matching [Switchboard release](https://github.com/tader/switchboard/releases). Extract it into a folder Docker can access. The [example folder](https://github.com/tader/switchboard/tree/main/distribution/compose) contains the same files.

Keep `compose.yaml`, `switchboard` and `.env.example` together. Keep the version-pinned `.env` if the release bundle includes one. Before the first start, edit `.env` if you want a different port, public URL or project name. Defaults expose Switchboard on `http://127.0.0.1:8770`.

### 2. Start the stack

Run these commands from that folder:

```sh
chmod +x switchboard
./switchboard up
./switchboard status
```

The wrapper supplies the folder and project settings automatically. Host Node, Git and npm are not needed for this image-based setup. Only the trusted updater container receives access to Docker.

### 3. Finish the first administrator setup

If this is a new installation, find the one-time setup link:

```sh
./switchboard logs switchboard
```

Open that link in your browser and choose an administrator password. Keep the link private. If you already have an administrator account, sign in with it.

### 4. Connect the updater

In **Admin → Server updates**, choose **Create enrollment code**. Then run:

```sh
./switchboard enroll 'YOUR_CODE'
```

Replace `YOUR_CODE` with the code from the page. It expires after ten minutes and works once. An ordinary administrator API token cannot be used here.

The updater reaches Switchboard automatically at `http://switchboard:8770` inside the stack; you do not need to enter an address or expose another port.

### 5. Verify the connection

The command prints `Updater enrolled.` Within a few seconds the page shows **Server updater · Connected**. You can now [install a server update](#install-an-update).

For everyday stack management, keep using the wrapper:

```sh
./switchboard status
./switchboard restart
./switchboard down
./switchboard up
```

It retains the release selected by the updater. `down` keeps your data volumes. **Do not use `down -v` to preserve an installation:** that removes the volumes.

The bundle's [README](https://github.com/tader/switchboard/blob/main/distribution/compose/README.md) also covers source builds and backups.

## macOS app

[Switchboard for macOS](https://github.com/tader/switchboard-macos) manages a local server from the menu bar, including initial setup, start/stop, login startup and server upgrades. It downloads its own prepared runtime, so the app does not need a separate Node, Git or npm installation.

> [!NOTE]
> There is not yet a published app download. Current development builds are unsigned. Check the [app repository](https://github.com/tader/switchboard-macos) for release availability.

If you have a compatible app build:

1. Open **Switchboard** and review its settings. The default data folder is `~/.switchboard`; the default address is `127.0.0.1:8770`.
2. Choose **Set Up Switchboard**. The app downloads the runtime and opens administrator setup in your default browser.
3. Create your administrator password in the browser. The app pairs the updater automatically; no enrollment code needs to be copied.
4. Use **Updates** in the app, or open **Admin → Server updates** in the browser. The updater shows **Connected** while the app is serving the instance.
5. Optionally enable **Open app at login** and **Start server when the app opens** in the app's Settings.

To adopt existing compatible data, stop the previous server and disable its old automatic launcher before selecting that data folder in the app. Closing Settings keeps the server running; **Quit** stops the app's server and updater.

## Git checkout

Use this route when you run Switchboard from source and want a host launcher to manage starts, backups and upgrades. You need Node 24.10 or newer, Git and npm. For manual updates, keep your normal start command and use this page for version checks only.

1. Start with a compatible source checkout and finish its administrator setup.
2. Create an owner-only settings file outside the checkout and data folder. Use the [settings example](/docs/guides/updater-host-setup#host-launcher-requirements); set your current data directory, a separate updater directory and an address that reaches the server directly.
3. From your source checkout, install the launcher. Replace the example path with your settings file's absolute path:

   ```sh
   node updater/main.ts setup /srv/switchboard-updater-settings.json
   ```

4. In **Admin → Server updates**, create an enrollment code and run the launcher command. Replace the example paths and code:

   ```sh
   node /srv/switchboard-updater/launcher/main.ts enroll /srv/switchboard-updater-settings.json YOUR_CODE
   ```

5. Stop the old server and disable its previous restart service. Start the managed launcher:

   ```sh
   node /srv/switchboard-updater/launcher/main.ts launch /srv/switchboard-updater-settings.json
   ```

6. Verify **Connected** in the browser. To keep the launcher running after terminal closure or a restart, follow [Keep the launcher running](/docs/guides/updater-host-setup#keep-the-launcher-running).

The original checkout and local changes are preserved. Future releases are prepared in separate folders. Once the launcher owns this installation, use it for starts and stops; avoid running a second server against the same data.

## Install an update

1. Keep an independent backup of the complete data folder and updater state.
2. Open **Admin → Server updates** and choose **Check for updates**.
3. Leave **Stable releases** selected for normal use. Review the available version and release notes.
4. With the updater **Connected**, choose **Upgrade to …** and confirm **Prepare upgrade**.
5. Follow the status: **Prepare → Back up → Restart**. The page reconnects automatically after the restart. The updater continues if you close the page.

Preparation downloads or builds while the current server keeps running. During cutover, service requests pause and long-lived streams disconnect. A full backup and restart cause an interruption; its duration depends on your data size and storage. **Cancel preparation** is available until cutover begins. Requests to services are never automatically replayed.

**Validated main** is an optional development channel for checkout and Compose installations. It follows newer compatible development commits after upstream CI has passed. The macOS app uses prepared stable releases.

Custom builds, local source changes, unknown revisions and releases whose artifacts are still publishing can prevent managed upgrades. A failed check preserves the last successful check time; it does not mean the server is up to date.

## Backups

For the example Compose stack:

```sh
./switchboard backup
```

The command briefly stops the application to make a complete snapshot and prints a backup ID. Store an independent off-host copy of both data and updater state. Backups contain credentials; keep them private. Allow space for a full backup and failed-release data.

For a host launcher or the macOS app, backups and recovery records are in the configured updater folder. Keep the encryption key, database and extension data from the same snapshot together.

## Recovery

### Update preparation failed

The old server remains in place. Check local updater logs, free space and release availability before trying again. If an upgrade stays on **Waiting for updater**, follow the [updater connection and mount checks](/docs/guides/updater-host-setup#waiting-for-updater).

### Previous release restored

Startup failed before the new server opened. The updater restored the previous release and matching data. Inspect the updater journal before another upgrade.

### Recovery required

Stop and preserve the current data and updater state. Follow the manual recovery steps before starting another upgrade.

For an explicit restore of a known backup from the example Compose stack:

```sh
./switchboard restore BACKUP_ID
./switchboard status
```

This preserves current data separately and restores the full backup with its matching previous release. Re-enroll if the restored data predates the current pairing.

> [!WARNING]
> Restoring after the new server has accepted work can discard later writes. External actions cannot be undone by restoring local files. Never combine a database from one backup with another encryption key.

For host services, custom Compose installations or an interrupted upgrade, follow [Manual recovery](/docs/guides/updater-host-setup#recovery). Retain the journal and failed data until you have made a recovery decision.
