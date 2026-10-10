#!/bin/sh
# Generate the SHA256SUMS file for a kawai release directory, or exit 1.
#
# The updater treats this file as its only trust anchor: it refuses an update
# whose tarball hash is not listed (see openspec/changes/add-update-checker).
# A release that would ship without a complete checksum file must therefore
# never be created — a missing tarball or an unreadable file fails the publish
# job instead of uploading a partial manifest.
#
# Usage: release-checksums.sh <release-dir>
# Expects the four platform tarballs agentboard-<platform>.tar.gz inside
# <release-dir> and writes <release-dir>/SHA256SUMS naming each one.

set -eu

if [ "$#" -ne 1 ]; then
	echo "usage: $0 <release-dir>" >&2
	exit 1
fi

release_dir=$1
platforms="darwin-arm64 darwin-x64 linux-x64 linux-arm64"

checksums_file="$release_dir/SHA256SUMS"
: > "$checksums_file"

for platform in $platforms; do
	tarball="agentboard-$platform.tar.gz"
	if [ ! -f "$release_dir/$tarball" ]; then
		echo "error: $tarball is missing from $release_dir; refusing to publish without a complete checksum file" >&2
		exit 1
	fi
	# Hash from inside the directory so entries name the bare tarball, the
	# way release assets (and a user verifying by hand) are named.
	if ! ( cd "$release_dir" && sha256sum "$tarball" ) >> "$checksums_file" 2>/dev/null; then
		echo "error: could not hash $tarball; refusing to publish without a complete checksum file" >&2
		exit 1
	fi
done

entries=$(grep -c . "$checksums_file")
if [ "$entries" -ne 4 ]; then
	echo "error: expected 4 checksum entries, wrote $entries; refusing to publish" >&2
	exit 1
fi

echo "SHA256SUMS written with $entries entries"
