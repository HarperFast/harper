/**
 * SQA-89 — the documented deploy-only role (a role `operations` allowlist naming `deploy_component`, PR #2809)
 * and the stored secrets it can reach through `deploy_component` `credentials`, measured on main.
 *
 * Documented contract under test (docs origin/main 34b029d9):
 *   - learn/developers/deploying-from-ci.mdx:73-87 — the deploy-only role is
 *     `{"operations":["deploy_component","get_job","get_deployment","registration_info"]}`; "Deploying is still
 *     administrative authority, because the deployed component runs inside the Harper process"; a literal `token`
 *     "needs super_user"; "this role deploys private sources through a secret reference".
 *   - reference/users-and-roles/overview.md:84 — the secrets-store operations "cannot be granted by listing them";
 *     :90 — `deploy_component` is "granted as listed now".
 *   - reference/security/secrets.md:14 — secret values "are never returned by any read operation".
 *   - reference/operations-api/operations.md:1013-1020 — a `secret` reference "names an existing store row directly";
 *     a git entry's `host` is "the bare git host the credential applies to"; a registry entry's `registry` is "the
 *     registry URL or host the credential applies to".
 *
 * Question (SF-58's open legs 5 and 2): on main, which hdb_secret rows can the allowlist deployer have decrypted and
 * delivered to a host or registry it names, when it cannot call any secrets-store read operation? The oracles are a
 * loopback git HTTP server and a loopback npm registry, both answering 401 to everything and recording the
 * Authorization header they receive (gitCredentialServer.ts serves plaintext to a loopback host; the transient
 * .npmrc keys the token by registry host, scheme stripped).
 *
 *   P   the allowlist user cannot read, write or grant secrets (403 on list_secrets / set_secret / grant_secret);
 *       a credential-less call is 401; the admin's list_secrets carries no plaintext
 *   A   git kind — the allowlist user deploys `shop` referencing a row granted to `shop` for a loopback host it
 *       names → the loopback host receives `x-access-token:<plaintext>` (the documented CI flow)
 *   B   the allowlist user deploys `other-team`, referencing a row granted ONLY to `other-team` → served: nothing on
 *       main limits which component names an allowlist role may deploy
 *   C   a `processEnv: true` row referenced for `shop` → served without any grant (resolveCredentials skips the
 *       grant check for processEnv rows)
 *   D   registry kind — the allowlist user deploys `shop` from `sqa89-private-pkg@1.0.0` with
 *       `{ registry: 'http://127.0.0.1:<port>/', secret }` → the loopback registry receives `Bearer <plaintext>`
 *   E   controls — a row granted only to `other-team`, referenced while deploying `shop` → 403 and no request;
 *       a reference to a name that does not exist → 404 (the status pair is a secret-name existence oracle for a
 *       caller that cannot list_secrets — recorded, not judged here)
 *   F   a literal `token` from the allowlist user → 403 super_user, no request, no row sealed
 *
 * Run (harper main):
 *   TMPDIR=$HOME/dev/tmp/agent-tmp npm run test:integration -- "integrationTests/security/allowlist-deploy-credentials.test.ts"
 */
import { suite, test, before, after } from 'node:test';
import { ok, strictEqual, match, notStrictEqual } from 'node:assert';
import { createServer, type Server } from 'node:http';
import { generateKeyPairSync } from 'node:crypto';
import { join } from 'node:path';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import request from 'supertest';

import {
	startHarper,
	teardownHarper,
	DEFAULT_ADMIN_USERNAME,
	DEFAULT_ADMIN_PASSWORD,
	type ContextWithHarper,
} from '@harperfast/integration-testing';

const CI_ROLE = 'sqa89_ci_deploy';
const CI = { username: 'sqa89_ci_deploy', password: 'Ci-pw-89!' };
// deploying-from-ci.mdx:76 verbatim
const CI_OPERATIONS = ['deploy_component', 'get_job', 'get_deployment', 'registration_info'];
const TMP = process.env.TMPDIR ?? join(process.env.HOME ?? '/tmp', 'dev', 'tmp');
const skipSuite = process.platform === 'win32' || process.env.HARPER_RUNTIME === 'bun';

// Tokens are generated here, never stored in state. Distinguishable per row.
const TOKEN_SHOP = `tok-shop-${Math.random().toString(36).slice(2, 10)}`;
const TOKEN_OTHER = `tok-other-${Math.random().toString(36).slice(2, 10)}`;
const TOKEN_GLOBAL = `tok-global-${Math.random().toString(36).slice(2, 10)}`;
const TOKEN_LITERAL = `tok-literal-${Math.random().toString(36).slice(2, 10)}`;

const { privateKey } = generateKeyPairSync('rsa', {
	modulusLength: 2048,
	publicKeyEncoding: { type: 'spki', format: 'pem' },
	privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

type Res = { status: number; body: any; text: string };
type Hit = { server: 'git' | 'registry'; method: string; url: string; authorization?: string; decoded?: string };

suite(
	'SQA-89 allowlist deploy_component and the secrets it can deliver (main)',
	{ skip: skipSuite },
	(ctx: ContextWithHarper) => {
		let gitServer: Server;
		let registryServer: Server;
		let gitHost: string; // `127.0.0.1:<port>` — the host the deployer names in `credentials[].host`
		let registryUrl: string; // `http://127.0.0.1:<port>/` — the registry the deployer names
		let hits: Hit[] = [];
		let scratch: string;

		const opsUrl = () => ctx.harper.operationsAPIURL;
		const asAdmin = (body: Record<string, unknown>): Promise<Res> =>
			request(opsUrl()).post('/').auth(DEFAULT_ADMIN_USERNAME, DEFAULT_ADMIN_PASSWORD).send(body) as any;
		const asCi = (body: Record<string, unknown>): Promise<Res> =>
			request(opsUrl()).post('/').auth(CI.username, CI.password).send(body) as any;
		const asNobody = (body: Record<string, unknown>): Promise<Res> => request(opsUrl()).post('/').send(body) as any;

		const gitPackage = (repo: string) => `git+http://${gitHost}/${repo}.git`;
		const authHits = (server: Hit['server']) => hits.filter((h) => h.server === server && h.authorization);
		const serverHits = (server: Hit['server']) => hits.filter((h) => h.server === server);
		const resetHits = () => (hits = []);

		function decodeAuth(authorization: string): string {
			const [scheme, value] = authorization.split(' ');
			if (scheme === 'Basic') return `Basic ${Buffer.from(value, 'base64').toString('utf8')}`;
			return `${scheme} ${value}`;
		}

		function recorder(server: Hit['server']) {
			return (req: any, res: any) => {
				const hit: Hit = {
					server,
					method: req.method ?? '',
					url: req.url ?? '',
					authorization: req.headers.authorization,
				};
				if (hit.authorization) hit.decoded = decodeAuth(hit.authorization);
				hits.push(hit);
				res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="sqa89"', 'Content-Type': 'application/json' });
				res.end('{"error":"auth required"}');
			};
		}

		async function secretRows(): Promise<any[]> {
			const list = await asAdmin({ operation: 'list_secrets' });
			strictEqual(list.status, 200, list.text);
			return Array.isArray(list.body) ? list.body : (list.body?.secrets ?? []);
		}

		before(async () => {
			await mkdir(TMP, { recursive: true });
			scratch = await mkdtemp(join(TMP, 'sqa89-'));

			// Oracle 1: a loopback "git host". git's first request is GET /<repo>.git/info/refs?service=git-upload-pack;
			// after a 401 it asks the per-deploy credential helper and retries with Basic auth; the second 401 ends the
			// clone (the deploy fails) — the retried request's header is what we read.
			gitServer = createServer(recorder('git'));
			await new Promise<void>((resolve) => gitServer.listen(0, '127.0.0.1', resolve));
			gitHost = `127.0.0.1:${(gitServer.address() as any).port}`;
			// Oracle 2: a loopback "npm registry". `npm pack <name>@<ver>` fetches GET /<name> with the registry's
			// configured _authToken as `Authorization: Bearer`; 401 makes npm fail (E401) and the deploy fails.
			registryServer = createServer(recorder('registry'));
			await new Promise<void>((resolve) => registryServer.listen(0, '127.0.0.1', resolve));
			registryUrl = `http://127.0.0.1:${(registryServer.address() as any).port}/`;

			await startHarper(ctx, {
				config: {
					threads: { count: 1 },
					authentication: { authorizeLocal: false },
					secretCustody: true,
					logging: { level: 'debug' },
				},
				env: {
					TMPDIR: TMP,
					HARPER_BUILTIN_COMPONENTS: 'secretCustody=@/integrationTests/security/allowlist-deploy-custody/custody.mjs',
					BOOT_CUSTODY_PRIVATE_KEY_B64: Buffer.from(privateKey).toString('base64'),
					BOOT_CUSTODY_START_LOG: join(scratch, 'custody-starts.log'),
				},
			});

			const role = await asAdmin({
				operation: 'add_role',
				role: CI_ROLE,
				permission: { super_user: false, operations: CI_OPERATIONS },
			});
			strictEqual(role.status, 200, `add_role: ${role.text}`);
			const user = await asAdmin({ operation: 'add_user', role: CI_ROLE, active: true, ...CI });
			strictEqual(user.status, 200, `add_user: ${user.text}`);

			for (const [name, value, extra] of [
				['sqa89.shop', TOKEN_SHOP, { grants: ['shop'] }],
				['sqa89.other', TOKEN_OTHER, { grants: ['other-team'] }],
				['sqa89.global', TOKEN_GLOBAL, { processEnv: true }],
			] as const) {
				const r = await asAdmin({ operation: 'set_secret', name, value, ...extra });
				strictEqual(r.status, 200, `set_secret ${name}: ${r.text}`);
			}
		});

		after(async () => {
			await teardownHarper(ctx);
			await new Promise<void>((resolve) => gitServer.close(() => resolve()));
			await new Promise<void>((resolve) => registryServer.close(() => resolve()));
			await rm(scratch, { recursive: true, force: true });
		});

		test('P: the allowlist user cannot read, write or grant secrets; no read operation returns a value', async () => {
			const anon = await asNobody({ operation: 'list_secrets' });
			strictEqual(anon.status, 401, `credential-less call: ${anon.status} ${anon.text.slice(0, 200)}`);

			const rows = await secretRows();
			for (const name of ['sqa89.shop', 'sqa89.other', 'sqa89.global']) {
				ok(
					rows.some((r: any) => r.name === name),
					`${name} missing from list_secrets: ${JSON.stringify(rows).slice(0, 300)}`
				);
			}
			const listText = JSON.stringify(rows);
			for (const tok of [TOKEN_SHOP, TOKEN_OTHER, TOKEN_GLOBAL]) {
				ok(!listText.includes(tok), `list_secrets returned a plaintext token: ${listText.slice(0, 300)}`);
			}

			// overview.md:84 — secrets-store operations are refused for a role that lists them, and this role does not
			// even list them (gate 1 refuses). Measure the status each refusal carries.
			const ciList = await asCi({ operation: 'list_secrets' });
			const ciSet = await asCi({ operation: 'set_secret', name: 'sqa89.ci', value: 'x' });
			const ciGrant = await asCi({ operation: 'grant_secret', name: 'sqa89.other', component: 'shop' });
			console.log(
				`[sqa89 P] ci list_secrets=${ciList.status} ${ciList.text.slice(0, 120)} | set_secret=${ciSet.status} ${ciSet.text.slice(0, 120)} | grant_secret=${ciGrant.status} ${ciGrant.text.slice(0, 120)}`
			);
			strictEqual(ciList.status, 403);
			strictEqual(ciSet.status, 403);
			strictEqual(ciGrant.status, 403);
			ok(
				!ciList.text.includes(TOKEN_SHOP) && !ciList.text.includes(TOKEN_OTHER) && !ciList.text.includes(TOKEN_GLOBAL)
			);
			// The grant must not have landed.
			const after = await secretRows();
			const other = after.find((r: any) => r.name === 'sqa89.other');
			ok(other, 'sqa89.other row vanished');
			ok(!(other.grants ?? []).includes('shop'), `grant_secret by the allowlist user landed: ${JSON.stringify(other)}`);
			// The documented deploy-only role can call its listed read operation (sanity: the role works at all).
			const reg = await asCi({ operation: 'registration_info' });
			strictEqual(reg.status, 200, `registration_info: ${reg.status} ${reg.text.slice(0, 200)}`);
		});

		test('A: git kind — a row granted to shop, deployed as shop by the allowlist user, is served to the host it names', async () => {
			resetHits();
			const r = await asCi({
				operation: 'deploy_component',
				project: 'shop',
				package: gitPackage('shop'),
				credentials: [{ host: gitHost, secret: 'sqa89.shop' }],
			});
			console.log(`[sqa89 A] deploy status=${r.status} body=${r.text.slice(0, 200)}`);
			console.log(`[sqa89 A] hits=${JSON.stringify(hits)}`);
			notStrictEqual(r.status, 403, `the documented deploy-only role was refused: ${r.status} ${r.text.slice(0, 300)}`);
			ok(serverHits('git').length >= 1, 'the loopback git host was never contacted');
			const withAuth = authHits('git');
			ok(withAuth.length >= 1, `git never retried with a credential: ${JSON.stringify(hits)}`);
			strictEqual(withAuth[0].decoded, `Basic x-access-token:${TOKEN_SHOP}`);
			notStrictEqual(r.status, 200, 'the 401-only git host cannot have produced a successful deploy');
		});

		test('B: a row granted only to other-team is served when the allowlist user deploys other-team', async () => {
			resetHits();
			const r = await asCi({
				operation: 'deploy_component',
				project: 'other-team',
				package: gitPackage('other-team'),
				credentials: [{ host: gitHost, secret: 'sqa89.other' }],
			});
			console.log(`[sqa89 B] deploy status=${r.status} body=${r.text.slice(0, 200)} hits=${JSON.stringify(hits)}`);
			notStrictEqual(r.status, 403, `refused: ${r.status} ${r.text.slice(0, 300)}`);
			const withAuth = authHits('git');
			ok(withAuth.length >= 1, `git never retried with a credential: ${JSON.stringify(hits)}`);
			strictEqual(withAuth[0].decoded, `Basic x-access-token:${TOKEN_OTHER}`);
		});

		test('C: a processEnv row is served for any component, with no grant', async () => {
			resetHits();
			const r = await asCi({
				operation: 'deploy_component',
				project: 'shop',
				package: gitPackage('shop'),
				credentials: [{ host: gitHost, secret: 'sqa89.global' }],
			});
			console.log(`[sqa89 C] deploy status=${r.status} body=${r.text.slice(0, 200)} hits=${JSON.stringify(hits)}`);
			notStrictEqual(r.status, 403, `refused: ${r.status} ${r.text.slice(0, 300)}`);
			const withAuth = authHits('git');
			ok(withAuth.length >= 1, `git never retried with a credential: ${JSON.stringify(hits)}`);
			strictEqual(withAuth[0].decoded, `Basic x-access-token:${TOKEN_GLOBAL}`);
		});

		test('D: registry kind — the row is sent as a Bearer token to the registry the allowlist user names', async () => {
			resetHits();
			const r = await asCi({
				operation: 'deploy_component',
				project: 'shop',
				package: 'sqa89-private-pkg@1.0.0',
				credentials: [{ registry: registryUrl, secret: 'sqa89.shop' }],
			});
			console.log(`[sqa89 D] deploy status=${r.status} body=${r.text.slice(0, 300)}`);
			console.log(`[sqa89 D] hits=${JSON.stringify(hits)}`);
			notStrictEqual(r.status, 403, `refused: ${r.status} ${r.text.slice(0, 300)}`);
			ok(serverHits('registry').length >= 1, `the loopback registry was never contacted: ${r.text.slice(0, 400)}`);
			const withAuth = authHits('registry');
			ok(withAuth.length >= 1, `npm sent no credential to the registry: ${JSON.stringify(hits)}`);
			strictEqual(withAuth[0].decoded, `Bearer ${TOKEN_SHOP}`);
			notStrictEqual(r.status, 200, 'the 401-only registry cannot have produced a successful deploy');
		});

		test('E: controls — a row not granted to the deployed component is refused with no request; a missing name is 404', async () => {
			resetHits();
			const notGranted = await asCi({
				operation: 'deploy_component',
				project: 'shop',
				package: gitPackage('shop'),
				credentials: [{ host: gitHost, secret: 'sqa89.other' }],
			});
			console.log(
				`[sqa89 E1] status=${notGranted.status} body=${notGranted.text.slice(0, 300)} hits=${JSON.stringify(hits)}`
			);
			strictEqual(
				notGranted.status,
				403,
				`expected 403 not-granted: ${notGranted.status} ${notGranted.text.slice(0, 300)}`
			);
			match(notGranted.text, /not granted to component 'shop'/);
			strictEqual(hits.length, 0, 'no host may be contacted when the credential is refused');

			resetHits();
			const missing = await asCi({
				operation: 'deploy_component',
				project: 'shop',
				package: gitPackage('shop'),
				credentials: [{ host: gitHost, secret: 'sqa89.does-not-exist' }],
			});
			console.log(
				`[sqa89 E2] status=${missing.status} body=${missing.text.slice(0, 300)} hits=${JSON.stringify(hits)}`
			);
			strictEqual(missing.status, 404, `expected 404 unknown-secret: ${missing.status} ${missing.text.slice(0, 300)}`);
			strictEqual(hits.length, 0);
			// Positive control for the oracle pair: the allowlist user can tell an existing, ungranted name (403) from an
			// absent one (404) without any secrets-store read operation.
			notStrictEqual(notGranted.status, missing.status);
		});

		test('F: a literal token from the allowlist user is refused as super_user-only; nothing is sealed or served', async () => {
			resetHits();
			const before = (await secretRows()).map((r: any) => r.name).sort();
			const r = await asCi({
				operation: 'deploy_component',
				project: 'shop',
				package: gitPackage('shop'),
				credentials: [{ host: gitHost, token: TOKEN_LITERAL }],
			});
			console.log(`[sqa89 F] status=${r.status} body=${r.text.slice(0, 300)} hits=${JSON.stringify(hits)}`);
			strictEqual(r.status, 403, `expected 403 super_user-only: ${r.status} ${r.text.slice(0, 300)}`);
			strictEqual(hits.length, 0, 'no host may be contacted when the literal token is refused');
			const afterNames = (await secretRows()).map((r: any) => r.name).sort();
			strictEqual(JSON.stringify(afterNames), JSON.stringify(before), `a row was sealed: ${afterNames}`);
			ok(
				!afterNames.some((n: string) => n.startsWith('deploy.shop.git.')),
				'the derived deploy.shop.git.* row must not exist'
			);
		});
	}
);
