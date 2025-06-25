/**
 * ComponentStatusRegistry Class
 * 
 * This module contains the ComponentStatusRegistry class which provides
 * centralized management of component health status.
 */

import { ComponentStatus } from './ComponentStatus.ts';
import { 
	ComponentStatusLevel, 
	COMPONENT_STATUS_LEVELS,
	AggregatedComponentStatus
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

		this.statusMap.set(componentName, new ComponentStatus(status, message, error));
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
			[COMPONENT_STATUS_LEVELS.UNKNOWN]: 0
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
	public static async getAggregatedFromAllThreads(registry: ComponentStatusRegistry): Promise<Map<string, AggregatedComponentStatus>> {
		const allStatuses = await crossThreadCollector.collect(registry);
		return StatusAggregator.aggregate(allStatuses);
	}
}