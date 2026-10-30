#!/usr/bin/env bash
# Prints MEMBER on stdout when $2 is a confirmed active member of org $1, using the
# members:read-scoped token in $GH_TOKEN. Prints nothing otherwise — a definitive
# non-member (404) exits immediately with no retry; anything else warns after
# exhausting retries, so a lost permission or a broken installation is loud rather
# than silently reverting to no live check at all.
set -uo pipefail

org=$1
login=$2
[[ "$org" =~ ^[A-Za-z0-9_.-]+$ ]] || exit 0
[[ "$login" =~ ^[A-Za-z0-9_-]+$ ]] || exit 0

err="$(mktemp)"
trap 'rm -f "$err"' EXIT

for attempt in 1 2 3; do
	state=$(gh api "orgs/$org/memberships/$login" --jq '.state' 2>"$err") && {
		[[ "$state" == "active" ]] && echo "MEMBER"
		exit 0
	}
	grep -q "HTTP 404" "$err" && exit 0
	if (( attempt == 3 )); then
		echo "::warning::review-coverage: org membership lookup for $login failed ($(tail -1 "$err"))" >&2
		exit 0
	fi
	sleep "$attempt"
done
