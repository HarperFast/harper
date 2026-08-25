#!/usr/bin/env bash
# Apply a list of commits onto the current branch, classifying each failure.
#
# Usage: apply-picks.sh "<pick-flags>" "<sha> [<sha>...]"
# Prints the SHAs that conflicted, space-separated, on stdout. Exits non-zero
# if a pick failed for a reason that is neither a conflict nor an
# already-applied commit — those must never be dropped silently.
set -euo pipefail

PICK_FLAGS="$1"
PICK_SHAS="$2"
CONFLICTS=""

for SHA in $PICK_SHAS; do
	# shellcheck disable=SC2086
	if git cherry-pick $PICK_FLAGS "$SHA" >&2; then
		continue
	fi

	if [ -n "$(git diff --name-only --diff-filter=U)" ]; then
		CONFLICTS="${CONFLICTS:+$CONFLICTS }$SHA"
		git add -A
		GIT_EDITOR=true git cherry-pick --continue >&2 || git cherry-pick --skip >&2 || true
		if git rev-parse --verify --quiet CHERRY_PICK_HEAD >/dev/null; then
			git cherry-pick --abort 2>/dev/null || true
			echo "::error::cherry-pick sequencer left dirty after $SHA" >&2
			exit 1
		fi
		continue
	fi

	# No unmerged paths. "Already applied" requires proof, not an absence: the
	# sequencer must be stopped on THIS commit (a stale CHERRY_PICK_HEAD from an
	# earlier iteration would otherwise vouch for it) and the index and worktree
	# must match HEAD. Anything else failed before it could apply, and dropping
	# it would fast-forward a partial change onto a release branch.
	PICK_HEAD=$(git rev-parse --verify --quiet CHERRY_PICK_HEAD || true)
	if [ -n "$PICK_HEAD" ] && [ "$PICK_HEAD" = "$(git rev-parse "$SHA")" ] \
		&& git diff --cached --quiet HEAD && git diff --quiet; then
		echo "Commit $SHA is already applied; skipping" >&2
		git cherry-pick --skip >&2
		continue
	fi

	git cherry-pick --abort 2>/dev/null || true
	echo "::error::cherry-pick of $SHA failed before it could apply" >&2
	exit 1
done

echo "$CONFLICTS"
