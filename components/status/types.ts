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
	/** Most recent message across all threads */
	latestMessage?: string;
	/** Any error from any thread */
	error?: Error | string;
}

/**
 * Component status information from a worker thread
 */
export interface WorkerComponentStatuses {
	workerIndex: number | undefined;
	isMainThread: boolean;
	statuses: Array<[string, ComponentStatusSummary]>;
}

/**
 * Aggregated application-level component status
 * Used for components that may have multiple sub-components (e.g., application-template.rest, application-template.static)
 */
export interface ComponentApplicationStatus {
	/** Overall aggregated status (error > loading > loaded > healthy) */
	status: ComponentStatusLevel;
	/** Descriptive message with details when not healthy */
	message: string;
	/** Detailed breakdown when issues exist */
	details?: Record<string, { status: ComponentStatusLevel; message?: string }>;
	/** Last checked time information */
	lastChecked: { workers: Record<number, number> };
}
