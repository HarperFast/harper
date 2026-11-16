export class AuthRequiredProbe extends Resource {
	static mcpTools = [
		{
			name: 'auth_required_whoami',
			method: 'whoami',
			description: 'Returns the username the MCP session authenticated as',
			inputSchema: { type: 'object', properties: {} },
		},
	];

	async whoami(_args, context) {
		return { username: context?.user?.username ?? null };
	}
}
