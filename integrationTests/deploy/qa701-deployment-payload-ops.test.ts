/**
 * QA-701 — anchor for `get_deployment_payload` / `delete_deployment_payload` (#1898), which shipped
 * with unit coverage only. Two contracts are pinned.
 *
 * (1) The delete reclaims disk, it does not just flip a flag. Nulling `payload_blob` and committing
 * the row is expected to unlink the blob file through RecordEncoder's retained-blob check. Harper
 * has a history on this axis (#595; drop_attribute/drop_table drop metadata only), so both delete
 * legs assert against the on-disk blob store at ~4 KB and again at 12 MB, and require `freed_bytes`
 * to equal `payload_size` exactly.
 *
 * (2) The authorization asymmetry is deliberate. A non-super_user role explicitly granted both
 * operations can delete but is still 403 on get, because `components/deploymentOperations.ts`'s
 * `requireSuperUser` runs inside the get handler on top of the registered permission — the payload
 * is the raw tarball and can embed secrets, unlike `get_deployment`'s stripped metadata. Pinning it
 * means a later "consistency" cleanup that lets a role grant unlock the download goes red rather
 * than quietly widening secret exposure.
 *
 * Not the mechanism covered by integrationTests/deploy/deploy-payload-reclaim.test.ts, which is the
 * AUTOMATIC post-deploy drop of a payload over `deployment.payloadRetention.maxSize` (#1496) and
 * never calls either operation. `maxSize` is forced to 200 MiB here so that drop can never fire,
 * which is what makes any blob disappearance attributable to an explicit delete.
 *
 * Proof boundary: nothing here covers replication. `delete_deployment_payload` replicates the
 * nulled blob so peers drop their copies too; this is a single-node suite and asserts only the
 * local unlink.
 *
 * Reproduction:
 *   npm run build && npm run test:integration -- "integrationTests/deploy/qa701-deployment-payload-ops.test.ts"
 */
import { suite, test, before, after } from 'node:test';
import { ok, strictEqual } from 'node:assert';
import { join } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readdirSync, statSync, type Dirent } from 'node:fs';
import { tmpdir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { request as httpRequest } from 'node:http';
import { Readable } from 'node:stream';
import { createHash, randomFillSync } from 'node:crypto';

import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';

// Reach into built dist directly, same pattern as the sibling deploy-*.test.ts files.
import { streamPackagedDirectory } from '../../dist/components/packageComponent.js';
import { buildMultipartBody } from '../../dist/bin/multipartBuilder.js';

const FIXTURE_PATH = join(import.meta.dirname, 'qa701-deployment-payload-ops');
// Forced high so every deploy in this suite retains its payload_blob regardless of size —
// isolates the two explicit ops from the automatic post-deploy retention drop, so any blob
// disappearance here is attributable only to delete_deployment_payload.
const FORCED_RETENTION_MAX_SIZE = 200 * 1024 * 1024; // 200 MiB

// Every fixture gets a DISTINCT payload size: countFilesNearSize() identifies the blob under test
// by size alone, so two same-size deploys coexisting in the store would make one read as the
// other's leak.
const SMALL_FIXTURE_KB = 4;
const REDEPLOY_FIXTURE_KB = 16;
const DELEGATION_FIXTURE_KB = 64;
const NONTERMINAL_FIXTURE_KB = 256;
const LARGE_FIXTURE_KB = 12 * 1024;

// Mirrors TERMINAL_STATUSES in components/deploymentOperations.ts -- the set the 409 guard keys on.
const TERMINAL_STATUSES = ['success', 'failed', 'rolled_back'];

function postMultipart(
	url: URL,
	contentType: string,
	body: Readable,
	auth: { username: string; password: string }
): Promise<{ status: number; body: Buffer }> {
	return new Promise((resolve, reject) => {
		const req = httpRequest(
			{
				protocol: url.protocol,
				hostname: url.hostname,
				port: url.port,
				method: 'POST',
				path: url.pathname + url.search,
				headers: {
					'Content-Type': contentType,
					'Transfer-Encoding': 'chunked',
					'Authorization': 'Basic ' + Buffer.from(`${auth.username}:${auth.password}`).toString('base64'),
				},
			},
			(res) => {
				const chunks: Buffer[] = [];
				res.on('data', (c) => chunks.push(c));
				res.on('error', reject);
				res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }));
			}
		);
		req.on('error', (err) => {
			body.destroy(err);
			reject(err);
		});
		body.on('error', (err) => {
			req.destroy(err);
			reject(err);
		});
		body.pipe(req);
	});
}

async function callOperationAs(
	ctx: ContextWithHarper,
	op: Record<string, unknown>,
	auth: { username: string; password: string }
): Promise<{ status: number; headers: Headers; body: any; raw: Buffer }> {
	const url = new URL(ctx.harper.operationsAPIURL);
	const authHeader = 'Basic ' + Buffer.from(`${auth.username}:${auth.password}`).toString('base64');
	const res = await fetch(url, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', 'Authorization': authHeader },
		body: JSON.stringify(op),
	});
	const raw = Buffer.from(await res.arrayBuffer());
	// A successful get_deployment_payload streams octet-stream bytes; decoding those as UTF-8 would
	// replace anything non-textual, so binary responses are left to `raw` and `body` stays undefined.
	let parsed: any;
	if (!(res.headers.get('content-type') ?? '').includes('application/octet-stream')) {
		parsed = raw.toString('utf8');
		try {
			parsed = JSON.parse(parsed);
		} catch {
			// a non-JSON text body is still useful in an assertion message
		}
	}
	return { status: res.status, headers: res.headers, body: parsed, raw };
}

async function callOperation(ctx: ContextWithHarper, op: Record<string, unknown>) {
	return callOperationAs(ctx, op, ctx.harper.admin);
}

async function getDeploymentWhenTerminal(
	ctx: ContextWithHarper,
	deploymentId: string,
	timeoutMs = 20000
): Promise<any> {
	const deadline = Date.now() + timeoutMs;
	let last: any;
	while (Date.now() < deadline) {
		const got = await callOperation(ctx, { operation: 'get_deployment', deployment_id: deploymentId });
		last = got;
		if (got.status === 200 && (got.body?.status === 'success' || got.body?.status === 'failed')) return got;
		await sleep(75);
	}
	if (!last) throw new Error(`get_deployment for '${deploymentId}' was never polled within ${timeoutMs}ms`);
	return last;
}

// Listed in full so a failure names the residual file rather than an aggregate byte delta.
function listBlobFiles(blobsRoot: string): Array<{ path: string; size: number; mtimeMs: number }> {
	if (!existsSync(blobsRoot)) return [];
	const out: Array<{ path: string; size: number; mtimeMs: number }> = [];
	const stack = [blobsRoot];
	while (stack.length) {
		const dir = stack.pop()!;
		let entries: Dirent[];
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			const full = join(dir, entry.name);
			if (entry.isDirectory()) {
				stack.push(full);
			} else {
				try {
					const st = statSync(full);
					out.push({ path: full.slice(blobsRoot.length), size: st.size, mtimeMs: st.mtimeMs });
				} catch {
					// vanished mid-list; ignore
				}
			}
		}
	}
	return out;
}

// Counts blob files whose size matches `targetSize` within `toleranceBytes`. An on-disk blob file
// runs a handful of bytes larger than payload_size (resources/blob.ts), hence the tolerance. This
// is an identity oracle, so every fixture below is built at a DISTINCT size: two same-size random
// payloads land inside the tolerance of each other, and a surviving unrelated blob would then read
// as a leak of the one under test. Callers require exactly one pre-delete match to keep that
// honest -- if this ever counts more than one, widen the size spread, don't widen the tolerance.
function countFilesNearSize(listing: Array<{ size: number }>, targetSize: number, toleranceBytes = 64): number {
	return listing.filter((f) => Math.abs(f.size - targetSize) <= toleranceBytes).length;
}

// Polls rather than sleeping so a slow-but-real async unlink is not reported as a leak.
async function pollUntilSizeGone(
	blobsRoot: string,
	targetSize: number,
	timeoutMs = 8000
): Promise<Array<{ path: string; size: number; mtimeMs: number }>> {
	const deadline = Date.now() + timeoutMs;
	let listing = listBlobFiles(blobsRoot);
	while (countFilesNearSize(listing, targetSize) > 0 && Date.now() < deadline) {
		await sleep(200);
		listing = listBlobFiles(blobsRoot);
	}
	return listing;
}

const tempFixtureDirs: string[] = [];

// Routeless on purpose, so any number of these can coexist without colliding over "/". The
// padding is filled in one randomFillSync call rather than tiled: a tile below gzip's 32 KiB
// window compresses away, and the payload SIZE is what every disk assertion keys on.
function buildFixture(kb: number, marker: string): string {
	const dir = mkdtempSync(join(tmpdir(), 'qa701-fixture-'));
	tempFixtureDirs.push(dir);
	writeFileSync(join(dir, 'config.yaml'), `# ${marker} -- payload-size padding only, no routes registered\n`);
	if (kb > 0) {
		const scratch = Buffer.allocUnsafe(1024 * kb);
		randomFillSync(scratch);
		writeFileSync(join(dir, 'padding.bin'), scratch);
	}
	return dir;
}

// Registers a root static route. Only ONE of these may be restart:true'd at a time, or the
// root-path routes collide.
function buildLiveFixture(marker: string): string {
	const dir = mkdtempSync(join(tmpdir(), 'qa701-live-fixture-'));
	tempFixtureDirs.push(dir);
	writeFileSync(join(dir, 'config.yaml'), 'static:\n  files: web\nrest: true\n');
	mkdirSync(join(dir, 'web'), { recursive: true });
	writeFileSync(join(dir, 'web', 'index.html'), `<h1>${marker}</h1>`);
	return dir;
}

// Packages fixtureDir into an in-memory tarball buffer (so we know the EXACT uploaded bytes to
// compare against what get_deployment_payload streams back), and returns it alongside its sha256.
async function packageToBuffer(fixtureDir: string): Promise<{ buffer: Buffer; sha256: string }> {
	const chunks: Buffer[] = [];
	for await (const chunk of streamPackagedDirectory(fixtureDir, { skip_node_modules: true })) {
		chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
	}
	const buffer = Buffer.concat(chunks);
	const sha256 = createHash('sha256').update(buffer).digest('hex');
	return { buffer, sha256 };
}

// How long the gate parks the deploy if the test never releases it, and the install timeout that
// must outlast it. Neither is a race budget: the probe releases the gate as soon as its assertions
// are done, and the `exited` marker below reports a gate that closed early rather than letting it
// be misread as a guard failure.
const GATE_MAX_HOLD_MS = 120_000;
const GATE_INSTALL_TIMEOUT_MS = 180_000;

// The 409 probe needs the deployment to be non-terminal while it runs, and it must be able to PROVE
// it was: a window paced by wall clock (a slow upload, a `sleep` install) closes on a loaded runner
// and then reports the miss as a guard failure. deploy_component awaits prepareApplication, which
// awaits the component's install_command, so a component whose install command parks holds its row
// non-terminal for exactly as long as the test wants it held -- the same lever
// integrationTests/deploy/stage-swap-availability.test.ts uses to sample a mid-deploy state.
//
// This gate adds a third signal to that pattern: it writes `exited` on its way out, whatever the
// reason. An ABSENT `exited` at the moment the delete response lands is what proves the install
// command was still parked across the whole call -- i.e. that the row could not have gone terminal
// underneath the probe -- which is what separates 'the window closed early' from 'the guard did not
// fire'.
function installGateScript(paths: { started: string; release: string; exited: string }): string {
	return (
		`const fs = require('node:fs');\n` +
		`function leave(code) {\n` +
		`\tfs.writeFileSync(${JSON.stringify(paths.exited)}, String(code));\n` +
		`\tprocess.exit(code);\n` +
		`}\n` +
		`fs.writeFileSync(${JSON.stringify(paths.started)}, 'started');\n` +
		// Self-releases inside install_timeout so a test that dies before writing the release file
		// still lets the deploy, and the rest of the suite, finish.
		`const deadline = Date.now() + ${GATE_MAX_HOLD_MS};\n` +
		`(function wait() {\n` +
		`\tif (fs.existsSync(${JSON.stringify(paths.release)})) return leave(0);\n` +
		`\tif (Date.now() >= deadline) return leave(2);\n` +
		`\tsetTimeout(wait, 10);\n` +
		`})();\n`
	);
}

// The probe's own failure modes read very differently depending on whether the deploy had already
// finished, so say which it was rather than printing an empty serialized Error.
function describeDeployResolution(
	resolution: { value: Awaited<ReturnType<typeof deployBuffer>> } | { error: unknown } | undefined
): string {
	if (!resolution) return 'was still in flight';
	if ('error' in resolution) return `had already failed: ${String(resolution.error)}`;
	return `had already returned ${resolution.value.status}: ${resolution.value.raw.toString('utf8').slice(0, 300)}`;
}

// A fixture whose install_command parks on the gate. package.json is what makes installApplication
// run the command at all (without a manifest it logs "skipping install"), and node_modules must be
// absent for the same reason -- see installApplication in components/Application.ts.
function buildGatedFixture(
	kb: number,
	marker: string,
	project: string,
	paths: { started: string; release: string; exited: string }
): string {
	const dir = buildFixture(kb, marker);
	writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: project, version: '0.0.0', private: true }));
	writeFileSync(join(dir, 'install-gate.js'), installGateScript(paths));
	return dir;
}

async function deployBuffer(
	ctx: ContextWithHarper,
	project: string,
	buffer: Buffer,
	restart: boolean,
	auth = ctx.harper.admin,
	extraFields?: Record<string, unknown>
): Promise<{ status: number; deploymentId: string | undefined; raw: Buffer }> {
	const multipart = buildMultipartBody(
		{ operation: 'deploy_component', project, restart, ...extraFields },
		{
			name: 'payload',
			filename: 'package.tar.gz',
			contentType: 'application/gzip',
			stream: Readable.from(buffer),
		}
	);
	const url = new URL(ctx.harper.operationsAPIURL);
	const response = await postMultipart(url, multipart.contentType, multipart.stream, auth);
	let parsed: any;
	try {
		parsed = JSON.parse(response.body.toString('utf8'));
	} catch {
		parsed = response.body.toString('utf8');
	}
	return { status: response.status, deploymentId: parsed?.deployment_id, raw: response.body };
}

suite(
	'QA-701 deployment payload operations: boundaries, on-disk reclaim, and the authorization asymmetry (#1898)',
	(ctx: ContextWithHarper) => {
		let blobsRoot: string;
		const NON_SU_ROLE_PLAIN = 'qa701_non_su_plain';
		const NON_SU_USER_PLAIN = 'qa701_non_su_plain_user';
		const NON_SU_ROLE_DELEGATED = 'qa701_non_su_delegated';
		const NON_SU_USER_DELEGATED = 'qa701_non_su_delegated_user';
		const NON_SU_PASSWORD = 'Qa701!nonSuPassw0rd';

		before(async () => {
			await setupHarperWithFixture(ctx, FIXTURE_PATH, {
				config: { deployment: { payloadRetention: { maxSize: String(FORCED_RETENTION_MAX_SIZE) } } },
				env: {},
			});
			blobsRoot = join(ctx.harper.dataRootDir, 'blobs');

			// Poll the probe route directly until it stops 404-ing; do NOT call restartHttpWorkers()
			// against a pre-installed fixture (races and flakes on CI).
			const deadline = Date.now() + 120_000;
			let ready = false;
			while (Date.now() < deadline) {
				try {
					const probe = await fetch(`${ctx.harper.httpURL}/Beacon/`, {
						headers: {
							Authorization:
								'Basic ' + Buffer.from(`${ctx.harper.admin.username}:${ctx.harper.admin.password}`).toString('base64'),
						},
					});
					// A 5xx means mounted but unhealthy, which is not ready either.
					if (probe.status !== 404 && probe.status < 500) {
						ready = true;
						break;
					}
				} catch {
					/* not ready yet */
				}
				await sleep(250);
			}
			ok(ready, 'the Beacon route never became ready — the suite would run against an unrouted instance');
		});

		after(async () => {
			for (const dir of tempFixtureDirs) {
				try {
					rmSync(dir, { recursive: true, force: true });
				} catch {
					// best-effort
				}
			}
			await teardownHarper(ctx);
		});

		test('verify Harper', async () => {
			const response = await fetch(`${ctx.harper.operationsAPIURL}/health`);
			strictEqual(response.status, 200);
		});

		test('1: get/delete on a deployment_id that was never deployed -> clean 404, JSON body', async () => {
			const getResp = await callOperation(ctx, {
				operation: 'get_deployment_payload',
				deployment_id: 'qa701-never-existed',
			});
			strictEqual(
				getResp.status,
				404,
				`get_deployment_payload on unknown id: expected 404, got ${getResp.status}: ${JSON.stringify(getResp.body)}`
			);
			ok(
				typeof getResp.body?.error === 'string' && getResp.body.error.includes('qa701-never-existed'),
				`expected error naming the id, got ${JSON.stringify(getResp.body)}`
			);
			// The success path sets content-disposition/octet-stream headers; the error path must
			// not leak them (would indicate the stream branch started before the 404 check landed).
			ok(
				!getResp.headers.get('content-disposition'),
				`error response should not carry a download content-disposition header, got ${getResp.headers.get('content-disposition')}`
			);

			const delResp = await callOperation(ctx, {
				operation: 'delete_deployment_payload',
				deployment_id: 'qa701-never-existed',
			});
			strictEqual(
				delResp.status,
				404,
				`delete_deployment_payload on unknown id: expected 404, got ${delResp.status}: ${JSON.stringify(delResp.body)}`
			);
			ok(
				typeof delResp.body?.error === 'string' && delResp.body.error.includes('qa701-never-existed'),
				`expected error naming the id, got ${JSON.stringify(delResp.body)}`
			);
		});

		let smallDeploymentId: string;
		let smallBuffer: Buffer;
		let smallSha256: string;

		test('2 setup: deploy a small real component, confirm payload_blob retained', async () => {
			const fixtureDir = buildFixture(SMALL_FIXTURE_KB, 'QA-701 small');
			const packaged = await packageToBuffer(fixtureDir);
			smallBuffer = packaged.buffer;
			smallSha256 = packaged.sha256;

			const deployed = await deployBuffer(ctx, 'qa701-small-app', smallBuffer, false);
			strictEqual(
				deployed.status,
				200,
				`deploy expected 200, got ${deployed.status}: ${deployed.raw.toString('utf8')}`
			);
			ok(deployed.deploymentId, 'deploy should return a deployment_id');
			smallDeploymentId = deployed.deploymentId!;

			const got = await getDeploymentWhenTerminal(ctx, smallDeploymentId);
			strictEqual(got.status, 200);
			strictEqual(got.body.status, 'success', `deploy should succeed: ${JSON.stringify(got.body.error)}`);
			strictEqual(
				got.body.payload_blob_present,
				true,
				'payload_blob should be retained under the forced high retention threshold'
			);
			strictEqual(
				got.body.payload_hash,
				smallSha256,
				'row payload_hash should match the sha256 of the exact uploaded bytes'
			);
			strictEqual(
				got.body.payload_size,
				smallBuffer.length,
				'row payload_size should match the exact uploaded byte count'
			);
		});

		test('2: get_deployment_payload streams byte-identical bytes (sha256 round-trip)', async () => {
			const url = new URL(ctx.harper.operationsAPIURL);
			const auth =
				'Basic ' + Buffer.from(`${ctx.harper.admin.username}:${ctx.harper.admin.password}`).toString('base64');
			const res = await fetch(url, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', 'Authorization': auth },
				body: JSON.stringify({ operation: 'get_deployment_payload', deployment_id: smallDeploymentId }),
			});
			const downloaded = Buffer.from(await res.arrayBuffer());
			strictEqual(res.status, 200, `expected 200, got ${res.status}: ${downloaded.toString('utf8').slice(0, 300)}`);
			ok(
				(res.headers.get('content-disposition') ?? '').includes(smallDeploymentId),
				`expected content-disposition to name the deployment, got ${res.headers.get('content-disposition')}`
			);
			strictEqual(
				downloaded.length,
				smallBuffer.length,
				'downloaded byte length should exactly match uploaded byte length'
			);
			const downloadedSha256 = createHash('sha256').update(downloaded).digest('hex');
			strictEqual(
				downloadedSha256,
				smallSha256,
				'downloaded bytes must be byte-identical (sha256 match) to the uploaded tarball'
			);
		});

		test('3: delete_deployment_payload on a non-terminal deployment -> 409, blob untouched', async () => {
			// deploy_component only responds once the row is terminal, so awaiting the deploy and then
			// deleting can never reach the guard -- the delete has to be issued mid-deploy. Holding the
			// window open with elapsed time (a paced upload, a `sleep` install) is what made this probe
			// flaky: on a loaded runner the deploy finished first and the 200 read as a guard failure
			// (nightly 2026-09-05, Bun shard). The install gate replaces that with a causal window --
			// the deploy is parked inside install_command until this test releases it -- and the gate's
			// 'exited' marker makes 'the window closed early' a DIFFERENT failure from 'the guard did
			// not fire', so a future red run says which one happened.
			const project = 'qa701-nonterminal-app';
			// The signal files live outside the packaged tree, so the gate script's own component
			// directory (staged, then renamed on swap) can never be what makes them appear.
			const gateDir = mkdtempSync(join(tmpdir(), 'qa701-install-gate-'));
			tempFixtureDirs.push(gateDir);
			const gate = {
				started: join(gateDir, 'install-started'),
				release: join(gateDir, 'install-release'),
				exited: join(gateDir, 'install-exited'),
			};

			const fixtureDir = buildGatedFixture(NONTERMINAL_FIXTURE_KB, 'QA-701 nonterminal', project, gate);
			const packaged = await packageToBuffer(fixtureDir);

			let deployResolution: { value: Awaited<ReturnType<typeof deployBuffer>> } | { error: unknown } | undefined;
			const deployPromise = deployBuffer(ctx, project, packaged.buffer, false, ctx.harper.admin, {
				install_command: 'node install-gate.js',
				install_timeout: GATE_INSTALL_TIMEOUT_MS,
			}).then(
				(value) => (deployResolution = { value }),
				(error: unknown) => (deployResolution = { error })
			);

			try {
				// Wait for the gate, not for a duration. A deploy that settles first can only mean the
				// install command never ran (no package.json in the payload, or an install that was
				// skipped), which is a broken probe rather than a guard failure -- say so.
				const readyDeadline = Date.now() + 60_000;
				while (!existsSync(gate.started) && !deployResolution && Date.now() < readyDeadline) await sleep(25);
				ok(
					existsSync(gate.started),
					`the install gate never signalled that it was running, so the deployment was never held ` +
						`non-terminal -- the deploy ${describeDeployResolution(deployResolution)}`
				);

				// The gate is blocking install_command, so the deploy cannot have reached a terminal
				// status -- this row read is an identification step, not a race window.
				const listed = await callOperation(ctx, { operation: 'list_deployments', project });
				const rows: Array<{ deployment_id: string; status?: string }> = listed.body?.deployments ?? [];
				strictEqual(
					rows.length,
					1,
					`expected exactly one '${project}' deployment row while the install gate holds it: ${JSON.stringify(listed.body)}`
				);
				const inFlight = rows[0];
				ok(
					!TERMINAL_STATUSES.includes(inFlight.status ?? ''),
					`the row reported terminal status '${inFlight.status}' while its own install command was ` +
						`still blocked -- the deployment record went terminal before the deploy finished`
				);

				const delResp = await callOperation(ctx, {
					operation: 'delete_deployment_payload',
					deployment_id: inFlight.deployment_id,
				});
				// Read the moment the response lands: the gate writes 'exited' before the install command
				// returns, so an absent marker proves the deploy was still parked in install for the whole
				// delete -- i.e. the row could not have gone terminal underneath it.
				const gateExited = existsSync(gate.exited);
				const after = await callOperation(ctx, { operation: 'get_deployment', deployment_id: inFlight.deployment_id });
				ok(
					!gateExited,
					`the install gate released before the delete completed, so the non-terminal window was not ` +
						`held open and this run proves nothing about the 409 guard (delete returned ${delResp.status}, ` +
						`row status now '${after.body?.status}')`
				);
				strictEqual(
					delResp.status,
					409,
					`delete on a non-terminal deployment (status '${inFlight.status}' at the list read, ` +
						`'${after.body?.status}' after the delete, install command still blocked throughout) should ` +
						`409, got ${delResp.status}: ${JSON.stringify(delResp.body)}`
				);
			} finally {
				writeFileSync(gate.release, '');
				await deployPromise;
			}

			if (!deployResolution || 'error' in deployResolution)
				throw deployResolution?.error ?? new Error('deploy never settled');
			const deployed = deployResolution.value;
			strictEqual(
				deployed.status,
				200,
				`deploy expected 200, got ${deployed.status}: ${deployed.raw.toString('utf8')}`
			);
			ok(deployed.deploymentId);
			const settled = await getDeploymentWhenTerminal(ctx, deployed.deploymentId!);
			strictEqual(settled.body.status, 'success', `deploy should succeed: ${JSON.stringify(settled.body.error)}`);
			strictEqual(settled.body.payload_blob_present, true, 'a 409-refused delete must leave payload_blob in place');
		});

		test('4: delete_deployment_payload reclaims ON-DISK bytes, not just the row flag', async () => {
			const beforeListing = listBlobFiles(blobsRoot);
			const got = await callOperation(ctx, { operation: 'get_deployment', deployment_id: smallDeploymentId });
			strictEqual(
				got.body.payload_blob_present,
				true,
				'precondition: payload_blob should still be present before delete'
			);
			const payloadSize = got.body.payload_size as number;
			strictEqual(
				countFilesNearSize(beforeListing, payloadSize),
				1,
				`precondition: exactly one blob file should match payload_size=${payloadSize} before delete ` +
					`(the size is this suite's identity oracle -- see countFilesNearSize), ` +
					`listing=${JSON.stringify(beforeListing)}`
			);

			const delResp = await callOperation(ctx, {
				operation: 'delete_deployment_payload',
				deployment_id: smallDeploymentId,
			});
			strictEqual(delResp.status, 200, `expected 200, got ${delResp.status}: ${JSON.stringify(delResp.body)}`);
			strictEqual(delResp.body.deployment_id, smallDeploymentId);
			strictEqual(delResp.body.freed_bytes, smallBuffer.length, 'freed_bytes should match the original payload_size');
			strictEqual(delResp.body.freed_bytes, payloadSize);

			const gotAfter = await callOperation(ctx, { operation: 'get_deployment', deployment_id: smallDeploymentId });
			strictEqual(gotAfter.status, 200);
			strictEqual(gotAfter.body.payload_blob_present, false, 'payload_blob_present should flip to false after delete');
			strictEqual(gotAfter.body.status, 'success', 'row metadata/status should be retained (audit trail), not wiped');
			ok(
				Array.isArray(gotAfter.body.event_log) &&
					gotAfter.body.event_log.some((e: any) => e.event === 'payload_dropped'),
				`expected an audit event_log entry for payload_dropped, got ${JSON.stringify(gotAfter.body.event_log)}`
			);

			// Poll (not a fixed sleep) for the SPECIFIC blob file matching this payload's exact size
			// to vanish on disk -- targets the actual bytes under test rather than an aggregate
			// directory total, which is fragile once multiple small test deploys' blobs coexist.
			const afterListing = await pollUntilSizeGone(blobsRoot, payloadSize, 8000);
			console.log(
				`[QA-701] 4 disk listing: payloadSize=${payloadSize} before=${JSON.stringify(beforeListing)} after=${JSON.stringify(afterListing)}`
			);
			strictEqual(
				countFilesNearSize(afterListing, payloadSize),
				0,
				`DEFECT-LEAK: a blob file matching payload_size=${payloadSize} is still on disk after delete_deployment_payload ` +
					`(listing=${JSON.stringify(afterListing)})`
			);
		});

		test('5: get_deployment_payload after delete -> 404, not 500', async () => {
			const getResp = await callOperation(ctx, {
				operation: 'get_deployment_payload',
				deployment_id: smallDeploymentId,
			});
			strictEqual(
				getResp.status,
				404,
				`expected 404 after delete, got ${getResp.status}: ${JSON.stringify(getResp.body)}`
			);
			ok(
				typeof getResp.body?.error === 'string' && /reclaim|delete/i.test(getResp.body.error),
				`expected error to explain the payload was reclaimed/deleted, got ${JSON.stringify(getResp.body)}`
			);
		});

		test('6: delete_deployment_payload is idempotent on an already-gone payload', async () => {
			const delResp = await callOperation(ctx, {
				operation: 'delete_deployment_payload',
				deployment_id: smallDeploymentId,
			});
			strictEqual(
				delResp.status,
				200,
				`second delete should not error, got ${delResp.status}: ${JSON.stringify(delResp.body)}`
			);
			strictEqual(delResp.body.freed_bytes, 0, 'second delete should report freed_bytes: 0 (nothing left to free)');
			strictEqual(delResp.body.deployment_id, smallDeploymentId);
		});

		let redeployedDeploymentId: string;

		test('7: redeploy after delete produces an independent new deployment_id + fresh payload_blob', async () => {
			const fixtureDir = buildFixture(REDEPLOY_FIXTURE_KB, 'QA-701 redeploy');
			const packaged = await packageToBuffer(fixtureDir);
			const deployed = await deployBuffer(ctx, 'qa701-small-app', packaged.buffer, false);
			strictEqual(
				deployed.status,
				200,
				`redeploy expected 200, got ${deployed.status}: ${deployed.raw.toString('utf8')}`
			);
			ok(
				deployed.deploymentId && deployed.deploymentId !== smallDeploymentId,
				'redeploy should mint a new deployment_id'
			);
			redeployedDeploymentId = deployed.deploymentId!;

			const got = await getDeploymentWhenTerminal(ctx, deployed.deploymentId!);
			strictEqual(got.body.status, 'success');
			strictEqual(got.body.payload_blob_present, true, 'the NEW deployment should have its own fresh payload_blob');

			// Old row must remain independently gone -- confirms delete scoped to the old
			// deployment_id, not the project.
			const oldRow = await callOperation(ctx, { operation: 'get_deployment', deployment_id: smallDeploymentId });
			strictEqual(
				oldRow.body.payload_blob_present,
				false,
				'the OLD deployment row must remain payload-less after redeploy'
			);
		});

		test('8: deleting the payload of a DEPLOYED-AND-RUNNING component does not disturb the live route', async () => {
			// The ONLY component in this suite deployed with a static route + restart:true (see
			// buildLiveFixture's header note on root-path route collisions) -- fetch the root URL
			// directly, not a project subpath.
			const fixtureDir = buildLiveFixture('QA-701 LIVE MARKER');
			const packaged = await packageToBuffer(fixtureDir);
			const deployed = await deployBuffer(ctx, 'qa701-live-app', packaged.buffer, true);
			strictEqual(
				deployed.status,
				200,
				`deploy(restart:true) expected 200, got ${deployed.status}: ${deployed.raw.toString('utf8')}`
			);
			const got = await getDeploymentWhenTerminal(ctx, deployed.deploymentId!, 30000);
			strictEqual(got.body.status, 'success', `deploy should succeed: ${JSON.stringify(got.body.error)}`);

			// Wait for the restart to settle and the component to actually serve.
			let serving = false;
			let lastBody = '';
			const readyDeadline = Date.now() + 30000;
			while (Date.now() < readyDeadline) {
				try {
					const r = await fetch(ctx.harper.httpURL);
					if (r.status === 200) {
						lastBody = await r.text();
						if (lastBody.includes('QA-701 LIVE MARKER')) {
							serving = true;
							break;
						}
					}
				} catch {
					/* not ready */
				}
				await sleep(500);
			}
			ok(serving, `precondition: qa701-live-app should be serving before the payload delete (last body: ${lastBody})`);

			const delResp = await callOperation(ctx, {
				operation: 'delete_deployment_payload',
				deployment_id: deployed.deploymentId,
			});
			strictEqual(
				delResp.status,
				200,
				`delete on the running component's payload expected 200, got ${delResp.status}: ${JSON.stringify(delResp.body)}`
			);

			// payload_blob is the historical tarball, not the installed copy the worker serves from.
			const r2 = await fetch(ctx.harper.httpURL);
			const body2 = await r2.text();
			strictEqual(r2.status, 200);
			ok(
				body2.includes('QA-701 LIVE MARKER'),
				`running component should still serve after its deployment payload was deleted, got: ${body2}`
			);
		});

		test('9: multi-MB payload delete reclaims disk bytes at scale', async () => {
			// Above the *default* 10 MiB auto-retention threshold, but this suite forces
			// payloadRetention.maxSize to 200 MiB, so this deploy retains its blob until the explicit
			// delete below -- isolating this op's reclaim from the automatic drop.
			const fixtureDir = buildFixture(LARGE_FIXTURE_KB, 'QA-701 large');
			const packaged = await packageToBuffer(fixtureDir);
			ok(
				packaged.buffer.length > LARGE_FIXTURE_KB * 1024 * 0.9,
				`fixture should package to multi-MB, got ${packaged.buffer.length}`
			);

			const deployed = await deployBuffer(ctx, 'qa701-large-app', packaged.buffer, false);
			strictEqual(
				deployed.status,
				200,
				`large deploy expected 200, got ${deployed.status}: ${deployed.raw.toString('utf8')}`
			);
			const got = await getDeploymentWhenTerminal(ctx, deployed.deploymentId!, 30000);
			strictEqual(got.body.status, 'success', `large deploy should succeed: ${JSON.stringify(got.body.error)}`);
			strictEqual(
				got.body.payload_blob_present,
				true,
				'large payload should be retained under the forced high threshold'
			);

			const beforeListing = listBlobFiles(blobsRoot);
			const payloadSize = got.body.payload_size as number;
			strictEqual(
				countFilesNearSize(beforeListing, payloadSize),
				1,
				`precondition: exactly one blob file should match payload_size=${payloadSize} before delete ` +
					`(the size is this suite's identity oracle -- see countFilesNearSize), ` +
					`listing=${JSON.stringify(beforeListing)}`
			);

			const delResp = await callOperation(ctx, {
				operation: 'delete_deployment_payload',
				deployment_id: deployed.deploymentId,
			});
			strictEqual(delResp.status, 200, `expected 200, got ${delResp.status}: ${JSON.stringify(delResp.body)}`);
			strictEqual(delResp.body.freed_bytes, payloadSize);

			// Poll (not a fixed sleep) so a slow-but-real async unlink at multi-MB scale isn't
			// mistaken for a leak; 8s ceiling before treating it as a genuine defect.
			const afterListing = await pollUntilSizeGone(blobsRoot, payloadSize, 8000);
			console.log(
				`[QA-701] 9 disk listing (multi-MB): payloadSize=${payloadSize} before=${JSON.stringify(beforeListing)} after=${JSON.stringify(afterListing)}`
			);
			strictEqual(
				countFilesNearSize(afterListing, payloadSize),
				0,
				`DEFECT-LEAK: a blob file matching payload_size=${payloadSize} is still on disk after delete_deployment_payload ` +
					`(listing=${JSON.stringify(afterListing)})`
			);
		});

		test('10 setup: non-super_user roles (plain-forbidden and gate-2-delegated)', async () => {
			const plainRole = await callOperation(ctx, {
				operation: 'add_role',
				role: NON_SU_ROLE_PLAIN,
				permission: { super_user: false },
			});
			strictEqual(
				plainRole.status,
				200,
				`add_role(plain) expected 200, got ${plainRole.status}: ${JSON.stringify(plainRole.body)}`
			);
			const plainUser = await callOperation(ctx, {
				operation: 'add_user',
				role: NON_SU_ROLE_PLAIN,
				username: NON_SU_USER_PLAIN,
				password: NON_SU_PASSWORD,
				active: true,
			});
			strictEqual(
				plainUser.status,
				200,
				`add_user(plain) expected 200, got ${plainUser.status}: ${JSON.stringify(plainUser.body)}`
			);

			const delegatedRole = await callOperation(ctx, {
				operation: 'add_role',
				role: NON_SU_ROLE_DELEGATED,
				permission: { super_user: false, operations: ['get_deployment_payload', 'delete_deployment_payload'] },
			});
			strictEqual(
				delegatedRole.status,
				200,
				`add_role(delegated) expected 200, got ${delegatedRole.status}: ${JSON.stringify(delegatedRole.body)}`
			);
			const delegatedUser = await callOperation(ctx, {
				operation: 'add_user',
				role: NON_SU_ROLE_DELEGATED,
				username: NON_SU_USER_DELEGATED,
				password: NON_SU_PASSWORD,
				active: true,
			});
			strictEqual(
				delegatedUser.status,
				200,
				`add_user(delegated) expected 200, got ${delegatedUser.status}: ${JSON.stringify(delegatedUser.body)}`
			);
		});

		test('10a: default non-SU role (no operations grant) gets 403 on both ops', async () => {
			const auth = { username: NON_SU_USER_PLAIN, password: NON_SU_PASSWORD };
			const getResp = await callOperationAs(
				ctx,
				{ operation: 'get_deployment_payload', deployment_id: 'qa701-anything' },
				auth
			);
			strictEqual(getResp.status, 403, `expected 403, got ${getResp.status}: ${JSON.stringify(getResp.body)}`);
			const delResp = await callOperationAs(
				ctx,
				{ operation: 'delete_deployment_payload', deployment_id: 'qa701-anything' },
				auth
			);
			strictEqual(delResp.status, 403, `expected 403, got ${delResp.status}: ${JSON.stringify(delResp.body)}`);
		});

		let liveForDelegationDeploymentId: string;

		test('10b setup: deploy one more real payload for the delegated-role probe', async () => {
			const fixtureDir = buildFixture(DELEGATION_FIXTURE_KB, 'QA-701 delegation target');
			const packaged = await packageToBuffer(fixtureDir);
			const deployed = await deployBuffer(ctx, 'qa701-delegation-app', packaged.buffer, false);
			strictEqual(deployed.status, 200);
			const got = await getDeploymentWhenTerminal(ctx, deployed.deploymentId!);
			strictEqual(got.body.status, 'success');
			strictEqual(got.body.payload_blob_present, true);
			liveForDelegationDeploymentId = deployed.deploymentId!;
		});

		test('10c: gate-2-delegated non-SU role can delete_deployment_payload but is STILL 403 on get_deployment_payload', async () => {
			const auth = { username: NON_SU_USER_DELEGATED, password: NON_SU_PASSWORD };

			// components/deploymentOperations.ts's requireSuperUser runs inside the get handler, on top of
			// the registered permission: the raw tarball can embed secrets, unlike get_deployment's
			// stripped metadata, so an explicit role `operations` grant must NOT be enough to unlock it.
			const getResp = await callOperationAs(
				ctx,
				{ operation: 'get_deployment_payload', deployment_id: liveForDelegationDeploymentId },
				auth
			);
			strictEqual(
				getResp.status,
				403,
				`get_deployment_payload should stay 403 even with an explicit operations grant (self-enforced SU), got ${getResp.status}: ${JSON.stringify(getResp.body)}`
			);

			// delete_deployment_payload has no such self-enforcement -- the explicit operations grant
			// (gate-2) is the intended, documented way to delegate cleanup automation (#1893's stated
			// use case) to a non-SU role.
			const delResp = await callOperationAs(
				ctx,
				{ operation: 'delete_deployment_payload', deployment_id: liveForDelegationDeploymentId },
				auth
			);
			strictEqual(
				delResp.status,
				200,
				`delete_deployment_payload should succeed for a role explicitly granted the operation, got ${delResp.status}: ${JSON.stringify(delResp.body)}`
			);

			// Confirm the delegated delete actually did something real (as everywhere else here:
			// row metadata retained, blob gone).
			const gotAfter = await callOperation(ctx, {
				operation: 'get_deployment',
				deployment_id: liveForDelegationDeploymentId,
			});
			strictEqual(gotAfter.body.payload_blob_present, false);

			// The SU download path must still work with a delegated role in place. This has to target a
			// deployment whose payload is still present -- the redeploy from probe 7 -- because every
			// other row in this suite has had its payload deleted by now.
			const suDownload = await callOperationAs(
				ctx,
				{ operation: 'get_deployment_payload', deployment_id: redeployedDeploymentId },
				ctx.harper.admin
			);
			strictEqual(
				suDownload.status,
				200,
				`a super_user download must still succeed alongside a delegated role, got ${suDownload.status}: ${suDownload.raw.toString('utf8').slice(0, 200)}`
			);
			ok(suDownload.raw.length > 0, 'the super_user download should return the payload bytes');
		});
	}
);
