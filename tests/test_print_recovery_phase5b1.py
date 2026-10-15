"""Chrome regression: completed print-job recovery after MV3 worker global state is lost.

Runs on a local-only HTTP origin. Synthetic markup, no provider access.
"""
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import json
import os
import threading
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
BACKGROUND = (ROOT / "background.js").read_text(encoding="utf-8")
PRINT = (ROOT / "print.js").read_text(encoding="utf-8")

class Handler(SimpleHTTPRequestHandler):
    def do_GET(self):
        data = b"<!doctype html><title>ChatFolio print recovery fixture</title><body>Test</body>"
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)
    def log_message(self, *args):
        pass

SETUP = """() => {
window.sent = [];
window.chrome = {
  runtime: {
    getURL: (path) => location.origin + "/" + path,
    onMessage: { addListener: (fn) => window.__messageHandler = fn },
    onConnect: { addListener: (fn) => window.__connectHandler = fn }
  },
  tabs: {
    create: async () => ({ id: 77 }),
    update: async () => ({}),
    remove: async () => ({}),
    onRemoved: { addListener: (fn) => window.__tabRemovedHandler = fn },
    onUpdated: { addListener: () => {} }
  }
};
window.send = (message) => new Promise((resolve) =>
  window.__messageHandler(message, { tab: { id: 42, windowId: 1 } }, resolve));
window.attachPort = () => {
  const port = {
    name: "chatfolio-print",
    sender: { tab: { id: 77 } },
    onMessage: { addListener: (fn) => window.__portHandler = fn },
    onDisconnect: { addListener: (fn) => window.__portDisconnect = fn },
    postMessage: (message) => window.sent.push(message)
  };
  window.__connectHandler(port);
  return port;
};
}
"""

with ThreadingHTTPServer(("127.0.0.1", 0), Handler) as server:
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
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

        assert first.evaluate("""async () => (await send({
          type:"CHATFOLIO_PRINT_BEGIN",jobId:"recovery-5b1",totalChunks:2,
          title:"Safe synthetic sample"
        })).ok""")
        assert first.evaluate("""async () => (await send({
          type:"CHATFOLIO_PRINT_CHUNK",jobId:"recovery-5b1",index:0,
          data:"<p>synthetic"
        })).ok""")
        assert first.evaluate("""async () => (await send({
          type:"CHATFOLIO_PRINT_CHUNK",jobId:"recovery-5b1",index:1,
          data:" restart case</p>"
        })).ok""")
        assert first.evaluate("""async () => (await send({
          type:"CHATFOLIO_PRINT_END",jobId:"recovery-5b1"
        })).ok""")
        first.close()  # Simulates a new service-worker JavaScript global.

        second = context.new_page()
        second.goto(origin)
        second.evaluate(SETUP)
        second.add_script_tag(content=BACKGROUND)
        second.evaluate("""() => {
          attachPort();
          __portHandler({type:"CHATFOLIO_PRINT_READY",jobId:"recovery-5b1"});
        }""")
        second.wait_for_function(
            """() => sent.some(m => m.type === "CHATFOLIO_PRINT_END")""",
            timeout=10000,
        )
        events = second.evaluate("sent")
        payload = "".join(e["data"] for e in events if e["type"] == "CHATFOLIO_PRINT_CHUNK")
        assert payload == "<p>synthetic restart case</p>", events
        assert [e["index"] for e in events if e["type"] == "CHATFOLIO_PRINT_CHUNK"] == [0,1], events
        assert events[-1]["type"] == "CHATFOLIO_PRINT_END", events
        second.evaluate("""() => __portHandler({
          type:"CHATFOLIO_PRINT_CONSUMED",jobId:"recovery-5b1"
        })""")
        second.wait_for_timeout(250)
        second.close()

        third = context.new_page()
        third.goto(origin)
        third.evaluate(SETUP)
        third.add_script_tag(content=BACKGROUND)
        third.evaluate("""() => {
          attachPort();
          __portHandler({type:"CHATFOLIO_PRINT_READY",jobId:"recovery-5b1"});
        }""")
        third.wait_for_function(
            """() => sent.some(m => m.type === "CHATFOLIO_PRINT_ERROR")""",
            timeout=10000,
        )
        assert not third.evaluate(
            """() => sent.some(m => m.type === "CHATFOLIO_PRINT_END")"""
        ), "Consumed data should not be replayable"
        third.close()

        # Verify the print view retries a disconnected worker port.
        page = context.new_page()
        page.goto(origin + "/?job=retry-fixture")
        page.set_content("""<!doctype html><html><body>
          <div id="statusTitle"></div><div id="statusText"></div>
          <button id="printAgain" hidden></button><iframe id="preview"></iframe>
        </body></html>""")
        page.evaluate("""() => {
          window.ports = [];
          window.chrome = {
            runtime: { connect: () => {
              const port = {
                messages: [],
                name: "chatfolio-print",
                onMessage: { addListener: (fn) => port.received = fn },
                onDisconnect: { addListener: (fn) => port.disconnect = fn },
                postMessage: (message) => port.messages.push(message)
              };
              window.ports.push(port);
              return port;
            }}
          };
        }""")
        page.add_script_tag(content=PRINT)
        assert page.evaluate("ports.length") == 1
        page.evaluate("() => ports[0].disconnect()")
        page.wait_for_function("ports.length === 2", timeout=3000)
        assert page.evaluate("ports[1].messages[0].type") == "CHATFOLIO_PRINT_READY"
        page.close()

        browser.close()

    server.shutdown()

print(json.dumps({"passed": True, "recovered_complete_job": True,
                  "consumed_snapshot_deleted": True, "print_port_reconnected": True}))
