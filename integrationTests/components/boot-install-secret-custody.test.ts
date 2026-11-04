/**
 * Boot-time application installs see the node's secret custody (harper#2780).
 *
 * A root-config application that is not yet installed is installed by `installApplications()` during
 * boot. Its install spawn needs custody to decrypt sealed (`enc:v1:`) SSH deploy keys and to resolve
 * registry credentials stored as secrets. Custody is itself a root built-in, so this pins that it is
 * started before that install runs: the install command must receive the decrypted SSH identity and the
 * resolved registry token.
 */
import { suite, test, before, after } from 'node:test';
import { deepStrictEqual, doesNotMatch, match } from 'node:assert';
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import YAML from 'yaml';
import {
	startHarper,
	killHarper,
	teardownHarper,
	sendOperation,
	type ContextWithHarper,
} from '@harperfast/integration-testing';

const FIXTURE_DIRECTORY = resolve(import.meta.dirname, 'fixtures/boot-install-secret-custody');
const APPLICATION_PACKAGE = resolve(import.meta.dirname, '../fixtures/application-template-1.0.0.tgz');
const APPLICATION_NAME = 'bootCustodyApp';
const SSH_KEY_FILE = 'boot-probe.key';
const SSH_KEY_PLAINTEXT =
	'-----BEGIN OPENSSH PRIVATE KEY-----\nboot-install-custody-probe\n-----END OPENSSH PRIVATE KEY-----\n';
const REGISTRY = 'https://registry.boot-custody.invalid/';
const REGISTRY_SECRET = 'bootCustodyRegistryToken';
const REGISTRY_TOKEN = 'boot-custody-registry-token-2780';

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
	modulusLength: 2048,
	publicKeyEncoding: { type: 'spki', format: 'pem' },
	privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const scratchDirectory = mkdtempSync(join(tmpdir(), 'harper-boot-custody-'));
const custodyStartLog = join(scratchDirectory, 'custody-starts.log');
const ENV = {
	HARPER_BUILTIN_COMPONENTS:
		'secretCustody=@/integrationTests/components/fixtures/boot-install-secret-custody/custody.mjs',
	BOOT_CUSTODY_PRIVATE_KEY_B64: Buffer.from(privateKey).toString('base64'),
	BOOT_CUSTODY_START_LOG: custodyStartLog,
};
const CONFIG = { secretCustody: true, logging: { level: 'debug' } };

// hdb.log can stay in the first boot's log directory after a restart, so read every candidate.
function readInstanceLogs(logDirectories: string[]): string {
	return logDirectories
		.map((directory) => join(directory, 'hdb.log'))
		.filter((path) => existsSync(path))
		.map((path) => readFileSync(path, 'utf8'))
		.join('\n');
}

function addRootApplication(dataRootDir: string, name: string, entry: object): void {
	const configPath = join(dataRootDir, 'harper-config.yaml');
	const document = YAML.parseDocument(readFileSync(configPath, 'utf8'));
	document.setIn([name], entry);
	writeFileSync(configPath, String(document));
}

suite(
	'boot-time application install sees secret custody (#2780)',
	{ skip: process.platform === 'win32' },
	(ctx: ContextWithHarper) => {
		let probePath: string;
		const logDirectories: string[] = [];

		before(async () => {
			await startHarper(ctx, { config: CONFIG, env: ENV });
			logDirectories.push(ctx.harper.logDir ?? join(ctx.harper.dataRootDir, 'log'));
			await sendOperation(ctx.harper, {
				operation: 'set_secret',
				name: REGISTRY_SECRET,
				value: REGISTRY_TOKEN,
				grants: [APPLICATION_NAME],
			});
			await killHarper(ctx);

			// While Harper is stopped: seal a deploy key into the ssh dir and add an application that is
			// not installed yet, so the next boot installs it.
			const { dataRootDir } = ctx.harper;
			const { encryptEnvelope, fingerprintOf } = await import(
				pathToFileURL(resolve(import.meta.dirname, '../../dist/utility/secretEnvelope.js')).toString()
			);
			mkdirSync(join(dataRootDir, 'ssh'), { recursive: true });
			writeFileSync(
				join(dataRootDir, 'ssh', SSH_KEY_FILE),
				'enc:v1:' + encryptEnvelope(SSH_KEY_PLAINTEXT, publicKey, fingerprintOf(publicKey)),
				{ mode: 0o600 }
			);
			probePath = join(dataRootDir, 'install-probe.json');
			addRootApplication(dataRootDir, APPLICATION_NAME, {
				package: APPLICATION_PACKAGE,
				install: { command: `node ${join(FIXTURE_DIRECTORY, 'installProbe.mjs')} ${probePath} ${SSH_KEY_FILE}` },
				credentials: [{ registry: REGISTRY, secret: REGISTRY_SECRET }],
			});

			await startHarper(ctx, { config: CONFIG, env: ENV });
			logDirectories.push(ctx.harper.logDir ?? join(ctx.harper.dataRootDir, 'log'));
		});

		after(async () => {
			await teardownHarper(ctx);
			rmSync(scratchDirectory, { recursive: true, force: true });
		});

		test('the install spawn receives the decrypted SSH identity and the resolved registry token', () => {
			const log = readInstanceLogs(logDirectories);
			match(
				log,
				new RegExp(`\\[${APPLICATION_NAME}:spawn:node\\]: Executing`),
				'the boot install log must be readable'
			);
			doesNotMatch(log, /no secret custody is registered/);
			doesNotMatch(log, new RegExp(`Could not resolve credentials for application ${APPLICATION_NAME}`));
			const probe = JSON.parse(readFileSync(probePath, 'utf8'));
			deepStrictEqual(probe.sshKey, SSH_KEY_PLAINTEXT);
			match(probe.npmrc ?? '', new RegExp(`:_authToken=${REGISTRY_TOKEN}$`, 'm'));
		});

		test('custody starts once per boot: the root load reuses the start made before installing', () => {
			deepStrictEqual(readFileSync(custodyStartLog, 'utf8'), 'start\n'.repeat(2));
		});
	}
);
