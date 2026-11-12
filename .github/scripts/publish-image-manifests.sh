#!/usr/bin/env bash
set -euo pipefail
: "${APP_TAGS:?application tags required}"
: "${DIGESTS:?digest directory required}"
: "${REPOSITORY:?repository required}"
repository=$(printf '%s' "$REPOSITORY" | tr '[:upper:]' '[:lower:]')
[[ "$repository" =~ ^[a-z0-9._-]+/[a-z0-9._-]+$ ]] || exit 1
image="ghcr.io/$repository"
IFS=, read -r -a tags <<< "$APP_TAGS"
app_tags=() updater_tags=()
for tag in "${tags[@]}"; do
  [[ "$tag" == "$image:"* ]] || exit 1
  suffix=${tag#"$image:"}
  [[ "$suffix" =~ ^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$ ]] || exit 1
  app_tags+=(--tag "$tag")
  updater_tags+=(--tag "$image-updater:$suffix")
done
shopt -s nullglob
app_files=("$DIGESTS/app/"*) updater_files=("$DIGESTS/updater/"*)
# Validate both complete sets before moving any public tag.
[[ ${#app_files[@]} -eq 2 && ${#updater_files[@]} -eq 2 ]] || exit 1
app_refs=() updater_refs=()
for file in "${app_files[@]}" "${updater_files[@]}"; do
  [[ -f "$file" && ! -s "$file" && "${file##*/}" =~ ^[a-f0-9]{64}$ ]] || exit 1
done
for file in "${app_files[@]}"; do app_refs+=("$image@sha256:${file##*/}"); done
for file in "${updater_files[@]}"; do updater_refs+=("$image-updater@sha256:${file##*/}"); done
docker buildx imagetools create "${app_tags[@]}" "${app_refs[@]}"
docker buildx imagetools create "${updater_tags[@]}" "${updater_refs[@]}"
