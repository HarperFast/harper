---
section: 'Built-in Agent'
order: 40
---

### Credential Values Are Masked in the Agent's Config and Log Reads

The config file can hold plaintext credentials, such as a model `apiKey` passed through `HARPER_SET_CONFIG`, and the agent's `config` scope returned them, as did its `logs` scope and `read_log` for anything a component logged. The agent's reads of the `logs` and `config` scopes, and its `read_log` results, now show the value of every credential-named key (`apiKey`, `password`, `token`, `secret`, and similar) as `*`s, including a value that continues on more-indented YAML lines and a value a positional read starts in the middle of. `grep_files` searches the masked text in those scopes, and the agent's `read_log` refuses `filter`, which matches the unmasked log. The `components` scope, and `read_log` called through the operations API or an MCP client, are unchanged. Sessions recorded before this release keep whatever they already read, so rotate any credential an agent session may have read. See [Masked credential values](/reference/v5/configuration/options#masked-credential-values) ([harper#3097](https://github.com/HarperFast/harper/issues/3097)).
