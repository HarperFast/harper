/**
 * The peer side of a replicated build, driven on one node through the operation-body transport. The origin side and
 * the row transport need real replication; harper-pro's cluster tests cover them.
 */
import { suite, test, before, after } from 'node:test';
import { strictEqual, notStrictEqual, match } from 'node:assert';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';

import {
	startHarper,
	teardownHarper,
	killHarper,
	targz,
	type ContextWithHarper,
} from '@harperfast/integration-testing';

import { inventoryBuild, packBuild } from '../../dist/components/buildArtifact.js';

type Artifact = { archive: Buffer; sha256: string; size: number; manifest: any };

async function callOperation(ctx: ContextWithHarper, op: Record<string, unknown>) {
	const auth = 'Basic ' + Buffer.from(`${ctx.harper.admin.username}:${ctx.harper.admin.password}`).toString('base64');
	const res = await fetch(ctx.harper.operationsAPIURL, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', 'Authorization': auth },
		body: JSON.stringify(op),
	});
	const rawText = await res.text();
	let body: any = rawText;
	try {
		body = JSON.parse(rawText);
	} catch {
		// not JSON
	}
	return { status: res.status, body, rawText };
}

function writeTree(files: Record<string, string>): string {
	const dir = mkdtempSync(join(tmpdir(), 'prebuilt-artifact-'));
	for (const [rel, content] of Object.entries(files)) {
		mkdirSync(join(dir, rel, '..'), { recursive: true });
		writeFileSync(join(dir, rel), content);
	}
	return dir;
}

/** What an origin would publish for this tree. */
async function artifactOf(dir: string): Promise<Artifact> {
	const chunks: Buffer[] = [];
	for await (const chunk of packBuild(dir)) chunks.push(chunk as Buffer);
	const archive = Buffer.concat(chunks);
	return {
		archive,
		sha256: createHash('sha256').update(archive).digest('hex'),
		size: archive.length,
		manifest: await inventoryBuild(dir),
	};
}

function peerShaped(project: string, artifact: Artifact, overrides: Record<string, unknown> = {}) {
	const { _artifact, ...rest } = overrides as { _artifact?: Record<string, unknown> };
	return {
		operation: 'deploy_component',
		project,
		restart: false,
		_deploymentId: randomUUID(),
		payload: artifact.archive.toString('base64'),
		_artifact: {
			sha256: artifact.sha256,
			size: artifact.size,
			installationIsOpaque: false,
			build: artifact.manifest,
			..._artifact,
		},
		...rest,
	};
}

const COMPONENT = {
	'config.yaml': 'rest: true\n',
	'resources.js': 'export class Hello {}\n',
};

suite('Deploying the origin’s build on a peer', (ctx: ContextWithHarper) => {
	const scratch: string[] = [];
	const componentsDir = () => join(ctx.harper.dataRootDir, 'components');
	const liveTree = async (project: string) => (await inventoryBuild(join(componentsDir(), project))).tree;

	before(async () => {
		await startHarper(ctx, { config: {}, env: {} });
	});

	after(async () => {
		await teardownHarper(ctx);
		for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
	});

	test('installs nothing and holds exactly the tree the origin built', async () => {
		// A package.json and no node_modules, so only this branch keeps the failing install command from running.
		const origin = writeTree({ ...COMPONENT, 'package.json': '{"name":"prebuilt-take","version":"1.0.0"}' });
		scratch.push(origin);
		const artifact = await artifactOf(origin);

		const response = await callOperation(
			ctx,
			peerShaped('prebuilt-take', artifact, { install_command: 'node -e process.exit(1)' })
		);

		strictEqual(response.status, 200, `the peer should take the build: ${response.rawText}`);
		strictEqual(response.body.artifact, artifact.manifest.tree, 'and answer with the tree it admitted');
		strictEqual(await liveTree('prebuilt-take'), artifact.manifest.tree);
		const marker = JSON.parse(readFileSync(join(componentsDir(), 'prebuilt-take', '.harper-deployment.json'), 'utf8'));
		strictEqual(marker.described, true);
	});

	test('refuses a build that is not the one its origin published, keeping the live release', async () => {
		const origin = writeTree({ ...COMPONENT, 'package.json': '{"name":"prebuilt-refuse","version":"1.0.0"}' });
		scratch.push(origin);
		const artifact = await artifactOf(origin);
		strictEqual((await callOperation(ctx, peerShaped('prebuilt-refuse', artifact))).status, 200);
		const live = await liveTree('prebuilt-refuse');

		const next = await artifactOf(writeTree({ ...COMPONENT, 'resources.js': 'export class Changed {}\n' }));
		const refusals = {
			'a different archive': peerShaped('prebuilt-refuse', next, { _artifact: { sha256: 'f'.repeat(64) } }),
			'a different tree': peerShaped('prebuilt-refuse', next, {
				_artifact: { build: { ...next.manifest, tree: 'e'.repeat(64) } },
			}),
			'a platform this node is not': peerShaped('prebuilt-refuse', next, {
				_artifact: {
					build: {
						...next.manifest,
						platform: { ...next.manifest.platform, arch: `not-${process.arch}`, binds: { arch: 'addon.node' } },
					},
				},
			}),
		};
		const expected = {
			'a different archive': /is not the one its origin published/,
			'a different tree': /is not the tree its origin built/,
			'a platform this node is not': new RegExp(`CPU architecture not-${process.arch}`),
		};
		for (const [label, op] of Object.entries(refusals)) {
			const response = await callOperation(ctx, op);
			strictEqual(response.status, 409, `${label}: ${response.rawText}`);
			match(response.rawText, expected[label], label);
			strictEqual(await liveTree('prebuilt-refuse'), live, `${label} leaves the live release`);
		}
	});

	test('refuses to activate a staged build whose tree changed while it was dormant', async () => {
		const artifact = await artifactOf(writeTree({ ...COMPONENT, 'package.json': '{"name":"prebuilt-stage"}' }));
		const op: Record<string, any> = peerShaped('prebuilt-stage', artifact, { activate: false });
		// Staging changes nothing running, so the validator refuses a restart with it.
		delete op.restart;
		const staged = await callOperation(ctx, op);
		strictEqual(staged.status, 200, staged.rawText);
		strictEqual(staged.body.staged, true);
		strictEqual(staged.body.artifact, artifact.manifest.tree);

		writeFileSync(
			join(componentsDir(), '.deploy-staging', op._deploymentId, 'prebuilt-stage', 'resources.js'),
			'export class EditedWhileDormant {}\n'
		);
		const activation = await callOperation(ctx, {
			operation: 'deploy_component',
			project: 'prebuilt-stage',
			deployment_id: op._deploymentId,
		});
		strictEqual(activation.status, 409, activation.rawText);
		match(activation.rawText, /no longer the one this node certified/);
	});

	test('keeps a deployed release across its own restart and a process restart, without resolving its package again', async () => {
		// The configured package resolves to other bytes now — a moving reference — so a reinstall would show.
		const moved = writeTree({ ...COMPONENT, 'resources.js': 'export class ResolvedLater {}\n' });
		scratch.push(moved);
		const movedTarball = join(mkdtempSync(join(tmpdir(), 'prebuilt-moved-')), 'moved.tgz');
		scratch.push(join(movedTarball, '..'));
		writeFileSync(movedTarball, Buffer.from(await targz(moved), 'base64'));
		const artifact = await artifactOf(writeTree({ ...COMPONENT, 'package.json': '{"name":"prebuilt-boot"}' }));

		const response = await callOperation(
			ctx,
			peerShaped('prebuilt-boot', artifact, { package: `file:${movedTarball}`, restart: true })
		);
		strictEqual(response.status, 200, response.rawText);
		strictEqual(await liveTree('prebuilt-boot'), artifact.manifest.tree, 'kept through the deploy’s own restart');

		await killHarper(ctx);
		await startHarper(ctx, { config: {}, env: {} });
		strictEqual(await liveTree('prebuilt-boot'), artifact.manifest.tree, 'and through a process restart');
		notStrictEqual(await liveTree('prebuilt-boot'), (await inventoryBuild(moved)).tree);
	});
});
