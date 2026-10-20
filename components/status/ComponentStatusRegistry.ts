/**
 * ComponentStatusRegistry Class
 *
 * This module contains the ComponentStatusRegistry class which provides
 * centralized management of component health status.
 */

import { ComponentStatus } from './ComponentStatus.ts';
import {
	type ComponentStatusLevel,
	type ComponentStatusSource,
	COMPONENT_STATUS_LEVELS,
	type AggregatedComponentStatus,
	type ComponentApplicationStatus,
} from './types.ts';
import { crossThreadCollector, StatusAggregator } from './crossThread.ts';
import { ComponentStatusOperationError } from './errors.ts';

/**
 * Map of component names to their status information
 */
export type ComponentStatusMap = Map<string, ComponentStatus>;

/**
 * Component Status Registry Class
 * Provides a centralized registry for managing component health status
 */
export class ComponentStatusRegistry {
	private statusMap: ComponentStatusMap = new Map();

	/**
	 * Reset the component status registry, clearing all existing status data
	 * This should be called when the component system starts up
	 */
	public reset(): void {
		this.statusMap = new Map();
	}

	/**
	 * Register or update component health status
	 * This function allows components to report their own health status
	 */
	public setStatus(
		componentName: string,
		status: ComponentStatusLevel,
		message?: string,
		error?: Error | string,
		source?: ComponentStatusSource
	): void {
		if (!componentName || typeof componentName !== 'string') {
			throw new ComponentStatusOperationError(
				String(componentName),
				'setStatus',
				'Component name must be a non-empty string'
			);
		}

		if (!Object.values(COMPONENT_STATUS_LEVELS).includes(status)) {
			throw new ComponentStatusOperationError(
				componentName,
				'setStatus',
				`Invalid status level: ${status}. Must be one of: ${Object.values(COMPONENT_STATUS_LEVELS).join(', ')}`
			);
		}

		const sanitizedMessage = typeof message === 'string' ? redactUrlCredentials(message) : message;
		const sanitizedError = typeof error === 'string' ? redactUrlCredentials(error) : error;
		const existing = this.statusMap.get(componentName);
		if (existing && existing.status === status) {
			existing.lastChecked = new Date();
			existing.message = sanitizedMessage;
			existing.error = sanitizedError;
			if (source !== undefined) existing.source = source;
			existing.occurrenceCount++;
		} else {
			this.statusMap.set(componentName, new ComponentStatus(status, sanitizedMessage, sanitizedError, source));
		}
	}

	/**
	 * Get the current status of a component
	 */
	public getStatus(componentName: string): ComponentStatus | undefined {
		return this.statusMap.get(componentName);
	}

	/**
	 * Get all component statuses
	 */
	public getAllStatuses(): ComponentStatusMap {
		return this.statusMap;
	}

	/**
	 * Report component as healthy
	 */
	public reportHealthy(componentName: string, message?: string): void {
		this.setStatus(componentName, COMPONENT_STATUS_LEVELS.HEALTHY, message);
	}

	/**
	 * Report component error
	 */
	public reportError(componentName: string, error: Error | string, message?: string): void {
		this.setStatus(componentName, COMPONENT_STATUS_LEVELS.ERROR, message, error);
	}

	/**
	 * Report component warning
	 */
	public reportWarning(componentName: string, message: string): void {
		this.setStatus(componentName, COMPONENT_STATUS_LEVELS.WARNING, message);
	}

	/**
	 * Component Lifecycle Management
	 */

	/**
	 * Initialize component as loading - call this when component loading begins
	 */
	public initializeLoading(componentName: string, message?: string): void {
		this.setStatus(componentName, COMPONENT_STATUS_LEVELS.LOADING, message || 'Component is loading');
	}

	/**
	 * Mark component as successfully loaded
	 */
	public markLoaded(componentName: string, message?: string): void {
		this.setStatus(componentName, COMPONENT_STATUS_LEVELS.HEALTHY, message || 'Component loaded successfully');
	}

	/**
	 * Mark component as failed to load
	 */
	public markFailed(componentName: string, error: Error | string, message?: string): void {
		this.setStatus(componentName, COMPONENT_STATUS_LEVELS.ERROR, message, error);
	}

	/**
	 * Get all components with a specific status level
	 */
	public getComponentsByStatus(statusLevel: ComponentStatusLevel): Array<{ name: string; status: ComponentStatus }> {
		const result: Array<{ name: string; status: ComponentStatus }> = [];
		for (const [name, status] of this.statusMap) {
			if (status.status === statusLevel) {
				result.push({ name, status });
			}
		}
		return result;
	}

	/**
	 * Get a summary of all component statuses
	 */
	public getStatusSummary(): Record<ComponentStatusLevel, number> {
		const summary: Record<ComponentStatusLevel, number> = {
			[COMPONENT_STATUS_LEVELS.HEALTHY]: 0,
			[COMPONENT_STATUS_LEVELS.ERROR]: 0,
			[COMPONENT_STATUS_LEVELS.WARNING]: 0,
			[COMPONENT_STATUS_LEVELS.LOADING]: 0,
			[COMPONENT_STATUS_LEVELS.UNKNOWN]: 0,
		};

		for (const status of this.statusMap.values()) {
			summary[status.status]++;
		}

		return summary;
	}

	/**
	 * Static method to get aggregated component statuses from all threads
	 * Returns a Map with one entry per component showing overall status and thread distribution
	 */
	public static async getAggregatedFromAllThreads(
		registry: ComponentStatusRegistry
	): Promise<Map<string, AggregatedComponentStatus>> {
		const allStatuses = await crossThreadCollector.collect(registry);
		return StatusAggregator.aggregate(allStatuses);
	}

	/**
	 * Get aggregated status for a specific component and all its sub-components
	 * This method handles both exact matches and sub-component aggregation
	 * @param componentName - The component name to look up (e.g., "application-template", "http")
	 * @param consolidatedStatuses - Pre-fetched consolidated statuses from all threads (optional, will fetch if not provided)
	 * @returns Aggregated status information for the component
	 */
	public async getAggregatedStatusFor(
		componentName: string,
		consolidatedStatuses?: Map<string, AggregatedComponentStatus>
	): Promise<ComponentApplicationStatus> {
		// Get consolidated statuses from all threads if not provided
		if (!consolidatedStatuses) {
			consolidatedStatuses = await ComponentStatusRegistry.getAggregatedFromAllThreads(this);
		}

		// Collect all statuses related to this component
		const allStatuses = [];
		const componentPrefix = componentName + '.';

		// Add exact match if exists
		const exactMatch = consolidatedStatuses.get(componentName);
		if (exactMatch) {
			allStatuses.push({ key: componentName, ...exactMatch });
		}

		// Add sub-component statuses
		for (const [statusKey, statusValue] of consolidatedStatuses) {
			if (statusKey.startsWith(componentPrefix)) {
				allStatuses.push({ key: statusKey, ...statusValue });
			}
		}

		if (allStatuses.length === 0) {
			// No status found at all
			return {
				status: COMPONENT_STATUS_LEVELS.UNKNOWN,
				message: 'The component has not been loaded yet (may need a restart)',
				lastChecked: { workers: {} },
			};
		}

		// Aggregate all statuses
		const hasErrors = allStatuses.some((s) => s.status === COMPONENT_STATUS_LEVELS.ERROR);
		const hasLoading = allStatuses.some((s) => s.status === COMPONENT_STATUS_LEVELS.LOADING);

		const overallStatus = hasErrors
			? COMPONENT_STATUS_LEVELS.ERROR
			: hasLoading
				? COMPONENT_STATUS_LEVELS.LOADING
				: COMPONENT_STATUS_LEVELS.HEALTHY;

		// Show details if anything is not healthy
		let overallMessage = 'All components loaded successfully';
		const details: Record<string, { status: ComponentStatusLevel; message?: string; error?: string }> = {};

		if (hasErrors || hasLoading) {
			const problemStatuses = allStatuses.filter(
				(s) => s.status === COMPONENT_STATUS_LEVELS.ERROR || s.status === COMPONENT_STATUS_LEVELS.LOADING
			);
			overallMessage = problemStatuses
				.map((s) => {
					const errorMessage = serializeStatusError(s.error);
					const message = formatProblemMessage(s.latestMessage, errorMessage);
					return `${s.key}: ${message || s.status}`;
				})
				.join('; ');

			// Include details for debugging
			for (const status of allStatuses) {
				if (status.status !== COMPONENT_STATUS_LEVELS.HEALTHY) {
					const errorMessage = serializeStatusError(status.error);
					details[status.key] = {
						status: status.status,
						message: formatProblemMessage(status.latestMessage, errorMessage),
						...(errorMessage !== undefined && { error: errorMessage }),
					};
				}
			}
		}

		return {
			status: overallStatus,
			message: overallMessage,
			...(Object.keys(details).length > 0 && { details }),
			lastChecked: allStatuses[0]?.lastChecked || { workers: {} },
		};
	}
}

const CREDENTIAL_URL_USERINFO_PATTERN = /(?<=[a-z][a-z0-9+.-]*:\/\/)[^/?#\s]+@/gi;
const LOADER_COMPONENT_FAILURE_MESSAGE = /^Could not load component '[^']*'$/;
const LOADER_DIRECTORY_FAILURE_MESSAGE = /^Could not load \S+$/;

export function redactUrlCredentials(text: string): string {
	return text.replace(CREDENTIAL_URL_USERINFO_PATTERN, '[REDACTED]@');
}

/**
 * Format a component status error into a single wire-safe diagnostic string.
 *
 * Deliberate exposure decision: `get_status` and `get_components` are operator
 * health/diagnostic operations (super_user by default, or explicitly granted via
 * a role's `operations` allowlist) that intentionally surface component failure
 * causes so operators can diagnose broken deployments without log access. Only
 * the error class name and message are rendered (never stack traces or arbitrary
 * enumerable properties), and embedded URL userinfo credentials (`scheme://user:pass@host`)
 * are redacted in both status messages (`setStatus`) and serialized errors before
 * text leaves the status registry.
 */
export function serializeStatusError(error: unknown): string | undefined {
	if (error === undefined || error === null) return undefined;
	if (typeof error === 'string') return redactUrlCredentials(error);
	try {
		if (typeof error === 'object') {
			const message = (error as { message?: unknown }).message;
			if (typeof message === 'string') {
				const rawName = (error as { name?: unknown }).name;
				const ctorName = (error as { constructor?: { name?: unknown } }).constructor?.name;
				const errorName =
					typeof rawName === 'string' && rawName.length > 0 && rawName !== 'Error'
						? rawName
						: typeof ctorName === 'string' && ctorName.length > 0 && ctorName !== 'Object'
							? ctorName
							: typeof rawName === 'string' && rawName.length > 0
								? rawName
								: undefined;
				if (!message) {
					return errorName || 'Error';
				}
				const rendered =
					errorName && errorName !== 'Error' && !message.startsWith(`${errorName}:`)
						? `${errorName}: ${message}`
						: message;
				return redactUrlCredentials(rendered);
			}
		}
		return redactUrlCredentials(String(error));
	} catch {
		try {
			return Object.prototype.toString.call(error);
		} catch {
			return '[Unrenderable Object]';
		}
	}
}

function formatProblemMessage(latestMessage: string | undefined, errorMessage: string | undefined): string | undefined {
	const sanitizedLatest = latestMessage !== undefined ? redactUrlCredentials(latestMessage) : undefined;
	if (sanitizedLatest && errorMessage) {
		if (sanitizedLatest.includes(errorMessage)) {
			return sanitizedLatest;
		}
		if (
			errorMessage.includes(sanitizedLatest) ||
			(LOADER_COMPONENT_FAILURE_MESSAGE.test(sanitizedLatest) &&
				/^(?:[\w$]+:\s*)?Could not load component /.test(errorMessage)) ||
			(LOADER_DIRECTORY_FAILURE_MESSAGE.test(sanitizedLatest) &&
				/^(?:[\w$]+:\s*)?Could not load application due to /.test(errorMessage))
		) {
			return errorMessage;
		}
		return `${sanitizedLatest}: ${errorMessage}`;
	}
	return sanitizedLatest ?? errorMessage;
}
