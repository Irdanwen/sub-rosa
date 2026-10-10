#!/usr/bin/env python3
"""Keycloak administrator rotation, against an in-memory master realm.
No Keycloak, Docker daemon or VPS is contacted."""
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import unittest

import admin_rotate as ar
import bootstrap

BOOTSTRAP_SECRET = "bootstrap-Secret-4f8a1c"


class Recorder:
    def __init__(self):
        self.lines = []

    def __call__(self, line):
        self.lines.append(line)

    def text(self):
        return "\n".join(self.lines)


class RotationTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="subrosa-admin-test-")
        self.private = Path(self.temp.name) / "private"
        self.private.mkdir(mode=0o700)
        bootstrap.write(self.private / ar.BOOTSTRAP_FILE, BOOTSTRAP_SECRET + "\n")
        self.keycloak = ar.FakeKeycloak({ar.BOOTSTRAP_USER: BOOTSTRAP_SECRET})
        self.out = Recorder()

    def tearDown(self):
        self.temp.cleanup()

    def rotate(self, keycloak=None):
        fake = keycloak or self.keycloak
        ar.rotate(ar.Files(self.private), ar.Keycloak(fake.send, self.out), self.out)

    def permanent(self):
        return bootstrap.read_private(self.private / ar.PERMANENT_FILE).strip()

    def test_a_generated_password_is_long_plain_and_fresh(self):
        first, second = ar.generate_password(), ar.generate_password()
        self.assertEqual(len(first), 32)
        self.assertTrue(set(first) <= set(ar.ALPHABET))
        self.assertNotEqual(first, second)

    def test_the_loopback_root_follows_the_identity_path(self):
        self.assertEqual(ar.base_url("IDENTITY_PATH=/id\n"), "http://127.0.0.1:18080/id")
        self.assertEqual(ar.base_url("IDENTITY_PATH='/auth/'\n"), "http://127.0.0.1:18080/auth")
        self.assertEqual(ar.base_url("IDENTITY_PATH=/\n"), "http://127.0.0.1:18080")
        self.assertEqual(ar.base_url("OTHER=1\n"), "http://127.0.0.1:18080/id")
        for bad in ("IDENTITY_PATH=id", "IDENTITY_PATH=/id;rm", "IDENTITY_PATH=//evil.example"):
            with self.assertRaises(ValueError):
                ar.base_url(bad)

    def test_the_bootstrap_administrator_is_replaced_by_a_permanent_one(self):
        self.rotate()
        password = self.permanent()
        self.assertEqual(len(password), 32)
        self.assertEqual(stat.S_IMODE((self.private / ar.PERMANENT_FILE).stat().st_mode), 0o600)
        self.assertFalse((self.private / ar.BOOTSTRAP_FILE).exists())
        self.assertNotIn(ar.BOOTSTRAP_USER, self.keycloak.users)
        admin = self.keycloak.users[ar.PERMANENT_USER]
        self.assertEqual(admin["password"], password)
        self.assertIn("admin", admin["roles"])
        # The deletion was made with the new administrator's own token.
        self.assertTrue(any(ar.BOOTSTRAP_USER in line and "DELETE" in line for line in self.out.lines))

    def test_nothing_printed_carries_a_credential(self):
        self.rotate()
        text = self.out.text()
        self.assertNotIn(self.permanent(), text)
        self.assertNotIn(BOOTSTRAP_SECRET, text)
        self.assertNotIn("access_token", text)

    def test_running_again_changes_nothing(self):
        self.rotate()
        password = self.permanent()
        self.rotate()
        self.assertEqual(self.permanent(), password)
        self.assertEqual(set(self.keycloak.users), {ar.PERMANENT_USER})

    def test_an_interrupted_run_keeps_the_bootstrap_admin_and_resumes_with_the_same_password(self):
        failing = ar.FakeKeycloak({ar.BOOTSTRAP_USER: BOOTSTRAP_SECRET})
        send = failing.send
        broken = {"once": True}

        def flaky(method, path, headers, data):
            if path.endswith("/role-mappings/realm") and broken.pop("once", False):
                return 500, b""
            return send(method, path, headers, data)

        failing.send = flaky
        with self.assertRaises(ar.KeycloakError):
            self.rotate(failing)
        written = self.permanent()
        self.assertIn(ar.BOOTSTRAP_USER, failing.users)
        self.assertTrue((self.private / ar.BOOTSTRAP_FILE).exists())
        self.rotate(failing)
        self.assertEqual(self.permanent(), written)
        self.assertEqual(set(failing.users), {ar.PERMANENT_USER})
        self.assertFalse((self.private / ar.BOOTSTRAP_FILE).exists())

    def test_a_permanent_admin_that_cannot_sign_in_leaves_the_bootstrap_one(self):
        refusing = ar.FakeKeycloak({ar.BOOTSTRAP_USER: BOOTSTRAP_SECRET})
        send = refusing.send

        def refuse_new_admin(method, path, headers, data):
            if path == ar.TOKEN_PATH and b"subrosa-admin" in data:
                return 401, b'{"error":"invalid_grant"}'
            return send(method, path, headers, data)

        refusing.send = refuse_new_admin
        with self.assertRaises(ValueError):
            self.rotate(refusing)
        self.assertIn(ar.BOOTSTRAP_USER, refusing.users)
        self.assertTrue((self.private / ar.BOOTSTRAP_FILE).exists())

    def test_an_admin_without_rights_never_deletes_the_bootstrap_one(self):
        self.rotate()
        # A later run against a realm where the permanent account lost its
        # role: it signs in, cannot list users, and nothing is deleted.
        weak = ar.FakeKeycloak({ar.BOOTSTRAP_USER: BOOTSTRAP_SECRET})
        weak.users[ar.PERMANENT_USER] = {"id": "user-9", "username": ar.PERMANENT_USER,
                                         "password": self.permanent(), "roles": set()}
        with self.assertRaises(ar.KeycloakError):
            self.rotate(weak)
        self.assertIn(ar.BOOTSTRAP_USER, weak.users)

    def test_a_bootstrap_file_left_after_its_user_went_is_cleaned_up(self):
        self.rotate()
        bootstrap.write(self.private / ar.BOOTSTRAP_FILE, BOOTSTRAP_SECRET + "\n")
        self.rotate()
        self.assertFalse((self.private / ar.BOOTSTRAP_FILE).exists())

    def test_without_any_working_credential_it_stops(self):
        (self.private / ar.BOOTSTRAP_FILE).unlink()
        with self.assertRaises(ValueError):
            self.rotate()


class DryRunTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="subrosa-admin-dry-")
        self.directory = Path(self.temp.name) / "stack"
        bootstrap.init(self.directory, "https://accounts.example.com", "https://accounts.example.com/id")
        self.private = self.directory / "private"

    def tearDown(self):
        self.temp.cleanup()

    def test_the_plan_reads_writes_and_sends_nothing(self):
        secret = bootstrap.read_private(self.private / ar.BOOTSTRAP_FILE).strip()
        # A file the real run would refuse to read (not 0600): the dry run
        # does not read it at all, so it does not notice.
        os.chmod(self.private / ar.BOOTSTRAP_FILE, 0o640)
        out = Recorder()
        ar.dry_run(self.private, "http://127.0.0.1:18080/id", out)
        text = out.text()
        for step in ("password grant as subrosa-bootstrap", "create subrosa-admin",
                     "/reset-password", "grant admin", "password grant as subrosa-admin",
                     "DELETE", "Removed private/keycloak-admin-password"):
            self.assertIn(step, text)
        self.assertNotIn(secret, text)
        self.assertTrue((self.private / ar.BOOTSTRAP_FILE).exists())
        self.assertFalse((self.private / ar.PERMANENT_FILE).exists())

    def test_the_stack_command_prints_the_plan_without_a_secret(self):
        secret = bootstrap.read_private(self.private / ar.BOOTSTRAP_FILE).strip()
        here = Path(__file__).resolve().parent
        result = subprocess.run([sys.executable, str(here / "stack.py"), "admin-rotate", "--dry-run",
                                 "--directory", str(self.directory)], capture_output=True, text=True, check=False)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("prepare-secrets", result.stdout)
        self.assertIn("http://127.0.0.1:18080/id", result.stdout)
        self.assertNotIn(secret, result.stdout + result.stderr)
        self.assertFalse((self.private / ar.PERMANENT_FILE).exists())


class PrepareSecretsTest(unittest.TestCase):
    def test_the_permanent_password_never_enters_the_shared_volume(self):
        script = (Path(__file__).resolve().parent / "prepare-secrets.sh").read_text()
        self.assertIn("keycloak-admin.password) continue ;;", script)
        self.assertLess(script.index("keycloak-admin.password) continue ;;"), script.index("*) continue ;;"))


if __name__ == "__main__":
    unittest.main()
