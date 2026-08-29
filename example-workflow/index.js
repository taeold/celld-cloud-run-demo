import { WorkflowEntrypoint } from "cloudflare:workers";

function generateSpanId() {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
}

async function emitOtelSpan({ traceId, parentSpanId, spanId, name, startMs, endMs, attributes = {} }) {
  if (!traceId || traceId.length !== 32) return;
  const sid = spanId || generateSpanId();
  const startNano = (BigInt(Math.floor(startMs)) * 1000000n).toString();
  const endNano = (BigInt(Math.ceil(endMs)) * 1000000n).toString();
  
  const span = {
    traceId: traceId.toLowerCase(),
    spanId: sid.toLowerCase(),
    name,
    kind: 1, // SPAN_KIND_INTERNAL
    startTimeUnixNano: startNano,
    endTimeUnixNano: endNano,
    attributes: Object.entries(attributes).map(([key, val]) => {
      if (typeof val === "number") return { key, value: { intValue: String(val) } };
      if (typeof val === "boolean") return { key, value: { boolValue: val } };
      return { key, value: { stringValue: String(val) } };
    })
  };
  if (parentSpanId && parentSpanId.length === 16) {
    span.parentSpanId = parentSpanId.toLowerCase();
  }

  const payload = {
    resourceSpans: [{
      resource: {
        attributes: [
          { key: "service.name", value: { stringValue: "celld-workflow-demo" } }
        ]
      },
      scopeSpans: [{
        scope: { name: "celld.workflows", version: "0.4.0" },
        spans: [span]
      }]
    }]
  };

  try {
    console.log(`[OTEL] Emitting span: ${name}, traceId: ${traceId}, parent: ${parentSpanId}`);
    const res = await fetch("http://127.0.0.1:4318/v1/traces", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    console.log(`[OTEL] Result for ${name}: status ${res.status}`);
  } catch (err) {
    console.error(`[OTEL] Failed to emit span ${name}:`, err);
  }
}

export class DataPipelineWorkflow extends WorkflowEntrypoint {
  async run(event, step) {
    const { name, items, traceId } = event.payload;
    const rawItems = Array.isArray(items) && items.length > 0 ? items : [12, 45, 68, 23, 89, 34, 56, 91, 14, 77];
    const wfStartTime = Date.now();
    // Deterministic 16-hex spanId from traceId ensures identical parent across sleep replays
    const wfSpanId = (traceId && traceId.length === 32) ? traceId.slice(16, 32) : generateSpanId();

    // Stage 1: Ingest & Partition
    const planned = await step.do("ingest-and-partition", async () => {
      const t0 = Date.now();
      const n = Math.ceil(rawItems.length / 3);
      const res = {
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
      return res;
    });

    // Emit Step 1 span
    await emitOtelSpan({
      traceId,
      parentSpanId: wfSpanId,
      name: "step: ingest-and-partition",
      startMs: planned.t0,
      endMs: planned.t1,
      attributes: {
        "step.name": "ingest-and-partition",
        "step.total_items": planned.totalItems,
        "step.checksum": planned.checksum
      }
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

    // Emit Step 2 parallel spans
    await Promise.all([
      emitOtelSpan({
        traceId,
        parentSpanId: wfSpanId,
        name: "step: transform-partition-a",
        startMs: partA.t0,
        endMs: partA.t1,
        attributes: { "step.partition": 0, "step.count": partA.count, "step.sum": partA.sum }
      }),
      emitOtelSpan({
        traceId,
        parentSpanId: wfSpanId,
        name: "step: transform-partition-b",
        startMs: partB.t0,
        endMs: partB.t1,
        attributes: { "step.partition": 1, "step.count": partB.count, "step.sum": partB.sum, "step.min": partB.min, "step.max": partB.max }
      }),
      emitOtelSpan({
        traceId,
        parentSpanId: wfSpanId,
        name: "step: transform-partition-c",
        startMs: partC.t0,
        endMs: partC.t1,
        attributes: { "step.partition": 2, "step.count": partC.count, "step.sum": partC.sum, "step.average": String(partC.average) }
      }),
    ]);

    // Stage 3: Durable Sleep Cooldown (Zero-CPU GCS Hibernate)
    const sleepT0 = Date.now();
    await step.sleep("durable-cooldown", "2 seconds");
    const sleepT1 = Date.now();

    // Emit Step 3 hibernate span
    await emitOtelSpan({
      traceId,
      parentSpanId: wfSpanId,
      name: "step: durable-cooldown (2s sleep)",
      startMs: sleepT0,
      endMs: sleepT1,
      attributes: {
        "step.kind": "sleep",
        "step.duration_spec": "2 seconds",
        "celld.compute_cost": "0 CPU",
        "celld.storage": "gs://danielylee-junk-celld-demo-fleet/main/cells/"
      }
    });

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

    // Emit Step 4 span
    await emitOtelSpan({
      traceId,
      parentSpanId: wfSpanId,
      name: "step: verify-integrity",
      startMs: verified.t0,
      endMs: verified.t1,
      attributes: {
        "step.integrity_valid": true,
        "step.verified_partitions": 3,
        "step.checksum": verified.checksum
      }
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

    // Emit Step 5 span
    await emitOtelSpan({
      traceId,
      parentSpanId: wfSpanId,
      name: "step: aggregate-and-commit",
      startMs: finalized.t0,
      endMs: finalized.t1,
      attributes: {
        "step.status": finalized.status,
        "step.grand_sum": finalized.grandSum,
        "step.mean": String(finalized.mean),
        "celld.commit": "SQLite LTX"
      }
    });

    const wfEndTime = Date.now();

    // Emit top-level Workflow execution span (root span for this workflow instance)
    await emitOtelSpan({
      traceId,
      parentSpanId: undefined,
      spanId: wfSpanId,
      name: `celld.workflow: data-pipeline`,
      startMs: wfStartTime,
      endMs: wfEndTime,
      attributes: {
        "workflow.name": "data-pipeline",
        "workflow.status": "COMPLETED",
        "workflow.total_duration_ms": wfEndTime - wfStartTime,
        "workflow.total_items": rawItems.length,
        "celld.runtime": "v0.4.0"
      }
    });

    // Construct sequential/parallel timeline for frontend
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
      let parentSpanId = "";
      if (traceContext.includes("/")) {
        const parts = traceContext.split("/");
        traceId = parts[0];
        if (parts[1]) {
          const rawSpan = parts[1].split(";")[0].trim();
          if (/^\d+$/.test(rawSpan)) {
            try {
              parentSpanId = BigInt(rawSpan).toString(16).padStart(16, "0");
            } catch (e) {
              parentSpanId = rawSpan.padStart(16, "0");
            }
          } else if (/^[0-9a-fA-F]{1,16}$/.test(rawSpan)) {
            parentSpanId = rawSpan.toLowerCase().padStart(16, "0");
          }
        }
      } else if (traceContext.startsWith("00-")) {
        const parts = traceContext.split("-");
        traceId = parts[1];
        if (parts[2]) {
          parentSpanId = parts[2].toLowerCase();
        }
      }

      const traceUrl = traceId ? `https://console.cloud.google.com/traces/explorer?project=danielylee-junk&traceId=${traceId}` : null;
      const pantheonUrl = traceId ? `https://pantheon.corp.google.com/traces/explorer;query=%7B%22timeSeriesQuery%22:%7B%22traceQuery%22:%7B%22resourceContainer%22:%22projects%2Fdanielylee-junk%2Flocations%2Fglobal%2FtraceScopes%2F_Default%22%7D%7D%7D;traceId=${traceId}?project=danielylee-junk` : null;

      const instance = await env.PIPELINE.create({
        params: {
          name: body.name ?? "Cloud Run User",
          items: body.items ?? [10, 20, 30, 40, 50],
          traceId,
          parentSpanId,
          traceUrl,
          pantheonUrl,
        },
      });
      WORKFLOW_REGISTRY.unshift({
        id: instance.id,
        workflowName: "data-pipeline",
        createdAt: new Date().toISOString(),
        traceId,
        parentSpanId,
        traceUrl,
        pantheonUrl,
        params: {
          name: body.name ?? "Cloud Run User",
          items: body.items ?? [10, 20, 30, 40, 50],
          traceId,
          parentSpanId,
        },
      });
      if (WORKFLOW_REGISTRY.length > 50) WORKFLOW_REGISTRY.pop();

      return Response.json({
        success: true,
        workflowId: instance.id,
        traceId,
        parentSpanId,
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
        return Response.json({ error: String(err) }, { status: 500 });
      }
    }

    if (url.pathname === "/test-otel") {
      try {
        const res = await fetch("http://127.0.0.1:4318/v1/traces", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ resourceSpans: [] })
        });
        const text = await res.text();
        return Response.json({ status: res.status, text });
      } catch (err) {
        return Response.json({ error: String(err), stack: err.stack }, { status: 500 });
      }
    }

    if (url.pathname === "/list") {
      return Response.json(WORKFLOW_REGISTRY);
    }

    return new Response("Not found", { status: 400 });
  },
};
