# Managed Compose stack

This bundle runs the application and a separate trusted updater. Only the updater receives the Docker socket. The application keeps all persistent data in a named volume; updater credentials, release pins, journals and backups live in a second named volume. No host Node installation is needed.

Install Docker Engine with the Compose plugin, then extract the versioned example bundle from the matching server release. Keep its folder on a local filesystem shared with Docker. Docker Desktop and Colima must be able to mount that folder. Use one folder/project name per installation. The updater has administrator-equivalent Docker access; protect the host and bundle settings accordingly.

## First start

```sh
cp .env.example .env
chmod 600 .env
./switchboard up
./switchboard status
./switchboard logs switchboard
```

The release bundle may already include a version-pinned `.env`; keep that file rather than copying over it. Edit `.env` to choose a port, public URL or project name before starting. Defaults expose port 8770 on host loopback only. Open the one-time setup link printed in application logs and create the first administrator password in the browser. Never share this link or the logs containing it.

Open **Admin → Server updates → Create enrollment code**, then run the supplied command with that code:

```sh
./switchboard enroll ONE_TIME_CODE
```

Expected result: `Updater enrolled.` Within a few seconds **Admin → Server updates** shows the updater connected. The code expires after ten minutes and works once. It grants only updater access. Avoid retaining it in shell history. There are no settings JSON files to edit and no volume identifiers to discover.

The trusted updater reaches the application's private Compose service address directly, including during gated startup. This container-only setting does not relax the HTTPS/loopback rule for ordinary host controllers.

## Operation and updates

```sh
./switchboard status
./switchboard logs --tail 100 updater
./switchboard restart
./switchboard down
./switchboard up
```

Always use this wrapper. It includes the persistent active-image override for every stack operation. Both a restart and a full down/up retain the selected release and resume normal operation. `down` retains data and updater volumes; `down -v` deletes them and must never be used to preserve an installation.

Choose **Check for updates**, then **Upgrade to …** in **Admin → Server updates**. Preparation pulls an immutable image while the application keeps serving. The updater rehearses migrations, drains/stops only the application service, snapshots its entire data volume, and starts the candidate gated. Before opening it, failures restore the previous image and snapshot. The updater never runs a full-stack down during cutover and leaves unrelated services alone.

## Optional source build

Use this bundle from `distribution/compose` in a compatible source checkout. Set these values in `.env`:

```dotenv
SWITCHBOARD_SOURCE_BUILD=true
SWITCHBOARD_SOURCE_DIR=../..
SWITCHBOARD_REVISION=YOUR_40_CHARACTER_COMMIT_REVISION
```

Run `./switchboard up`. The first start includes `compose.source.yaml` and builds the application locally. The updater remains a separately published image. Future upgrades prepare verified source revisions in the updater volume and build with Docker. An active image pin takes precedence on later restarts; restarting never rebuilds or reverts a selected release.

## Backups and recovery

```sh
./switchboard backup
```

The application briefly stops for a complete snapshot, then restarts. The command prints a backup ID such as `manual-1700000000000`. Helpers use isolated containers without networking, application credentials or a Docker socket; they mount the named volumes directly. Keep sufficient free space for full backups and failed-candidate data. Backups include secrets and must remain private. Keep independent off-host copies of both named volumes; local snapshots do not protect against host loss.

To restore a known backup explicitly:

```sh
./switchboard restore BACKUP_ID
./switchboard status
```

This stops the stack, preserves current data in updater state, restores the entire matching snapshot and previous image, archives the active recovery journal, and restarts. A job ID recorded under updater `history/` can also select its automatic snapshot. Restoring after the application opened can discard later writes; external actions cannot be undone. Re-enroll from **Admin → Server updates** if the restored data predates the current pairing. Never combine a database from one backup with another encryption key.

If an operation fails, keep both volumes and inspect updater logs and its owner-only journal. Do not delete or recreate the volumes to clear a recovery state. Stop the stack while diagnosing uncertain process or storage state.
