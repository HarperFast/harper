'use strict';

const assert = require('node:assert');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { stripVTControlCharacters } = require('node:util');
const { ACTIONS_POLICY_DOCS, previewSetup, starterPreviewWorkflow } = require('#src/bin/previewSetup');
const { prompts } = require('#src/utility/interactivePrompts');
const cliOperationsModule = require('#js/bin/cliOperations');

const TARGET = 'https://cluster.example.com:9925/';
const WORKFLOW = path.join('.github', 'workflows', 'preview.yaml');

describe('harper preview setup (harper#3609)', () => {
	const saved = {};
	let directory;
	let cwd;
	let operations;

	const enabled = () => operations.some((request) => request.operation === 'enable_previews');
	const workflowPresent = () =>
		fs.stat(path.join(directory, WORKFLOW)).then(
			() => true,
			() => false
		);
	const setup = (extra = {}) =>
		previewSetup({ app: 'shop', repo: 'acme/shop', repository_id: '67890', write_workflow: true, ...extra });
	const repository = JSON.stringify({
		id: 67890,
		full_name: 'acme/shop',
		default_branch: 'main',
		private: true,
		permissions: { push: true },
	});
	const writeGh = (variable, repositoryAnswer = `echo '${repository}'`) =>
		fs.writeFile(
			path.join(directory, 'bin', 'gh'),
			`#!/bin/sh\ncase "$*" in\n  auth*) exit 1 ;;\n  *actions/variables*) ${variable} ;;\n  *) ${repositoryAnswer} ;;\nesac\n`,
			{ mode: 0o755 }
		);
	const absentVariable = 'echo "gh: Not Found (HTTP 404)" >&2; exit 1';

	beforeEach(async () => {
		directory = await fs.mkdtemp(path.join(os.tmpdir(), 'preview-setup-'));
		await fs.mkdir(path.join(directory, 'bin'));
		await writeGh(absentVariable);
		cwd = process.cwd();
		process.chdir(directory);
		Object.assign(saved, {
			cliOperations: cliOperationsModule.cliOperations,
			password: prompts.password,
			PATH: process.env.PATH,
			GITHUB_REPOSITORY: process.env.GITHUB_REPOSITORY,
			log: console.log,
			fetch: globalThis.fetch,
		});
		globalThis.fetch = async () => {
			throw new Error('offline');
		};
		process.env.PATH = `${path.join(directory, 'bin')}${path.delimiter}${process.env.PATH}`;
		process.env.GITHUB_REPOSITORY = 'acme/shop';
		console.log = () => {};
		operations = [];
		cliOperationsModule.cliOperations = async (request) => {
			operations.push(request);
			if (request.operation === 'get_preview_policy') return { resolvedTarget: TARGET };
			if (request.operation === 'enable_previews') return { message: 'created' };
			return { public_key: 'not used', fingerprint: 'not used' };
		};
	});

	afterEach(async () => {
		cliOperationsModule.cliOperations = saved.cliOperations;
		prompts.password = saved.password;
		process.env.PATH = saved.PATH;
		console.log = saved.log;
		globalThis.fetch = saved.fetch;
		if (saved.GITHUB_REPOSITORY === undefined) delete process.env.GITHUB_REPOSITORY;
		else process.env.GITHUB_REPOSITORY = saved.GITHUB_REPOSITORY;
		process.chdir(cwd);
		await fs.rm(directory, { recursive: true, force: true });
	});

	it('refuses, changing nothing, when the variable already names another cluster', async () => {
		await writeGh('echo https://other.example.com:9925/');
		await assert.rejects(setup(), /HARPER_PREVIEW_TARGET variable on acme\/shop is .*Nothing was changed/s);
		assert.strictEqual(enabled(), false);
		assert.strictEqual(await workflowPresent(), false);
	});

	it('refuses, changing nothing, when it cannot read the variable, unless told to go on', async () => {
		await writeGh('echo "gh: To get started, please run: gh auth login" >&2; exit 4');
		await assert.rejects(setup(), /could not read the HARPER_PREVIEW_TARGET variable.*allow_unverified=true/s);
		assert.strictEqual(enabled(), false);
		assert.strictEqual(await workflowPresent(), false);

		await assert.rejects(setup({ allow_unverified: true }), /repository variable was not set/);
		assert.strictEqual(enabled(), true);
	});

	it('does not take a 404 for an absent variable on a repository it could not see', async () => {
		await writeGh(absentVariable, absentVariable);
		await assert.rejects(setup(), /could not read the HARPER_PREVIEW_TARGET variable on acme\/shop/);
		assert.strictEqual(enabled(), false);
	});

	it('does not take a 404 for an absent variable when the account cannot push to the repository', async () => {
		await writeGh(absentVariable, `echo '${repository.replace('"push":true', '"push":false')}'`);
		await assert.rejects(setup(), /only to an account that can push to acme\/shop/);
		assert.strictEqual(enabled(), false);
	});

	it('refuses before it asks for a token when the variable names another cluster', async () => {
		await writeGh('echo https://other.example.com:9925/');
		let asked = false;
		prompts.password = async () => {
			asked = true;
			return 'a-token';
		};
		await assert.rejects(setup({ credential: true }), /Nothing was changed/);
		assert.strictEqual(asked, false);
	});

	it('asks for the credential before it enables anything', async () => {
		prompts.password = async () => {
			throw new Error('cancelled');
		};
		await assert.rejects(setup({ credential: true }), /cancelled/);
		assert.strictEqual(enabled(), false);
		assert.strictEqual(await workflowPresent(), false);
	});

	it('stops before it enables anything when it cannot write the workflow', async () => {
		await fs.writeFile(path.join(directory, '.github'), 'a file where the directory should be');
		await assert.rejects(setup(), /Cannot write \.github\/workflows\/preview\.yaml: .*Nothing was changed/);
		assert.strictEqual(enabled(), false);
	});

	it('stops before it enables anything when the workflow file appeared while it asked', async () => {
		prompts.password = async () => {
			await fs.mkdir(path.dirname(path.join(directory, WORKFLOW)), { recursive: true });
			await fs.writeFile(path.join(directory, WORKFLOW), 'someone else wrote this\n');
			return 'a-token';
		};
		await assert.rejects(setup({ credential: true }), /appeared while setup ran.*Nothing was changed/);
		assert.strictEqual(enabled(), false);
		assert.strictEqual(await fs.readFile(path.join(directory, WORKFLOW), 'utf8'), 'someone else wrote this\n');
	});

	describe('the pull_request_target event policy GitHub requires of a public repository', () => {
		let output;
		const printed = () => output.join('\n');
		const visibility = (value) => {
			const parsed = JSON.parse(repository);
			if (value === undefined) delete parsed.private;
			else parsed.private = value;
			return `echo '${JSON.stringify(parsed)}'`;
		};
		const writeGhFor = (repositoryAnswer, { create = 'exit 0', variable = absentVariable } = {}) =>
			fs.writeFile(
				path.join(directory, 'bin', 'gh'),
				`#!/bin/sh\ncase "$*" in\n  auth*) exit 1 ;;\n  *POST*) ${create} ;;\n` +
					`  *actions/variables*) ${variable} ;;\n  *) ${repositoryAnswer} ;;\nesac\n`,
				{ mode: 0o755 }
			);

		beforeEach(() => {
			output = [];
			console.log = (...parts) => output.push(stripVTControlCharacters(parts.join(' ')));
		});

		it('names the workflow, where to allow it, and the guide, before anything can stop setup', async () => {
			await writeGhFor(visibility(false));
			await setup();
			const text = printed();
			assert.match(text, /acme\/shop is public: from December 2, 2026, GitHub Actions blocks pull_request_target/);
			assert.match(
				text,
				/repository's Settings > Actions > Policies, make sure an Active policy targets only \.github\/workflows\/preview\.yaml and its Restrict events allows pull_request_target.*An organization policy for it must target acme\/shop too/
			);
			assert.ok(text.includes(ACTIONS_POLICY_DOCS));
			assert.ok(text.indexOf('is public') < text.indexOf('can deploy previews of shop'));
			assert.match(
				await fs.readFile(path.join(directory, WORKFLOW), 'utf8'),
				/^# In a public repository, pull_request_target runs only if an Actions event policy targeting this repository and this file allows it\. https:\/\/docs\.github\.com\/actions\/how-tos\/administer\/control-workflow-execution$/m
			);
		});

		it('names a workflow that was already there', async () => {
			const custom = path.join('.github', 'workflows', 'pr.yml');
			await fs.mkdir(path.dirname(path.join(directory, custom)), { recursive: true });
			await fs.writeFile(path.join(directory, custom), starterPreviewWorkflow({ app: 'shop', branch: 'main' }));
			await writeGhFor(visibility(false));
			await setup({ workflow: '.github/workflows/pr.yml', write_workflow: undefined });
			assert.match(printed(), /targets only \.github\/workflows\/pr\.yml and/);
		});

		it('is worded as conditional when the repository visibility is unknown', async () => {
			await writeGhFor(visibility(undefined));
			await setup();
			assert.match(printed(), /If acme\/shop is public: from December 2, 2026/);
		});

		it('says nothing for a private or internal repository, which GitHub does not block', async () => {
			await writeGhFor(visibility(true));
			await setup();
			assert.doesNotMatch(printed(), /pull_request_target in public repositories/);
			const internal = JSON.parse(repository);
			internal.private = false;
			internal.visibility = 'internal';
			await fs.rm(path.join(directory, WORKFLOW));
			await writeGhFor(`echo '${JSON.stringify(internal)}'`);
			await setup();
			assert.doesNotMatch(printed(), /pull_request_target in public repositories/);
		});

		it('is printed even when setting the repository variable fails afterwards', async () => {
			await writeGhFor(visibility(false), { create: 'echo "gh: HTTP 403" >&2; exit 1' });
			await assert.rejects(setup(), /repository variable was not set/);
			assert.match(printed(), /acme\/shop is public/);
		});

		it('is printed when setup stops at the repository variable, before it enables anything', async () => {
			await writeGhFor(visibility(false), { variable: 'echo https://other.example.com:9925/' });
			await assert.rejects(setup(), /Nothing was changed/);
			assert.strictEqual(enabled(), false);
			assert.match(printed(), /acme\/shop is public/);
		});
	});
});
