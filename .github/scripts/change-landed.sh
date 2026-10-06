#!/usr/bin/env bash
# Report whether a branch already contains a change.
#
# Usage: change-landed.sh <target> <base> <head>
# Exits 0 when merging <base>..<head> into <target> (three-way, <base> as the
# merge base) is clean and leaves <target>'s tree unchanged: every hunk of the
# change is already there verbatim. Exits 1 otherwise — a change that is only
# partly present, was reverted, or conflicts — and 2, with a warning, when the
# check cannot run. Only 0 means "skip"; the caller picks on anything else.
set -u

TARGET="$1"
BASE="$2"
HEAD="$3"

MERGED=$(git merge-tree --write-tree --merge-base="$BASE" "$TARGET" "$HEAD")
case $? in
	0) [ "$MERGED" = "$(git rev-parse "$TARGET^{tree}")" ] ;;
	1) exit 1 ;;
	*)
		echo "::warning::could not check whether $TARGET already contains $BASE..$HEAD, so it will be picked"
		exit 2
		;;
esac
