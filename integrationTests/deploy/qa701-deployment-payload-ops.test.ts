/**
 * QA-701 — anchor for `get_deployment_payload` / `delete_deployment_payload` (#1898), which shipped
 * with unit coverage only.
 *
 * Two contracts are pinned here.
 *
 * (1) DELETE REALLY RECLAIMS DISK. `delete_deployment_payload` nulls `payload_blob` and commits the
 * row, which is expected to unlink the blob file through RecordEncoder's retained-blob check — not
 * merely flip a flag. Harper has a history on this axis (#595, "dropping a table leaves orphan
 * blobs", and the metadata-only behavior confirmed for drop_attribute/drop_table), so every delete
 * probe asserts against the actual on-disk blob store, at ~4 KB and again at 12 MB, and checks that
 * `freed_bytes` equals the row's `payload_size` exactly. The disk check polls for the file to
 * disappear rather than sleeping, so a slow-but-real unlink is not misread as a leak.
 *
 * (2) THE AUTHORIZATION ASYMMETRY IS DELIBERATE. A non-super_user role with no `operations` grant is
 * 403 on both ops. A non-super_user role explicitly granted BOTH operations can call
 * `delete_deployment_payload` — that gate-2 delegation is the intended way to hand cleanup
 * automation to a non-SU role — but is STILL 403 on `get_deployment_payload`, because that handler
 * self-enforces super_user in addition to the registered permission (components/deploymentOperations.ts's
 * `requireSuperUser`, and the note beside it in utility/operation_authorization.ts): the payload is
 * the raw tarball and can embed secrets, unlike `get_deployment`'s stripped metadata. This file
 * pins that asymmetry as the contract, so a future "consistency" cleanup that lets a role grant
 * unlock the download goes red instead of quietly widening secret exposure.
 *
 * Boundaries also covered: unknown deployment_id → 404 with a JSON error body and no download
 * headers leaking from the error path; delete on a non-terminal deployment → 409; get after delete
 * → 404, not 500; a second delete → 200 with `freed_bytes: 0`; deleting a running component's
 * payload leaves the live route serving (the blob is the historical tarball, not the installed
 * copy); and a redeploy after a delete mints an independent deployment_id whose own blob is
 * retained while the old row stays payload-less.
 *
 * Not the same mechanism as integrationTests/deploy/deploy-payload-reclaim.test.ts, which covers the
 * AUTOMATIC post-deploy drop of a payload exceeding `deployment.payloadRetention.maxSize` (#1496)
 * and never calls either of these operations. This suite forces `maxSize` to 200 MiB precisely so
 * that automatic drop can never fire, which makes any blob disappearance here attributable only to
 * an explicit `delete_deployment_payload` call.
 *
 * Proof boundary: the 409 leg races a real deploy to its terminal status. When the deploy settles
 * first the 409 assertion is skipped (and says so on stdout) rather than false-failing; the guard's
 * unconditional coverage is unitTests/components/deploymentOperations.test.js's, not this file's.
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
// other's leak. The multi-MB non-terminal size is also what gives the 409 probe a real window.
const SMALL_FIXTURE_KB = 4;
const REDEPLOY_FIXTURE_KB = 16;
const DELEGATION_FIXTURE_KB = 64;
const NONTERMINAL_FIXTURE_KB = 6 * 1024;
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
		req.on('error', reject);
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
	let parsed: any = raw.toString('utf8');
	try {
		parsed = JSON.parse(parsed);
	} catch {
		// leave as text/binary (payload stream case)
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

// Full listing (relative path, size, mtime) -- diagnostic only, so a leak report names the
// actual residual file(s) rather than just an aggregate byte delta.
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

// Polls until no blob file of ~`targetSize` bytes remains, or `timeoutMs` elapses. Distinguishes
// a slow-but-real async unlink from a genuine leak.
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

// Builds a payload-only fixture: no HTTP routes registered at all, just `kb` KB of genuinely
// random (non-repeating, gzip-incompressible) padding. Used for every probe that only cares
// about the payload_blob bytes, not live serving -- deliberately routeless so N of these
// deployed side-by-side in the same instance never collide over "/". The buffer is filled in one
// randomFillSync call rather than tiled from a smaller block: a tile below gzip's 32 KiB window
// compresses away to near-nothing, and the payload size is the thing under measurement here.
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

// Builds a fixture that DOES register a root static route -- used only by the single
// "deployed and running" probe, which needs a live HTTP route to hit. Only ONE of these may be
// active (restart:true'd) at a time in this suite, or root-path routes would collide.
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

async function deployBuffer(
	ctx: ContextWithHarper,
	project: string,
	buffer: Buffer,
	restart: boolean,
	auth = ctx.harper.admin
): Promise<{ status: number; deploymentId: string | undefined; raw: Buffer }> {
	const multipart = buildMultipartBody(
		{ operation: 'deploy_component', project, restart },
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
			while (Date.now() < deadline) {
				try {
					const probe = await fetch(`${ctx.harper.httpURL}/Beacon/`, {
						headers: {
							Authorization:
								'Basic ' + Buffer.from(`${ctx.harper.admin.username}:${ctx.harper.admin.password}`).toString('base64'),
						},
					});
					if (probe.status !== 404) break;
				} catch {
					/* not ready yet */
				}
				await sleep(250);
			}
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
			// deploy_component only responds once the row has reached a terminal status, so awaiting
			// the deploy and then deleting can never reach the guard -- it deletes against a row that
			// is already terminal. The recorder writes the row as 'pending' before the payload is
			// ingested (components/deploymentRecorder.ts's create()), so the in-flight row is visible
			// through list_deployments for the whole upload+install window. Deploy without awaiting,
			// catch the row there, and delete against it. NONTERMINAL_FIXTURE_KB is multi-MB to keep
			// that window comfortably wider than the poll interval.
			const fixtureDir = buildFixture(NONTERMINAL_FIXTURE_KB, 'QA-701 nonterminal');
			const packaged = await packageToBuffer(fixtureDir);
			const deployPromise = deployBuffer(ctx, 'qa701-nonterminal-app', packaged.buffer, false);

			let inFlightId: string | undefined;
			let inFlightStatus: string | undefined;
			const windowDeadline = Date.now() + 20000;
			while (Date.now() < windowDeadline) {
				const listed = await callOperation(ctx, { operation: 'list_deployments' });
				const row = (listed.body?.deployments ?? []).find(
					(d: any) => d.project === 'qa701-nonterminal-app' && !TERMINAL_STATUSES.includes(d.status)
				);
				if (row) {
					inFlightId = row.deployment_id;
					inFlightStatus = row.status;
					break;
				}
				if (!listed.body?.deployments) break; // list_deployments is not answering; fall through
			}

			if (inFlightId) {
				const delResp = await callOperation(ctx, {
					operation: 'delete_deployment_payload',
					deployment_id: inFlightId,
				});
				strictEqual(
					delResp.status,
					409,
					`delete on a non-terminal deployment (status='${inFlightStatus}') should 409, got ${delResp.status}: ${JSON.stringify(delResp.body)}`
				);
			} else {
				console.log(
					'[QA-701] 3: the deployment reached a terminal status before any poll observed it -- 409 window missed, not a defect.'
				);
			}

			const deployed = await deployPromise;
			strictEqual(
				deployed.status,
				200,
				`deploy expected 200, got ${deployed.status}: ${deployed.raw.toString('utf8')}`
			);
			ok(deployed.deploymentId);
			const settled = await getDeploymentWhenTerminal(ctx, deployed.deploymentId!);
			strictEqual(settled.body.status, 'success', `deploy should succeed: ${JSON.stringify(settled.body.error)}`);
			// The refused delete must not have touched the blob: it is still there once terminal.
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

			// The live route must be entirely unaffected -- payload_blob is the historical tarball
			// artifact, not the installed component copy the running worker actually serves from.
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

			// SU caller can still get a byte-identical download for a DIFFERENT, still-present blob
			// (sanity: the SU gate itself isn't broken by the presence of a delegated role).
			const suCheck = await callOperation(ctx, { operation: 'get_deployment', deployment_id: smallDeploymentId });
			ok(suCheck.status === 200, 'SU caller should still be able to read deployment metadata normally');
		});
	}
);
