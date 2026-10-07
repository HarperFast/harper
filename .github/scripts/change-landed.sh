#!/usr/bin/env bash
# Usage: change-landed.sh <target> <base> <head> <commit>...
# Exits 0 only when picking the commits onto <target> would land nothing new:
# replayed onto it with each conflict resolved toward the commit, they end at
# <target>'s own tree, and so does the net change <base>..<head>. 1 when they
# would land something, 2 when the check cannot tell; callers pick on either.
set -u

if [ "$#" -lt 4 ]; then
	echo "::warning::change-landed.sh needs a target, base, head and at least one commit, so the commits will be picked"
	exit 2
fi

TARGET="$1"
BASE="$2"
HEAD="$3"
shift 3

could_not_run() {
	echo "::warning::could not check whether $TARGET already contains $BASE..$HEAD ($1), so it will be picked"
	exit 2
}

TARGET_TREE=$(git rev-parse --verify --quiet "$TARGET^{tree}") || could_not_run "$TARGET does not resolve"

REPLAYED="$TARGET"
for COMMIT in "$@"; do
	# A real pick reads the .gitattributes earlier picks wrote; merge-tree reads only the checkout's.
	git diff-tree -z --name-only -r "$COMMIT^1" "$COMMIT" | grep -qzE '(^|/)\.gitattributes$' &&
		could_not_run "$COMMIT changes .gitattributes"
	REPLAYED=$(git merge-tree --write-tree -X theirs --merge-base="$COMMIT^1" "$REPLAYED" "$COMMIT")
	case $? in
		0) REPLAYED="${REPLAYED%%$'\n'*}" ;;
		1) exit 1 ;;
		*) could_not_run "git merge-tree failed replaying $COMMIT" ;;
	esac
done
[ "$REPLAYED" = "$TARGET_TREE" ] || exit 1

MERGED=$(git merge-tree --write-tree --merge-base="$BASE" "$TARGET" "$HEAD")
case $? in
	0) [ "${MERGED%%$'\n'*}" = "$TARGET_TREE" ] && exit 0 ;;
	1) ;;
	*) could_not_run "git merge-tree failed merging the net change" ;;
esac
exit 1
