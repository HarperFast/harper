#!/usr/bin/env bash
# Usage: change-landed.sh <target> <base> <head>
# Exits 0 only when one pick of <base>..<head> onto <target> would come out
# empty under Git's merge rules: merge-tree with <base> as the merge base is
# clean and leaves <target>'s tree unchanged. 1 means it would change <target>,
# 2 that the check could not run. Callers pick on anything but 0.
set -u

TARGET="$1"
BASE="$2"
HEAD="$3"

MERGED=$(git merge-tree --write-tree --merge-base="$BASE" "$TARGET" "$HEAD")
case $? in
	0)
		[ "$MERGED" = "$(git rev-parse "$TARGET^{tree}")" ] && exit 0
		exit 1
		;;
	1) exit 1 ;;
	*)
		echo "::warning::could not check whether $TARGET already contains $BASE..$HEAD, so it will be picked"
		exit 2
		;;
esac
