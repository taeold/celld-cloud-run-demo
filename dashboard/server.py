#!/usr/bin/env python3
"""
Celld Workflow Observability Dashboard Server
Discovers workflows directly from GCS bucket LTX records and queries Cloud Run Ingress.
"""

import http.server
import json
import os
import re
import socketserver
import subprocess
import sys
import threading
import time
import urllib.request
import urllib.error

PORT = int(os.environ.get("PORT", 8888))
GCS_BUCKET = os.environ.get("CELLD_BUCKET", "gs://danielylee-junk-celld-demo-fleet/main")
INGRESS_URL = os.environ.get("CELLD_INGRESS_URL", "https://celld-demo-ingress-hqfdpj7xha-uw.a.run.app")
CACHE_FILE = "/tmp/celld_workflow_cache.json"

_token_cache = {"token": None, "expires": 0}
_workflow_cache = {}
_lock = threading.Lock()

def load_cache():
    global _workflow_cache
    if os.path.exists(CACHE_FILE):
        try:
            with open(CACHE_FILE, "r") as f:
                disk = json.load(f)
                with _lock:
                    for k, v in disk.items():
                        if k not in _workflow_cache:
                            _workflow_cache[k] = v
        except Exception:
            pass

def save_cache():
    try:
        with open(CACHE_FILE, "w") as f:
            json.dump(_workflow_cache, f, indent=2)
    except Exception as e:
        print(f"Error saving cache: {e}", file=sys.stderr)

def get_auth_token():
    now = time.time()
    if _token_cache["token"] and _token_cache["expires"] > now:
        return _token_cache["token"]
    
    # 1. Try metadata server (Cloud Run runtime)
    try:
        req = urllib.request.Request(
            f"http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity?audience={INGRESS_URL}",
            headers={"Metadata-Flavor": "Google"}
        )
        with urllib.request.urlopen(req, timeout=1) as resp:
            token = resp.read().decode("utf-8").strip()
            if token:
                _token_cache["token"] = token
                _token_cache["expires"] = now + 1800
                return token
    except Exception:
        pass

    # 2. Fallback to local gcloud CLI (local development)
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

def scan_gcs_for_workflow_ids():
    """Scans GCS LTX files to discover all workflow instance UUIDs."""
    print("Scanning GCS bucket for workflow cells...", flush=True)
    discovered = set()
    try:
        cmd = ["gcloud", "storage", "ls", f"{GCS_BUCKET.rstrip('/')}/cells/__Workflow.*/**.ltx"]
        files = subprocess.check_output(cmd, text=True, stderr=subprocess.DEVNULL).splitlines()
        for f in files:
            f = f.strip()
            if not f:
                continue
            out = subprocess.check_output(["gcloud", "storage", "cat", f], stderr=subprocess.DEVNULL)
            uuids = re.findall(rb"[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}", out)
            for u in uuids:
                discovered.add(u.decode("utf-8"))
    except Exception as e:
        print(f"Error scanning GCS: {e}", file=sys.stderr)
    
    with _lock:
        for wf_id in discovered:
            if wf_id not in _workflow_cache:
                # Query status from ingress
                status_res = call_ingress(f"/status?id={wf_id}")
                if "error" not in status_res:
                    _workflow_cache[wf_id] = {
                        "id": wf_id,
                        "workflowName": "data-pipeline",
                        "status": status_res.get("status", "complete"),
                        "output": status_res.get("output"),
                        "error": status_res.get("error")
                    }
        save_cache()
    print(f"GCS scan complete. Discovered {len(_workflow_cache)} total workflow instances.", flush=True)

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
            load_cache()
            # Refresh active or pending runs
            runs = []
            with _lock:
                for wf_id, record in list(_workflow_cache.items()):
                    if record.get("status") in ("waiting", "running", "queued"):
                        fresh = call_ingress(f"/status?id={wf_id}")
                        if "error" not in fresh:
                            record.update(fresh)
                    runs.append(record)
            
            # Sort newest first
            runs.sort(key=lambda x: x.get("output", {}).get("startedAt", "") if isinstance(x.get("output"), dict) else "", reverse=True)

            self.send_json(200, {
                "bucket": GCS_BUCKET,
                "totalRuns": len(runs),
                "workflows": runs
            })
            return

        if url_path.startswith("/api/workflow/"):
            wf_id = url_path.split("/")[-1]
            status_res = call_ingress(f"/status?id={wf_id}")
            if "error" not in status_res:
                with _lock:
                    if wf_id in _workflow_cache:
                        _workflow_cache[wf_id].update(status_res)
                    else:
                        _workflow_cache[wf_id] = {
                            "id": wf_id,
                            "workflowName": "data-pipeline",
                            **status_res
                        }
                    save_cache()
                self.send_json(200, {
                    "id": wf_id,
                    **status_res
                })
            else:
                # Return cached if available
                cached = _workflow_cache.get(wf_id, {"id": wf_id, "error": status_res.get("error")})
                self.send_json(200, cached)
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
            if res.get("workflowId"):
                wf_id = res["workflowId"]
                with _lock:
                    _workflow_cache[wf_id] = {
                        "id": wf_id,
                        "workflowName": "user-onboarding",
                        "status": "running",
                        "output": None,
                        "error": None
                    }
                    save_cache()
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
    load_cache()
    # Start initial GCS scan in background thread
    t = threading.Thread(target=scan_gcs_for_workflow_ids, daemon=True)
    t.start()

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
