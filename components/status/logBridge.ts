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
import { setStatusHandler } from '../../utility/logging/harper_logger.js';

const LOG_TO_STATUS_LEVEL = {
	fatal: COMPONENT_STATUS_LEVELS.ERROR,
	error: COMPONENT_STATUS_LEVELS.ERROR,
	warn: COMPONENT_STATUS_LEVELS.WARNING,
	notify: COMPONENT_STATUS_LEVELS.WARNING,
	info: COMPONENT_STATUS_LEVELS.WARNING,
	debug: COMPONENT_STATUS_LEVELS.WARNING,
	trace: COMPONENT_STATUS_LEVELS.WARNING,
} as const;

const expiryTimers = new Map<string, ReturnType<typeof setTimeout>>();

function formatMessage(args: any[]): string {
	return args
		.map((a) => {
			if (typeof a === 'string') return a;
			if (a instanceof Error) return a.message;
			try {
				return String(a);
			} catch {
				return '[unserializable]';
			}
		})
		.join(' ')
		.substring(0, 500);
}

/**
 * Status handler called by the logger's .status() wrapper.
 * This is registered with harper_logger.js via setStatusHandler().
 */
export function handleStatusLog(
	options: StatusOptions,
	level: string | null,
	componentTag: string | undefined,
	args: any[]
) {
	// When level is null, this is a status-only call (no chained log method).
	// If a chained method follows, it will call again with level set — skip the
	// initial status-only call in that case by deferring: the chained call will
	// provide the actual level and message.
	if (level === null) {
		// Immediate status-only registration (no log output)
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
			if (options.expires) {
				scheduleExpiry(options.problem, options.expires * 1000);
			}
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
		const errorArg = args.find((a) => a instanceof Error);

		componentStatusRegistry.setStatus(key, statusLevel, message, errorArg, 'log');

		if (options.expires) {
			scheduleExpiry(key, options.expires * 1000);
		} else {
			clearExpiry(key);
		}
	}
}

function scheduleExpiry(key: string, ms: number) {
	clearExpiry(key);
	const timer = setTimeout(() => {
		componentStatusRegistry.setStatus(key, COMPONENT_STATUS_LEVELS.HEALTHY, 'Auto-expired', undefined, 'log');
		expiryTimers.delete(key);
	}, ms);
	timer.unref();
	expiryTimers.set(key, timer);
}

function clearExpiry(key: string) {
	const existing = expiryTimers.get(key);
	if (existing) {
		clearTimeout(existing);
		expiryTimers.delete(key);
	}
}

/**
 * Initialize the log-to-status bridge by registering handleStatusLog
 * with the harper logger's setStatusHandler.
 */
export function initLogBridge() {
	setStatusHandler(handleStatusLog);
}
