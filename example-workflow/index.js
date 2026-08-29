import { WorkflowEntrypoint } from "cloudflare:workers";

export class DataPipelineWorkflow extends WorkflowEntrypoint {
  async run(event, step) {
    const { name, items } = event.payload;

    // Step 1: Ingest and validate data
    const validated = await step.do("validate-input", async () => {
      const t0 = Date.now();
      if (!items || !Array.isArray(items)) {
        throw new Error("Invalid items array");
      }
      return {
        itemCount: items.length,
        t0,
        t1: Date.now(),
      };
    });

    // Step 2: Sleep briefly to demonstrate durable workflow timer
    await step.sleep("wait-briefly", "2 seconds");

    // Step 3: Process items
    const processed = await step.do("process-items", async () => {
      const t0 = Date.now();
      const sum = items.reduce((acc, x) => acc + (typeof x === "number" ? x : 0), 0);
      const uppercaseName = (name || "anonymous").toUpperCase();
      return {
        processedBy: uppercaseName,
        totalSum: sum,
        average: items.length > 0 ? sum / items.length : 0,
        t0,
        t1: Date.now(),
      };
    });

    // Step 4: Finalize report
    const summary = await step.do("finalize-report", async () => {
      const t0 = Date.now();
      return {
        status: "SUCCESS",
        metadata: validated,
        result: processed,
        t0,
        t1: Date.now(),
      };
    });

    const s1Duration = Math.max(1, validated.t1 - validated.t0);
    const s2Duration = 2000;
    const s3Duration = Math.max(1, processed.t1 - processed.t0);
    const s4Duration = Math.max(1, summary.t1 - summary.t0);

    const s1Start = 0;
    const s2Start = s1Start + s1Duration;
    const s3Start = s2Start + s2Duration;
    const s4Start = s3Start + s3Duration;
    const totalMs = s4Start + s4Duration;

    const timeline = [
      {
        name: "validate-input",
        kind: "step",
        status: "completed",
        startOffsetMs: s1Start,
        durationMs: s1Duration,
        output: { itemCount: validated.itemCount }
      },
      {
        name: "wait-briefly",
        kind: "sleep",
        sleepSpec: "2 seconds",
        status: "completed",
        startOffsetMs: s2Start,
        durationMs: s2Duration
      },
      {
        name: "process-items",
        kind: "step",
        status: "completed",
        startOffsetMs: s3Start,
        durationMs: s3Duration,
        output: { processedBy: processed.processedBy, totalSum: processed.totalSum, average: processed.average }
      },
      {
        name: "finalize-report",
        kind: "step",
        status: "completed",
        startOffsetMs: s4Start,
        durationMs: s4Duration,
        output: { status: "SUCCESS", totalSum: processed.totalSum }
      }
    ];

    return {
      status: "SUCCESS",
      workflowName: "data-pipeline",
      totalDurationMs: totalMs,
      timeline,
      summary: {
        metadata: { itemCount: validated.itemCount },
        result: { processedBy: processed.processedBy, totalSum: processed.totalSum, average: processed.average }
      },
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

