import { WorkflowEntrypoint } from "cloudflare:workers";

function generateSpanId() {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
}

function burnCpu(iterations, type = "math") {
  const t0 = Date.now();
  let acc = 1234567;
  if (type === "monte-carlo") {
    let varSum = 0;
    for (let i = 0; i < iterations; i++) {
      const shock = (Math.sin(i) * 1000) % 2;
      acc += shock;
      varSum += shock * shock;
    }
    return { dur: Math.max(1, Date.now() - t0), var: (varSum / Math.max(1, iterations)).toFixed(4) };
  } else if (type === "crypto") {
    for (let i = 0; i < iterations; i++) {
      acc = Math.imul(acc ^ (i + 101), 1664525) + 1013904223 | 0;
    }
    return { dur: Math.max(1, Date.now() - t0), hash: (acc >>> 0).toString(16).padStart(8, "0") };
  } else if (type === "regression") {
    let sumX = 0, sumY = 0, sumXY = 0, sumXX = 0;
    for (let i = 0; i < iterations; i++) {
      const x = i % 100;
      const y = x * 1.45 + (Math.cos(i) * 5);
      sumX += x; sumY += y; sumXY += x * y; sumXX += x * x;
    }
    const denom = iterations * sumXX - sumX * sumX;
    const slope = denom !== 0 ? (iterations * sumXY - sumX * sumY) / denom : 1.45;
    return { dur: Math.max(1, Date.now() - t0), beta: slope.toFixed(4) };
  } else {
    for (let i = 0; i < iterations; i++) {
      acc = (acc * 33 + i) ^ (acc >>> 5);
    }
    return { dur: Math.max(1, Date.now() - t0), metric: (acc % 1000) / 10 };
  }
}

async function emitOtelSpan({ traceId, parentSpanId, spanId, name, startMs, endMs, attributes = {} }) {
  if (!traceId || traceId.length !== 32) return;
  const sid = spanId || generateSpanId();
  const startNano = (BigInt(Math.floor(startMs)) * 1000000n).toString();
  const endNano = (BigInt(Math.ceil(Math.max(startMs + 1, endMs))) * 1000000n).toString();
  
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
    await fetch("http://127.0.0.1:4318/v1/traces", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
  } catch (err) {}
}

export class DataPipelineWorkflow extends WorkflowEntrypoint {
  async run(event, step) {
    const { name, items, traceId } = event.payload;
    const rawItems = Array.isArray(items) && items.length > 0 ? items : [12, 45, 68, 23, 89, 34, 56, 91, 14, 77, 62, 83];
    const wfStartTime = Date.now();
    // Deterministic 16-hex spanId from traceId ensures identical parent across sleep replays
    const wfSpanId = (traceId && traceId.length === 32) ? traceId.slice(16, 32) : generateSpanId();

    // =========================================================================
    // WAVE 1: INGESTION & 4-WAY PARALLEL COMPUTE FAN-OUT
    // =========================================================================

    // Stage 1: Ingest & Shard Dataset
    const planned = await step.do("01-ingest-and-shard", async () => {
      const t0 = Date.now();
      const cpu = burnCpu(1500000, "crypto");
      return {
        totalItems: rawItems.length,
        partitions: 4,
        checksum: rawItems.reduce((a, b) => a + (typeof b === "number" ? b : 0), 0),
        digest: cpu.hash,
        t0,
        t1: Date.now(),
      };
    });

    await emitOtelSpan({
      traceId,
      parentSpanId: wfSpanId,
      name: "01: ingest-and-shard",
      startMs: planned.t0,
      endMs: planned.t1,
      attributes: {
        "step.name": "ingest-and-shard",
        "step.total_items": planned.totalItems,
        "step.checksum": planned.checksum,
        "step.digest": planned.digest
      }
    });

    // Stage 2: 4x Parallel Heavy Compute Fan-Out (Promise.all)
    const [partA, partB, partC, partD] = await Promise.all([
      // Worker A: Cryptographic Merkle Hash Tree (~350ms)
      step.do("02a-merkle-tree-hashing", async () => {
        const t0 = Date.now();
        const cpu = burnCpu(3500000, "crypto");
        return {
          worker: "merkle-tree-hashing",
          status: "VERIFIED",
          merkleRoot: `0x${cpu.hash}fa81b`,
          depth: 4,
          t0,
          t1: Date.now(),
        };
      }),
      // Worker B: Monte Carlo Volatility Simulation (~500ms)
      step.do("02b-monte-carlo-simulation", async () => {
        const t0 = Date.now();
        const cpu = burnCpu(4500000, "monte-carlo");
        return {
          worker: "monte-carlo-simulation",
          simulations: 250000,
          valueAtRisk99: `${(cpu.var * 100).toFixed(2)}%`,
          t0,
          t1: Date.now(),
        };
      }),
      // Worker C: Linear Regression & Beta Modeling (~300ms)
      step.do("02c-linear-regression-modeling", async () => {
        const t0 = Date.now();
        const cpu = burnCpu(3000000, "regression");
        return {
          worker: "linear-regression-modeling",
          beta: cpu.beta,
          rSquared: "0.984",
          t0,
          t1: Date.now(),
        };
      }),
      // Worker D: Anomaly & Z-Score Detection (~200ms)
      step.do("02d-anomaly-zscore-detection", async () => {
        const t0 = Date.now();
        const cpu = burnCpu(2000000, "math");
        return {
          worker: "anomaly-zscore-detection",
          outliersDetected: 0,
          zScoreMax: "2.14",
          t0,
          t1: Date.now(),
        };
      }),
    ]);

    // Emit 4 parallel spans to OTLP sidecar
    await Promise.all([
      emitOtelSpan({
        traceId,
        parentSpanId: wfSpanId,
        name: "02a: merkle-tree-hashing",
        startMs: partA.t0,
        endMs: partA.t1,
        attributes: { "worker.type": "merkle", "merkle.root": partA.merkleRoot }
      }),
      emitOtelSpan({
        traceId,
        parentSpanId: wfSpanId,
        name: "02b: monte-carlo-simulation",
        startMs: partB.t0,
        endMs: partB.t1,
        attributes: { "worker.type": "monte-carlo", "simulations": partB.simulations, "var_99": partB.valueAtRisk99 }
      }),
      emitOtelSpan({
        traceId,
        parentSpanId: wfSpanId,
        name: "02c: linear-regression-modeling",
        startMs: partC.t0,
        endMs: partC.t1,
        attributes: { "worker.type": "regression", "model.beta": partC.beta }
      }),
      emitOtelSpan({
        traceId,
        parentSpanId: wfSpanId,
        name: "02d: anomaly-zscore-detection",
        startMs: partD.t0,
        endMs: partD.t1,
        attributes: { "worker.type": "anomaly", "zscore.max": partD.zScoreMax }
      }),
    ]);

    // =========================================================================
    // STAGE 3: DURABLE HIBERNATION #1 (Zero-CPU GCS Eviction)
    // =========================================================================
    const sleep1T0 = Date.now();
    await step.sleep("03-cooldown-window-1", "3 seconds");
    const sleep1T1 = Date.now();

    await emitOtelSpan({
      traceId,
      parentSpanId: wfSpanId,
      name: "03: durable-sleep-1 (3s - Isolate Evicted to GCS)",
      startMs: sleep1T0,
      endMs: sleep1T1,
      attributes: {
        "step.kind": "sleep",
        "step.duration_spec": "3 seconds",
        "celld.compute_cost": "0 CPU",
        "celld.storage": "gs://danielylee-junk-celld-demo-fleet/main/cells/"
      }
    });

    // =========================================================================
    // WAVE 2: INTER-SHARD RECONCILIATION & 3-WAY MODEL CALIBRATION
    // =========================================================================

    // Stage 4: Reconcile proofs & cross-validate
    const reconciled = await step.do("04-cross-shard-reconciliation", async () => {
      const t0 = Date.now();
      const cpu = burnCpu(1500000, "crypto");
      return {
        step: "reconciliation",
        reconciledShards: 4,
        merkleConsensus: partA.merkleRoot,
        hash: cpu.hash,
        t0,
        t1: Date.now(),
      };
    });

    await emitOtelSpan({
      traceId,
      parentSpanId: wfSpanId,
      name: "04: cross-shard-reconciliation",
      startMs: reconciled.t0,
      endMs: reconciled.t1,
      attributes: { "reconciliation.shards": 4, "reconciliation.consensus": reconciled.merkleConsensus }
    });

    // Stage 5: 3x Parallel Calibration Fan-Out
    const [calibA, calibB, calibC] = await Promise.all([
      // Calibrator 1: Bayesian Parameter Prior Update (~250ms)
      step.do("05a-bayesian-calibration", async () => {
        const t0 = Date.now();
        const cpu = burnCpu(2500000, "regression");
        return {
          model: "bayesian",
          priorConfidence: "99.1%",
          betaAdj: cpu.beta,
          t0,
          t1: Date.now(),
        };
      }),
      // Calibrator 2: Black Swan Stress-Test Simulation (~450ms)
      step.do("05b-stress-test-simulation", async () => {
        const t0 = Date.now();
        const cpu = burnCpu(4000000, "monte-carlo");
        return {
          model: "black-swan-stress",
          maxDrawdownEstimate: "14.2%",
          volatilityShock: cpu.var,
          t0,
          t1: Date.now(),
        };
      }),
      // Calibrator 3: Regulatory Capital Audit (~200ms)
      step.do("05c-regulatory-capital-audit", async () => {
        const t0 = Date.now();
        const cpu = burnCpu(2000000, "math");
        return {
          model: "basel-iii-audit",
          tier1CapitalRatio: "16.8%",
          compliant: true,
          t0,
          t1: Date.now(),
        };
      }),
    ]);

    // Emit calibration spans
    await Promise.all([
      emitOtelSpan({
        traceId,
        parentSpanId: wfSpanId,
        name: "05a: bayesian-calibration",
        startMs: calibA.t0,
        endMs: calibA.t1,
        attributes: { "model.prior": calibA.priorConfidence, "model.beta_adj": calibA.betaAdj }
      }),
      emitOtelSpan({
        traceId,
        parentSpanId: wfSpanId,
        name: "05b: stress-test-simulation",
        startMs: calibB.t0,
        endMs: calibB.t1,
        attributes: { "stress.max_drawdown": calibB.maxDrawdownEstimate, "stress.shock": calibB.volatilityShock }
      }),
      emitOtelSpan({
        traceId,
        parentSpanId: wfSpanId,
        name: "05c: regulatory-capital-audit",
        startMs: calibC.t0,
        endMs: calibC.t1,
        attributes: { "audit.tier1_ratio": calibC.tier1CapitalRatio, "audit.compliant": calibC.compliant }
      }),
    ]);

    // =========================================================================
    // STAGE 6: DURABLE HIBERNATION #2 (Zero-CPU Settlement Lockout)
    // =========================================================================
    const sleep2T0 = Date.now();
    await step.sleep("06-settlement-delay", "3 seconds");
    const sleep2T1 = Date.now();

    await emitOtelSpan({
      traceId,
      parentSpanId: wfSpanId,
      name: "06: durable-sleep-2 (3s - Isolate Evicted to GCS)",
      startMs: sleep2T0,
      endMs: sleep2T1,
      attributes: {
        "step.kind": "sleep",
        "step.duration_spec": "3 seconds",
        "celld.compute_cost": "0 CPU",
        "celld.storage": "gs://danielylee-junk-celld-demo-fleet/main/cells/"
      }
    });

    // =========================================================================
    // STAGE 7: FINAL GLOBAL CONSENSUS & ACID LTX COMMIT
    // =========================================================================
    const committed = await step.do("07-consensus-and-commit", async () => {
      const t0 = Date.now();
      burnCpu(1500000, "crypto");
      return {
        status: "COMMITTED",
        pipeline: name || "Autonomous Risk & Analytics Pipeline",
        totalItemsProcessed: rawItems.length,
        grandChecksum: planned.checksum,
        merkleRoot: partA.merkleRoot,
        valueAtRisk99: partB.valueAtRisk99,
        capitalCompliance: calibC.compliant,
        storageEngine: "SQLite LTX via GCS",
        t0,
        t1: Date.now(),
      };
    });

    await emitOtelSpan({
      traceId,
      parentSpanId: wfSpanId,
      name: "07: consensus-and-commit",
      startMs: committed.t0,
      endMs: committed.t1,
      attributes: {
        "step.status": committed.status,
        "step.merkle_root": committed.merkleRoot,
        "step.capital_compliant": committed.capitalCompliance,
        "celld.storage": "SQLite LTX"
      }
    });

    const wfEndTime = Date.now();
    const startTimeMs = event?.timestamp ? new Date(event.timestamp).getTime() : (planned?.t0 || wfStartTime);
    const realTotalDuration = Math.max(1, wfEndTime - startTimeMs);

    // Emit top-level Workflow execution root span
    await emitOtelSpan({
      traceId,
      parentSpanId: undefined,
      spanId: wfSpanId,
      name: `celld.workflow: data-pipeline`,
      startMs: planned?.t0 || wfStartTime,
      endMs: wfEndTime,
      attributes: {
        "workflow.name": "data-pipeline",
        "workflow.status": "COMMITTED",
        "workflow.total_duration_ms": realTotalDuration,
        "workflow.stages": 7,
        "workflow.total_items": rawItems.length,
        "celld.runtime": "v0.4.0"
      }
    });

    return {
      status: "SUCCESS",
      workflowName: "data-pipeline",
      totalDurationMs: realTotalDuration,
      traceId,
      traceUrl: traceId ? `https://console.cloud.google.com/traces/explorer?project=danielylee-junk&traceId=${traceId}` : null,
      summary: committed
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
          name: body.name ?? "Autonomous Risk & Analytics Pipeline",
          items: body.items ?? [12, 45, 68, 23, 89, 34, 56, 91, 14, 77, 62, 83],
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
          name: body.name ?? "Autonomous Risk & Analytics Pipeline",
          items: body.items ?? [12, 45, 68, 23, 89, 34, 56, 91, 14, 77, 62, 83],
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
        return Response.json({ error: String(err) }, { status: 500 });
      }
    }

    if (url.pathname === "/list") {
      return Response.json(WORKFLOW_REGISTRY);
    }

    return new Response("Not found", { status: 400 });
  },
};
