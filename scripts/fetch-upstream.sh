#!/usr/bin/env bash
# Fetch the pinned God's Eye View commit into a folder.
# The pin lives in UPSTREAM_COMMIT. The script checks that git returns exactly that commit.
set -euo pipefail

dest="${1:?usage: fetch-upstream.sh <dest>}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
sha="$(tr -d '[:space:]' < "$here/UPSTREAM_COMMIT")"
repo="${GEV_UPSTREAM_REPO:-https://github.com/bilawalsidhu/gods-eye-view.git}"

if [[ ! "$sha" =~ ^[0-9a-f]{40}$ ]]; then
  echo "UPSTREAM_COMMIT must hold a full 40 character commit hash." >&2
  exit 1
fi

rm -rf "$dest"
mkdir -p "$dest"
git -C "$dest" init -q
git -C "$dest" remote add origin "$repo"
git -C "$dest" fetch -q --depth 1 origin "$sha"
git -C "$dest" checkout -q FETCH_HEAD

actual="$(git -C "$dest" rev-parse HEAD)"
if [[ "$actual" != "$sha" ]]; then
  echo "Fetched $actual but UPSTREAM_COMMIT pins $sha." >&2
  exit 1
fi
echo "Fetched upstream $sha into $dest"
