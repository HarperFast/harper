---
id: openai-gateway
title: OpenAI-Compatible Gateway
sidebar_position: 55
sidebar_label: 'OpenAI-Compatible Gateway'
---

<!-- Source: harper resources/models/v1/*.ts, resources/models/openaiStream.ts (v5.2.1) -->

<VersionBadge version="v5.2.1" />

Harper can expose an OpenAI-compatible REST gateway on the application HTTP server port (default `9926`, alongside the [REST interface](../rest/overview)): `POST /v1/embeddings`, `POST /v1/chat/completions` (including SSE streaming), and `GET /v1/models`. These endpoints translate the OpenAI wire format to and from the [`models`](./overview) API, so an OpenAI client such as the official OpenAI SDK can point its `baseURL` at a Harper instance.

| Endpoint                    | Maps to                                                                                   |
| --------------------------- | ----------------------------------------------------------------------------------------- |
| `POST /v1/embeddings`       | [`models.embed()`](./api#embed)                                                           |
| `POST /v1/chat/completions` | [`models.generate()`](./api#generate) / [`models.generateStream()`](./api#generatestream) |
| `GET /v1/models`            | Registered embedding and generative logical names                                         |

## Enabling it

The gateway is off by default. Enable it with `modelsGateway.enabled: true` in `harper-config.yaml`, alongside at least one configured model. The endpoints are REST resources, so REST must also be active: add `rest: true`, or deploy an application that enables REST. If that application has a [`urlPath` or `host` mount](../http/overview#middleware-routing), its REST serves the gateway under the mount, such as `/app/v1/models` for `urlPath: /app`. Without a root `rest` section, clients must go through that mount. Without REST, every `/v1/*` path returns `404`, and Harper logs a warning at startup when the root configuration has no `rest` section.

Each endpoint looks up the `model` name in its own kind, so `/v1/embeddings` needs a model under `embedding` and `/v1/chat/completions` needs one under `generative`:

```yaml
rest: true
modelsGateway:
  enabled: true
models:
  embedding:
    default:
      backend: openai
      apiKey: ${OPENAI_API_KEY}
      model: text-embedding-3-large
  generative:
    default:
      backend: openai
      apiKey: ${OPENAI_API_KEY}
      model: gpt-4o
```

## Authentication

All three endpoints require a user with `super_user` permission. Credentials go through Harper's normal [authentication](../security/overview), so any method Harper accepts works. A request with no credentials receives a `401` OpenAI error envelope, and an authenticated user without `super_user` receives a `403`. The exception is a request that [`authorizeLocal`](../security/configuration#authorizelocal) trusts: with that option enabled, a request from a loopback address runs as a super user without credentials, and the gateway serves it. Harper rejects invalid credentials before the request reaches the gateway, so that response uses Harper's standard error format, not the OpenAI envelope.

## Using it with an OpenAI client

Point the client's `baseURL` at the gateway's `/v1` path, such as `http://localhost:9926/v1` in local development, and pass a Harper [JWT operation token](../security/jwt-authentication) as `apiKey`. OpenAI SDKs send it as `Authorization: Bearer <apiKey>`, which Harper validates the same way it validates that header on any other request:

```javascript
import OpenAI from 'openai';

const client = new OpenAI({
	apiKey: '<harper-operation-token>',
	baseURL: 'http://localhost:9926/v1',
});

const completion = await client.chat.completions.create({
	model: 'default',
	messages: [{ role: 'user', content: 'Say hello in three words' }],
});
console.log(completion.choices[0].message.content);
```

Obtain the token with [`create_authentication_tokens`](../security/jwt-authentication#create-authentication-tokens). The token must belong to a user with `super_user`, and anyone holding it has that access. A client on another host should therefore connect over HTTPS, on the port set by [`http.securePort`](../http/configuration#httpsecureport). For clients that let you set the `Authorization` header yourself, [Basic Authentication](../security/basic-authentication) with a Harper username and password also works.

## Model selection

The `model` field in a request selects a logical model name from the `models` configuration or a backend registered with [`models.registerBackend()`](./backends#registerbackend). It is the same lookup `models.embed()` and `models.generate()` use, and it defaults to `default` when omitted. `GET /v1/models` lists the registered names:

```json
{
	"object": "list",
	"data": [
		{ "id": "default", "object": "model", "created": 1730000000, "owned_by": "harper" },
		{ "id": "fast", "object": "model", "created": 1730000000, "owned_by": "harper" }
	]
}
```

The list includes generative and embedding names. A name configured under both appears once. An unknown `model` value returns a `404` with code `model_not_found` (see [Errors](#errors)).

## POST /v1/embeddings

```json
{ "model": "default", "input": "What is Harper?" }
```

`input` is a string or an array of up to 2048 strings, embedded in one call. Other request fields, including `encoding_format`, are ignored, so each `embedding` is always an array of numbers. Some OpenAI Node SDK versions request `base64` when `encoding_format` is omitted and decode the number arrays as base64, which corrupts the vectors. Pass `encoding_format: 'float'` to `embeddings.create()` to avoid this. The response follows the OpenAI list shape, with vectors in input order and token counts as reported by the backend:

```json
{
	"object": "list",
	"data": [{ "object": "embedding", "index": 0, "embedding": [0.0123, -0.0456, 0.0789] }],
	"model": "default",
	"usage": { "prompt_tokens": 4, "total_tokens": 4 }
}
```

## POST /v1/chat/completions

```json
{
	"model": "default",
	"messages": [{ "role": "user", "content": "What is an HNSW index?" }]
}
```

Recognized fields are `model`, `messages`, `tools`, `tool_choice`, `temperature`, `max_tokens` / `max_completion_tokens` (the latter takes precedence when both are present), `response_format`, and `stream`. Other fields are ignored. These map to [`GenerateOpts`](./api#generate):

- `response_format: { type: 'json_object' }` maps to `responseFormat: 'json'`.
- `response_format: { type: 'json_schema', json_schema: { schema } }` maps to `responseFormat: { schema }`.
- Any other `response_format.type` maps to `responseFormat: 'text'`.

`messages[].role` is one of `system`, `developer` (treated as `system`), `user`, `assistant`, or `tool`. `content` is a string, `null`, or an array of text parts (`{ type: 'text', text }`), which are joined. Other content part types, such as images, are rejected with a `400`.

A non-streaming call returns an OpenAI `chat.completion` object:

```json
{
	"id": "chatcmpl-...",
	"object": "chat.completion",
	"created": 1730000000,
	"model": "default",
	"choices": [{ "index": 0, "message": { "role": "assistant", "content": "..." }, "finish_reason": "stop" }],
	"usage": { "prompt_tokens": 12, "completion_tokens": 8, "total_tokens": 20 }
}
```

### Streaming

Set `stream: true` to receive Server-Sent Events instead. `Accept: text/event-stream` alone does not select streaming: without `stream: true`, the handler returns a single `chat.completion` rather than chunk events and `[DONE]`. Each event is an OpenAI `chat.completion.chunk` delta, and the stream ends with the `data: [DONE]` sentinel:

```
data: {"id":"chatcmpl-...","object":"chat.completion.chunk","created":1730000000,"model":"default","choices":[{"index":0,"delta":{"role":"assistant","content":"An"},"finish_reason":null}]}

data: {"id":"chatcmpl-...","object":"chat.completion.chunk","created":1730000000,"model":"default","choices":[{"index":0,"delta":{"content":" HNSW"},"finish_reason":null}]}

data: {"id":"chatcmpl-...","object":"chat.completion.chunk","created":1730000000,"model":"default","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}

data: [DONE]
```

Content streams as it arrives. Tool calls do not: Harper's backends deliver tool-call arguments as parsed objects, so Harper collects each call by id and sends all of them in one chunk, after the content, with complete `arguments` JSON strings.

If the backend fails after the stream has started, the stream ends with a `data: {"error": {...}}` event carrying the [error envelope](#errors), and no `[DONE]`. If the client disconnects mid-stream, Harper stops reading from the backend stream.

### Tool calls

`tools` are supported in return mode only, the equivalent of [`toolMode: 'return'`](./tool-calling#toolmode-return). The model's requested calls appear on `choices[0].message.tool_calls`, or as a `tool_calls` delta while streaming. The caller runs them, then sends a follow-up request that appends the assistant message with its `tool_calls`, followed by one `role: 'tool'` message per call carrying that call's `tool_call_id`. Harper's in-process agent loop (`toolMode: 'auto'`) is not available through this gateway.

`tool_choice` accepts `auto` (the default) and `none`. With `none`, Harper does not pass the tools to the backend. `required` and named function selection are rejected with a `400`.

## Errors

Errors from the gateway use the OpenAI error envelope instead of Harper's standard error format:

```json
{
	"error": {
		"message": "No backend registered for 'generative.unknown'",
		"type": "invalid_request_error",
		"code": "model_not_found",
		"param": null
	}
}
```

| Status | `type`                  | `code`                   | Cause                                                                                                 |
| ------ | ----------------------- | ------------------------ | ----------------------------------------------------------------------------------------------------- |
| `400`  | `invalid_request_error` | `null`                   | Malformed request body or unsupported field value                                                     |
| `400`  | `invalid_request_error` | `capability_unsupported` | The selected backend lacks a capability the request needs, such as tools or streaming                 |
| `401`  | `authentication_error`  | `null`                   | No credentials, unless `authorizeLocal` trusts the request                                            |
| `403`  | `permission_error`      | `null`                   | Authenticated user without `super_user`                                                               |
| `404`  | `invalid_request_error` | `model_not_found`        | Unknown `model`                                                                                       |
| `5xx`  | `server_error`          | `null`                   | Backend or unexpected failure. The message is always `Internal server error`; Harper logs the details |

`param` is always `null`.

## Analytics

Embeddings and chat completion requests that pass authentication and validation call the `models` API directly, so they are recorded like any other model call. `GET /v1/models` makes no model call. See [Analytics](./analytics).
