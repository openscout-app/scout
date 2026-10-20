"""Static runbook checks, not tailnet authorization or VM acceptance."""
import json
import shutil
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
DOC = ROOT / "docs/linux-tailnet-guest.md"
POLICY = ROOT / "docs/examples/scout-guest-policy.json"


@unittest.skipUnless(DOC.exists() and POLICY.exists(), "needs repository onboarding files")
class LinuxOnboarding(unittest.TestCase):
    def test_policy_is_one_guest_tag_one_destination_and_one_tcp_port(self):
        policy = json.loads(POLICY.read_text())
        self.assertEqual(policy["grants"], [{"src": ["tag:scout-guest"], "dst": ["scout-runtime"], "ip": ["tcp:43110"]}])
        test = policy["tests"][0]
        self.assertEqual(test["src"], "tag:scout-guest")
        self.assertEqual(test["proto"], "tcp")
        self.assertEqual(test["accept"], ["scout-runtime:43110"])
        self.assertIn("scout-runtime:22", test["deny"])
        self.assertIn("scout-runtime:43111", test["deny"])
        self.assertIn("other-node:43110", test["deny"])
        self.assertNotIn("*", json.dumps(policy))

    @unittest.skipUnless(shutil.which("bash"), "needs bash for syntax-only checks")
    def test_shell_blocks_parse_without_running_them(self):
        blocks = DOC.read_text().split("```sh\n")[1:]
        self.assertGreaterEqual(len(blocks), 5)
        for block in blocks:
            result = subprocess.run(["bash", "-n"], input=block.split("```", 1)[0], text=True, capture_output=True)
            self.assertEqual(result.returncode, 0, result.stderr)

    def test_admission_uses_file_secret_and_no_implicit_hosted_pairing(self):
        doc = DOC.read_text()
        self.assertIn("--auth-key=file:/run/secrets/scout-tailnet-key", doc)
        self.assertIn("--accept-routes=false --ssh=false", doc)
        self.assertIn("connect --bootstrap grant.json", doc)
        self.assertIn("--proxy direct", doc)
        self.assertNotIn("connect --owner", doc)
        self.assertIn("No Linux VM has been enrolled", doc)
        self.assertIn("does not subtract broader access", doc)
