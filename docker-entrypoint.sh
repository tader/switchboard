#!/bin/sh
# Make the data volume writable for the unprivileged user, then drop root.
set -e
umask 077
mkdir -p "$SWITCHBOARD_DATA_DIR"
chown -R node:node "$SWITCHBOARD_DATA_DIR"
exec su-exec node "$@"
