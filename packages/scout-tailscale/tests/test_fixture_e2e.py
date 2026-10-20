"""End to end: this client against the real TypeScript guest gate and routes.

Launches fixture/guest-fixture.ts (runtime mesh-ingress-gate + broker guest
routes, temporary state) on loopback. Skipped when bun or the repo runtime is
unavailable, e.g. on an installed wheel.
"""

import contextlib
import io
import json
import os
import shutil
import socket
import subprocess
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

from scout_tailscale import cli
from scout_tailscale.core import GuestClient, GuestError, Store

ROOT = Path(__file__).resolve().parents[1]
FIXTURE = ROOT / "fixture" / "guest-fixture.ts"
RUNTIME = ROOT.parent / "runtime" / "src" / "broker-guest-http-routes.ts"


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


@unittest.skipUnless(shutil.which("bun") and RUNTIME.exists(), "needs bun and the repo runtime")
class FixtureEndToEnd(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.dir = Path(tempfile.mkdtemp())
        cls.port, cls.admin = free_port(), free_port()
        cls.process = subprocess.Popen(
            ["bun", str(FIXTURE), "serve", "--host", "127.0.0.1", "--port", str(cls.port), "--admin", str(cls.admin),
             "--state", str(cls.dir / "fixture"), "--reply-delay-ms", "200"],
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        deadline = time.time() + 30
        while not (cls.dir / "fixture" / "fixture.json").exists():
            if time.time() > deadline or cls.process.poll() is not None:
                raise RuntimeError("fixture did not start: " + (cls.process.stdout.read() if cls.process.poll() is not None else "timeout"))
            time.sleep(0.1)
        cls.info = json.loads((cls.dir / "fixture" / "fixture.json").read_text())

    @classmethod
    def tearDownClass(cls):
        cls.process.terminate()
        cls.process.wait(10)
        cls.process.stdout.close()

    def run_cli(self, home, *argv):
        out = io.StringIO()
        with mock.patch.dict(os.environ, {"SCOUT_TAILSCALE_HOME": str(home), "SCOUT_TAILSCALE_PROXY": "direct"}), \
                contextlib.redirect_stdout(out), contextlib.redirect_stderr(io.StringIO()):
            code = cli.main(["--json", *argv])
        return code, json.loads(out.getvalue() or "{}")

    def enroll(self, home, request_id, targets="fixture.echo"):
        _, key = self.run_cli(home, "key")
        claim = home.parent / f"{request_id}.json"
        subprocess.run(["bun", str(FIXTURE), "grant", "--admin", str(self.admin), "--public-key", key["publicKey"],
                        "--request-id", request_id, "--targets", targets, "--out", str(claim)], check=True, capture_output=True)
        code, result = self.run_cli(home, "connect", "--bootstrap", str(claim), "--node-key", self.info["nodeKeyId"],
                                    "--endpoint", f"https://127.0.0.1:{self.port}")
        self.assertEqual((code, result.get("verified")), (0, True), result)

    def test_scout_mesh_guests_exports_a_usable_bootstrap_and_revokes(self):
        home = self.dir / "cli-client" / "state"
        _, key = self.run_cli(home, "key")
        entry = ROOT.parents[1] / "apps" / "desktop" / "bin" / "scout.ts"
        env = {**os.environ, "OPENSCOUT_INSTANCE": "prod", "OPENSCOUT_BROKER_URL": f"http://127.0.0.1:{self.admin}",
               "OPENSCOUT_HOME": str(self.dir / "owner"), "SCOUT_HOME": str(self.dir / "owner")}

        def owner(*args):
            result = subprocess.run(["bun", str(entry), "mesh", "guests", *args, "--json"],
                                    check=True, capture_output=True, text=True, env=env, timeout=20)
            return json.loads(result.stdout)

        claim = owner("grant", key["publicKey"], "--label", "CLI guest", "--agent", "fixture.echo",
                      "--expires-at", str(int(time.time() * 1000) + 60_000), "--request-id", "cli-bootstrap")
        self.assertEqual(claim["allowed_targets"], ["fixture.echo"])
        self.assertIsInstance(claim["expires_at"], str)
        path = self.dir / "cli-bootstrap.json"
        path.write_text(json.dumps(claim))
        code, connected = self.run_cli(home, "connect", "--bootstrap", str(path),
                                       "--node-key", self.info["nodeKeyId"],
                                       "--endpoint", f"https://127.0.0.1:{self.port}", "--proxy", "direct")
        self.assertEqual((code, connected.get("verified")), (0, True), connected)
        code, result = self.run_cli(home, "ask", "--to", "fixture.echo", "--wait", "20", "CLI bootstrap")
        self.assertEqual((code, result["state"]), (0, "completed"), result)
        self.assertTrue(owner("revoke", "--request-id", "cli-bootstrap")["ok"])
        with self.assertRaises(GuestError) as caught:
            GuestClient(Store(home)).ask("fixture.echo", "revoked", "cli-revoked-1")
        self.assertEqual(caught.exception.status, 401)

    def test_ask_and_result_through_the_real_gate(self):
        home = self.dir / "client-a" / "state"
        self.enroll(home, "e2e-a")
        code, who = self.run_cli(home, "who")
        self.assertEqual([a["id"] for a in who["agents"]], ["fixture.echo"])
        code, result = self.run_cli(home, "ask", "--to", "fixture.echo", "--request-id", "e2e-ask-0001", "--wait", "20", "hello ✓")
        self.assertEqual((code, result["state"]), (0, "completed"))
        self.assertEqual(result["output"], "fixture.echo received 9 bytes: hello ✓")
        # Resending the journaled ask is the same ask, not a second one.
        code, again = self.run_cli(home, "ask", "--resume", "e2e-ask-0001")
        self.assertEqual((code, again["duplicate"], again["invocationId"]), (0, True, result["invocationId"]))
        code, denied = self.run_cli(home, "ask", "--to", "scout.main", "not in scope")
        self.assertEqual((code, denied["error"]), (1, "no_machine_for_target"))
        # The local check is a courtesy; the node's gate refuses it on its own.
        with mock.patch.dict(os.environ, {"SCOUT_TAILSCALE_HOME": str(home), "SCOUT_TAILSCALE_PROXY": "direct"}):
            with self.assertRaises(GuestError) as caught:
                GuestClient(Store(home)).ask("scout.main", "not in scope", "e2e-scope-0001")
        self.assertEqual((caught.exception.status, caught.exception.code), (403, "target_not_allowed"))

    def test_doctor_distinguishes_valid_grant_from_missing_destination(self):
        for name, target, expected in [("ready", "fixture.echo", 0), ("stale", "fixture.retired", 1)]:
            with self.subTest(target=target):
                home = self.dir / ("doctor-" + name) / "state"
                self.enroll(home, "doctor-" + name, target)
                code, result = self.run_cli(home, "doctor")
                self.assertEqual(code, expected, result)
                checks = {item["check"].split(": ")[-1]: item for item in result["checks"]}
                self.assertTrue(checks["node card"]["ok"], result)
                self.assertTrue(checks["guest grant"]["ok"], result)
                self.assertEqual(checks["permitted agents"]["ok"], expected == 0, result)

    def test_revocation_and_pin_mismatch_fail_closed(self):
        home = self.dir / "client-b" / "state"
        self.enroll(home, "e2e-b")
        subprocess.run(["bun", str(FIXTURE), "revoke", "--admin", str(self.admin), "--request-id", "e2e-b"], check=True, capture_output=True)
        code, result = self.run_cli(home, "who")
        self.assertEqual(code, 4, result)
        state = json.loads((home / "state.json").read_text())
        for entry in state["machines"].values():
            entry["node"]["pin"] = "0" * 64
        (home / "state.json").write_text(json.dumps(state))
        code, result = self.run_cli(home, "who")
        self.assertEqual((code, list(result["unavailable"].values())), (3, ["pin_mismatch"]))

    def test_bootstrap_for_another_node_key_is_refused(self):
        home = self.dir / "client-c" / "state"
        _, key = self.run_cli(home, "key")
        claim = self.dir / "c.json"
        subprocess.run(["bun", str(FIXTURE), "grant", "--admin", str(self.admin), "--public-key", key["publicKey"],
                        "--request-id", "e2e-c", "--out", str(claim)], check=True, capture_output=True)
        code, result = self.run_cli(home, "connect", "--bootstrap", str(claim), "--node-key", "f" * 64)
        self.assertEqual((code, result["error"]), (1, "invalid_bootstrap"))


if __name__ == "__main__":
    unittest.main()
