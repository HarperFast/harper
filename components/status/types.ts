/**
 * Component Status Type Definitions
 *
 * This module defines the core types, constants, and interfaces for the
 * component status tracking system.
 */

/**
 * Status levels for components
 */
export const COMPONENT_STATUS_LEVELS = {
	HEALTHY: 'healthy',
	WARNING: 'warning',
	ERROR: 'error',
	UNKNOWN: 'unknown',
	LOADING: 'loading',
} as const;

export type ComponentStatusLevel = (typeof COMPONENT_STATUS_LEVELS)[keyof typeof COMPONENT_STATUS_LEVELS];

export type ComponentStatusSource = 'log' | 'explicit' | 'health-check';

/** Worst-first order; the first level present is the aggregate status. */
export const STATUS_PRIORITY: readonly ComponentStatusLevel[] = [
	COMPONENT_STATUS_LEVELS.ERROR,
	COMPONENT_STATUS_LEVELS.WARNING,
	COMPONENT_STATUS_LEVELS.LOADING,
	COMPONENT_STATUS_LEVELS.UNKNOWN,
	COMPONENT_STATUS_LEVELS.HEALTHY,
];

/**
 * Component status information as a plain object
 */
export interface ComponentStatusSummary {
	/** Last time this status was checked/updated */
	lastChecked: Date;
	/** Current status level */
	status: ComponentStatusLevel;
	/** Human-readable status message */
	message?: string;
	/** Error information if status is 'error' */
	error?: Error | string;
	/** Worker index for cross-thread tracking */
	workerIndex?: number;
	/** When this thread last finished loading the component */
	loadedAt?: Date;
	/** How the status was set */
	source?: ComponentStatusSource;
	/** Reports at this thread's current level; resets to 1 when the level changes. */
	occurrenceCount?: number;
}

/**
 * Abnormal component status information for a specific thread
 */
export interface ComponentStatusAbnormality {
	/** Worker index for the thread with abnormal status */
	workerIndex: number;
	/** The abnormal status level */
	status: ComponentStatusLevel;
	/** Status message for this abnormal instance */
	message?: string;
	/** Error information if status is 'error' */
	error?: Error | string;
}

/**
 * Aggregated component status with thread information
 */
export interface AggregatedComponentStatus {
	/** Component name (without thread suffix) */
	componentName: string;
	/** Overall status - error if any thread has error, warning if any has warning, etc */
	status: ComponentStatusLevel;
	/** Last checked times for each thread (ms since epoch) */
	lastChecked: {
		/** Main thread last checked time (if component runs on main) */
		main?: number;
		/** Worker thread last checked times indexed by worker number */
		workers: Record<number, number>;
	};
	/** Map of thread-specific statuses if they differ (only populated when inconsistent) */
	abnormalities?: Map<string, ComponentStatusAbnormality>;
	/** Status message from the highest-priority, most recent non-healthy thread */
	latestMessage?: string;
	/** Error from the highest-priority, most recent non-healthy thread */
	error?: Error | string;
	/** The most recent time any thread finished loading the component (ms since epoch) */
	loadedAt?: number;
	/** Last known source in thread collection order, independent of the message/error owner. */
	source?: ComponentStatusSource;
	/** Sum of current per-thread counters at every level, including healthy; not a lifetime count. */
	occurrenceCount?: number;
}

/**
 * Component status information from a worker thread
 */
export interface WorkerComponentStatuses {
	threadId?: number;
	workerIndex: number | undefined;
	isMainThread: boolean;
	statuses: Array<[string, ComponentStatusSummary]>;
}

/**
 * Aggregated application-level component status
 * Used for components that may have multiple sub-components (e.g., application-template.rest, application-template.static)
 */
export interface ComponentApplicationStatus {
	/** Overall aggregated status (error > warning > loading > unknown > healthy) */
	status: ComponentStatusLevel;
	/** Descriptive message with details when not healthy */
	message: string;
	/** Detailed breakdown when issues exist */
	details?: Record<string, { status: ComponentStatusLevel; message?: string; error?: string }>;
	/** Last checked time information */
	lastChecked: { workers: Record<number, number> };
	/** The most recent time any thread finished loading the component or a sub-component (ms since epoch) */
	loadedAt?: number;
}
