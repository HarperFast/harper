import isEqual from 'lodash/isEqual.js';
import { getConfigValue, updateConfigObject } from './configUtils.ts';
import { canonicalShards, shardListDigest } from '../resources/residencyPolicy.ts';
import * as logger from '../utility/logging/harper_logger.ts';
import { ClientError } from '../utility/errors/hdbError.ts';
import type { RootConfigWatcher } from './RootConfigWatcher.ts';

const listeners = new Set<() => void>();
let ready: Promise<void> | undefined;
export let shardingRecoveryConfiguration: Readonly<{ shards: unknown; shard: number }> | undefined;

function report(error: unknown): void {
	logger.warn?.('Could not observe sharding configuration', error);
}

function canonicalList(value: unknown): unknown {
	try {
		return canonicalShards(value);
	} catch {
		return value;
	}
}

function digest(value: unknown): string | null {
	try {
		return shardListDigest(canonicalShards(value));
	} catch {
		return 'invalid';
	}
}

export function onShardingConfigurationChange(listener: () => void): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

export function watchShardingConfiguration(watcher: RootConfigWatcher): { ready: Promise<void>; stop: () => void } {
	let timer: NodeJS.Timeout | undefined;
	let stopped = false;
	function apply() {
		if (stopped || !watcher.config)
			throw new ClientError(
				'Sharding configuration is unavailable; retry after the root configuration is readable',
				503
			);
		const replication = watcher.config.replication;
		if (!replication || typeof replication !== 'object' || Array.isArray(replication)) return;
		if (replication.shard !== getConfigValue('replication_shard')) return;
		const previous = getConfigValue('replication_shards');
		const next = canonicalList(replication.shards);
		if (isEqual(canonicalList(previous), next)) return;
		updateConfigObject('replication_shards', next);
		if (digest(previous) === digest(next)) return;
		for (const listener of listeners) {
			try {
				Promise.resolve(listener()).catch(report);
			} catch (error) {
				report(error);
			}
		}
	}
	function changed() {
		try {
			clearTimeout(timer);
			timer = setTimeout(() => {
				try {
					apply();
				} catch (error) {
					report(error);
				}
			}, 150).unref();
		} catch (error) {
			report(error);
		}
	}
	function stop() {
		stopped = true;
		ready = undefined;
		clearTimeout(timer);
		watcher.off('change', changed);
		watcher.off('error', report);
		watcher.off('close', stop);
	}
	watcher.on('change', changed);
	watcher.on('error', report);
	watcher.on('close', stop);
	return {
		ready: watcher.ready.then(apply).catch((error) => {
			stop();
			throw error;
		}),
		stop,
	};
}

export function ensureShardingConfiguration(): Promise<void> {
	if (!ready) {
		const shards = getConfigValue('replication_shards');
		shardingRecoveryConfiguration ??= Object.freeze({
			shards: Array.isArray(shards) ? Object.freeze([...shards]) : shards,
			shard: getConfigValue('replication_shard'),
		});
		ready = import('./RootConfigWatcher.ts')
			.then(({ getSharedRootConfigWatcher }) => watchShardingConfiguration(getSharedRootConfigWatcher()).ready)
			.catch((error) => {
				ready = undefined;
				throw error;
			});
		// Optional replication startup does not await this observer; declarations still see the rejection.
		void ready.catch(report);
	}
	return ready;
}
