export class StatelessProbe extends Resource {
	static mcpTools = [
		{
			name: 'stateless_node',
			method: 'node',
			description: 'Returns the process id of the node that served the call, and who called it',
			inputSchema: { type: 'object', properties: {} },
		},
	];

	async node(_args, context) {
		return { pid: process.pid, username: context?.user?.username ?? null, sessionId: context?.sessionId ?? null };
	}
}
