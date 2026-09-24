import { isDeepStrictEqual } from 'node:util';
import * as env from '../utility/environment/environmentManager.ts';
import { atomicWriteFile, getConfigFilePath, parseYamlDoc, syncFileToStorageSync } from '../config/configUtils.ts';
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
// The keys a package deploy publishes about HOW the component is installed. Everything else on the entry —
// `isolated`, `urlPath`, `host`, `branchedDatabases` — is runtime configuration a payload deploy does not own.
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
			getConfigFilePath(),
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
 * Apply an effect to the component's root-config entry under the publication lock, and return only once the
 * entry as the effect wants it is on storage — even when this call found it already in place, because a
 * crashed predecessor can have renamed the file in without flushing it. Idempotent, so recovery can re-apply
 * a journal after a crash at any point. Refreshes THIS thread's memoized config, which is what lets a boot-time
 * recovery publish before `installApplications()` reads the config it installs from. Returns whether the file
 * changed.
 */
export async function applyRootConfigEffect(component: string, effect: RootConfigEffect): Promise<boolean> {
	if (effect.kind === 'keep') return false;
	const changed = await withRootConfigPublicationLock(async () => {
		const configFilePath = getConfigFilePath();
		const configDoc = parseYamlDoc(configFilePath);
		// Refused before anything is applied: rewriting a document that did not parse cleanly writes back only
		// what the parser recovered.
		if (configDoc.errors?.length > 0) {
			throw new Error(
				`Cannot publish the root config entry of ${component}: ${configFilePath} does not parse: ${configDoc.errors}`
			);
		}
		if (!applyEffectToDocument(configDoc, component, effect)) {
			syncFileToStorageSync(configFilePath);
			return false;
		}
		atomicWriteFile(configFilePath, String(configDoc), { durable: true });
		return true;
	});
	env.initSync(true);
	return changed;
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
