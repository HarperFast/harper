#!/usr/bin/env bash
# Decide whether a cherry-pick branch's current remote head is "foreign" — not
# something the workflow itself pushed — so callers never reset, force-push,
# or delete over a human's conflict resolution. See branch-guard.js for the
# classification rule and sticky-head.js for where the workflow's last pushed
# SHA is recorded.
#
# Usage: check-branch-foreign.sh <branch> <sticky-marker> <pr-number>
# Prints a single-line JSON object on stdout: {"exists","foreign","reason","head"}.
set -euo pipefail

BRANCH="$1"
MARKER="$2"
PR_NUMBER="$3"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKFLOW_EMAIL="noreply@harperdb.io"

git fetch origin "+refs/heads/${BRANCH}:refs/remotes/origin/${BRANCH}" 2>/dev/null || true

if ! REMOTE_HEAD=$(git rev-parse --verify --quiet "origin/${BRANCH}"); then
	echo '{"exists":false,"foreign":false,"reason":"branch does not exist","head":""}'
	exit 0
fi

RECORDED_HEAD=$(node "$SCRIPT_DIR/upsert-sticky-comment.js" --read-head "$PR_NUMBER" "$MARKER" 2>/dev/null || true)
COMMITTER_EMAIL=$(git log -1 --format=%ae "$REMOTE_HEAD")

RESULT=$(REMOTE_EXISTS=true REMOTE_HEAD="$REMOTE_HEAD" RECORDED_HEAD="$RECORDED_HEAD" \
	COMMITTER_EMAIL="$COMMITTER_EMAIL" WORKFLOW_EMAIL="$WORKFLOW_EMAIL" \
	node "$SCRIPT_DIR/branch-guard.js")

echo "$RESULT" | jq -c --arg head "$REMOTE_HEAD" '. + {exists: true, head: $head}'
