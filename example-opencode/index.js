import { OpenCodeWorkerd } from "@opencode-ai/sdk/workerd";

const MODEL = { providerID: "opencode", id: "nemotron-3.5-lightning-free" };
const json = (value, status = 200) => Response.json(value, {
  status, headers: { "cache-control": "no-store" },
});

// Keep one SDK host for this object's lifetime. Its sessions share SQLite storage.
export class Agent {
  constructor(state) {
    this.host = state.blockConcurrencyWhile(() => OpenCodeWorkerd.create({
      storage: state.storage,
      config: { model: "opencode/nemotron-3.5-lightning-free", permission: "deny" },
    }));
  }

  async fetch(request) {
    const host = await this.host;
    const path = new URL(request.url).pathname;
    if (path === "/sessions" && request.method === "POST") {
      return json(await host.sessions.create({
        location: { directory: "/workspace" }, model: MODEL,
      }), 201);
    }

    const match = /^\/sessions\/([^/]+)(\/prompt)?$/.exec(path);
    if (!match) return json({ error: "Not found" }, 404);
    if (request.method !== (match[2] ? "POST" : "GET")) return json({ error: "Method not allowed" }, 405);
    const sessionID = match[1];
    if (match[2]) {
      const body = await request.json().catch(() => null);
      if (typeof body?.text !== "string" || !body.text.trim() || body.text.length > 8000) {
        return json({ error: "Enter a prompt between 1 and 8,000 characters." }, 400);
      }
      await host.sessions.prompt({ sessionID, text: body.text.trim() });
      // prompt() enqueues a turn; wait() waits for its result.
      await host.sessions.wait({ sessionID });
    }
    const session = await host.sessions.get({ sessionID });
    const messages = await host.message.list({ sessionID, order: "desc", limit: 100 });
    return json({ session, messages: messages.data.reverse() });
  }
}

export default {
  async fetch(request, env) {
    try {
      return await env.AGENT.get(env.AGENT.idFromName("demo")).fetch(request);
    } catch (error) {
      console.error(error);
      return json({ error: "OpenCode request failed. Read the session before retrying a prompt." }, 502);
    }
  },
};
