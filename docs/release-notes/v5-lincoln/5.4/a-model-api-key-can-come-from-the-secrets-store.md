---
section: 'Models'
---

### A Model API Key Can Come From the Secrets Store

A model entry whose `apiKey` is a `${VAR_NAME}` placeholder now resolves it from a global secret (`set_secret` with `processEnv: true`) as well as from a real environment variable. Before, the main thread registered its models before stored secrets were loaded, so the entry failed there with a "literal placeholder" error; with `threads.count: 0` the model was not registered at all. Set the secret and restart Harper. With `threads.count: 0`, a global secret now also takes precedence over a root-config `.env` value of the same name, as it already did with worker threads; set `override: true` on that `loadEnv` entry to keep the file's value. See [Credentials](/reference/v5/models/overview#credentials) ([harper#4424](https://github.com/HarperFast/harper/issues/4424)).
