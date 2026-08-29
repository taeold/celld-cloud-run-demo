import { WorkflowEntrypoint } from "cloudflare:workers";

export class DataPipelineWorkflow extends WorkflowEntrypoint {
  async run(event, step) {
    const { name, items, traceId } = event.payload;
    const rawItems = Array.isArray(items) && items.length > 0 ? items : [12, 45, 68, 23, 89, 34, 56, 91, 14, 77];

    // Stage 1: Ingest & Partition
    const planned = await step.do("ingest-and-partition", async () => {
      const t0 = Date.now();
      const n = Math.ceil(rawItems.length / 3);
      return {
        totalItems: rawItems.length,
        partitions: [
          rawItems.slice(0, n),
          rawItems.slice(n, 2 * n),
          rawItems.slice(2 * n),
        ],
        checksum: rawItems.reduce((a, b) => a + (typeof b === "number" ? b : 0), 0),
        t0,
        t1: Date.now(),
      };
    });

    // Stage 2: Parallel Fan-Out (3 Concurrent Workers)
    const [partA, partB, partC] = await Promise.all([
      step.do("transform-partition-a", async () => {
        const t0 = Date.now();
        const p = planned.partitions[0];
        const sum = p.reduce((a, b) => a + b, 0);
        return {
          partition: 0,
          count: p.length,
          sum,
          squaresSum: p.reduce((a, b) => a + b * b, 0),
          t0,
          t1: Date.now(),
        };
      }),
      step.do("transform-partition-b", async () => {
        const t0 = Date.now();
        const p = planned.partitions[1];
        const sum = p.reduce((a, b) => a + b, 0);
        return {
          partition: 1,
          count: p.length,
          sum,
          min: Math.min(...p),
          max: Math.max(...p),
          t0,
          t1: Date.now(),
        };
      }),
      step.do("transform-partition-c", async () => {
        const t0 = Date.now();
        const p = planned.partitions[2];
        const sum = p.reduce((a, b) => a + b, 0);
        return {
          partition: 2,
          count: p.length,
          sum,
          average: p.length > 0 ? sum / p.length : 0,
          t0,
          t1: Date.now(),
        };
      }),
    ]);

    // Stage 3: Durable Sleep Cooldown (Zero-CPU GCS Hibernate)
    await step.sleep("durable-cooldown", "2 seconds");

    // Stage 4: Integrity Verification
    const verified = await step.do("verify-integrity", {
      retries: { limit: 3, delay: 500, backoff: "exponential" }
    }, async () => {
      const t0 = Date.now();
      const recombinedSum = partA.sum + partB.sum + partC.sum;
      if (recombinedSum !== planned.checksum) {
        throw new Error(`Checksum mismatch: expected ${planned.checksum}, got ${recombinedSum}`);
      }
      return {
        integrityValid: true,
        verifiedPartitions: 3,
        checksum: recombinedSum,
        t0,
        t1: Date.now(),
      };
    });

    // Stage 5: Aggregate and Commit
    const finalized = await step.do("aggregate-and-commit", async () => {
      const t0 = Date.now();
      const totalCount = partA.count + partB.count + partC.count;
      const grandSum = partA.sum + partB.sum + partC.sum;
      return {
        status: "COMMITTED",
        jobName: name || "Autonomous Pipeline",
        totalItemsProcessed: totalCount,
        grandSum,
        mean: totalCount > 0 ? (grandSum / totalCount).toFixed(2) : 0,
        varianceEstimate: ((partA.squaresSum - (partA.sum * partA.sum) / partA.count) / Math.max(1, partA.count - 1)).toFixed(2),
        t0,
        t1: Date.now(),
      };
    });

    // Construct sequential/parallel timeline
    const s1Dur = Math.max(1, planned.t1 - planned.t0);
    const s2aDur = Math.max(1, partA.t1 - partA.t0);
    const s2bDur = Math.max(1, partB.t1 - partB.t0);
    const s2cDur = Math.max(1, partC.t1 - partC.t0);
    const parallelDur = Math.max(s2aDur, s2bDur, s2cDur);
    const sleepDur = 2000;
    const s4Dur = Math.max(1, verified.t1 - verified.t0);
    const s5Dur = Math.max(1, finalized.t1 - finalized.t0);

    const s1Start = 0;
    const s2Start = s1Start + s1Dur;
    const s3Start = s2Start + parallelDur;
    const s4Start = s3Start + sleepDur;
    const s5Start = s4Start + s4Dur;
    const totalMs = s5Start + s5Dur;

    const timeline = [
      {
        name: "ingest-and-partition",
        stage: 1,
        kind: "step",
        status: "completed",
        startOffsetMs: s1Start,
        durationMs: s1Dur,
        output: { totalItems: planned.totalItems, partitions: 3, checksum: planned.checksum }
      },
      {
        name: "transform-partition-a",
        stage: 2,
        kind: "step",
        status: "completed",
        isParallel: true,
        startOffsetMs: s2Start,
        durationMs: s2aDur,
        output: { partition: 0, count: partA.count, sum: partA.sum }
      },
      {
        name: "transform-partition-b",
        stage: 2,
        kind: "step",
        status: "completed",
        isParallel: true,
        startOffsetMs: s2Start,
        durationMs: s2bDur,
        output: { partition: 1, count: partB.count, sum: partB.sum, min: partB.min, max: partB.max }
      },
      {
        name: "transform-partition-c",
        stage: 2,
        kind: "step",
        status: "completed",
        isParallel: true,
        startOffsetMs: s2Start,
        durationMs: s2cDur,
        output: { partition: 2, count: partC.count, sum: partC.sum, avg: partC.average }
      },
      {
        name: "durable-cooldown",
        stage: 3,
        kind: "sleep",
        sleepSpec: "2 seconds",
        status: "completed",
        startOffsetMs: s3Start,
        durationMs: sleepDur
      },
      {
        name: "verify-integrity",
        stage: 4,
        kind: "step",
        status: "completed",
        startOffsetMs: s4Start,
        durationMs: s4Dur,
        output: { integrityValid: true, verifiedPartitions: 3 }
      },
      {
        name: "aggregate-and-commit",
        stage: 5,
        kind: "step",
        status: "completed",
        startOffsetMs: s5Start,
        durationMs: s5Dur,
        output: finalized
      }
    ];

    return {
      status: "SUCCESS",
      workflowName: "data-pipeline",
      totalDurationMs: totalMs,
      traceId,
      traceUrl: traceId ? `https://console.cloud.google.com/traces/explorer?project=danielylee-junk&traceId=${traceId}` : null,
      timeline,
      summary: finalized
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

      const traceContext = request.headers.get("x-cloud-trace-context") || request.headers.get("traceparent") || "";
      let traceId = "";
      if (traceContext.includes("/")) {
        traceId = traceContext.split("/")[0];
      } else if (traceContext.startsWith("00-")) {
        traceId = traceContext.split("-")[1];
      }

      const traceUrl = traceId ? `https://console.cloud.google.com/traces/explorer?project=danielylee-junk&traceId=${traceId}` : null;
      const pantheonUrl = traceId ? `https://pantheon.corp.google.com/traces/explorer;query=%7B%22timeSeriesQuery%22:%7B%22traceQuery%22:%7B%22resourceContainer%22:%22projects%2Fdanielylee-junk%2Flocations%2Fglobal%2FtraceScopes%2F_Default%22%7D%7D%7D;traceId=${traceId}?project=danielylee-junk` : null;

      const instance = await env.PIPELINE.create({
        params: {
          name: body.name ?? "Cloud Run User",
          items: body.items ?? [10, 20, 30, 40, 50],
          traceId,
          traceUrl,
          pantheonUrl,
        },
      });
      WORKFLOW_REGISTRY.unshift({
        id: instance.id,
        workflowName: "data-pipeline",
        createdAt: new Date().toISOString(),
        traceId,
        traceUrl,
        pantheonUrl,
        params: {
          name: body.name ?? "Cloud Run User",
          items: body.items ?? [10, 20, 30, 40, 50],
          traceId,
        },
      });
      if (WORKFLOW_REGISTRY.length > 50) WORKFLOW_REGISTRY.pop();

      return Response.json({
        success: true,
        workflowId: instance.id,
        traceId,
        traceUrl,
        pantheonUrl,
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

