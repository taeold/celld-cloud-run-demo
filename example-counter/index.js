const ROOM_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const RESERVED_ROOM_IDS = new Set([
  "__celld",
  "cell",
  "health",
  "internal",
  "operator",
  "peer",
  "probe",
  "shutdown",
  "state",
]);
const PAGE_HEADERS = {
  "cache-control": "no-store",
  "content-type": "text/html; charset=utf-8",
  "x-content-type-options": "nosniff",
};

const PAGE = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Celld Counter Room</title>
  <style>
    :root { color-scheme: light; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    * { box-sizing: border-box; }
    body { margin: 0; color: #1f2328; background: #fff; }
    main { width: min(400px, calc(100% - 32px)); margin: 72px auto; text-align: center; }
    h1 { margin: 0 0 28px; font-size: 14px; font-weight: 600; }
    h2 { margin: 0 0 32px; overflow-wrap: anywhere; font-size: 20px; font-weight: 600; }
    #count { display: block; min-height: 1em; margin-bottom: 24px; font-variant-numeric: tabular-nums; font-size: 72px; font-weight: 600; line-height: 1; letter-spacing: -.05em; }
    button { width: 100%; height: 40px; border: 1px solid rgba(27, 31, 36, .15); border-radius: 6px; color: #fff; background: #1f883d; cursor: pointer; font: inherit; font-size: 14px; font-weight: 600; }
    button:hover:not(:disabled) { background: #1a7f37; }
    button:disabled { cursor: not-allowed; opacity: .55; }
    button:focus-visible, a:focus-visible { outline: 2px solid #54aeff; outline-offset: 2px; }
    nav { display: flex; justify-content: center; gap: 12px; margin-top: 20px; font-size: 13px; }
    a { color: #0969da; text-decoration: none; }
    a:hover { text-decoration: underline; }
    a.active { color: #1f2328; font-weight: 600; }
  </style>
</head>
<body>
  <main>
    <h1>Celld on Cloud Run</h1>
    <h2 id="room-id">Loading…</h2>
    <output id="count" aria-live="polite">—</output>
    <button id="increment" type="button" disabled>Increment</button>
    <nav aria-label="Other rooms">
      <a data-room="alpha" href="/alpha">Alpha</a>
      <a data-room="beta" href="/beta">Beta</a>
      <a data-room="gamma" href="/gamma">Gamma</a>
    </nav>
  </main>

  <script>
  (() => {
    "use strict";
    const roomPattern = /^[a-z0-9][a-z0-9_-]{0,63}$/;
    let room;
    try {
      room = decodeURIComponent(location.pathname.slice(1)).toLowerCase();
    } catch {
      location.replace("/alpha");
      return;
    }
    if (!roomPattern.test(room)) {
      location.replace("/alpha");
      return;
    }

    const roomPath = "/" + encodeURIComponent(room);
    const roomName = room.charAt(0).toUpperCase() + room.slice(1);
    const count = document.querySelector("#count");
    const increment = document.querySelector("#increment");
    document.querySelector("#room-id").textContent = room;
    document.title = roomName + " · Celld Counter";
    for (const link of document.querySelectorAll("[data-room]")) {
      if (link.dataset.room === room) {
        link.classList.add("active");
        link.setAttribute("aria-current", "page");
      }
    }

    let socket;
    let retry;
    let attempts = 0;
    let leaving = false;
    function connect() {
      clearTimeout(retry);
      increment.disabled = true;
      const scheme = location.protocol === "https:" ? "wss:" : "ws:";
      socket = new WebSocket(scheme + "//" + location.host + roomPath);
      socket.addEventListener("open", () => {
        attempts = 0;
      });
      socket.addEventListener("message", event => {
        let message;
        try { message = JSON.parse(event.data); } catch { return; }
        if (message.type !== "count" || !Number.isSafeInteger(message.count) || message.count < 0) return;
        count.textContent = String(message.count);
        increment.disabled = false;
      });
      socket.addEventListener("close", () => {
        increment.disabled = true;
        if (leaving) return;
        attempts += 1;
        retry = setTimeout(connect, Math.min(500 * (2 ** (attempts - 1)), 5000));
      });
      socket.addEventListener("error", () => socket.close());
    }
    increment.addEventListener("click", () => {
      if (socket?.readyState === WebSocket.OPEN) {
        increment.disabled = true;
        socket.send(JSON.stringify({ type: "increment" }));
      }
    });
    addEventListener("beforeunload", () => {
      leaving = true;
      clearTimeout(retry);
      socket?.close();
    });
    connect();
  })();
  </script>
</body>
</html>`;

function roomRoute(pathname) {
  if (!pathname.startsWith("/") || pathname.indexOf("/", 1) !== -1) return null;
  let room;
  try {
    room = decodeURIComponent(pathname.slice(1)).toLowerCase();
  } catch {
    return { invalid: true };
  }
  if (!ROOM_ID.test(room) || RESERVED_ROOM_IDS.has(room)) return { invalid: true };
  const canonicalPath = `/${encodeURIComponent(room)}`;
  return { canonicalPath, room };
}

export class Room {
  constructor(state) {
    this.state = state;
  }

  async fetch(request) {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("WebSocket upgrade required\n", { status: 426 });
    }
    const pair = new WebSocketPair();
    const server = pair[0];
    this.state.acceptWebSocket(server);
    const count = (await this.state.storage.get("count")) ?? 0;
    server.send(JSON.stringify({ type: "count", count }));
    return new Response(null, { status: 101, webSocket: pair[1] });
  }

  async webSocketMessage(_socket, raw) {
    let message;
    try {
      message = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw));
    } catch {
      return;
    }
    if (message.type !== "increment") return;
    const count = ((await this.state.storage.get("count")) ?? 0) + 1;
    await this.state.storage.put("count", count);
    const update = JSON.stringify({ type: "count", count });
    for (const socket of this.state.getWebSockets()) socket.send(update);
  }

  async webSocketClose(socket, code, reason) {
    const closeCode = code === 1000 || (code >= 3000 && code <= 4999) ? code : 1000;
    socket.close(closeCode, reason);
  }

  async webSocketError(socket) {
    socket.close(1000, "WebSocket error");
  }
}

export default {
  fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/") {
      return new Response(null, { status: 302, headers: { location: "/alpha" } });
    }
    const route = roomRoute(url.pathname);
    if (!route) return new Response("Not found\n", { status: 404 });
    if (route.invalid) {
      return new Response("Invalid or reserved room ID. Use 1-64 lowercase letters, numbers, hyphens, or underscores.\n", { status: 404 });
    }
    if (url.pathname !== route.canonicalPath || url.search) {
      return new Response(null, { status: 308, headers: { location: route.canonicalPath } });
    }
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response(PAGE, { headers: PAGE_HEADERS });
    }
    return env.ROOM.get(env.ROOM.idFromName(route.room)).fetch(request);
  },
};
