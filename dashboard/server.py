#!/usr/bin/env python3
"""
Celld Workflow Observability Dashboard Server
Connects to GCS bucket and Cloud Run Ingress to provide a span-like execution waterfall.
"""

import http.server
import json
import os
import re
import socketserver
import subprocess
import sys
import time
import urllib.request
import urllib.error

PORT = int(os.environ.get("PORT", 8888))
GCS_BUCKET = os.environ.get("CELLD_BUCKET", "gs://danielylee-junk-celld-demo-fleet/main")
INGRESS_URL = os.environ.get("CELLD_INGRESS_URL", "https://celld-demo-ingress-hqfdpj7xha-uw.a.run.app")

_token_cache = {"token": None, "expires": 0}

def get_auth_token():
    now = time.time()
    if _token_cache["token"] and _token_cache["expires"] > now:
        return _token_cache["token"]
    try:
        cmd = ["gcloud", "auth", "print-identity-token"]
        token = subprocess.check_output(cmd, text=True).strip()
        _token_cache["token"] = token
        _token_cache["expires"] = now + 1800
        return token
    except Exception as e:
        print(f"Error getting identity token: {e}", file=sys.stderr)
        return ""

def call_ingress(path, method="GET", body=None):
    token = get_auth_token()
    url = f"{INGRESS_URL.rstrip('/')}{path}"
    headers = {"Authorization": f"Bearer {token}"}
    data = None
    if body is not None:
        headers["Content-Type"] = "application/json"
        data = json.dumps(body).encode("utf-8")
    
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        return {"error": f"HTTP {e.code}: {e.read().decode('utf-8')}"}
    except Exception as e:
        return {"error": str(e)}

def list_gcs_workflow_cells():
    cells = []
    try:
        cmd = [
            "gcloud", "storage", "ls",
            f"{GCS_BUCKET.rstrip('/')}/cells/__Workflow.*"
        ]
        out = subprocess.check_output(cmd, text=True, stderr=subprocess.DEVNULL)
        for line in out.splitlines():
            line = line.strip().rstrip("/")
            if not line:
                continue
            m = re.search(r"(__Workflow\.[^/:]+):([a-f0-9]+)", line)
            if m:
                cells.append({
                    "workflowClass": m.group(1),
                    "cellId": m.group(2),
                    "fullPath": line
                })
    except Exception as e:
        print(f"Error listing GCS cells: {e}", file=sys.stderr)
    return cells

class DashboardHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(200)
        self.end_headers()

    def do_GET(self):
        url_path = self.path.split("?")[0]

        if url_path == "/" or url_path == "/index.html":
            self.serve_ui()
            return

        if url_path == "/api/status":
            self.send_json(200, {
                "service": "celld-workflow-dashboard",
                "bucket": GCS_BUCKET,
                "ingressUrl": INGRESS_URL,
                "version": "v0.4.0",
                "status": "ready"
            })
            return

        if url_path == "/api/workflows":
            # 1. Fetch live in-memory registry from Ingress
            ingress_runs = call_ingress("/api/workflows")
            registry_map = {}
            if isinstance(ingress_runs, dict) and "workflows" in ingress_runs:
                for item in ingress_runs["workflows"]:
                    registry_map[item["id"]] = item

            # 2. Fetch GCS cell records
            cells = list_gcs_workflow_cells()
            
            runs = []
            for wf_id, reg in registry_map.items():
                status_res = call_ingress(f"/status?id={wf_id}")
                runs.append({
                    "id": wf_id,
                    "workflowName": reg.get("workflowName", "data-pipeline"),
                    "createdAt": reg.get("createdAt", ""),
                    "params": reg.get("params", {}),
                    "status": status_res.get("status", "unknown"),
                    "output": status_res.get("output"),
                    "error": status_res.get("error")
                })

            self.send_json(200, {
                "bucket": GCS_BUCKET,
                "totalCells": len(cells),
                "workflows": runs
            })
            return

        if url_path.startswith("/api/workflow/"):
            wf_id = url_path.split("/")[-1]
            status_res = call_ingress(f"/status?id={wf_id}")
            self.send_json(200, {
                "id": wf_id,
                "status": status_res.get("status", "unknown"),
                "rollback": status_res.get("rollback"),
                "output": status_res.get("output"),
                "error": status_res.get("error")
            })
            return

        super().do_GET()

    def do_POST(self):
        if self.path == "/api/trigger":
            length = int(self.headers.get("Content-Length", 0))
            body = {}
            if length > 0:
                try:
                    body = json.loads(self.rfile.read(length).decode("utf-8"))
                except Exception:
                    pass
            
            res = call_ingress("/create", method="POST", body=body)
            self.send_json(200, res)
            return

        self.send_json(404, {"error": "Not found"})

    def serve_ui(self):
        html_file = os.path.join(os.path.dirname(__file__), "index.html")
        if os.path.exists(html_file):
            with open(html_file, "rb") as f:
                content = f.read()
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(content)))
            self.end_headers()
            self.wfile.write(content)
        else:
            self.send_json(404, {"error": "index.html not found"})

    def send_json(self, status_code, data):
        payload = json.dumps(data).encode("utf-8")
        self.send_response(status_code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

def main():
    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.TCPServer(("0.0.0.0", PORT), DashboardHandler) as httpd:
        print(f"===========================================================")
        print(f" Celld Workflow Observability Dashboard Running")
        print(f" Local URL:   http://localhost:{PORT}")
        print(f" Cloudtop URL: http://danielylee1.c.googlers.com:{PORT}")
        print(f" Ingress URL:  {INGRESS_URL}")
        print(f" GCS Bucket:   {GCS_BUCKET}")
        print(f"===========================================================")
        sys.stdout.flush()
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nShutting down dashboard...")

if __name__ == "__main__":
    main()
