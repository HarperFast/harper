/**
 * Log-to-Status Bridge
 *
 * Handles the connection between logger.status() calls and the component status system.
 * When code uses logger.status({ problem: 'key' }).error('message'), this module
 * receives the call and updates the ComponentStatusRegistry accordingly.
 */

import { componentStatusRegistry } from './registry.ts';
import { COMPONENT_STATUS_LEVELS } from './types.ts';
import type { StatusOptions } from '../../utility/logging/logger.ts';
import { isErrorLike, setStatusHandler } from '../../utility/logging/harper_logger.ts';
import { types } from 'node:util';
import { MAX_SET_TIMEOUT_MS } from '../../utility/hdbTerms.ts';
import { redactUrlCredentials } from './ComponentStatusRegistry.ts';

const LOG_TO_STATUS_LEVEL = {
	fatal: COMPONENT_STATUS_LEVELS.ERROR,
	error: COMPONENT_STATUS_LEVELS.ERROR,
	warn: COMPONENT_STATUS_LEVELS.WARNING,
	notify: COMPONENT_STATUS_LEVELS.WARNING,
	info: COMPONENT_STATUS_LEVELS.WARNING,
	debug: COMPONENT_STATUS_LEVELS.WARNING,
	trace: COMPONENT_STATUS_LEVELS.WARNING,
} as const;

const expiryTimers = new Map<
	string,
	{ timer: ReturnType<typeof setTimeout>; ms: number; deadline: number; lastChecked?: Date }
>();

function formatMessage(args: any[]): string {
	const message = args
		.map((a) => {
			if (typeof a === 'string') return a;
			if (types.isProxy(a)) return '[Proxy]';
			if (isErrorLike(a)) {
				const message = Object.getOwnPropertyDescriptor(a, 'message')?.value;
				return typeof message === 'string' ? message : '';
			}
			if (a !== null && (typeof a === 'object' || typeof a === 'function')) return '[Object]';
			return String(a);
		})
		.join(' ');
	return redactUrlCredentials(message).substring(0, 500);
}

export function handleStatusLog(
	options: StatusOptions,
	level: string | null,
	componentTag: string | undefined,
	args: any[]
) {
	if (level === null) {
		if (options.resolves) {
			clearExpiry(options.resolves);
			componentStatusRegistry.setStatus(
				options.resolves,
				COMPONENT_STATUS_LEVELS.HEALTHY,
				'Resolved',
				undefined,
				'log'
			);
		} else if (options.problem) {
			const statusLevel = options.level
				? LOG_TO_STATUS_LEVEL[options.level] || COMPONENT_STATUS_LEVELS.WARNING
				: COMPONENT_STATUS_LEVELS.ERROR;
			componentStatusRegistry.setStatus(options.problem, statusLevel, undefined, undefined, 'log');
			scheduleExpiry(options.problem, options.expires);
		}
		return;
	}

	const message = formatMessage(args);

	if (options.resolves) {
		clearExpiry(options.resolves);
		componentStatusRegistry.setStatus(
			options.resolves,
			COMPONENT_STATUS_LEVELS.HEALTHY,
			message || 'Resolved',
			undefined,
			'log'
		);
		return;
	}

	if (options.problem) {
		const key = options.problem;
		const statusLevel = LOG_TO_STATUS_LEVEL[level] || COMPONENT_STATUS_LEVELS.WARNING;
		const errorArg = args.find(isErrorLike);

		componentStatusRegistry.setStatus(key, statusLevel, message, errorArg, 'log');

		scheduleExpiry(key, options.expires);
	}
}

function scheduleExpiry(key: string, seconds: unknown) {
	const ms = typeof seconds === 'number' || typeof seconds === 'string' ? Number(seconds) * 1000 : NaN;
	if (!Number.isFinite(ms) || ms <= 0) {
		clearExpiry(key);
		return;
	}
	const existing = expiryTimers.get(key);
	if (existing?.ms === ms) {
		existing.lastChecked = componentStatusRegistry.getStatus(key)?.lastChecked;
		existing.deadline = performance.now() + ms;
		existing.timer.refresh();
		return;
	}
	clearExpiry(key);
	const expire = () => {
		if (expiryTimers.get(key) !== entry) return;
		const remaining = entry.deadline - performance.now();
		if (remaining > 0) {
			entry.timer = setTimeout(expire, Math.min(remaining, MAX_SET_TIMEOUT_MS));
			entry.timer.unref();
			return;
		}
		// Every registry write replaces lastChecked, so this expiry owns only its report.
		if (componentStatusRegistry.getStatus(key)?.lastChecked === entry.lastChecked) {
			componentStatusRegistry.setStatus(key, COMPONENT_STATUS_LEVELS.HEALTHY, 'Auto-expired', undefined, 'log');
		}
		if (expiryTimers.get(key) === entry) expiryTimers.delete(key);
	};
	const entry = {
		timer: setTimeout(expire, Math.min(ms, MAX_SET_TIMEOUT_MS)),
		ms,
		deadline: performance.now() + ms,
		lastChecked: componentStatusRegistry.getStatus(key)?.lastChecked,
	};
	entry.timer.unref();
	expiryTimers.set(key, entry);
}

function clearExpiry(key: string) {
	const existing = expiryTimers.get(key);
	if (existing) {
		clearTimeout(existing.timer);
		expiryTimers.delete(key);
	}
}

export function initLogBridge() {
	setStatusHandler(handleStatusLog);
}
