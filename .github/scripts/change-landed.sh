#!/usr/bin/env bash
# Usage: change-landed.sh <target> <base> <head> <commit>...
# Exits 0 only when picking the commits onto <target> would land nothing new:
# replayed onto it with each conflict resolved toward the commit, they end at
# <target>'s own tree, and so does the net change <base>..<head>. 1 when they
# would land something, 2 when the check cannot tell; callers pick on either.
set -u

TARGET="$1"
BASE="$2"
HEAD="$3"
shift 3

could_not_run() {
	echo "::warning::could not check whether $TARGET already contains $BASE..$HEAD, so it will be picked"
	exit 2
}

[ "$#" -gt 0 ] || could_not_run
TARGET_TREE=$(git rev-parse --verify --quiet "$TARGET^{tree}") || could_not_run

REPLAYED="$TARGET"
for COMMIT in "$@"; do
	# A real pick reads the .gitattributes earlier picks wrote; merge-tree reads only the checkout's.
	git diff-tree --name-only -r "$COMMIT^1" "$COMMIT" | grep -qE '(^|/)\.gitattributes$' && could_not_run
	REPLAYED=$(git merge-tree --write-tree -X theirs --merge-base="$COMMIT^1" "$REPLAYED" "$COMMIT")
	case $? in
		0) REPLAYED="${REPLAYED%%$'\n'*}" ;;
		1) exit 1 ;;
		*) could_not_run ;;
	esac
done
[ "$REPLAYED" = "$TARGET_TREE" ] || exit 1

MERGED=$(git merge-tree --write-tree --merge-base="$BASE" "$TARGET" "$HEAD")
case $? in
	0) [ "${MERGED%%$'\n'*}" = "$TARGET_TREE" ] && exit 0 ;;
	1) ;;
	*) could_not_run ;;
esac
exit 1
