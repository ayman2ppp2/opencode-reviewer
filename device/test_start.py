from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import start


class StartTests(unittest.TestCase):
    def test_key_is_private_reused_and_never_follows_symlinks(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "laptop" / "relay.key"
            first = start.ensure_key(path)
            self.assertEqual(len(first), 64)
            self.assertEqual(start.ensure_key(path), first)
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            path.unlink()
            target = Path(directory) / "unrelated"
            target.write_text(first)
            target.chmod(0o600)
            path.symlink_to(target)
            with self.assertRaises(OSError):
                start.ensure_key(path)

    def test_registration_uses_stdin_and_only_explicit_repositories(self):
        token = "0123456789abcdef" * 4
        with patch("start.subprocess.run") as run:
            start.register("laptop", "https://fixture.trycloudflare.com/", token, ["owner/repo"], True)
            self.assertEqual(run.call_count, 3)
            for call in run.call_args_list:
                self.assertNotIn(token, " ".join(call.args[0]))
                self.assertIn("owner/repo", call.args[0])
            self.assertEqual(run.call_args_list[1].kwargs["input"], token)
            self.assertEqual(run.call_args_list[2].args[0][0:4], ["gh", "variable", "set", "REVIEWER_EGRESS_PROFILE"])

    def test_standby_registration_does_not_change_default(self):
        with patch("start.subprocess.run") as run:
            start.register("android", "https://fixture.trycloudflare.com/", "0123456789abcdef" * 4, ["owner/repo"])
            self.assertEqual(run.call_count, 2)
            self.assertNotIn("variable", " ".join(run.call_args_list[0].args[0]))
            self.assertIn("REVIEWER_ANDROID_RELAY_KEY", run.call_args_list[1].args[0])

    def test_invalid_repo_cannot_partially_register_another_repo(self):
        with patch("start.subprocess.run") as run:
            with self.assertRaises(ValueError):
                start.register("laptop", "https://fixture.trycloudflare.com/", "0123456789abcdef" * 4, ["owner/valid", "owner/repo\nbad"])
            run.assert_not_called()


if __name__ == "__main__":
    unittest.main()
