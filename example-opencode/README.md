# OpenCode on celld

Run OpenCode in a SQLite Durable Object using [`@opencode-ai/sdk/workerd`](https://unpkg.com/@opencode-ai/sdk@0.0.0-dev-18697/README.md). This example uses **celld v0.4.1** and SDK **0.0.0-dev-18697**.

The model is `opencode/nemotron-3.5-lightning-free`. No model API key is needed.

## Deploy to Cloud Run

With celld already running on Cloud Run ([setup](../README.md#quickstart)), run from this folder:

```bash
npm ci
celld deploy . --bucket gs://YOUR_BUCKET
```

Allow about 30 seconds for celld to load the new deployment before making requests.

## Create a session and prompt it

Set `URL` to your celld deployment URL and authenticate with your IAM-authorized gcloud account. Using `curl` and `jq`:

```bash
URL="https://YOUR_CELLD_DEPLOYMENT_URL"
AUTH="Authorization: Bearer $(gcloud auth print-identity-token)"
SESSION_ID=$(curl -fsS -H "$AUTH" -X POST "$URL/sessions" | jq -r '.id')

curl -fsS -H "$AUTH" -X POST "$URL/sessions/$SESSION_ID/prompt" \
  -H 'content-type: application/json' \
  -d '{"text":"Remember the word cedar. Reply with exactly: remembered cedar"}' \
  | jq -r '.messages[-1].content[] | select(.type == "text") | .text'
# remembered cedar
```

## Resume the session

Use the same session ID to read its history and send a follow-up. Re-run the `AUTH` assignment if the token has expired:

```bash
# Read the two stored messages: your prompt and the reply.
curl -fsS -H "$AUTH" "$URL/sessions/$SESSION_ID" | jq '.messages | length'
# 2

# Continue the same conversation.
curl -fsS -H "$AUTH" -X POST "$URL/sessions/$SESSION_ID/prompt" \
  -H 'content-type: application/json' \
  -d '{"text":"What word did I ask you to remember? Reply with only that word."}' \
  | jq -r '.messages[-1].content[] | select(.type == "text") | .text'
# cedar
```

## Code

[`index.js`](index.js) creates one SDK host in a Durable Object and exposes three routes:

| Request | SDK calls |
| --- | --- |
| `POST /sessions` | `sessions.create()` |
| `POST /sessions/:id/prompt` | `sessions.prompt()`, then `sessions.wait()` |
| `GET /sessions/:id` | `sessions.get()` and `message.list()` |

Prompts return session metadata and the latest 100 messages after the turn finishes. [`wrangler.jsonc`](wrangler.jsonc) enables `nodejs_compat` and the SQLite Durable Object migration.

Cloud Run IAM protects the endpoint; the Worker has no additional authentication or shell tools. Session state is persisted to the configured GCS bucket.
