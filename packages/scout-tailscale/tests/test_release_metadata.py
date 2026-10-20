"""Candidate metadata checks; no publication or network operations."""
import contextlib
import io
import tomllib
import unittest
from pathlib import Path
from scout_tailscale import PROTOCOL, __version__, cli

ROOT = Path(__file__).resolve().parents[1]


@unittest.skipUnless((ROOT / "pyproject.toml").exists(), "needs source metadata")
class ReleaseMetadata(unittest.TestCase):
    def test_version_protocol_and_runtime_requirements_agree(self):
        project = tomllib.loads((ROOT / "pyproject.toml").read_text())["project"]
        self.assertEqual(project["version"], __version__)
        self.assertEqual(__version__, "0.3.2")
        self.assertEqual(PROTOCOL, "scout-guest/1")
        self.assertEqual(project["requires-python"], ">=3.11")
        self.assertEqual(project["dependencies"], ["cryptography>=42,<51"])
        self.assertEqual(project["scripts"], {"scout-tailscale": "scout_tailscale.cli:main"})

    def test_docs_do_not_claim_candidate_is_published(self):
        readme = (ROOT / "README.md").read_text()
        self.assertIn("0.3.2, not published", readme)
        self.assertNotIn("releases/download/", readme)
        self.assertIn("0.3.2 (unreleased candidate)", (ROOT / "CHANGELOG.md").read_text())
        self.assertIn("it does not tag, upload, publish", (ROOT / "RELEASE.md").read_text())

    def test_bootstrap_help_describes_manual_enrollment(self):
        output = io.StringIO()
        with contextlib.redirect_stdout(output), self.assertRaises(SystemExit) as raised:
            cli.build_parser().parse_args(["connect", "--help"])
        self.assertEqual(raised.exception.code, 0)
        self.assertIn("delivered out of band", output.getvalue())
        self.assertNotIn("(fixtures)", output.getvalue())
