#!/usr/bin/env python3
"""Source-only checks. No VPS, email, S3 or Docker daemon is contacted."""
import json
import os
from pathlib import Path
import shutil
import stat
import subprocess
import tempfile
import unittest
import bootstrap


class BootstrapTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory(prefix="subrosa-stack-test-")
        cls.directory = Path(cls.temp.name) / "stack"
        bootstrap.init(cls.directory, "https://accounts.example.com", "https://accounts.example.com/id")

    @classmethod
    def tearDownClass(cls):
        cls.temp.cleanup()

    def test_files_are_private_and_initialization_never_replaces_existing_keys(self):
        self.assertEqual(stat.S_IMODE(self.directory.stat().st_mode), 0o700)
        for path in self.directory.rglob("*"):
            if path.is_file():
                self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
        before = (self.directory / "private/ledger-signing-key").read_bytes()
        with self.assertRaises(ValueError):
            bootstrap.init(self.directory, "https://accounts.example.com", "https://accounts.example.com/id")
        self.assertEqual(before, (self.directory / "private/ledger-signing-key").read_bytes())

    def test_oidc_is_confidential_pkce_exact_callback_and_signup_is_closed(self):
        realm = json.loads((self.directory / "private/subrosa-realm.json").read_text())
        self.assertFalse(realm["registrationAllowed"])
        self.assertFalse(realm["resetPasswordAllowed"])
        self.assertTrue(realm["verifyEmail"])
        self.assertNotIn("users", realm)
        self.assertNotIn("smtpServer", realm)
        client = realm["clients"][0]
        self.assertFalse(client["publicClient"])
        self.assertIn("basic", client["defaultClientScopes"])
        self.assertEqual(realm["defaultLocale"], "en")
        self.assertEqual(realm["supportedLocales"], ["en"])
        self.assertFalse(client["directAccessGrantsEnabled"])
        self.assertEqual(client["attributes"]["pkce.code.challenge.method"], "S256")
        self.assertEqual(client["redirectUris"], ["https://accounts.example.com/auth/callback"])
        self.assertEqual(realm["webAuthnPolicyPasswordlessRpId"], "accounts.example.com")
        self.assertEqual(realm["webAuthnPolicyPasswordlessUserVerificationRequirement"], "required")

    def test_missing_storage_blocks_application_even_when_identity_is_configured(self):
        env = self.directory / "stack.env"
        previous = env.read_text()
        try:
            bootstrap.write(env, previous.replace("REPLACE_WITH_ACTUAL_DOCKER_GATEWAY_IP", "172.20.0.1"))
            bootstrap.check(self.directory, False)
            with self.assertRaisesRegex(ValueError, "external S3"):
                bootstrap.check(self.directory, True)
        finally:
            bootstrap.write(env, previous)

    def test_operations_can_rehearse_before_public_opening_and_digest_is_exact(self):
        env_path, op_path = self.directory / "stack.env", self.directory / "operator.json"
        old_env, old_op = env_path.read_text(), op_path.read_text()
        try:
            op = json.loads(old_op)
            for field, suffix in [("storage", "data"), ("deletion_ledger_storage", "ledger")]:
                op[field] = {"bucket": "test-" + suffix, "region": "eu-west-3", "endpoint": "https://objects.example.com", "access_key": "test-" + suffix, "secret_key": "fixture-only"}
            bootstrap.write(op_path, json.dumps(op))
            env = old_env.replace("REPLACE_WITH_ACTUAL_DOCKER_GATEWAY_IP", "172.20.0.1")
            env = env.replace("CLOUD_IMAGE=subrosa-cloud:deployment-candidate", "CLOUD_IMAGE=registry.example.com/subrosa@sha256:" + "a" * 64)
            bootstrap.write(env_path, env)
            bootstrap.check(self.directory, True, require_rehearsal=False)
            with self.assertRaisesRegex(ValueError, "restore rehearsal"):
                bootstrap.check(self.directory, True)
            bootstrap.write(env_path, env.replace("@sha256:" + "a" * 64, ":mutable") + "OTHER_IMAGE=registry.example.com/x@sha256:" + "a" * 64 + "\n")
            with self.assertRaisesRegex(ValueError, "CLOUD_IMAGE"):
                bootstrap.check(self.directory, True, require_rehearsal=False)
        finally:
            bootstrap.write(env_path, old_env)
            bootstrap.write(op_path, old_op)

    def test_tls_certificate_matches_only_private_database_host(self):
        private = self.directory / "private"
        good = subprocess.run(["openssl", "verify", "-CAfile", str(private / "postgres-ca.crt"), "-verify_hostname", "postgres", str(private / "postgres.crt")], capture_output=True)
        bad = subprocess.run(["openssl", "verify", "-CAfile", str(private / "postgres-ca.crt"), "-verify_hostname", "untrusted", str(private / "postgres.crt")], capture_output=True)
        self.assertEqual(good.returncode, 0)
        self.assertNotEqual(bad.returncode, 0)

    def test_runtime_does_not_receive_migration_password(self):
        private = self.directory / "private"
        migration_secret = (private / "migration-password").read_text()
        self.assertNotIn(migration_secret, (private / "runtime.toml").read_text())
        self.assertIn("sslmode=verify-full", (private / "runtime.toml").read_text())
        self.assertIn("/id/realms/subrosa", (private / "runtime.toml").read_text())
        self.assertNotIn((private / "ledger-signing-key").read_text(), (self.directory / "stack.env").read_text())

    def test_bootstrap_command_outputs_no_secret(self):
        result = subprocess.run([os.sys.executable, str(Path(__file__).with_name("bootstrap.py")), "render", "--directory", str(self.directory)], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0)
        for name in ("postgres-password", "keycloak-admin-password", "oidc-client-secret", "ledger-signing-key"):
            secret = (self.directory / "private" / name).read_text()
            self.assertNotIn(secret, result.stdout + result.stderr)

    @unittest.skipUnless(shutil.which("initdb") and shutil.which("pg_ctl") and shutil.which("psql"), "Local PostgreSQL binaries are unavailable")
    def test_real_postgres_runtime_has_dml_but_no_schema_or_identity_database_access(self):
        with tempfile.TemporaryDirectory(prefix="subrosa-pg-roles-") as temp:
            cluster, socket = Path(temp) / "data", Path(temp) / "socket"
            socket.mkdir(mode=0o700)
            def run(args, **kwargs):
                return subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, **kwargs)
            self.assertEqual(run(["initdb", "-D", str(cluster), "-U", "postgres", "--auth-local=trust", "--auth-host=scram-sha-256"]).returncode, 0)
            self.assertEqual(run(["pg_ctl", "-D", str(cluster), "-l", str(Path(temp) / "postgres.log"), "-w", "-o", f"-k {socket} -c listen_addresses=''", "start"]).returncode, 0)
            try:
                psql = ["psql", "-h", str(socket), "-U", "postgres", "-d", "postgres", "-X", "-v", "ON_ERROR_STOP=1"]
                self.assertEqual(run(psql + ["-f", str(self.directory / "private/roles.sql")]).returncode, 0)
                connection = psql[:]
                connection[connection.index("-d") + 1] = "subrosa"
                works = "SET ROLE subrosa_migrator; CREATE TABLE privilege_fixture(id INT PRIMARY KEY); RESET ROLE; SET ROLE subrosa_runtime; INSERT INTO privilege_fixture VALUES(1); UPDATE privilege_fixture SET id=2; SELECT * FROM privilege_fixture; DELETE FROM privilege_fixture;"
                self.assertEqual(run(connection + ["-c", works]).returncode, 0)
                self.assertNotEqual(run(connection + ["-c", "SET ROLE subrosa_runtime; CREATE TABLE forbidden(id int);"]).returncode, 0)
                result = run(connection + ["-At", "-c", "SELECT has_database_privilege('subrosa_runtime','keycloak','CONNECT'),has_schema_privilege('subrosa_runtime','public','CREATE');"])
                self.assertEqual(result.stdout.strip(), b"f|f")
            finally:
                run(["pg_ctl", "-D", str(cluster), "-m", "immediate", "-w", "stop"])

if __name__ == "__main__":
    unittest.main()
