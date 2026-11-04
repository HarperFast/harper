import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('./resolveMembership.sh', import.meta.url));

// A stub `gh` on PATH stands in for the real CLI, so these tests exercise the actual shell
// parsing/retry/warning logic end to end rather than asserting on the script's source text.
const STUB = `#!/usr/bin/env bash
printf 'x' >> "$GH_STUB_CALLS"
case "$GH_STUB_MODE" in
  active) echo "active"; exit 0 ;;
  notfound) echo "gh: Not Found (HTTP 404)" >&2; exit 1 ;;
  forbidden) echo "gh: Resource not accessible by integration (HTTP 403)" >&2; exit 1 ;;
  *) exit 1 ;;
esac
`;

function run(mode, org = 'HarperFast', login = 'someone') {
	const dir = mkdtempSync(path.join(tmpdir(), 'resolve-membership-'));
	const stubPath = path.join(dir, 'gh');
	writeFileSync(stubPath, STUB);
	chmodSync(stubPath, 0o755);
	const callsFile = path.join(dir, 'calls');
	writeFileSync(callsFile, '');
	const result = spawnSync(SCRIPT, [org, login], {
		encoding: 'utf8',
		env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, GH_STUB_MODE: mode, GH_STUB_CALLS: callsFile },
	});
	return { ...result, calls: readFileSync(callsFile, 'utf8').length };
}

test('an active membership prints MEMBER', () => {
	const result = run('active');
	assert.strictEqual(result.status, 0);
	assert.strictEqual(result.stdout.trim(), 'MEMBER');
	assert.strictEqual(result.calls, 1);
});

test('a 404 prints nothing and does not retry', () => {
	const result = run('notfound');
	assert.strictEqual(result.status, 0);
	assert.strictEqual(result.stdout.trim(), '');
	assert.strictEqual(result.calls, 1, 'a confirmed non-member is not worth retrying');
});

test('a persistent non-404 failure retries, then warns instead of going silent', () => {
	const result = run('forbidden');
	assert.strictEqual(result.status, 0, 'still exits clean — a lookup failure never breaks the job');
	assert.strictEqual(result.stdout.trim(), '');
	assert.strictEqual(result.calls, 3, 'exhausts retries rather than giving up after one 403');
	assert.match(result.stderr, /::warning::review-coverage: org membership lookup for someone failed/);
});

test('an org or login outside the expected character set is refused before any gh call', () => {
	for (const [org, login] of [
		['HarperFast; rm -rf /', 'someone'],
		['HarperFast', 'some one'],
	]) {
		const result = run('active', org, login);
		assert.strictEqual(result.status, 0);
		assert.strictEqual(result.stdout.trim(), '');
		assert.strictEqual(result.calls, 0, `${org}/${login} must not reach gh`);
	}
});
