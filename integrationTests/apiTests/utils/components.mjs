import assert from 'node:assert/strict';
import { restartHttpWorkers } from './lifecycle.mjs';

/**
 * Deploy a Harper component via the operations API by issuing `add_component`
 * followed by `set_component_file` for each file in `files`, then restart
 * http workers and wait for the component's routes to register. Returns once
 * `probePath` returns a non-404 response.
 *
 * Mirrors the inline component-install dance used throughout the legacy
 * api-tests (1_envSetup → 17a → individual suites), but bound to a per-test
 * client so each suite can drive its own throwaway instance.
 *
 * @param {ReturnType<import('./client.mjs').createApiClient>} client
 * @param {object} options
 * @param {string} options.project — component name (used as the route prefix)
 * @param {Record<string, string>} options.files — map of file name → contents
 *   (e.g. `{ 'schema.graphql': '...', 'config.yaml': '...' }`)
 * @param {string} options.probePath — REST path the test will exercise; used
 *   to poll for route registration after the http_workers restart
 * @param {number} [options.restartTimeoutMs]
 */
export async function installAppComponent(client, { project, files, probePath, restartTimeoutMs }) {
	assert.ok(project, 'installAppComponent: project is required');
	assert.ok(files && typeof files === 'object', 'installAppComponent: files is required');
	assert.ok(probePath, 'installAppComponent: probePath is required');

	await client
		.req()
		.send({ operation: 'add_component', project })
		.expect((r) => {
			const body = JSON.stringify(r.body);
			assert.ok(
				body.includes('Successfully added project') || body.includes('Project already exists'),
				`add_component(${project}) failed: ${r.text}`
			);
		});

	for (const [file, payload] of Object.entries(files)) {
		await client
			.req()
			.send({ operation: 'set_component_file', project, file, payload })
			.expect((r) =>
				assert.ok(
					r.body.message.includes(`Successfully set component: ${file}`),
					`set_component_file(${project}/${file}) failed: ${r.text}`
				)
			)
			.expect(200);
	}

	await restartHttpWorkers(client, probePath, restartTimeoutMs);
}
