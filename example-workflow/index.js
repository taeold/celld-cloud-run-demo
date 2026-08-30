import { WorkflowEntrypoint } from "cloudflare:workers";
import { DASHBOARD_HTML } from "./dashboardHtml.js";

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

export class DemoWorkflow extends WorkflowEntrypoint {
  async run(event, step) {
    const { name, traceId } = event.payload || {};
    const wfStartTime = Date.now();
    // Deterministic 16-hex spanId from traceId ensures identical parent across sleep replays
    const wfSpanId = (traceId && traceId.length === 32) ? traceId.slice(16, 32) : generateSpanId();

    // =========================================================================
    // STEP 1: fetch-json (Outbound HTTP GET)
    // =========================================================================
    const jsonRes = await step.do("fetch-json", async () => {
      const t0 = Date.now();
      let ok = true;
      try {
        const res = await fetch("https://httpbin.org/json", { signal: AbortSignal.timeout(3000) });
        ok = res.ok;
      } catch (e) {}
      const t1 = Date.now();

      await emitOtelSpan({
        traceId,
        parentSpanId: wfSpanId,
        name: "01: fetch-json (httpbin.org)",
        startMs: t0,
        endMs: t1,
        attributes: {
          "http.url": "https://httpbin.org/json",
          "http.method": "GET"
        }
      });

      return { endpoint: "https://httpbin.org/json", ok, t0, t1 };
    });

    // =========================================================================
    // STEP 2: 3x Concurrent Parallel API Calls
    // =========================================================================
    const [delayed, bytes, post] = await Promise.all([
      // Worker 1: 1-second delayed API call
      step.do("fetch-delay-1s", async () => {
        const t0 = Date.now();
        let origin = "";
        try {
          const res = await fetch("https://httpbin.org/delay/1", { signal: AbortSignal.timeout(5000) });
          if (res.ok) {
            const data = await res.json();
            origin = data?.origin || "";
          }
        } catch (e) {}
        const t1 = Date.now();

        await emitOtelSpan({
          traceId,
          parentSpanId: wfSpanId,
          name: "02a: fetch-delay-1s (httpbin.org/delay/1)",
          startMs: t0,
          endMs: t1,
          attributes: {
            "http.url": "https://httpbin.org/delay/1",
            "http.method": "GET",
            "origin": origin
          }
        });

        return { origin, t0, t1 };
      }),

      // Worker 2: Fetch 16KB binary stream
      step.do("fetch-bytes", async () => {
        const t0 = Date.now();
        let bytesCount = 16384;
        try {
          const res = await fetch("https://httpbin.org/bytes/16384", { signal: AbortSignal.timeout(5000) });
          if (res.ok) {
            const buf = await res.arrayBuffer();
            bytesCount = buf.byteLength;
          }
        } catch (e) {}
        const comp = doSomethingExpensive(8000000);
        const t1 = Date.now();

        await emitOtelSpan({
          traceId,
          parentSpanId: wfSpanId,
          name: "02b: fetch-bytes (httpbin.org/bytes/16384)",
          startMs: t0,
          endMs: t1,
          attributes: {
            "http.url": "https://httpbin.org/bytes/16384",
            "bytes": bytesCount,
            "compute.duration_ms": t1 - t0
          }
        });

        return { bytes: bytesCount, ...comp, t0, t1 };
      }),

      // Worker 3: Outbound POST request with JSON payload
      step.do("post-json", async () => {
        const t0 = Date.now();
        let echoId = "ok";
        try {
          const res = await fetch("https://httpbin.org/post", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ping: "pong", ts: Date.now() }),
            signal: AbortSignal.timeout(5000)
          });
          if (res.ok) {
            const data = await res.json();
            echoId = data?.headers?.["X-Amzn-Trace-Id"] || echoId;
          }
        } catch (e) {}
        const comp = doSomethingExpensive(12000000);
        const t1 = Date.now();

        await emitOtelSpan({
          traceId,
          parentSpanId: wfSpanId,
          name: "02c: post-json (httpbin.org/post)",
          startMs: t0,
          endMs: t1,
          attributes: {
            "http.url": "https://httpbin.org/post",
            "http.method": "POST",
            "echo.id": echoId,
            "compute.duration_ms": t1 - t0
          }
        });

        return { echoId, ...comp, t0, t1 };
      }),
    ]);

    // =========================================================================
    // STEP 3: DURABLE HIBERNATION (Scale-to-Zero at 0 CPU)
    // =========================================================================
    const wave1End = Math.max(delayed?.t1 || 0, bytes?.t1 || 0, post?.t1 || 0);
    await step.sleep("sleep-3s", "3 seconds");
    const wakeTime = Date.now();

    // Emitted only on Drive 2 after waking up, covering full dormant duration
    await emitOtelSpan({
      traceId,
      parentSpanId: wfSpanId,
      name: "03: sleep-3s (3s sleep at 0 CPU)",
      startMs: wave1End,
      endMs: wakeTime,
      attributes: {
        "step.kind": "sleep",
        "step.duration_spec": "3 seconds",
        "celld.compute_cost": "0 CPU",
      }
    });

    // =========================================================================
    // STEP 4: fetch-uuid (Outbound HTTP GET)
    // =========================================================================
    const uuidRes = await step.do("fetch-uuid", async () => {
      const t0 = Date.now();
      let uuid = "uuid_" + generateSpanId().slice(0, 8);
      try {
        const res = await fetch("https://httpbin.org/uuid", { signal: AbortSignal.timeout(3000) });
        if (res.ok) {
          const data = await res.json();
          uuid = data?.uuid || uuid;
        }
      } catch (e) {}
      const t1 = Date.now();

      await emitOtelSpan({
        traceId,
        parentSpanId: wfSpanId,
        name: "04: fetch-uuid (httpbin.org)",
        startMs: t0,
        endMs: t1,
        attributes: {
          "http.url": "https://httpbin.org/uuid",
          "uuid": uuid
        }
      });

      return {
        uuid,
        endpoint: "https://httpbin.org/uuid",
        t0,
        t1
      };
    });

    // =========================================================================
    // STEP 5: finish (Final state commit)
    // =========================================================================
    const committed = await step.do("finish", async () => {
      const t0 = Date.now();
      const t1 = Date.now();

      await emitOtelSpan({
        traceId,
        parentSpanId: wfSpanId,
        name: "05: finish",
        startMs: t0,
        endMs: t1,
        attributes: {
          "step.status": "OK",
          "uuid": uuidRes.uuid,
        }
      });

      return {
        status: "ok",
        uuid: uuidRes.uuid,
        t0,
        t1
      };
    });

    const wfEndTime = Date.now();
    const startTimeMs = event?.timestamp ? new Date(event.timestamp).getTime() : (jsonRes?.t0 || wfStartTime);
    const realTotalDuration = Math.max(1, wfEndTime - startTimeMs);

    // Emit top-level Workflow execution root span
    await emitOtelSpan({
      traceId,
      parentSpanId: undefined,
      spanId: wfSpanId,
      name: `celld.workflow: demo-workflow`,
      startMs: jsonRes?.t0 || wfStartTime,
      endMs: wfEndTime,
      attributes: {
        "workflow.name": "demo-workflow",
        "workflow.status": "OK",
        "workflow.total_duration_ms": realTotalDuration,
        "celld.runtime": "v0.4.0"
      }
    });

    const sleepDurationMs = Math.max(3000, wakeTime - wave1End);

    return {
      status: "SUCCESS",
      workflowName: "demo-workflow",
      totalDurationMs: realTotalDuration,
      traceId,
      traceUrl: traceId ? `https://console.cloud.google.com/traces/explorer?project=danielylee-junk&traceId=${traceId}` : null,
      summary: committed,
      timings: {
        fetchUser: Math.max(1, (jsonRes?.t1 || 0) - (jsonRes?.t0 || 0)),
        analytics: Math.max(1, (delayed?.t1 || 0) - (delayed?.t0 || 0)),
        thumbnails: Math.max(1, (bytes?.t1 || 0) - (bytes?.t0 || 0)),
        embeddings: Math.max(1, (post?.t1 || 0) - (post?.t0 || 0)),
        sleep: sleepDurationMs,
        webhook: Math.max(1, (uuidRes?.t1 || 0) - (uuidRes?.t0 || 0)),
        commit: Math.max(1, (committed?.t1 || 0) - (committed?.t0 || 0)),
        total: realTotalDuration
      }
    };
  }
}

export const UserOnboardingWorkflow = DemoWorkflow;

const WORKFLOW_REGISTRY = [];

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/") {
      return new Response(DASHBOARD_HTML, {
        headers: { "content-type": "text/html; charset=utf-8" }
      });
    }

    if (url.pathname === "/headers") {
      return Response.json(Object.fromEntries(request.headers));
    }

    if ((url.pathname === "/create" || url.pathname === "/api/trigger") && request.method === "POST") {
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

    if (url.pathname === "/status" || url.pathname.startsWith("/api/workflow/")) {
      const id = url.searchParams.get("id") || url.pathname.split("/").pop();
      if (!id) return new Response("Missing id parameter", { status: 400 });
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
