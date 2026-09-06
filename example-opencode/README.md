# OpenCode inside celld

A small conversation API and UI using **stock celld v0.4.1** and [`@opencode-ai/sdk/workerd`](https://unpkg.com/@opencode-ai/sdk@0.0.0-dev-18697/README.md), pinned to **0.0.0-dev-18697**. Keep the lockfile: this is a development SDK build, not a claim that arbitrary newer versions work with this runtime.

The pinned dependency tree reported 14 moderate npm audit findings during validation. Review these before production use; blindly running `npm audit fix --force` would invalidate the tested compatibility pin.

## Run locally

Install celld v0.4.1 and Node.js/npm as in the [root Quickstart](../README.md#quickstart-one-cloud-run-instance). From the repository root:

```bash
npm ci --prefix example-opencode
export PATH="$PWD/example-opencode/node_modules/.bin:$PATH"
celld dev example-opencode --port 9876
```

Open **http://localhost:9876**. Choose **New session**, send a prompt, and send a follow-up. Copy the session ID or bookmark the URL (the ID is in its fragment). **Resume** loads the existing history; it does not create a replacement session. The UI shows the most recent 100 SDK messages, with text rendered literally, not as trusted HTML. Responses are non-streaming.

The free `opencode/nemotron-3.5-lightning-free` model currently needs no API key. It still needs outbound internet access; provider availability, rate limits and terms may change. Do not send private data. Model failures are displayed in the conversation or status area, not replaced with simulated answers.

### Exercise the API

Requires `curl` and Node.js (used only to extract the ID). Keep celld running in another terminal:

```bash
BASE_URL=http://localhost:9876
SESSION_ID=$(curl --fail-with-body -sS -X POST "$BASE_URL/api/sessions" \
  | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).id')

curl --fail-with-body -sS -H 'content-type: application/json' \
  -d '{"text":"Remember the word cedar. Reply briefly."}' \
  "$BASE_URL/api/sessions/$SESSION_ID/prompt"

# Stop celld with Ctrl+C and run the SAME dev command again, without --clean.
curl --fail-with-body -sS "$BASE_URL/api/sessions/$SESSION_ID"
curl --fail-with-body -sS -H 'content-type: application/json' \
  -d '{"text":"What word did I ask you to remember?"}' \
  "$BASE_URL/api/sessions/$SESSION_ID/prompt"
```

Or run `node example-opencode/smoke.mjs http://localhost:9876` for a real two-turn model test. It creates a new session and asserts successful model outcomes and recalled context. It uses the external free provider, so it is not an offline unit test.

## How it works

- A random public session ID selects one `Agent` Durable Object. That object saves the SDK's session ID alongside the SDK's SQLite-backed state.
- The constructor creates **one** `OpenCodeWorkerd` host under `blockConcurrencyWhile`, using `state.storage`. Requests reuse it.
- `sessions.create({ location, model })` creates a session; `sessions.get({ sessionID })` resumes its existing metadata. `sessions.prompt({ sessionID, text })` queues a turn; `sessions.wait({ sessionID })` waits before `message.list({ sessionID })` loads the result. These are the APIs of the pinned build, not the separate HTTP client SDK.
- `nodejs_compat` and the `new_sqlite_classes` migration are required. `/workspace` is an SDK location, **not a mounted persistent project directory**. This text-only demo denies tool permissions and provides no shell or filesystem UI.
- Local `celld dev` state lives in `example-opencode/.celld/dev`. In the Cloud Run deployment, celld persists Durable Object state to the fleet's GCS prefix. Clearing local state, changing the DO binding/class identity, or deleting the bucket is not a session-preserving operation.

A completed-turn restart is demonstrated here; this is not an exactly-once guarantee for arbitrary external tool effects during a crash. If a request times out or disconnects, **resume/read the session before submitting again**: the original turn may still have run. There are no automatic prompt retries. Session IDs are bearer capabilities for this demo, not user authentication; New session does not delete the old conversation.

## Deploy on the single Instance

Use the root Quickstart's tools, billed project, bucket and runtime account. For a fresh deployment, substitute this Worker at step 3:

```bash
celld deploy example-opencode --bucket "$CELLD_BUCKET"
# Then run the SAME stock celld Instance create command from the root README.
```

If you already deployed the counter, this command replaces the active app at that prefix within about 30 seconds; open **`$INSTANCE_URL/`** rather than `/alpha`. The counter's stored objects are not deleted. Use a separate prefix and Instance if you want both apps available at once.

**Do not leave an unrestricted agent endpoint public.** The root Quickstart's `--public` setting is for disposable, non-sensitive experiments; it lets anyone create sessions and consume your resources. Before sharing, configure private access using the [current Instance guide](https://docs.cloud.google.com/run/docs/instances/create-and-manage-instances), or add application authentication and quotas. The scale-out README's IAP commands and `gcloud run services proxy` target Services, not Instances; do not substitute an Instance name into them.

The 1 vCPU / 1 GiB shape is a starting point, not a session-capacity promise. The SDK bundle is much larger than the counter (~20 MiB uncompressed in this pin); monitor memory and latency under concurrent sessions. Move to the [Service + Worker Pool topology](../README.md#scale-out-architecture) for fleet capacity and peer-assisted write durability.
