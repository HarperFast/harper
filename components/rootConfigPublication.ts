import { access, constants } from 'node:fs/promises';
import { dirname } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import * as env from '../utility/environment/environmentManager.ts';
import {
	atomicWriteFile,
	getRootConfigFilePath,
	getConfigObj,
	parseYamlDoc,
	syncFileToStorageSync,
} from '../config/configUtils.ts';
import { composeReassertedEnvConfig, REASSERTING_CONFIG_ENV_VARS } from '../config/harperConfigEnvVars.ts';
import logger, { errorForLog } from '../utility/logging/harper_logger.ts';
import { ServerError } from '../utility/errors/hdbError.ts';
import { ComponentPreparationLockTimeoutError, withComponentPreparationLock } from './componentPreparationLock.ts';
import { isThreadRunning } from '../server/threads/manageThreads.js';

/**
 * What an activation does to the component's entry in the root config, recorded in the activation journal
 * and applied after the commit rename — by the activation itself, or by recovery when it rolls forward.
 *
 * - `keep`: no opinion. A boot re-install and a clone install FROM the config, so they must not touch it.
 * - `set`: a package deploy publishes the entry its build was declared with.
 * - `unset-package`: a payload deploy owns no registry provenance, so the keys that say how to install the
 *   component from one no longer describe what is live. "No package" is an opinion: left in place, a cold
 *   install resolves the old package over the payload release.
 * - `remove`: `drop_component`. Never journaled, because no activation removes a whole entry.
 */
export type RootConfigEffect =
	{ kind: 'keep' } | { kind: 'set'; entry: Record<string, unknown> } | { kind: 'unset-package' } | { kind: 'remove' };

const ROOT_CONFIG_EFFECT_KINDS = new Set(['keep', 'set', 'unset-package', 'remove']);
const PACKAGE_INSTALL_KEYS = ['package', 'install', 'credentials'];
// Every holder is one parse-and-rewrite of a small file, so a wait this long means the holder is wedged, not
// busy. Not renewed for a live holder: a config write is not an `npm install`.
const ROOT_CONFIG_LOCK_WAIT_MS = 30_000;

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Shape only. A `set` entry is additionally validated as an application config by whoever journals or reads it. */
export function isRootConfigEffect(value: unknown): value is RootConfigEffect {
	if (!isPlainObject(value) || typeof value.kind !== 'string' || !ROOT_CONFIG_EFFECT_KINDS.has(value.kind)) {
		return false;
	}
	return value.kind !== 'set' || isPlainObject(value.entry);
}

/**
 * The effect a deploy's declaration amounts to: an entry to publish, or `null` for a payload build. The entry
 * goes through the same JSON round trip the journal does, so what an activation applies in-process is exactly
 * what recovery would apply from the journal — an `undefined` install option would otherwise make the two
 * differ.
 */
export function rootConfigEffectFromDeclaration(rootConfig: Record<string, unknown> | null): RootConfigEffect {
	return rootConfig ? { kind: 'set', entry: JSON.parse(JSON.stringify(rootConfig)) } : { kind: 'unset-package' };
}

/**
 * Serialize every runtime read-modify-write of the root config document. Keyed by the file actually parsed
 * and written, which is fixed for the life of the process — not by a configured path, which
 * `set_configuration` can move under a concurrent writer. Lock order is always component preparation lock
 * first, then this one.
 */
export async function withRootConfigPublicationLock<T>(publish: () => Promise<T>): Promise<T> {
	let acquired = false;
	try {
		return await withComponentPreparationLock(
			getRootConfigFilePath(),
			() => {
				acquired = true;
				return publish();
			},
			{
				purpose: 'root-config',
				timeoutMs: ROOT_CONFIG_LOCK_WAIT_MS,
				renewTimeoutWhileOwnerAlive: false,
				// Without this a ticket left by a crashed worker of THIS process reads as live, and every config
				// writer on the node times out behind it until the process restarts.
				isOwnerAlive: (owner) => owner.pid !== process.pid || isThreadRunning(owner.threadId),
				onWait: (owner) =>
					logger.debug?.(
						'Waiting for the root config publication lock' +
							(owner ? ` held by process ${owner.pid}, thread ${owner.threadId}` : '')
					),
				onReleaseError: (error) =>
					logger.warn('Failed to release the root config publication lock:', errorForLog(error)),
			}
		);
	} catch (error) {
		// Not the component preparation lock's timeout class: recovery reads that one as "a live deploy of
		// this component holds its lock and will settle its own journal", which is not what this wait means.
		if (acquired || !(error instanceof ComponentPreparationLockTimeoutError)) throw error;
		const busy = new ServerError(`The root configuration is busy; ${error.message}`, 503);
		busy.cause = error;
		throw busy;
	}
}

/**
 * Apply an effect to the component's root-config entry, and return only once the entry as the effect wants it
 * is on storage and has survived the config refresh — even when it was already in place, because a crashed
 * predecessor can have renamed the file in without flushing it. Idempotent, so recovery can re-apply a journal after
 * a crash at any point. Leaves THIS thread's memoized config agreeing with the file, which is what lets a boot-time
 * recovery publish before `installApplications()` reads the config it installs from. Returns whether the file
 * changed.
 */
export async function applyRootConfigEffect(component: string, effect: RootConfigEffect): Promise<boolean> {
	if (effect.kind === 'keep') return false;
	// Answered without the lock when neither the file nor this thread's view of the entry needs anything: the lock
	// needs write access to the config's directory, and a node whose config is readable but not writable still
	// takes payload deploys. Any refresh stays under the lock, because on the main thread it can rewrite the file.
	// Safe unlocked: the file is only replaced by rename.
	const unlocked = readRootConfigChange(component, effect);
	if (!unlocked.changed && isDeepStrictEqual(getConfigObj()?.[component], unlocked.configDoc.toJSON()?.[component])) {
		syncFileToStorageSync(unlocked.configFilePath);
		return false;
	}
	return withRootConfigPublicationLock(async () => {
		const { configFilePath, configDoc, changed } = readRootConfigChange(component, effect);
		assertEnvLayersKeepEffect(component, effect, configDoc.toJSON() ?? {});
		if (changed) atomicWriteFile(configFilePath, String(configDoc), { durable: true });
		else syncFileToStorageSync(configFilePath);
		// Inside the lock: on the main thread a refresh re-applies the env config layers and can rewrite the file.
		env.initSync(true);
		const contradicted = contradictedKeys(parseYamlDoc(configFilePath).toJSON()?.[component], effect);
		if (contradicted.length > 0) {
			throw new ServerError(
				`The root config entry of ${component} did not take effect: after the config refresh, ${configFilePath} ` +
					`contradicts it at ${formatKeys(component, contradicted)}`
			);
		}
		return changed;
	});
}

/**
 * Refuse an effect this node could not publish, or that would not last, while refusing still changes nothing: the
 * publish runs after the commit rename, and a document that does not parse, a directory this process cannot write,
 * or a config env var that reasserts a key the effect changes fails it at every start after. Only static conditions
 * are caught; the publish can still fail.
 */
export async function assertRootConfigEffectPublishable(component: string, effect: RootConfigEffect): Promise<void> {
	if (effect.kind === 'keep') return;
	const { configFilePath, configDoc, changed } = readRootConfigChange(component, effect);
	assertEnvLayersKeepEffect(component, effect, configDoc.toJSON() ?? {});
	if (!changed) return;
	const configDirPath = dirname(configFilePath);
	try {
		await access(configDirPath, constants.W_OK);
	} catch (error) {
		const refusal = new ServerError(
			`Cannot deploy ${component}: its root config entry changes with this release, and ${configDirPath} is not ` +
				`writable, so the entry could not be published once the release went live: ${errorMessage(error)}`
		);
		refusal.cause = error;
		throw refusal;
	}
}

function readRootConfigChange(component: string, effect: RootConfigEffect) {
	const configFilePath = getRootConfigFilePath();
	const configDoc = parseYamlDoc(configFilePath);
	// Refused before anything is applied: rewriting a document that did not parse cleanly writes back only what
	// the parser recovered.
	if (configDoc.errors?.length > 0) {
		throw new Error(
			`Cannot publish the root config entry of ${component}: ${configFilePath} does not parse: ${configDoc.errors}`
		);
	}
	return { configFilePath, configDoc, changed: applyEffectToDocument(configDoc, component, effect) };
}

/**
 * HARPER_CONFIG and HARPER_SET_CONFIG rewrite every key they name at each start and each config refresh, so an
 * effect they contradict would be reported published and then undone — a package activation left live under the
 * forced entry, or a dropped component's entry put back.
 */
function assertEnvLayersKeepEffect(
	component: string,
	effect: RootConfigEffect,
	resultingConfig: Record<string, unknown>
): void {
	if (effect.kind === 'keep') return;
	const reasons: string[] = [];
	for (const envVarName of REASSERTING_CONFIG_ENV_VARS) {
		if (!process.env[envVarName]) continue;
		const keys = contradictedKeys(composeReassertedEnvConfig(resultingConfig, [envVarName])[component], effect);
		if (keys.length > 0) reasons.push(`${envVarName} sets ${formatKeys(component, keys)}`);
	}
	if (reasons.length === 0) return;
	const outcome =
		effect.kind === 'remove' ? 'the entry would come back' : 'the entry this release publishes would not last';
	throw new ServerError(
		`Cannot ${effect.kind === 'remove' ? 'remove' : 'publish'} the root config entry of ${component}: ` +
			`${reasons.join('; ')}, which the config environment reasserts at every start and config refresh, so ` +
			`${outcome}. Change the variable first.`,
		409
	);
}

/** The keys of the component's entry that contradict what the effect wants of it; none when the effect holds. */
function contradictedKeys(entry: unknown, effect: RootConfigEffect): string[] {
	switch (effect.kind) {
		case 'keep':
			return [];
		case 'set':
			return leafPaths(effect.entry).filter(
				(keyPath) => !isDeepStrictEqual(valueAt(entry, keyPath), valueAt(effect.entry, keyPath))
			);
		case 'unset-package':
			return isPlainObject(entry) ? PACKAGE_INSTALL_KEYS.filter((key) => key in entry) : [];
		case 'remove':
			if (entry === undefined) return [];
			return isPlainObject(entry) && Object.keys(entry).length > 0 ? Object.keys(entry) : [''];
	}
}

function leafPaths(value: Record<string, unknown>, prefix = ''): string[] {
	return Object.entries(value).flatMap(([key, child]) =>
		isPlainObject(child) && Object.keys(child).length > 0 ? leafPaths(child, `${prefix}${key}.`) : [`${prefix}${key}`]
	);
}

function valueAt(value: unknown, keyPath: string): unknown {
	for (const key of keyPath.split('.')) {
		if (!isPlainObject(value)) return undefined;
		value = value[key];
	}
	return value;
}

function formatKeys(component: string, keys: string[]): string {
	return keys.map((key) => (key ? `${component}.${key}` : component)).join(', ');
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function applyEffectToDocument(configDoc: any, component: string, effect: RootConfigEffect): boolean {
	const current = configDoc.toJSON()?.[component];
	switch (effect.kind) {
		case 'keep':
			return false;
		case 'set':
			if (isDeepStrictEqual(current, effect.entry)) return false;
			if (configDoc.hasIn([component])) configDoc.setIn([component], effect.entry);
			else configDoc.addIn([component], effect.entry);
			return true;
		case 'unset-package': {
			if (!isPlainObject(current)) return false;
			const installKeys = PACKAGE_INSTALL_KEYS.filter((key) => key in current);
			if (installKeys.length === 0) return false;
			if (Object.keys(current).length === installKeys.length) configDoc.deleteIn([component]);
			else for (const key of installKeys) configDoc.deleteIn([component, key]);
			return true;
		}
		case 'remove':
			if (!configDoc.hasIn([component])) return false;
			configDoc.deleteIn([component]);
			return true;
	}
}
