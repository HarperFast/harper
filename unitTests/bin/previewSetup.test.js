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
		const POLICY_NAME = 'Allow Harper previews (preview.yaml)';
		let output;
		let savedTTY;
		let savedInput;
		const printed = () => output.join('\n');
		const file = (name) => path.join(directory, name);
		const ghCalls = async () =>
			(await fs.readFile(file('gh.log'), 'utf8').catch(() => '')).split('\n').filter((line) => line.length > 0);
		const policyCalls = async () => (await ghCalls()).filter((call) => call.includes('actions/policies'));
		const posted = async () => JSON.parse(await fs.readFile(file('posted.json'), 'utf8'));
		const wasPosted = () =>
			fs.stat(file('posted.json')).then(
				() => true,
				() => false
			);
		const publicRepository = (permissions = { push: true, admin: true }) => ({
			...JSON.parse(repository),
			private: false,
			visibility: 'public',
			permissions,
		});
		const policyList = (policies, total = policies.length) => ({ total_count: total, policies });
		const policy = (overrides = {}) => ({
			id: 1,
			name: 'Previews',
			source_type: 'Repository',
			source: 'acme/shop',
			enforcement: 'active',
			conditions: { workflow_path: { include: ['.github/workflows/preview.yaml'], exclude: [] } },
			rules: [{ type: 'restrict_action_events', parameters: { allowed_events: ['pull_request_target'] } }],
			...overrides,
		});
		const notFound = 'echo "gh: Not Found (HTTP 404)" >&2; exit 1';
		const forbidden = 'echo "gh: Must have admin rights to Repository. (HTTP 403)" >&2; exit 1';
		/**
		 * A `gh` that records each call and answers from files, so a test sets an answer by writing JSON, or with
		 * `{ script }` a shell command. `auth` fails, as with no login, or a token lookup would wait on a prompt.
		 */
		async function fakeGh({
			repositoryAnswer = publicRepository(),
			list = policyList([]),
			page2,
			contents,
			create = 'echo \'{"id":7}\'',
			variable = absentVariable,
			variableCreate = 'exit 0',
		} = {}) {
			const answers = { repository: repositoryAnswer, list, page2, contents };
			for (const [name, value] of Object.entries(answers)) {
				if (value === undefined || value.script) continue;
				await fs.writeFile(file(`${name}.answer`), typeof value === 'string' ? value : JSON.stringify(value));
			}
			const answer = (name, fallback) =>
				answers[name] === undefined ? fallback : (answers[name].script ?? `cat '${file(`${name}.answer`)}'`);
			await fs.writeFile(
				path.join(directory, 'bin', 'gh'),
				`#!/bin/sh\nprintf '%s\\n' "$*" >> '${file('gh.log')}'\ncase "$*" in\n` +
					'  auth*) exit 1 ;;\n' +
					`  *POST*actions/policies*) cat > '${file('posted.json')}'; ${create} ;;\n` +
					`  *actions/policies*page=2*) ${answer('page2', notFound)} ;;\n` +
					`  *actions/policies*) ${answer('list', notFound)} ;;\n` +
					`  *contents/*) ${answer('contents', notFound)} ;;\n` +
					`  *POST*) ${variableCreate} ;;\n` +
					`  *actions/variables*) ${variable} ;;\n` +
					`  *) ${answer('repository', notFound)} ;;\n` +
					'esac\n',
				{ mode: 0o755 }
			);
		}
		const setInteractive = (value) =>
			Object.defineProperty(process.stdin, 'isTTY', { value, configurable: true, writable: true });
		const dispatchWorkflow = () =>
			starterPreviewWorkflow({ app: 'shop', branch: 'main' }).replace('\non:\n', '\non:\n  workflow_dispatch:\n');
		const writeCheckoutWorkflow = async (content) => {
			await fs.mkdir(path.dirname(path.join(directory, WORKFLOW)), { recursive: true });
			await fs.writeFile(path.join(directory, WORKFLOW), content);
		};

		beforeEach(async () => {
			output = [];
			console.log = (...parts) => output.push(stripVTControlCharacters(parts.join(' ')));
			savedTTY = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
			savedInput = prompts.input;
			setInteractive(false);
			await fakeGh();
		});

		afterEach(() => {
			prompts.input = savedInput;
			if (savedTTY) Object.defineProperty(process.stdin, 'isTTY', savedTTY);
			else delete process.stdin.isTTY;
		});

		it('creates one for the starter workflow, allowing pull_request_target, once the cluster part is done', async () => {
			await setup({ actions_policy: true });
			assert.deepStrictEqual(await posted(), {
				name: POLICY_NAME,
				enforcement: 'active',
				conditions: { workflow_path: { include: ['.github/workflows/preview.yaml'], exclude: [] } },
				rules: [{ type: 'restrict_action_events', parameters: { allowed_events: ['pull_request_target'] } }],
			});
			const create = (await policyCalls()).find((call) => call.includes('POST'));
			assert.match(
				create,
				/--hostname github\.com .*X-GitHub-Api-Version: 2026-03-10 .*repos\/acme\/shop\/actions\/policies/
			);
			const text = printed();
			assert.match(
				text,
				/✓ Created the Actions event policy "Allow Harper previews \(preview\.yaml\)" on acme\/shop: only pull_request_target can start \.github\/workflows\/preview\.yaml\./
			);
			assert.match(text, /organization or enterprise policy can still block it: Policy insights/);
			assert.ok(text.indexOf('can deploy previews of shop') < text.indexOf('Created the Actions event policy'));
			assert.ok(text.indexOf('Created the Actions event policy') < text.indexOf('Set the HARPER_PREVIEW_TARGET'));
		});

		it('allows every event the workflow runs on, read from the default branch', async () => {
			await writeCheckoutWorkflow(dispatchWorkflow());
			await fakeGh({ contents: dispatchWorkflow() });
			await setup({ write_workflow: undefined, actions_policy: true });
			assert.deepStrictEqual((await posted()).rules[0].parameters.allowed_events, [
				'workflow_dispatch',
				'pull_request_target',
			]);
			assert.ok((await ghCalls()).some((call) => /contents\/\.github\/workflows\/preview\.yaml\?ref=main/.test(call)));
		});

		it('creates none when the default branch runs the workflow on other events than this checkout', async () => {
			await writeCheckoutWorkflow(starterPreviewWorkflow({ app: 'shop', branch: 'main' }));
			await fakeGh({ contents: dispatchWorkflow() });
			await setup({ write_workflow: undefined, actions_policy: true });
			assert.strictEqual(await wasPosted(), false);
			assert.match(
				printed(),
				/preview\.yaml on main runs on workflow_dispatch, pull_request_target, and the copy here on pull_request_target\. Commit this copy to main, then run setup again\./
			);
			assert.doesNotMatch(printed(), /printf/);
			assert.strictEqual(enabled(), true);
		});

		it('changes nothing when an Active policy already allows the event, and names any event it leaves out', async () => {
			await writeCheckoutWorkflow(dispatchWorkflow());
			await fakeGh({ contents: dispatchWorkflow(), list: policyList([policy({ name: 'Allow Harper previews' })]) });
			await setup({ write_workflow: undefined, actions_policy: true });
			assert.strictEqual(await wasPosted(), false);
			assert.match(
				printed(),
				/✓ The Actions event policy "Allow Harper previews" on acme\/shop already allows pull_request_target for \.github\/workflows\/preview\.yaml\./
			);
			assert.match(printed(), /It leaves out workflow_dispatch, which \.github\/workflows\/preview\.yaml also runs on/);
		});

		it('leaves a disabled policy for the file, or one that leaves the event out, as it is and says what to change', async () => {
			await fakeGh({ list: policyList([policy({ enforcement: 'disabled' })]) });
			await setup({ actions_policy: true });
			assert.match(
				printed(),
				/Setup created no policy:\n {2}- Policy "Previews" targets \.github\/workflows\/preview\.yaml but is disabled, so it allows nothing\. Make it Active with pull_request_target among its allowed events, or delete it and run setup again\./
			);

			output.length = 0;
			await fs.rm(path.join(directory, WORKFLOW));
			const allWorkflows = { workflow_path: { include: [], exclude: [] } };
			const pushOnly = [{ type: 'restrict_action_events', parameters: { allowed_events: ['push'] } }];
			await fakeGh({ list: policyList([policy({ conditions: allWorkflows, rules: pushOnly })]) });
			await setup({ actions_policy: true });
			assert.match(
				printed(),
				/Policy "Previews" is Active for \.github\/workflows\/preview\.yaml, and its Restrict events leaves out pull_request_target: add pull_request_target to its allowed events, or exclude \.github\/workflows\/preview\.yaml from it\./
			);
			assert.strictEqual(await wasPosted(), false);
			assert.ok((await policyCalls()).every((call) => !/POST|PUT|PATCH|DELETE/.test(call)));
		});

		it("names an organization policy that blocks the event, through a pattern, and leaves it to the organization's owner", async () => {
			const organization = policy({
				source_type: 'Organization',
				source: 'acme',
				conditions: { workflow_path: { include: ['**/preview.yaml'], exclude: [] } },
				rules: [{ type: 'restrict_action_events', parameters: { allowed_events: ['push'] } }],
			});
			await fakeGh({ list: policyList([organization]) });
			await setup({ actions_policy: true });
			assert.strictEqual(await wasPosted(), false);
			assert.match(
				printed(),
				/The organization policy "Previews" \(acme\) is Active for \.github\/workflows\/preview\.yaml, and its Restrict events leaves out pull_request_target: its owner has to allow pull_request_target for acme\/shop and \.github\/workflows\/preview\.yaml\./
			);
		});

		it('reads every page of policies before it decides', async () => {
			const unrelated = Array.from({ length: 100 }, (_, index) =>
				policy({
					id: index + 2,
					conditions: { workflow_path: { include: [`.github/workflows/other-${index}.yaml`], exclude: [] } },
				})
			);
			const blocking = policy({
				rules: [{ type: 'restrict_action_events', parameters: { allowed_events: ['push'] } }],
			});
			await fakeGh({ list: policyList(unrelated, 101), page2: policyList([blocking], 101) });
			await setup({ actions_policy: true });
			assert.strictEqual(await wasPosted(), false);
			assert.match(printed(), /leaves out pull_request_target: add pull_request_target to its allowed events\./);
		});

		it('creates none when an Active policy that covers the file comes without its rules', async () => {
			const { rules, ...withoutRules } = policy({ name: 'Mystery' });
			assert.ok(rules);
			await fakeGh({ list: policyList([withoutRules]) });
			await setup({ actions_policy: true });
			assert.strictEqual(await wasPosted(), false);
			assert.match(printed(), /Setup created none: GitHub did not list the rules of policy "Mystery"\./);
		});

		it('falls back to the steps and the command when GitHub refuses, without failing setup', async () => {
			await fakeGh({ list: { script: forbidden } });
			await setup({ actions_policy: true });
			let text = printed();
			assert.match(
				text,
				/acme\/shop is public: .*Setup could not read its Actions policies \(gh: Must have admin rights to Repository\. \(HTTP 403\), which GitHub answers to an account that is not an admin of the repository\), so it created none\./
			);
			assert.match(text, /make sure an Active policy targets only \.github\/workflows\/preview\.yaml/);
			assert.ok(text.includes(ACTIONS_POLICY_DOCS));
			assert.ok(
				text.includes(
					`printf '%s' '${JSON.stringify({
						name: POLICY_NAME,
						enforcement: 'active',
						conditions: { workflow_path: { include: ['.github/workflows/preview.yaml'], exclude: [] } },
						rules: [{ type: 'restrict_action_events', parameters: { allowed_events: ['pull_request_target'] } }],
					})}' | gh api --hostname github.com --method POST -H 'X-GitHub-Api-Version: 2026-03-10' repos/acme/shop/actions/policies --input -`
				)
			);
			assert.match(text, /Set the HARPER_PREVIEW_TARGET variable on acme\/shop/);

			output.length = 0;
			await fs.rm(path.join(directory, WORKFLOW));
			await fakeGh({ create: forbidden });
			await setup({ actions_policy: true });
			text = printed();
			assert.ok(await wasPosted());
			assert.match(text, /Setup could not create the policy \(gh: Must have admin rights to Repository\. \(HTTP 403\)/);
			assert.match(text, /Or, as an admin of acme\/shop:\n {2}printf '%s' /);
			assert.match(text, /Set the HARPER_PREVIEW_TARGET variable on acme\/shop/);
		});

		it('reports a policy a failed request created rather than asking for another', async () => {
			const allowing = file('allowing.answer');
			await fs.writeFile(allowing, JSON.stringify(policyList([policy({ name: POLICY_NAME })])));
			await fakeGh({ create: 'echo "gh: context deadline exceeded" >&2; exit 1' });
			const script = await fs.readFile(path.join(directory, 'bin', 'gh'), 'utf8');
			await fs.writeFile(
				path.join(directory, 'bin', 'gh'),
				script.replace(
					/(\*actions\/policies\*\) )cat '[^']*'/,
					`$1if [ -f '${file('posted.json')}' ]; then cat '${allowing}'; else cat '${file('list.answer')}'; fi`
				)
			);
			await setup({ actions_policy: true });
			assert.match(
				printed(),
				/✓ The Actions event policy "Allow Harper previews \(preview\.yaml\)" on acme\/shop already allows/
			);
			assert.doesNotMatch(printed(), /could not create/);
		});

		it('does not read or create a policy for a private repository', async () => {
			await fakeGh({ repositoryAnswer: { ...publicRepository(), private: true, visibility: 'private' } });
			await setup({ actions_policy: true });
			assert.deepStrictEqual(await policyCalls(), []);
			assert.ok((await ghCalls()).every((call) => !call.includes('contents/')));
			assert.doesNotMatch(printed(), /Actions event policy|is public/);
		});

		it('prints only the command when not interactive and not told to create it', async () => {
			await setup();
			const text = printed();
			assert.strictEqual(await wasPosted(), false);
			assert.match(text, /acme\/shop is public: from December 2, 2026, GitHub Actions blocks pull_request_target/);
			assert.match(text, /Setup creates the policy with actions_policy=true\./);
			assert.match(text, /\| gh api --hostname github\.com --method POST/);
			assert.ok(text.indexOf('is public') < text.indexOf('can deploy previews of shop'));
		});

		it('asks once when interactive, yes by default, and a no prints the command', async () => {
			setInteractive(true);
			const asked = [];
			prompts.input = async (config) => {
				asked.push(config);
				return 'yes';
			};
			await setup();
			assert.strictEqual(asked.length, 1);
			assert.strictEqual(asked[0].default, 'yes');
			assert.match(asked[0].message, /lets only pull_request_target start \.github\/workflows\/preview\.yaml\?$/);
			assert.ok(await wasPosted());

			output.length = 0;
			await fs.rm(file('posted.json'));
			await fs.rm(path.join(directory, WORKFLOW));
			prompts.input = async () => 'no';
			await setup();
			assert.strictEqual(await wasPosted(), false);
			assert.match(printed(), /Setup did not create one\.[\s\S]*printf '%s' /);
		});

		it('does not ask an account that is not an admin', async () => {
			setInteractive(true);
			let asked = false;
			prompts.input = async () => {
				asked = true;
				return 'yes';
			};
			await fakeGh({ repositoryAnswer: publicRepository({ push: true, admin: false }) });
			await setup();
			assert.strictEqual(asked, false);
			assert.strictEqual(await wasPosted(), false);
			assert.match(printed(), /the gh account is not an admin of acme\/shop, which a policy takes/);
		});

		it('creates none for a workflow file name a policy would read as a pattern', async () => {
			await setup({ workflow: '.github/workflows/preview+.yaml', actions_policy: true });
			assert.strictEqual(await wasPosted(), false);
			assert.match(printed(), /a policy reads \.github\/workflows\/preview\+\.yaml as a pattern/);
		});

		it('keeps the conditional steps, and reads no policy, when the repository visibility is unknown', async () => {
			const unknown = publicRepository();
			delete unknown.visibility;
			await fakeGh({ repositoryAnswer: unknown });
			await setup({ actions_policy: true });
			assert.match(printed(), /If acme\/shop is public: from December 2, 2026/);
			assert.match(printed(), /targets only \.github\/workflows\/preview\.yaml and its Restrict events/);
			assert.deepStrictEqual(await policyCalls(), []);
		});

		it('names a workflow that was already there', async () => {
			const custom = path.join('.github', 'workflows', 'pr.yml');
			await fs.mkdir(path.dirname(path.join(directory, custom)), { recursive: true });
			await fs.writeFile(path.join(directory, custom), starterPreviewWorkflow({ app: 'shop', branch: 'main' }));
			await setup({ workflow: '.github/workflows/pr.yml', write_workflow: undefined, actions_policy: true });
			assert.strictEqual((await posted()).name, 'Allow Harper previews (pr.yml)');
			assert.deepStrictEqual((await posted()).conditions.workflow_path.include, ['.github/workflows/pr.yml']);
		});

		it('says nothing for an internal repository, which GitHub does not block', async () => {
			await fakeGh({ repositoryAnswer: { ...publicRepository(), private: false, visibility: 'internal' } });
			await setup();
			assert.doesNotMatch(printed(), /pull_request_target in public repositories/);
			assert.deepStrictEqual(await policyCalls(), []);
		});

		it('is created before the repository variable, so a variable that fails afterwards does not skip it', async () => {
			await fakeGh({ variableCreate: 'echo "gh: HTTP 403" >&2; exit 1' });
			await assert.rejects(setup({ actions_policy: true }), /repository variable was not set/);
			assert.ok(await wasPosted());
			assert.match(printed(), /✓ Created the Actions event policy/);
		});

		it('is printed when setup stops at the repository variable, before it enables anything', async () => {
			await fakeGh({ variable: 'echo https://other.example.com:9925/' });
			await assert.rejects(setup(), /Nothing was changed/);
			assert.strictEqual(enabled(), false);
			assert.strictEqual(await wasPosted(), false);
			assert.match(printed(), /acme\/shop is public/);
		});

		it('keeps the starter workflow comment that links to the guide', async () => {
			await setup();
			assert.match(
				await fs.readFile(path.join(directory, WORKFLOW), 'utf8'),
				/^# From December 2, 2026, in a public repository, pull_request_target runs only if an Actions event policy targeting this repository and this file allows it\. https:\/\/docs\.github\.com\/actions\/how-tos\/administer\/control-workflow-execution$/m
			);
		});
	});
});
