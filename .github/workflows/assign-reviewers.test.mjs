import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { parse } from 'yaml';

const workflow = parse(readFileSync(new URL('./assign-reviewers.yml', import.meta.url), 'utf8'));
const step = workflow.jobs.assign.steps.find(({ name }) => name === 'Assign default reviewers if none set');

// Stands in for POST /repos/{repo}/pulls/{n}/requested_reviewers, in either the `-f reviewers[]=`
// or the `--input -` JSON form. Like GitHub, it rejects a request naming any non-collaborator
// whole, with a 422, so nobody in that request is requested.
const GH_STUB = `#!/usr/bin/env bash
echo "$*" >> "$GH_STUB_CALLS"
reviewers=()
while [ $# -gt 0 ]; do
  case "$1" in
    -f) shift; reviewers+=("\${1#*=}") ;;
    --input) shift; while read -r reviewer; do reviewers+=("$reviewer"); done < <(jq -r '.reviewers[]') ;;
  esac
  shift
done
for reviewer in "\${reviewers[@]}"; do
  case " $GH_STUB_NON_COLLABORATORS " in
    *" $reviewer "*) echo "gh: Reviews may only be requested from collaborators. (HTTP 422)" >&2; exit 1 ;;
  esac
done
printf '%s\\n' "\${reviewers[@]}" >> "$GH_STUB_REQUESTED"
`;

function lines(file) {
	return readFileSync(file, 'utf8').split('\n').filter(Boolean);
}

function run({ author = 'someone', nonCollaborators = [], reviewersJson = '[]', teamsJson = '[]' } = {}) {
	assert.ok(step?.run, 'the assign job no longer has the step this test runs');
	const dir = mkdtempSync(path.join(tmpdir(), 'assign-reviewers-'));
	writeFileSync(path.join(dir, 'gh'), GH_STUB);
	chmodSync(path.join(dir, 'gh'), 0o755);
	const script = path.join(dir, 'step.sh');
	writeFileSync(script, step.run);
	const requestedFile = path.join(dir, 'requested');
	const callsFile = path.join(dir, 'calls');
	writeFileSync(requestedFile, '');
	writeFileSync(callsFile, '');
	// `bash -e` is what Actions runs a `run:` step with when the step names no `shell:`.
	const result = spawnSync('bash', ['-e', script], {
		encoding: 'utf8',
		env: {
			...process.env,
			PATH: `${dir}${path.delimiter}${process.env.PATH}`,
			GH_TOKEN: 'unused',
			REVIEWERS_JSON: reviewersJson,
			TEAMS_JSON: teamsJson,
			PR_NUMBER: '1',
			REPO: 'HarperFast/harper',
			PR_AUTHOR: author,
			GH_STUB_NON_COLLABORATORS: nonCollaborators.join(' '),
			GH_STUB_REQUESTED: requestedFile,
			GH_STUB_CALLS: callsFile,
		},
	});
	return { ...result, requested: lines(requestedFile), calls: lines(callsFile).length };
}

test('a default reviewer who lost access does not stop the others being requested', () => {
	const everyone = run().requested;
	assert.ok(everyone.length > 1, `needs at least two default reviewers, got ${everyone}`);
	const [stale, ...rest] = everyone;
	const result = run({ nonCollaborators: [stale] });
	assert.strictEqual(result.status, 0, result.stdout + result.stderr);
	assert.deepStrictEqual(result.requested, rest);
	assert.match(result.stdout, new RegExp(`::warning::Could not request a review from ${stale};`));
});

test('the job fails when none of the default reviewers can be requested', () => {
	const everyone = run().requested;
	const result = run({ nonCollaborators: everyone });
	assert.notStrictEqual(result.status, 0);
	assert.deepStrictEqual(result.requested, []);
	assert.match(result.stdout, /::error::None of the default reviewers could be requested/);
});

test('the PR author is not requested as a reviewer of their own PR', () => {
	const [author, ...rest] = run().requested;
	const result = run({ author });
	assert.strictEqual(result.status, 0, result.stdout + result.stderr);
	assert.deepStrictEqual(result.requested, rest);
});

test('a PR that already has a reviewer or team requested is left alone', () => {
	for (const options of [{ reviewersJson: '[{"login":"someone-else"}]' }, { teamsJson: '[{"slug":"developers"}]' }]) {
		const result = run(options);
		assert.strictEqual(result.status, 0, result.stdout + result.stderr);
		assert.strictEqual(result.calls, 0);
	}
});
