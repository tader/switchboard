#!/usr/bin/env bash
# Run only in an isolated Actions checkout: each attempt resets it to main.
set -euo pipefail

if [[ ! ${PR_NUMBER:-} =~ ^[1-9][0-9]*$ ]]; then
  echo 'PR_NUMBER must be a positive integer.' >&2
  exit 1
fi

# Keep every merge's run; a concurrency group can discard pending runs.
for attempt in {1..10}; do
  git fetch origin main
  git reset --hard origin/main
  if [[ -n $(git log -1 --format=%H --grep="^Version-Bump-For-PR: $PR_NUMBER$") ]]; then
    echo "PR #$PR_NUMBER already has a version bump."
    exit 0
  fi

  previous=$(git rev-parse HEAD)
  version=$(npm version patch --no-git-tag-version --ignore-scripts)
  git add package.json package-lock.json
  git commit -m "chore: bump version to $version" -m "Version-Bump-For-PR: $PR_NUMBER"
  if git push origin HEAD:main; then
    exit 0
  fi

  git fetch origin main
  if [[ $(git rev-parse origin/main) == "$previous" ]]; then
    echo 'Push failed without main advancing; check repository write permissions and branch protection.' >&2
    exit 1
  fi
  echo "Main advanced during attempt $attempt; recomputing the version."
done

echo 'Could not push the version bump after 10 attempts.' >&2
exit 1
