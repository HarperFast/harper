# Harper review styleguide

Harper is a high-performance Node.js database/application platform. `AGENTS.md` at the repo root is the
authority on conventions — when in doubt, defer to it rather than general best practice.

## House style (do not flag these as issues)

- Tests use plain `node:assert` (`import assert from 'node:assert'`). Do NOT recommend Chai/expect, and do
  NOT recommend `node:assert/strict` — plain `assert` is the deliberate house style and `/strict` imports
  are lint-rejected. Use `assert.strictEqual`/`assert.deepStrictEqual` explicitly where strict semantics
  are needed.
- Formatting is Prettier-enforced: tabs for indentation, semicolons. Never comment on formatting.
- TypeScript runs via Node type stripping (TypeStrip), so: no TS `enum`s, no constructor parameter
  properties, relative imports must include the file extension, and Node builtins use the `node:` prefix.
  These are constraints, not style choices.
- `== null` / `!= null` loose equality is the intentional idiom for null-or-undefined checks. Do not
  suggest `===` there.
- Circular imports between modules are acceptable in this codebase by design; do not flag them.
- New npm dependencies require explicit justification (`dependencies.md`); implementing in-repo is often
  preferred. Flag new dependencies, don't suggest adding them.
- Use named exports only; no default exports in new code.

## Review discipline

- Before asserting that a function, method, guard, or API "does not exist" or "is never handled", verify
  by reading the relevant file(s) in this repo. If you cannot verify, phrase it as a question, not a finding.
- State each distinct finding exactly once, with a list of all affected locations. Never repeat the same
  comment on multiple similar hunks.
- Only review code changed in this PR. No findings on pre-existing/unchanged lines, and ignore artifacts
  of rebases/merges that are not authored changes.
- Severity honesty: `critical`/`high` requires a concrete failure scenario (specific input or sequence →
  wrong outcome) stated in the comment. Cosmetic, by-design, or test-only observations are `low` at most.
- Performance is a feature here. Do flag hot-path allocations, unnecessary async/await layers, and
  per-request work that could be hoisted. Do NOT suggest defensive try/catch, extra validation layers, or
  cloning on hot paths without evidence of an actual failure mode.

## Threat model

App developers deploying code to Harper are trusted administrators; there is no untrusted multi-tenant
code execution, and deployment is containerized (Docker/Fabric). Do not raise sandbox-escape,
"malicious plugin", or intra-process isolation concerns that assume untrusted application code. Real
security findings (authn/authz bypass on network-facing surfaces, injection from external input) are
still in scope.
