/**
 * `harper renew-certs` when the effective `tls` config names no `privateKey`: renewal must
 * generate a key, replace the self-signed pair, and leave a root that `harper run` boots.
 */
import { suite, test, before, after } from 'node:test';
import assert from 'node:assert';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as yaml from 'yaml';
import {
	startHarper,
	killHarper,
	teardownHarper,
	sendOperation,
	type ContextWithHarper,
	type StartHarperOptions,
} from '@harperfast/integration-testing';
import { generateEd25519KeyPair, createCertificate, certToPem } from '../utils/security/certGenUtils.ts';

const run = promisify(execFile);
const CLI = resolve(import.meta.dirname, '../../dist/bin/harper.js');
const RENEW_TIMEOUT_MS = 120_000;

interface CertRow {
	name: string;
	is_authority: boolean;
	is_self_signed?: boolean | null;
	private_key_name?: string;
	details?: { serial_number?: string };
}

async function selfSignedSerials(ctx: ContextWithHarper) {
	const rows = (await sendOperation(ctx.harper, {
		operation: 'search_by_value',
		database: 'system',
		table: 'hdb_certificate',
		search_attribute: 'name',
		search_value: '*',
		get_attributes: ['*'],
	})) as CertRow[];
	const selfSigned = rows.filter((row) => row.is_self_signed === true);
	const ca = selfSigned.filter((row) => row.is_authority);
	const cert = selfSigned.filter((row) => !row.is_authority);
	assert.equal(ca.length, 1, `expected one self-signed CA row, got ${JSON.stringify(selfSigned)}`);
	assert.equal(cert.length, 1, `expected one self-signed certificate row, got ${JSON.stringify(selfSigned)}`);
	return { ca: ca[0].details?.serial_number, cert: cert[0].details?.serial_number };
}

function getConfigPath(ctx: ContextWithHarper): string {
	const harperConfig = join(ctx.harper.dataRootDir, 'harper-config.yaml');
	return existsSync(harperConfig) ? harperConfig : join(ctx.harper.dataRootDir, 'harperdb-config.yaml');
}

async function renewCerts(ctx: ContextWithHarper, options: StartHarperOptions) {
	try {
		const { stdout, stderr } = await run(process.execPath, [CLI, 'renew-certs'], {
			env: {
				...process.env,
				...options.env,
				// the same env startHarper gives the server: its HARPER_SET_CONFIG and isolated HOME
				HARPER_SET_CONFIG: JSON.stringify(options.config),
				HOME: ctx.harper.dataRootDir,
				USERPROFILE: ctx.harper.dataRootDir,
				ROOTPATH: ctx.harper.dataRootDir,
			},
			timeout: RENEW_TIMEOUT_MS,
		});
		return { code: 0, output: stdout + stderr };
	} catch (error: any) {
		return { code: error.code ?? 1, output: `${error.stdout ?? ''}${error.stderr ?? ''}` };
	}
}

function renewArm(name: string, options: () => StartHarperOptions, editConfig?: (ctx: ContextWithHarper) => void) {
	suite(name, (ctx: ContextWithHarper) => {
		let serialsBefore: { ca?: string; cert?: string };
		let renew: { code: number | string; output: string };

		before(async () => {
			await startHarper(ctx, options());
			serialsBefore = await selfSignedSerials(ctx);
			await killHarper(ctx);
			editConfig?.(ctx);
			renew = await renewCerts(ctx, options());
		});

		after(async () => {
			await teardownHarper(ctx);
		});

		test('renew-certs exits 0', () => {
			assert.equal(renew.code, 0, `renew-certs exited ${renew.code}:\n${renew.output.slice(-2000)}`);
			assert.match(renew.output, /Successfully renewed self-signed certificates/);
		});

		test('the node restarts with a renewed self-signed pair', async () => {
			await startHarper(ctx, options());
			const serialsAfter = await selfSignedSerials(ctx);
			assert.notEqual(serialsAfter.ca, serialsBefore.ca, 'self-signed CA serial must change');
			assert.notEqual(serialsAfter.cert, serialsBefore.cert, 'self-signed certificate serial must change');
			// the new pair must come from renew-certs, not from the restart regenerating a missing one;
			// a restart's main-thread log lines go to its stdout
			const restartOutput = ctx.harper.startupOutput?.stdout ?? '';
			assert.match(restartOutput, /\[main\/0\] \[info\]: Harper PID/, 'restart main-thread log not captured');
			assert.doesNotMatch(restartOutput, /A matching Certificate Authority and key was not found/);
			assert.doesNotMatch(restartOutput, /A suitable replication certificate was not found/);
		});
	});
}

suite('renew-certs with no tls.privateKey', () => {
	let certDir: string;
	let caPath: string;

	before(async () => {
		certDir = mkdtempSync(join(tmpdir(), 'harper-renew-certs-'));
		const subject = { CN: 'Harper Renew Certs Test Client CA' };
		const keys = await generateEd25519KeyPair();
		const ca = await createCertificate({
			serialNumber: 1,
			subject,
			issuer: subject,
			validDays: 30,
			issuerKey: keys.privateKey,
			subjectPublicKey: keys.publicKey,
			isCA: true,
		});
		caPath = join(certDir, 'ca.pem');
		writeFileSync(caPath, certToPem(ca));
	});

	after(() => {
		if (certDir) rmSync(certDir, { recursive: true, force: true });
	});

	renewArm('default install', () => ({ config: {} }));

	renewArm('array tls with a CA-only entry', () => ({ config: { tls: [{ certificateAuthority: caPath }] } }));

	renewArm(
		'object tls with privateKey removed from the config file',
		() => ({ config: {} }),
		(ctx) => {
			const configPath = getConfigPath(ctx);
			const doc = yaml.parseDocument(readFileSync(configPath, 'utf8'));
			assert.ok(doc.getIn(['tls', 'privateKey']), 'install should have written tls.privateKey');
			doc.deleteIn(['tls', 'privateKey']);
			writeFileSync(configPath, doc.toString());
		}
	);
});
