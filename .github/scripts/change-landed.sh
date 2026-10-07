#!/usr/bin/env bash
# Usage: change-landed.sh <target> <base> <head> <commit>...
# Exits 0 only when picking the commits onto <target> would leave it unchanged
# under Git's merge rules. Two merges into <target> must each be clean and
# leave its tree as it was: the net change <base>..<head>, which carries merge
# resolutions no commit does, and the commits replayed in order onto the first
# one's parent, which carries content main absorbed out of <base>..<head>.
# 1 means not landed, 2 that the check could not run; callers pick on either.
set -u

TARGET="$1"
BASE="$2"
HEAD="$3"
shift 3

could_not_run() {
	echo "::warning::could not check whether $TARGET already contains $BASE..$HEAD, so it will be picked"
	exit 2
}

require_landed() {
	local merged status
	merged=$(git merge-tree --write-tree --merge-base="$1" "$TARGET" "$2")
	status=$?
	[ "$status" -gt 1 ] && could_not_run
	[ "$status" -eq 0 ] && [ "${merged%%$'\n'*}" = "$(git rev-parse "$TARGET^{tree}")" ] || exit 1
}

[ "$#" -gt 0 ] || could_not_run
require_landed "$BASE" "$HEAD"

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
require_landed "$FROM" "$PICKED"
exit 0
