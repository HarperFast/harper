'use strict';

// harper#3059: list_releases reports the live release and the releases a node keeps, from what is on disk.

const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs/promises');
const os = require('node:os');
const zlib = require('node:zlib');
const tar = require('tar-fs');
const testUtils = require('../testUtils.js');
testUtils.preTestPrep();

const { prepareApplication, Application, DEPLOY_STAGING_DIR } = require('#src/components/Application');
const { handleListReleases } = require('#src/components/releaseOperations');
const { server } = require('#src/server/Server');
const { getThisNodeName } = require('#src/server/nodeName');
const env = require('#src/utility/environment/environmentManager');
const { CONFIG_PARAMS } = require('#src/utility/hdbTerms');
const { preserveRootConfig } = require('../rootConfigFixture.js');

const [A, B, C, D] = ['a', 'b', 'c', 'd'].map((letter) => `${letter.repeat(8)}-0000-4000-8000-000000000000`);

async function tarball(marker) {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'list-releases-src-'));
	await fs.writeFile(path.join(dir, 'package.json'), '{"name":"web","version":"1.0.0"}\n');
	await fs.writeFile(path.join(dir, 'index.js'), marker);
	const chunks = [];
	await new Promise((resolve, reject) => {
		const gzip = zlib.createGzip();
		gzip.on('data', (chunk) => chunks.push(chunk));
		gzip.on('end', resolve);
		gzip.on('error', reject);
		tar.pack(dir).pipe(gzip);
	});
	await fs.rm(dir, { recursive: true, force: true });
	return Buffer.concat(chunks);
}

async function build(root, id, mode) {
	const app = new Application({ name: 'web', payload: await tarball(`release ${id}`) });
	app.dirPath = path.join(root, 'web');
	await prepareApplication(app, {
		artifactId: id,
		...(mode === 'stage' ? { mode } : { describeArtifact: () => ({ rootConfig: null, isolated: false }) }),
	});
}

describe('list_releases (harper#3059)', () => {
	preserveRootConfig();
	let root;
	let previousRoot;
	let previousReplicate;

	before(async function () {
		this.timeout(60000);
		root = await fs.mkdtemp(path.join(os.tmpdir(), 'list-releases-'));
		previousRoot = env.get(CONFIG_PARAMS.COMPONENTSROOT);
		env.setProperty(CONFIG_PARAMS.COMPONENTSROOT, root);
		await build(root, A);
		await build(root, B);
		await build(root, C);
		await build(root, D, 'stage');
	});
	after(async () => {
		env.setProperty(CONFIG_PARAMS.COMPONENTSROOT, previousRoot);
		await fs.rm(root, { recursive: true, force: true });
	});
	afterEach(() => {
		if (previousReplicate) server.replication.replicateOperation = previousReplicate;
		previousReplicate = undefined;
	});

	it("reports this node's live release, the two it replaced as kept, and the stage nobody activated", async () => {
		const answer = await handleListReleases({ project: 'web' });
		assert.strictEqual(answer.node, getThisNodeName());
		const [web] = answer.components;
		assert.strictEqual(web.deployment_id, C);
		assert.deepStrictEqual(Object.fromEntries(web.releases.map(({ deployment_id, state }) => [deployment_id, state])), {
			[A]: 'kept',
			[B]: 'kept',
			[D]: 'staged',
		});
		for (const release of web.releases) {
			assert.ok(release.size > 0, 'the size of its tree on disk');
			assert.ok(release.at > 0);
		}
		assert.deepStrictEqual(
			web.releases.map(({ deployment_id }) => deployment_id),
			[D, B, A],
			'newest first'
		);
	});

	it('lists every component when no project is given, and only releases this node still keeps', async () => {
		await fs.rm(path.join(root, DEPLOY_STAGING_DIR, A), { recursive: true });
		const { components } = await handleListReleases({});
		assert.deepStrictEqual(
			components.map(({ project }) => project),
			['web']
		);
		assert.deepStrictEqual(components[0].releases.map(({ deployment_id }) => deployment_id).sort(), [B, D].sort());
	});

	it("returns each other node's answer with replicated: true, and a node that could not answer as an error", async () => {
		previousReplicate = server.replication.replicateOperation;
		let asked;
		server.replication.replicateOperation = async (request) => {
			asked = request;
			return {
				replicated: [
					{ node: 'peer-a', components: [{ project: 'web', deployment_id: B, releases: [] }] },
					{ node: 'peer-b', status: 'failed', reason: 'connection refused' },
				],
			};
		};
		const { nodes } = await handleListReleases({ project: 'web', replicated: true });
		assert.strictEqual(asked.operation ?? 'list_releases', 'list_releases');
		assert.deepStrictEqual(
			nodes.map(({ node, components, error }) => ({ node, live: components?.[0]?.deployment_id, error })),
			[
				{ node: getThisNodeName(), live: C, error: undefined },
				{ node: 'peer-a', live: B, error: undefined },
				{ node: 'peer-b', live: undefined, error: 'connection refused' },
			]
		);
	});

	it('refuses a project that is not a component name', async () => {
		await assert.rejects(handleListReleases({ project: '../etc' }), /must be a component name/);
	});
});
