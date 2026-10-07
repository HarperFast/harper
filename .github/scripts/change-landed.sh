#!/usr/bin/env bash
# Usage: change-landed.sh <target> <base> <head> <commit>...
# Exits 0 only when picking the commits onto <target> could land nothing new,
# under Git's merge rules:
# - no commit, picked alone onto <target>, applies cleanly and changes it;
# - the net change <base>..<head>, which carries merge resolutions no commit
#   does, merges into <target> cleanly without changing it;
# - so do the commits replayed in order onto the first one's parent, which
#   carry content main absorbed out of <base>..<head>.
# A commit that conflicts alone is taken as superseded by later ones only
# because the last two hold. 1 means not landed, 2 that the check could not
# run; callers pick on either.
set -u

TARGET="$1"
BASE="$2"
HEAD="$3"
shift 3

could_not_run() {
	echo "::warning::could not check whether $TARGET already contains $BASE..$HEAD, so it will be picked"
	exit 2
}

# 0: clean and leaves TARGET unchanged; 1: conflicts; 3: clean but changes it.
merge_into_target() {
	local merged status
	merged=$(git merge-tree --write-tree --merge-base="$1" "$TARGET" "$2")
	status=$?
	[ "$status" -gt 1 ] && could_not_run
	[ "$status" -eq 1 ] && return 1
	[ "${merged%%$'\n'*}" = "$TARGET_TREE" ] && return 0
	return 3
}

[ "$#" -gt 0 ] || could_not_run
TARGET_TREE=$(git rev-parse --verify --quiet "$TARGET^{tree}") || could_not_run

for COMMIT in "$@"; do
	merge_into_target "$COMMIT^1" "$COMMIT"
	[ "$?" -eq 3 ] && exit 1
done

merge_into_target "$BASE" "$HEAD" || exit 1

FROM="$1^1"
PICKED="$1"
shift
for COMMIT in "$@"; do
	PICKED=$(git merge-tree --write-tree --merge-base="$COMMIT^1" "$PICKED" "$COMMIT")
	case $? in
		0) ;;
		1) exit 1 ;;
		*) could_not_run ;;
	esac
done
merge_into_target "$FROM" "$PICKED" || exit 1
exit 0
