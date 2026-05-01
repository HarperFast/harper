#!/usr/bin/env bash
# Validate that the AI workflow auth gate structure is preserved
# across all `claude-*.yml` workflows. STRUCTURAL lint, not a semantic
# test — catches the obvious attacks (delete the authorize job, drop
# the `needs:` dependency, broaden permissions, change the
# if-expression to a tautology). Subtle attacks (e.g., modifying the
# bash logic inside the auth check to admit everyone) are out of
# scope for this validator and are caught by CODEOWNERS review on
# `.github/` changes.
#
# Defense in depth: branch-protection on `main` should make this
# workflow's job a REQUIRED status check.
#
# Inputs (none — runs in the workflow checkout). Validates:
#   .github/workflows/claude-*.yml
#
# Exit code:
#   0  all workflows pass
#   1  any check failed (errors emitted as ::error::)
set -uo pipefail

fail() {
  echo "::error::$1"
  exit 1
}

# yq is pre-installed on ubuntu-latest runners.
command -v yq >/dev/null || fail "yq not available on runner"

shopt -s nullglob
files=(.github/workflows/claude-*.yml)
if [ "${#files[@]}" -eq 0 ]; then
  echo "No claude-*.yml workflows found; nothing to validate."
  exit 0
fi

for f in "${files[@]}"; do
  echo ""
  echo "=== Validating $f ==="

  # 1. The authorize job exists.
  yq -e '.jobs.authorize' "$f" >/dev/null \
    || fail "$f: missing 'authorize' job"

  # 2. authorize.outputs.authorized is wired to some step output.
  output_expr=$(yq -r '.jobs.authorize.outputs.authorized // ""' "$f")
  [ -n "$output_expr" ] \
    || fail "$f: authorize job has no outputs.authorized"
  echo "$output_expr" | grep -q 'steps\..*\.outputs\.authorized' \
    || fail "$f: authorize.outputs.authorized must come from a step output (got: $output_expr)"

  # 3. authorize uses actions/create-github-app-token (pinned to a SHA).
  app_token_step=$(yq -r '.jobs.authorize.steps[] | select(.uses != null) | .uses' "$f" | grep '^actions/create-github-app-token@' || true)
  [ -n "$app_token_step" ] \
    || fail "$f: authorize doesn't use actions/create-github-app-token"
  echo "$app_token_step" | grep -qE '@[0-9a-f]{40}( |$)' \
    || fail "$f: actions/create-github-app-token must be pinned to a 40-char SHA (got: $app_token_step)"

  # 4. authorize.permissions doesn't grant any write-level scope.
  write_perms=$(yq -r '.jobs.authorize.permissions | (.[] // "") | select(. == "write")' "$f" 2>/dev/null || true)
  [ -z "$write_perms" ] \
    || fail "$f: authorize.permissions grants 'write' on at least one scope — auth job must be read-only"

  # 5. Required secrets are referenced (the auth check can't work without them).
  grep -q 'HARPERFAST_AI_CLIENT_ID' "$f" \
    || fail "$f: HARPERFAST_AI_CLIENT_ID secret not referenced"
  grep -q 'HARPERFAST_AI_APP_PRIVATE_KEY' "$f" \
    || fail "$f: HARPERFAST_AI_APP_PRIVATE_KEY secret not referenced"

  # 6. The authorize job sets USERS_TO_CHECK on at least one of its
  #    steps. The auth script (`authorize-claude-workflow.sh`) fails
  #    closed if USERS_TO_CHECK is empty, but the workflow still
  #    shouldn't ship without it — make the omission a structural
  #    error rather than a silent runtime denial. Defense in depth
  #    against a PR that drops the env var thinking the script will
  #    "do the right thing".
  #
  # NOTE: yq on ubuntu-latest is mikefarah/yq (Go), not jq. It does
  # NOT support jq's `empty` keyword, and an earlier version of this
  # check using `// empty` lexer-erred silently (`2>/dev/null` ate it)
  # and produced a false fail on workflows that DID set the env var.
  # `select(. != null)` is the idiomatic yq filter for "skip steps
  # without this env var"; `head -1` collapses the per-step stream to
  # a single value (or empty).
  users_to_check=$(yq -r '.jobs.authorize.steps[].env.USERS_TO_CHECK | select(. != null)' "$f" 2>/dev/null | head -1)
  [ -n "$users_to_check" ] \
    || fail "$f: authorize job has no step setting USERS_TO_CHECK env var — the auth script needs at least one login to check (PR author, commenter, labeler, etc.)"

  # 7. Every non-authorize job has `needs: authorize` and a strict
  #    if-expression of exactly: needs.authorize.outputs.authorized == 'true'
  #    (whitespace normalized). Stricter than substring match —
  #    rules out tautologies like `... || true`.
  other_jobs=$(yq -r '.jobs | keys | .[]' "$f" | grep -v '^authorize$' || true)
  [ -n "$other_jobs" ] \
    || fail "$f: no non-authorize job found — workflow has nothing gated"

  for j in $other_jobs; do
    needs=$(yq -r ".jobs.${j}.needs // \"\"" "$f")
    [ "$needs" = "authorize" ] \
      || fail "$f: job '$j' must have 'needs: authorize' (got: $needs)"

    if_expr=$(yq -r ".jobs.${j}.if // \"\"" "$f")
    # Normalize whitespace and quotes for the comparison.
    normalized=$(echo "$if_expr" | tr -s ' ' | tr -d "\n")
    expected="needs.authorize.outputs.authorized == 'true'"
    [ "$normalized" = "$expected" ] \
      || fail "$f: job '$j' if: must be exactly \"$expected\" — no compound expressions, no tautologies (got: $if_expr)"
  done

  echo "  ✓ $f passed"
done

echo ""
echo "All claude-*.yml workflows pass auth gate invariants."
