/**
 * Component Status Public API
 * 
 * This module provides the clean, simple public API for component status tracking.
 * All internal implementation details are hidden behind this interface.
 */

import { componentStatusRegistry } from './registry.ts';
import { ComponentStatus } from './ComponentStatus.ts';
import { COMPONENT_STATUS_LEVELS } from './types.ts';

/**
 * Component Status Builder
 * Provides a fluent interface for reporting component status
 */
export class ComponentStatusBuilder {
	private componentName: string;

	constructor(componentName: string) {
		this.componentName = componentName;
	}

	/**
	 * Report component as healthy
	 * @param message Optional status message
	 * @returns this for chaining
	 */
	healthy(message?: string): this {
		componentStatusRegistry.setStatus(this.componentName, COMPONENT_STATUS_LEVELS.HEALTHY, message);
		return this;
	}

	/**
	 * Report component warning
	 * @param message Warning message (required for warnings)
	 * @returns this for chaining
	 */
	warning(message: string): this {
		componentStatusRegistry.setStatus(this.componentName, COMPONENT_STATUS_LEVELS.WARNING, message);
		return this;
	}

	/**
	 * Report component error
	 * @param message Error message
	 * @param error Optional error object for additional context
	 * @returns this for chaining
	 */
	error(message: string, error?: Error): this {
		componentStatusRegistry.setStatus(this.componentName, COMPONENT_STATUS_LEVELS.ERROR, message, error);
		return this;
	}

	/**
	 * Report component as loading
	 * @param message Optional loading message
	 * @returns this for chaining
	 */
	loading(message?: string): this {
		componentStatusRegistry.setStatus(this.componentName, COMPONENT_STATUS_LEVELS.LOADING, message || 'Loading...');
		return this;
	}

	/**
	 * Report component status as unknown
	 * @param message Optional message explaining why status is unknown
	 * @returns this for chaining
	 */
	unknown(message?: string): this {
		componentStatusRegistry.setStatus(this.componentName, COMPONENT_STATUS_LEVELS.UNKNOWN, message);
		return this;
	}

	/**
	 * Get the current status of this component
	 * @returns Current component status or undefined if not set
	 */
	get(): ComponentStatus | undefined {
		return componentStatusRegistry.getStatus(this.componentName);
	}
}

// Cache for builders to avoid creating new objects
const builderCache = new Map<string, ComponentStatusBuilder>();

/**
 * Get a status builder for a component
 * This is the primary API for reporting component status
 * 
 * @example
 * ```typescript
 * // Report status
 * statusForComponent('my-service').healthy('Service started');
 * statusForComponent('database').error('Connection failed', err);
 * statusForComponent('cache').warning('Memory usage high');
 * 
 * // Get status
 * const status = statusForComponent('my-service').get();
 * ```
 */
export function statusForComponent(name: string): ComponentStatusBuilder {
	let builder = builderCache.get(name);
	if (!builder) {
		builder = new ComponentStatusBuilder(name);
		builderCache.set(name, builder);
	}
	return builder;
}

/**
 * Component lifecycle hooks for internal use
 * These are used by the component loader
 */
export const lifecycle = {
	/**
	 * Mark component as starting to load
	 */
	loading(componentName: string, message?: string): void {
		componentStatusRegistry.initializeLoading(componentName, message);
	},

	/**
	 * Mark component as successfully loaded
	 */
	loaded(componentName: string, message?: string): void {
		componentStatusRegistry.markLoaded(componentName, message);
	},

	/**
	 * Mark component as failed to load
	 */
	failed(componentName: string, error: Error | string, message?: string): void {
		componentStatusRegistry.markFailed(componentName, error, message);
	}
};

/**
 * Reset all component statuses (useful for testing)
 */
export function reset(): void {
	componentStatusRegistry.reset();
}

/**
 * Status level constants for external use
 */
export const STATUS = COMPONENT_STATUS_LEVELS;

/**
 * Re-export only the types that external users need
 */
export type { ComponentStatusLevel, AggregatedComponentStatus } from './types.ts';
export type { ComponentStatus } from './ComponentStatus.ts';