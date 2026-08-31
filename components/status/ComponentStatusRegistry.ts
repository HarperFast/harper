/**
 * ComponentStatusRegistry Class
 *
 * This module contains the ComponentStatusRegistry class which provides
 * centralized management of component health status.
 */

import { deployValidationStatusSink } from '../../server/serverHelpers/deployValidationState.ts';
import { ComponentStatus } from './ComponentStatus.ts';
import {
	type ComponentStatusLevel,
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
/**
 * A status copy handed to a validation must share nothing mutable with the live entry. `Error` is reachable
 * through the public `statusForComponent(...).get()` path, so candidate code could otherwise edit
 * `message`, `cause` or a custom field on the serving component's own error object. Own enumerable
 * properties are carried across; `cause` is flattened to a message, because an error graph of unknown depth
 * is not worth cloning to hand a throwaway load its own read.
 */
function detachError(error: Error | string | undefined): Error | string | undefined {
	if (!(error instanceof Error)) return error;
	const detached = new Error(error.message);
	detached.name = error.name;
	detached.stack = error.stack;
	for (const [key, value] of Object.entries(error)) {
		if (key === 'cause') continue;
		(detached as unknown as Record<string, unknown>)[key] = value;
	}
	if (error.cause !== undefined) {
		detached.cause = error.cause instanceof Error ? `${error.cause.name}: ${error.cause.message}` : error.cause;
	}
	return detached;
}

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
		error?: Error | string
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

		// A deploy's pre-flight validation loads the CANDIDATE's code under the real component's name, so its
		// writes would land on the live component. They go to the validation's own throwaway map instead —
		// which is why this cannot simply be reverted afterwards: the live component keeps serving through
		// that window, and `statusForComponent()` is a public API its own code may call at any time, so
		// reverting would silently discard a genuine report from it.
		const sink = deployValidationStatusSink();
		if (sink) {
			sink.set(componentName, new ComponentStatus(status, message, error));
			return;
		}
		this.statusMap.set(componentName, new ComponentStatus(status, message, error));
	}

	/**
	 * Get the current status of a component
	 */
	public getStatus(componentName: string): ComponentStatus | undefined {
		// Inside a validation the candidate reads its OWN writes, and never the live object: the returned
		// `ComponentStatus` is mutable, so handing back the live one would let candidate code edit the
		// serving component's status in place and bypass the diversion entirely. A component the candidate
		// has not written yet is copied into the sink on first read for the same reason.
		const sink = deployValidationStatusSink();
		if (sink) {
			const diverted = sink.get(componentName);
			if (diverted) return diverted;
			const live = this.statusMap.get(componentName);
			if (!live) return undefined;
			const copy = new ComponentStatus(live.status, live.message, detachError(live.error));
			// A new Date, not the live one: `Date` is mutable, so sharing it would let candidate code reach
			// back into the serving component's status through the copy.
			copy.lastChecked = new Date(live.lastChecked);
			sink.set(componentName, copy);
			return copy;
		}
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
	 *
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
		const details: Record<string, { status: ComponentStatusLevel; message?: string }> = {};

		if (hasErrors || hasLoading) {
			const problemStatuses = allStatuses.filter(
				(s) => s.status === COMPONENT_STATUS_LEVELS.ERROR || s.status === COMPONENT_STATUS_LEVELS.LOADING
			);
			overallMessage = problemStatuses.map((s) => `${s.key}: ${s.latestMessage || s.status}`).join('; ');

			// Include details for debugging
			for (const status of allStatuses) {
				if (status.status !== COMPONENT_STATUS_LEVELS.HEALTHY) {
					details[status.key] = {
						status: status.status,
						message: status.latestMessage,
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
