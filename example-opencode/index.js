import { OpenCodeWorkerd } from "@opencode-ai/sdk/workerd";
import { PAGE } from "./page.js";

const MODEL = { providerID: "opencode", id: "nemotron-3.5-lightning-free" };
const json = (value, status = 200) => Response.json(value, {
  status, headers: { "cache-control": "no-store" },
});

// One SDK host and one conversation per Durable Object; not one host per request.
export class Agent {
  constructor(state) {
    this.state = state;
    this.busy = false;
    this.host = state.blockConcurrencyWhile(() => OpenCodeWorkerd.create({
      storage: state.storage,
      config: { model: "opencode/nemotron-3.5-lightning-free", permission: "deny" },
    }));
  }

  async fetch(request) {
    const host = await this.host;
    const action = new URL(request.url).pathname.split("/").at(-1);
    let sessionID = await this.state.storage.get("sessionID");
    if (action === "create") {
      if (!sessionID) {
        const session = await host.sessions.create({
          location: { directory: "/workspace" }, model: MODEL,
        });
        sessionID = session.id;
        await this.state.storage.put("sessionID", sessionID);
      }
      return json({ sessionID });
    }
    if (!sessionID) return json({ error: "Session not found. Create a new session." }, 404);
    if (action === "prompt") {
      const body = await request.json().catch(() => null);
      if (typeof body?.text !== "string" || !body.text.trim() || body.text.length > 8000) {
        return json({ error: "Enter a prompt between 1 and 8,000 characters." }, 400);
      }
      if (this.busy) return json({ error: "A turn is already running. Reload its session before retrying." }, 409);
      this.busy = true;
      try {
        await host.sessions.prompt({ sessionID, text: body.text.trim() });
        // prompt() enqueues work; wait() keeps this request alive until it settles.
        await host.sessions.wait({ sessionID });
      } finally {
        this.busy = false;
      }
    }
    const session = await host.sessions.get({ sessionID });
    const messages = await host.message.list({ sessionID, order: "desc", limit: 100 });
    return json({ session, messages: messages.data.reverse(), busy: this.busy });
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/") {
      return new Response(PAGE, { headers: {
        "content-type": "text/html; charset=utf-8", "cache-control": "no-store",
        "x-content-type-options": "nosniff", "referrer-policy": "no-referrer",
      } });
    }
    try {
      if (request.method === "POST" && url.pathname === "/api/sessions") {
        const id = crypto.randomUUID();
        const response = await env.AGENT.get(env.AGENT.idFromName(id)).fetch("https://agent/create", { method: "POST" });
        if (!response.ok) return response;
        return json({ id }, 201);
      }
      const match = /^\/api\/sessions\/([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})(\/prompt)?$/.exec(url.pathname);
      if (!match) return json({ error: "Not found" }, 404);
      if (request.method !== (match[2] ? "POST" : "GET")) return json({ error: "Method not allowed" }, 405);
      return await env.AGENT.get(env.AGENT.idFromName(match[1])).fetch(request);
    } catch (error) {
      console.error(error);
      return json({ error: "OpenCode request failed. Reload the session before retrying; a submitted turn may still finish." }, 502);
    }
  },
};
