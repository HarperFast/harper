export default {
	path: '/redeploy-env-probe',
	async get() {
		return {
			codeVersion: 1,
			changedKey: process.env.REDEPLOY_ENV_CHANGED_KEY ?? null,
			newKey: process.env.REDEPLOY_ENV_NEW_KEY ?? null,
		};
	},
};
