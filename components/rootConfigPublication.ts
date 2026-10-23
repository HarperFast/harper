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
 *   install resolves the old package over the payload release. A payload deploy that set any routing key also
 *   carries `routing`: every one of `PAYLOAD_ROUTING_KEYS`, `null` for a key the entry does not have.
 * - `remove`: `drop_component`. Never journaled, because no activation removes a whole entry.
 */
export type RootConfigEffect =
	| { kind: 'keep' }
	| { kind: 'set'; entry: Record<string, unknown> }
	| { kind: 'unset-package'; routing?: PayloadRouting }
	| { kind: 'remove' };

/** The root-config keys a payload deploy can set on its component's entry. */
export const PAYLOAD_ROUTING_KEYS = ['host', 'urlPath', 'isolated', 'branchedDatabases'] as const;
export type PayloadRouting = Partial<Record<(typeof PAYLOAD_ROUTING_KEYS)[number], unknown>>;

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
	if (value.kind === 'unset-package') return value.routing === undefined || isPayloadRoutingShape(value.routing);
	return value.kind !== 'set' || isPlainObject(value.entry);
}

/** Shape only: the values are validated as application config by whoever journals or reads them. */
export function isPayloadRoutingShape(value: unknown): value is PayloadRouting {
	return (
		isPlainObject(value) && Object.keys(value).every((key) => (PAYLOAD_ROUTING_KEYS as readonly string[]).includes(key))
	);
}

/**
 * The effect a deploy's declaration amounts to: an entry to publish, or `null` for a payload build, with the
 * routing keys it owns when it set any. Both go through the same JSON round trip the journal does, so what an
 * activation applies in-process is exactly what recovery would apply from the journal — an `undefined` install
 * option would otherwise make the two differ.
 */
export function rootConfigEffectFromDeclaration(
	rootConfig: Record<string, unknown> | null,
	routing?: PayloadRouting
): RootConfigEffect {
	if (rootConfig) return { kind: 'set', entry: JSON.parse(JSON.stringify(rootConfig)) };
	return routing ? { kind: 'unset-package', routing: JSON.parse(JSON.stringify(routing)) } : { kind: 'unset-package' };
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
		const refreshedDoc = parseYamlDoc(configFilePath);
		if (refreshedDoc.errors?.length > 0) {
			throw new Error(
				`The root config entry of ${component} cannot be confirmed: after the config refresh, ${configFilePath} ` +
					`does not parse: ${refreshedDoc.errors}`
			);
		}
		const contradicted = contradictedKeys(refreshedDoc.toJSON()?.[component], effect);
		if (contradicted.length > 0) {
			throw new ServerError(
				`The root config entry of ${component} did not take effect: after the config refresh, ${configFilePath} ` +
					`contradicts it at ${contradicted.map((keyPath) => formatKeyPath(component, keyPath)).join(', ')}`,
				409
			);
		}
		return changed;
	});
}

/**
 * Whether the root config file on disk names an entry for the component — true when it cannot tell, since a caller
 * deciding whether the entry is gone must not guess that it is.
 */
export function hasRootConfigEntry(component: string): boolean {
	try {
		const configDoc = parseYamlDoc(getRootConfigFilePath());
		return configDoc.errors?.length > 0 || configDoc.toJSON()?.[component] !== undefined;
	} catch {
		return true;
	}
}

/** The component's entry as the root config file on disk has it, which is what an effect is applied to. */
export function readRootConfigEntry(component: string): unknown {
	return readRootConfigChange(component, { kind: 'keep' }).configDoc.toJSON()?.[component];
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
	const setVars = REASSERTING_CONFIG_ENV_VARS.filter((envVarName) => process.env[envVarName]);
	if (setVars.length === 0) return;
	// Composed together, as a refresh applies them: HARPER_CONFIG yields to HARPER_SET_CONFIG on a key both name.
	const contradicted = contradictedKeys(composeReassertedEnvConfig(resultingConfig, setVars)[component], effect);
	if (contradicted.length === 0) return;
	const entryByVar = [...setVars].reverse().map((name) => [name, composeReassertedEnvConfig({}, [name])[component]]);
	const keysByVar = new Map<string, string[]>();
	for (const keyPath of contradicted) {
		// Attributed to the variable that wins it. A key none of them sets is an artifact of composing the document,
		// not something a refresh would do to it: composition splits a key with a dot in it into nested keys.
		const envVarName = entryByVar.find(([, entry]) => setsKey(entry, keyPath))?.[0];
		if (envVarName)
			keysByVar.set(envVarName, [...(keysByVar.get(envVarName) ?? []), formatKeyPath(component, keyPath)]);
	}
	if (keysByVar.size === 0) return;
	const reasons = [...keysByVar].map(([envVarName, keys]) => `${envVarName} sets ${keys.join(', ')}`);
	const outcome =
		effect.kind === 'remove' ? 'the next start would reinstall it' : 'the entry this release publishes would not last';
	throw new ServerError(
		`Cannot ${effect.kind === 'remove' ? 'remove' : 'publish'} the root config entry of ${component}: ` +
			`${reasons.join('; ')}, which the config environment reasserts at every start and config refresh, so ` +
			`${outcome}. Change the variable first.`,
		409
	);
}

/**
 * The keys, as paths into the component's entry, that contradict what the effect wants of it; none when the
 * effect holds. For a payload deploy and a drop that is only `package`, plus the routing keys a payload deploy
 * owns: a start installs a component from its entry only when the entry names one, so the other keys a variable
 * keeps for the name, `install` and `credentials` included, reinstall nothing.
 */
function contradictedKeys(entry: unknown, effect: RootConfigEffect): string[][] {
	switch (effect.kind) {
		case 'keep':
			return [];
		case 'set':
			return leafPaths(effect.entry).filter(
				(keyPath) => !isDeepStrictEqual(valueAt(entry, keyPath), valueAt(effect.entry, keyPath))
			);
		case 'unset-package':
		case 'remove': {
			const contradicted = isPlainObject(entry) && 'package' in entry ? [['package']] : [];
			if (effect.kind === 'unset-package') {
				for (const [key, wanted] of Object.entries(effect.routing ?? {})) {
					const actual = isPlainObject(entry) ? entry[key] : undefined;
					if (wanted === null ? actual !== undefined : !isDeepStrictEqual(actual, wanted)) contradicted.push([key]);
				}
			}
			return contradicted;
		}
	}
}

function leafPaths(value: Record<string, unknown>, prefix: string[] = []): string[][] {
	return Object.entries(value).flatMap(([key, child]) =>
		isPlainObject(child) && Object.keys(child).length > 0 ? leafPaths(child, [...prefix, key]) : [[...prefix, key]]
	);
}

function valueAt(value: unknown, keyPath: string[]): unknown {
	for (const key of keyPath) {
		if (!isPlainObject(value)) return undefined;
		value = value[key];
	}
	return value;
}

/** Whether an entry a variable composes on its own sets the key at `keyPath`, or one of its ancestors outright. */
function setsKey(entry: unknown, keyPath: string[]): boolean {
	let value = entry;
	for (const key of keyPath) {
		if (value === undefined) return false;
		if (!isPlainObject(value)) return true;
		value = value[key];
	}
	return value !== undefined;
}

function formatKeyPath(component: string, keyPath: string[]): string {
	return [component, ...keyPath].join('.');
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
			const entry = isPlainObject(current) ? current : undefined;
			const removed = new Set(entry ? PACKAGE_INSTALL_KEYS.filter((key) => key in entry) : []);
			const written: [string, unknown][] = [];
			for (const [key, wanted] of Object.entries(effect.routing ?? {})) {
				if (wanted === null) {
					if (entry && key in entry) removed.add(key);
				} else if (!isDeepStrictEqual(entry?.[key], wanted)) written.push([key, wanted]);
			}
			if (removed.size === 0 && written.length === 0) return false;
			if (!entry) {
				const created = Object.fromEntries(written);
				if (configDoc.hasIn([component])) configDoc.setIn([component], created);
				else configDoc.addIn([component], created);
			} else if (written.length === 0 && Object.keys(entry).every((key) => removed.has(key))) {
				configDoc.deleteIn([component]);
			} else {
				for (const key of removed) configDoc.deleteIn([component, key]);
				for (const [key, wanted] of written) configDoc.setIn([component, key], wanted);
			}
			return true;
		}
		case 'remove':
			if (!configDoc.hasIn([component])) return false;
			configDoc.deleteIn([component]);
			return true;
	}
}
