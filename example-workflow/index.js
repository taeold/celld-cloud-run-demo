import { WorkflowEntrypoint } from "cloudflare:workers";

export class DataPipelineWorkflow extends WorkflowEntrypoint {
  async run(event, step) {
    const { name, items } = event.payload;
    const timeline = [];
    const runStart = Date.now();

    // Step 1: Ingest and validate data
    const s1Start = Date.now();
    const validated = await step.do("validate-input", async () => {
      const stepStart = Date.now();
      if (!items || !Array.isArray(items)) {
        throw new Error("Invalid items array");
      }
      return {
        itemCount: items.length,
        receivedAt: new Date().toISOString(),
        internalExecMs: Date.now() - stepStart,
      };
    });
    timeline.push({
      name: "validate-input",
      kind: "step",
      status: "completed",
      startOffsetMs: 0,
      durationMs: Math.max(1, Date.now() - s1Start),
      startedAt: new Date(s1Start).toISOString(),
      completedAt: new Date().toISOString(),
      output: validated,
    });

    // Step 2: Sleep briefly to demonstrate durable workflow timer
    const s2Start = Date.now();
    await step.sleep("wait-briefly", "2 seconds");
    timeline.push({
      name: "wait-briefly",
      kind: "sleep",
      sleepSpec: "2 seconds",
      status: "completed",
      startOffsetMs: s2Start - runStart,
      durationMs: Math.max(2000, Date.now() - s2Start),
      startedAt: new Date(s2Start).toISOString(),
      completedAt: new Date().toISOString(),
    });

    // Step 3: Process items
    const s3Start = Date.now();
    const processed = await step.do("process-items", async () => {
      const sum = items.reduce((acc, x) => acc + (typeof x === "number" ? x : 0), 0);
      const uppercaseName = (name || "anonymous").toUpperCase();
      return {
        processedBy: uppercaseName,
        totalSum: sum,
        average: items.length > 0 ? sum / items.length : 0,
        completedAt: new Date().toISOString(),
      };
    });
    timeline.push({
      name: "process-items",
      kind: "step",
      status: "completed",
      startOffsetMs: s3Start - runStart,
      durationMs: Math.max(1, Date.now() - s3Start),
      startedAt: new Date(s3Start).toISOString(),
      completedAt: new Date().toISOString(),
      output: processed,
    });

    // Step 4: Finalize report
    const s4Start = Date.now();
    const summary = await step.do("finalize-report", async () => {
      return {
        status: "SUCCESS",
        metadata: validated,
        result: processed,
      };
    });
    timeline.push({
      name: "finalize-report",
      kind: "step",
      status: "completed",
      startOffsetMs: s4Start - runStart,
      durationMs: Math.max(1, Date.now() - s4Start),
      startedAt: new Date(s4Start).toISOString(),
      completedAt: new Date().toISOString(),
      output: summary,
    });

    return {
      status: "SUCCESS",
      workflowName: "data-pipeline",
      totalDurationMs: Date.now() - runStart,
      startedAt: new Date(runStart).toISOString(),
      completedAt: new Date().toISOString(),
      timeline,
      summary,
    };
  }
}

const WORKFLOW_REGISTRY = [];

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/") {
      return new Response(JSON.stringify({
        service: "celld-workflow-demo",
        endpoints: [
          "POST /create - trigger a new workflow instance",
          "GET /status?id=<id> - check workflow instance status",
        ]
      }, null, 2), {
        headers: { "content-type": "application/json" }
      });
    }

    if (url.pathname === "/headers") {
      return Response.json(Object.fromEntries(request.headers));
    }

    if (url.pathname === "/create" && request.method === "POST") {
      let body = {};
      try {
        body = await request.json();
      } catch {}
      const instance = await env.PIPELINE.create({
        params: {
          name: body.name ?? "Cloud Run User",
          items: body.items ?? [10, 20, 30, 40, 50],
        },
      });
      WORKFLOW_REGISTRY.unshift({
        id: instance.id,
        workflowName: "data-pipeline",
        createdAt: new Date().toISOString(),
        params: {
          name: body.name ?? "Cloud Run User",
          items: body.items ?? [10, 20, 30, 40, 50],
        },
      });
      if (WORKFLOW_REGISTRY.length > 50) WORKFLOW_REGISTRY.pop();

      return Response.json({
        success: true,
        workflowId: instance.id,
        checkUrl: `/status?id=${instance.id}`,
      });
    }

    if (url.pathname === "/status") {
      const id = url.searchParams.get("id");
      if (!id) return new Response("Missing ?id parameter", { status: 400 });
      try {
        const instance = await env.PIPELINE.get(id);
        const status = await instance.status();
        return Response.json(status);
      } catch (err) {
        return Response.json({ error: err.message }, { status: 500 });
      }
    }

    if (url.pathname === "/api/workflows") {
      return Response.json({
        workflows: WORKFLOW_REGISTRY,
      });
    }

    return new Response("Not found", { status: 404 });
  },
};

