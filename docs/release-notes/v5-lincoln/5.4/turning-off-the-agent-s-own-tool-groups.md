---
section: 'Built-in Agent'
order: 15
---

### Turning Off the Agent's Own Tool Groups

The built-in agent's filesystem tools, `schedule_followup`, the V8 inspector tools and the best-practices lookup can each be removed from its toolset at startup with `agent.tools.filesystem`, `agent.tools.schedule`, `agent.tools.inspector` and `agent.tools.bestPractices` (default `true`). A group that is off is not described to the model, and a call to one of its tools runs nothing; its tool names stay reserved, so no operations or injected tool can take them. With every group and `httpFetch` off, the agent has only the operations tools `agent.user` may call, so an application can send it a prepared brief and take a one-turn answer. The switches are read at startup only, and `set_agent_config` rejects them. The new `get_agent_config` operation returns the configuration in effect, the startup-only keys included. See [Turning off tool groups](/reference/v5/configuration/options#turning-off-tool-groups) and [`get_agent_config`](/reference/v5/operations-api/operations#get_agent_config) ([harper#3993](https://github.com/HarperFast/harper/issues/3993)).
