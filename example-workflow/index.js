import { WorkflowEntrypoint } from "cloudflare:workers";

function generateSpanId() {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
}

function doSomethingExpensive(iterations = 4500000) {
  const t0 = Date.now();
  let acc = 0;
  for (let i = 0; i < iterations; i++) {
    acc += Math.sin(i) * Math.cos(i);
  }
  return {
    durationMs: Math.max(1, Date.now() - t0),
    checksum: acc.toFixed(4)
  };
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

export class UserOnboardingWorkflow extends WorkflowEntrypoint {
  async run(event, step) {
    const { name, traceId } = event.payload || {};
    const wfStartTime = Date.now();
    // Deterministic 16-hex spanId from traceId ensures identical parent across sleep replays
    const wfSpanId = (traceId && traceId.length === 32) ? traceId.slice(16, 32) : generateSpanId();

    // =========================================================================
    // STEP 1: Real Outbound HTTP Call to External API
    // =========================================================================
    const user = await step.do("fetch-user-profile", async () => {
      const t0 = Date.now();
      let author = "Alex Chen";
      try {
        const res = await fetch("https://httpbin.org/json", { signal: AbortSignal.timeout(3000) });
        if (res.ok) {
          const data = await res.json();
          author = data?.slideshow?.author || author;
        }
      } catch (e) {}

      return {
        userId: "usr_84920",
        author,
        source: "https://httpbin.org/json",
        t0,
        t1: Date.now()
      };
    });

    await emitOtelSpan({
      traceId,
      parentSpanId: wfSpanId,
      name: "01: fetch-user-profile (httpbin.org)",
      startMs: user.t0,
      endMs: user.t1,
      attributes: {
        "http.url": "https://httpbin.org/json",
        "http.method": "GET",
        "user.author": user.author
      }
    });

    // =========================================================================
    // STEP 2: 3x Parallel Expensive Compute in V8 Isolates
    // =========================================================================
    const [analytics, thumbnails, embeddings] = await Promise.all([
      // Worker 1: Compute heavy analytics
      step.do("process-analytics", async () => {
        const t0 = Date.now();
        const res = doSomethingExpensive(2500000);
        return { task: "analytics", ...res, t0, t1: Date.now() };
      }),
      // Worker 2: Render image thumbnails
      step.do("render-thumbnails", async () => {
        const t0 = Date.now();
        const res = doSomethingExpensive(4500000);
        return { task: "thumbnails", ...res, t0, t1: Date.now() };
      }),
      // Worker 3: Generate AI embeddings
      step.do("generate-embeddings", async () => {
        const t0 = Date.now();
        const res = doSomethingExpensive(6500000);
        return { task: "embeddings", ...res, t0, t1: Date.now() };
      }),
    ]);

    await Promise.all([
      emitOtelSpan({
        traceId,
        parentSpanId: wfSpanId,
        name: "02a: process-analytics",
        startMs: analytics.t0,
        endMs: analytics.t1,
        attributes: { "worker.task": "analytics", "compute.duration_ms": analytics.durationMs }
      }),
      emitOtelSpan({
        traceId,
        parentSpanId: wfSpanId,
        name: "02b: render-thumbnails",
        startMs: thumbnails.t0,
        endMs: thumbnails.t1,
        attributes: { "worker.task": "thumbnails", "compute.duration_ms": thumbnails.durationMs }
      }),
      emitOtelSpan({
        traceId,
        parentSpanId: wfSpanId,
        name: "02c: generate-embeddings",
        startMs: embeddings.t0,
        endMs: embeddings.t1,
        attributes: { "worker.task": "embeddings", "compute.duration_ms": embeddings.durationMs }
      }),
    ]);

    // =========================================================================
    // STEP 3: DURABLE HIBERNATION (Zero-CPU Scale-to-Zero in GCS)
    // =========================================================================
    const sleepT0 = Date.now();
    await step.sleep("wait-for-approval", "3 seconds");
    const sleepT1 = Date.now();

    await emitOtelSpan({
      traceId,
      parentSpanId: wfSpanId,
      name: "03: wait-for-approval (3s - Evicted to GCS at 0 CPU)",
      startMs: sleepT0,
      endMs: sleepT1,
      attributes: {
        "step.kind": "sleep",
        "step.duration_spec": "3 seconds",
        "celld.compute_cost": "0 CPU",
        "celld.storage": "gs://danielylee-junk-celld-demo-fleet/main/cells/"
      }
    });

    // =========================================================================
    // STEP 4: Real Outbound HTTP Call to External Webhook
    // =========================================================================
    const webhook = await step.do("call-webhook-api", async () => {
      const t0 = Date.now();
      let receiptId = "rec_" + generateSpanId().slice(0, 8);
      try {
        const res = await fetch("https://httpbin.org/uuid", { signal: AbortSignal.timeout(3000) });
        if (res.ok) {
          const data = await res.json();
          receiptId = data?.uuid || receiptId;
        }
      } catch (e) {}

      return {
        delivered: true,
        receiptId,
        endpoint: "https://httpbin.org/uuid",
        t0,
        t1: Date.now()
      };
    });

    await emitOtelSpan({
      traceId,
      parentSpanId: wfSpanId,
      name: "04: call-webhook-api (httpbin.org)",
      startMs: webhook.t0,
      endMs: webhook.t1,
      attributes: {
        "http.url": "https://httpbin.org/uuid",
        "webhook.delivered": true,
        "webhook.receipt_id": webhook.receiptId
      }
    });

    // =========================================================================
    // STEP 5: Final Durability Commit to SQLite LTX in GCS
    // =========================================================================
    const committed = await step.do("commit-final-state", async () => {
      const t0 = Date.now();
      doSomethingExpensive(1000000);
      return {
        status: "COMMITTED",
        user: user.author,
        receipt: webhook.receiptId,
        storageEngine: "SQLite LTX via GCS",
        t0,
        t1: Date.now()
      };
    });

    await emitOtelSpan({
      traceId,
      parentSpanId: wfSpanId,
      name: "05: commit-final-state",
      startMs: committed.t0,
      endMs: committed.t1,
      attributes: {
        "step.status": committed.status,
        "step.receipt": committed.receipt,
        "celld.storage": "SQLite LTX"
      }
    });

    const wfEndTime = Date.now();
    const startTimeMs = event?.timestamp ? new Date(event.timestamp).getTime() : (user?.t0 || wfStartTime);
    const realTotalDuration = Math.max(1, wfEndTime - startTimeMs);

    // Emit top-level Workflow execution root span
    await emitOtelSpan({
      traceId,
      parentSpanId: undefined,
      spanId: wfSpanId,
      name: `celld.workflow: user-onboarding`,
      startMs: user?.t0 || wfStartTime,
      endMs: wfEndTime,
      attributes: {
        "workflow.name": "user-onboarding",
        "workflow.status": "COMMITTED",
        "workflow.total_duration_ms": realTotalDuration,
        "celld.runtime": "v0.4.0"
      }
    });

    const wave1End = Math.max(analytics.t1 || 0, thumbnails.t1 || 0, embeddings.t1 || 0);
    const sleepDurationMs = Math.max(3000, sleepT1 - wave1End);

    return {
      status: "SUCCESS",
      workflowName: "user-onboarding",
      totalDurationMs: realTotalDuration,
      traceId,
      traceUrl: traceId ? `https://console.cloud.google.com/traces/explorer?project=danielylee-junk&traceId=${traceId}` : null,
      summary: committed,
      timings: {
        fetchUser: Math.max(1, (user?.t1 || 0) - (user?.t0 || 0)),
        analytics: Math.max(1, (analytics?.t1 || 0) - (analytics?.t0 || 0)),
        thumbnails: Math.max(1, (thumbnails?.t1 || 0) - (thumbnails?.t0 || 0)),
        embeddings: Math.max(1, (embeddings?.t1 || 0) - (embeddings?.t0 || 0)),
        sleep: sleepDurationMs,
        webhook: Math.max(1, (webhook?.t1 || 0) - (webhook?.t0 || 0)),
        commit: Math.max(1, (committed?.t1 || 0) - (committed?.t0 || 0)),
        total: realTotalDuration
      }
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

      const instance = await env.PIPELINE.create({
        params: {
          name: body.name ?? "User Onboarding Flow",
          userId: body.userId ?? "usr_84920",
          traceId,
          traceUrl,
        },
      });
      WORKFLOW_REGISTRY.unshift({
        id: instance.id,
        workflowName: "user-onboarding",
        createdAt: new Date().toISOString(),
        traceId,
        traceUrl,
        params: {
          name: body.name ?? "User Onboarding Flow",
          traceId,
        },
      });
      if (WORKFLOW_REGISTRY.length > 50) WORKFLOW_REGISTRY.pop();

      return Response.json({
        success: true,
        workflowId: instance.id,
        traceId,
        traceUrl,
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
