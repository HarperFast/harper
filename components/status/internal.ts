/**
 * Internal Component Status Exports
 * 
 * These exports are for Harper core internal use only.
 * Components should use the public API from index.ts
 */

// Import what we need for the query object
import type { ComponentStatusLevel } from './types.ts';
import { componentStatusRegistry } from './registry.ts';
import { ComponentStatusRegistry } from './ComponentStatusRegistry.ts';

// Internal classes and types
export { ComponentStatus } from './ComponentStatus.ts';
export { ComponentStatusRegistry } from './ComponentStatusRegistry.ts';
export { CrossThreadStatusCollector, StatusAggregator, crossThreadCollector } from './crossThread.ts';
export type { ComponentStatusMap } from './ComponentStatusRegistry.ts';

// Registry singleton for internal use
export { componentStatusRegistry } from './registry.ts';

// All error types for internal error handling
export * from './errors.ts';

// All type definitions
export * from './types.ts';

// Internal query functions for Harper core
export const query = {
	/**
	 * Get a single component's status
	 */
	get(componentName: string) {
		return componentStatusRegistry.getStatus(componentName);
	},

	/**
	 * Get all component statuses in the current thread
	 */
	all() {
		return componentStatusRegistry.getAllStatuses();
	},

	/**
	 * Get components by status level
	 */
	byStatus(status: ComponentStatusLevel) {
		return componentStatusRegistry.getComponentsByStatus(status);
	},

	/**
	 * Get a summary of component statuses
	 */
	summary() {
		return componentStatusRegistry.getStatusSummary();
	},

	/**
	 * Get aggregated status from all threads
	 * This is an async operation that collects status from all worker threads
	 */
	async allThreads() {
		return ComponentStatusRegistry.getAggregatedFromAllThreads(componentStatusRegistry);
	}
};