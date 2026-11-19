// Oracle for the MCP initialize-limit anchors: the super user's view of system.mcp_session, read from
// inside the worker. The operations API's schema view does not list the component-declared table
// ("Table 'system.mcp_session' does not exist"), so the specs read it through this resource.
export class McpInitializeSessions extends Resource {
	async get() {
		const table = databases.system?.mcp_session;
		if (!table) return { loaded: false, rows: [] };
		const rows = [];
		for await (const row of table.search({})) rows.push(row);
		return { loaded: true, rows };
	}
}
