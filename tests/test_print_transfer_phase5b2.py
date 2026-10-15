"""Phase 5B2 Chromium regression: source-owned transfer status and orphan tab cleanup."""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import json
import os
from threading import Thread
from playwright.sync_api import sync_playwright

BACKGROUND = (Path(__file__).resolve().parents[1] / "background.js").read_text()

class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        body = b"<!doctype html><html><body>synthetic fixture</body></html>"
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
    def log_message(self, *args):
        pass

SETUP = """() => {
  window.removed = [];
  window.mockPrintUrl = "chrome-extension://fixture/print.html?job=retry-orphan";
  window.chrome = {
    runtime: {
      getURL: (path) => "chrome-extension://fixture/" + path,
      onMessage: { addListener: (fn) => window.handler = fn },
      onConnect: { addListener: () => {} }
    },
    tabs: {
      onRemoved: { addListener: () => {} },
      onUpdated: { addListener: () => {} },
      create: async () => ({id:77}),
      update: async () => ({}),
      get: async (id) => ({id,url:window.mockPrintUrl}),
      remove: async (id) => {window.removed.push(id);}
    }
  };
  window.request = (message) => new Promise(resolve => handler(
    message, {tab:{id:42,windowId:1}}, resolve
  ));
}"""

with ThreadingHTTPServer(("127.0.0.1", 0), Handler) as server:
    Thread(target=server.serve_forever, daemon=True).start()
    origin = "http://127.0.0.1:" + str(server.server_port)
    with sync_playwright() as p:
        browser = p.chromium.launch(
            headless=True,
            executable_path=os.environ.get("CHATFOLIO_CHROMIUM") or None,
            args=["--no-sandbox", "--disable-dev-shm-usage"],
        )
        context = browser.new_context()
        first = context.new_page()
        first.goto(origin)
        first.evaluate(SETUP)
        first.add_script_tag(content=BACKGROUND)
        assert first.evaluate("""async () => (await request({
          type:"CHATFOLIO_PRINT_BEGIN",jobId:"retry-orphan",totalChunks:2
        })).ok""")
        active = first.evaluate("""async () => await request({
          type:"CHATFOLIO_PRINT_STATUS",jobId:"retry-orphan"
        })""")
        assert active["ok"] and not active["complete"], active
        assert first.evaluate("""async () => (await request({
          type:"CHATFOLIO_PRINT_CHUNK",jobId:"retry-orphan",index:0,data:"partial"
        })).ok""")
        first.close()  # An interrupted, incomplete transfer is lost.

        second = context.new_page()
        second.goto(origin)
        second.evaluate(SETUP)
        second.add_script_tag(content=BACKGROUND)
        missing = second.evaluate("""async () => await request({
          type:"CHATFOLIO_PRINT_STATUS",jobId:"retry-orphan"
        })""")
        assert not missing["ok"], missing

        second.evaluate("""() => {
          window.mockPrintUrl = "https://example.org/not-a-print-tab";
        }""")
        rejected = second.evaluate("""async () => await request({
          type:"CHATFOLIO_PRINT_ABORT",jobId:"retry-orphan",printTabId:77
        })""")
        assert not rejected["ok"], rejected
        assert second.evaluate("removed") == []

        second.evaluate("""() => {
          window.mockPrintUrl = "chrome-extension://fixture/print.html?job=retry-orphan";
        }""")
        aborted = second.evaluate("""async () => await request({
          type:"CHATFOLIO_PRINT_ABORT",jobId:"retry-orphan",printTabId:77
        })""")
        assert aborted["ok"], aborted
        assert second.evaluate("removed") == [77]
        second.close()
        browser.close()
    server.shutdown()
print(json.dumps({"passed":True,"partial_status":True,"lost_transfer_detected":True,
                  "unrelated_tab_protected":True,"orphan_preview_cleaned":True}))
