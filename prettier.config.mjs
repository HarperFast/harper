/**
 * Prettier configuration extending Harper shared config
 * @see https://prettier.io/docs/en/configuration.html
 * @type {import("prettier").Config}
 */
import harperConfig from '@harperdb/code-guidelines/prettier';

export default {
	...harperConfig,
	// Add any project-specific overrides here if needed
};
