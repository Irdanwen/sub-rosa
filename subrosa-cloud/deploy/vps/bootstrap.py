#!/usr/bin/env python3
"""Generate local deployment material, never contact a server or print secrets."""
import argparse
import json
import os
import re
from pathlib import Path
import secrets
import stat
import subprocess
import sys
from urllib.parse import quote, urlsplit

SIGNATURE_ALGORITHMS = ["ES256", "RS256"]


def write(path, text):
    flags = os.O_WRONLY | os.O_CREAT | os.O_TRUNC | getattr(os, "O_NOFOLLOW", 0)
    with os.fdopen(os.open(path, flags, 0o600), "w") as stream:
        os.fchmod(stream.fileno(), 0o600)
        stream.write(text)


def origin(value, path_allowed=False):
    p = urlsplit(value)
    if (p.scheme != "https" or not p.hostname or p.username or p.password
            or p.query or p.fragment or value.endswith("/")
            or (not path_allowed and p.path)
            or any(c in value for c in "\r\n$`'\" ")):
        raise ValueError("Use an HTTPS origin without credentials or trailing slash")
    return p


def read_private(path):
    if path.is_symlink() or stat.S_IMODE(path.stat().st_mode) != 0o600:
        raise ValueError("Private input must be a regular mode 0600 file")
    return path.read_text()


def init(directory, account_origin, identity_base):
    origin(account_origin)
    identity = origin(identity_base, True)
    if directory.exists():
        raise ValueError("Output already exists; initialization never overwrites keys or databases")
    directory.mkdir(parents=True, mode=0o700)
    os.chmod(directory, 0o700)
    private = directory / "private"
    private.mkdir(mode=0o700)
    values = {key: secrets.token_urlsafe(32) for key in (
        "postgres-password", "runtime-password", "migration-password", "keycloak-password",
        "keycloak-admin-password", "oidc-client-secret", "ledger-signing-key")}
    for key, value in values.items():
        write(private / key, value)
    write(directory / ".gitignore", "*\n")
    settings = {"account_origin": account_origin, "identity_base": identity_base,
                "identity_path": identity.path or "/", "rp_id": identity.hostname}
    write(directory / "settings.json", json.dumps(settings, indent=2) + "\n")
    operator = {
        "storage": {"bucket": "", "region": "", "endpoint": "", "access_key": "", "secret_key": ""},
        "deletion_ledger_storage": {"bucket": "", "region": "", "endpoint": "", "access_key": "", "secret_key": ""},
        "storage_semantics_verified": False,
        "ledger_policy_reviewed": False,
        "backup_is_independent": False,
        "backup_destination": "",
        "restore_rehearsal_at": "",
        "smtp": {"host": "", "port": "587", "from": "", "user": "", "password": "", "starttls": "true", "ssl": "false", "auth": "true"},
    }
    write(directory / "operator.json", json.dumps(operator, indent=2) + "\n")
    write(directory / "stack.env", "\n".join([
        f"STACK_PRIVATE_DIR='{private.resolve()}'", f"IDENTITY_BASE={identity_base}",
        f"IDENTITY_PATH={identity.path or '/'}", "CLOUD_IMAGE=subrosa-cloud:deployment-candidate",
        "PROXY_TRUSTED_ADDRESSES=REPLACE_WITH_ACTUAL_DOCKER_GATEWAY_IP",
        "KEYCLOAK_MEMORY=2048m", "POSTGRES_MEMORY=384m", "API_MEMORY=384m", ""]))
    certs(private)
    render(directory)


def certs(private):
    # A private local CA authenticates the isolated database network. Never disable
    # hostname verification to make an external PostgreSQL replacement work.
    commands = [
        ["openssl", "req", "-x509", "-newkey", "rsa:3072", "-nodes", "-days", "3650", "-subj", "/CN=Sub Rosa database CA", "-keyout", "postgres-ca.key", "-out", "postgres-ca.crt"],
        ["openssl", "req", "-new", "-newkey", "rsa:3072", "-nodes", "-subj", "/CN=postgres", "-keyout", "postgres.key", "-out", "postgres.csr"],
        ["openssl", "x509", "-req", "-in", "postgres.csr", "-CA", "postgres-ca.crt", "-CAkey", "postgres-ca.key", "-CAcreateserial", "-days", "365", "-sha256", "-extfile", "postgres.ext", "-out", "postgres.crt"],
    ]
    write(private / "postgres.ext", "subjectAltName=DNS:postgres\nextendedKeyUsage=serverAuth\nkeyUsage=digitalSignature,keyEncipherment\n")
    for command in commands:
        subprocess.run(command, cwd=private, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for path in private.iterdir():
        os.chmod(path, 0o600)
    (private / "postgres.csr").unlink()
    (private / "postgres.ext").unlink()


def render(directory):
    private = directory / "private"
    s = json.loads(read_private(directory / "settings.json"))
    op = json.loads(read_private(directory / "operator.json"))
    origin(s["account_origin"])
    origin(s["identity_base"], True)
    value = lambda name: read_private(private / name).strip()
    sql = f"""CREATE ROLE subrosa_migrator LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD '{value('migration-password')}';
CREATE ROLE subrosa_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION CONNECTION LIMIT 20 PASSWORD '{value('runtime-password')}';
CREATE ROLE keycloak LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION CONNECTION LIMIT 15 PASSWORD '{value('keycloak-password')}';
CREATE DATABASE subrosa OWNER subrosa_migrator;
CREATE DATABASE keycloak OWNER keycloak;
REVOKE ALL ON DATABASE subrosa FROM PUBLIC;
REVOKE ALL ON DATABASE keycloak FROM PUBLIC;
GRANT CONNECT ON DATABASE subrosa TO subrosa_runtime;
\\connect subrosa
REVOKE ALL ON SCHEMA public FROM PUBLIC;
ALTER SCHEMA public OWNER TO subrosa_migrator;
GRANT USAGE ON SCHEMA public TO subrosa_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE subrosa_migrator IN SCHEMA public GRANT SELECT,INSERT,UPDATE,DELETE ON TABLES TO subrosa_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE subrosa_migrator IN SCHEMA public GRANT USAGE,SELECT ON SEQUENCES TO subrosa_runtime;
\\connect keycloak
REVOKE ALL ON SCHEMA public FROM PUBLIC;
ALTER SCHEMA public OWNER TO keycloak;
"""
    write(private / "roles.sql", sql)
    write(private / "migrator.pgpass", f"postgres:5432:subrosa:subrosa_migrator:{value('migration-password')}\n")
    realm = {
        "realm": "subrosa", "displayName": "Sub Rosa", "enabled": True,
        "sslRequired": "all", "registrationAllowed": False, "resetPasswordAllowed": False,
        "registrationEmailAsUsername": True, "loginWithEmailAllowed": True,
        "duplicateEmailsAllowed": False, "editUsernameAllowed": False, "verifyEmail": True,
        "rememberMe": False, "bruteForceProtected": True, "failureFactor": 5,
        "maxFailureWaitSeconds": 900, "waitIncrementSeconds": 60,
        "revokeRefreshToken": True, "refreshTokenMaxReuse": 0,
        "defaultSignatureAlgorithm": "RS256", "accessTokenLifespan": 300,
        "ssoSessionIdleTimeout": 1800, "ssoSessionMaxLifespan": 43200,
        "passwordPolicy": "length(14) and notUsername(undefined) and notEmail(undefined)",
        "webAuthnPolicyPasswordlessRpEntityName": "Sub Rosa",
        "webAuthnPolicyPasswordlessRpId": s["rp_id"],
        "webAuthnPolicyPasswordlessUserVerificationRequirement": "required",
        "webAuthnPolicyPasswordlessResidentKey": "required",
        "webAuthnPolicyPasswordlessPasskeysEnabled": True,
        "webAuthnPolicyPasswordlessSignatureAlgorithms": list(SIGNATURE_ALGORITHMS),
        "webAuthnPolicyPasswordlessAttestationConveyancePreference": "none",
        "eventsEnabled": True, "eventsExpiration": 604800,
        "adminEventsEnabled": True, "adminEventsDetailsEnabled": False,
        "internationalizationEnabled": True, "supportedLocales": ["en"], "defaultLocale": "en",
        "clients": [{"clientId": "subrosa-cloud", "name": "Sub Rosa", "enabled": True,
                     "protocol": "openid-connect", "publicClient": False,
                     "clientAuthenticatorType": "client-secret", "secret": value("oidc-client-secret"),
                     "standardFlowEnabled": True, "implicitFlowEnabled": False,
                     "directAccessGrantsEnabled": False, "serviceAccountsEnabled": False,
                     "redirectUris": [s["account_origin"] + "/auth/callback"], "webOrigins": [],
                     "defaultClientScopes": ["basic", "email", "profile"],
                     "attributes": {"pkce.code.challenge.method": "S256", "id.token.signed.response.alg": "RS256"}}],
    }
    smtp = op["smtp"]
    if all(smtp.get(k) for k in ("host", "port", "from", "user", "password")):
        if smtp.get("starttls") != "true" and smtp.get("ssl") != "true":
            raise ValueError("SMTP must require TLS")
        realm["smtpServer"] = smtp
    write(private / "subrosa-realm.json", json.dumps(realm, indent=2) + "\n")
    for role, prefix in [("subrosa_runtime", "runtime"), ("subrosa_migrator", "migration")]:
        db = f"postgresql://{role}:{quote(value(prefix + '-password'), safe='')}@postgres:5432/subrosa?sslmode=verify-full&sslrootcert=/run/private/postgres-ca.crt"
        q = json.dumps
        lines = ["bind = \"0.0.0.0:8088\"", f"public_url = {q(s['account_origin'])}", "development = false", f"database_url = {q(db)}", "account_quota_bytes = 5368709120", "", "[oidc]", f"issuer = {q(s['identity_base'] + '/realms/subrosa')}", "client_id = \"subrosa-cloud\"", f"client_secret = {q(value('oidc-client-secret'))}"]
        for section, storage in [("storage", op["storage"]), ("deletion_ledger.storage", op["deletion_ledger_storage"])]:
            if section.startswith("deletion"):
                lines += ["", "[deletion_ledger]", 'active_key_id = "v1"', "[deletion_ledger.signing_keys]", f"v1 = {q(value('ledger-signing-key'))}"]
            lines += ["", f"[{section}]", 'kind = "s3"']
            for field in ("bucket", "region", "endpoint", "access_key", "secret_key"):
                lines.append(f"{field} = {q(storage.get(field) or ('https://unconfigured.invalid' if field == 'endpoint' else 'UNCONFIGURED'))}")
        write(private / (prefix + ".toml"), "\n".join(lines) + "\n")


def check(directory, application=False, require_rehearsal=True):
    s = json.loads(read_private(directory / "settings.json"))
    origin(s["account_origin"])
    origin(s["identity_base"], True)
    env = read_private(directory / "stack.env")
    if "REPLACE_" in env:
        raise ValueError("Set PROXY_TRUSTED_ADDRESSES to the actual private ingress address")
    if application:
        op = json.loads(read_private(directory / "operator.json"))
        for section in ("storage", "deletion_ledger_storage"):
            cfg = op[section]
            if not all(cfg.get(k) for k in ("bucket", "region", "endpoint", "access_key", "secret_key")):
                raise ValueError("Configure both external S3 services before starting the API")
            endpoint = origin(cfg["endpoint"], True)
            if endpoint.hostname.endswith((".invalid", ".test")):
                raise ValueError("A real external S3 HTTPS endpoint is required")
        if op["storage"]["bucket"] == op["deletion_ledger_storage"]["bucket"]:
            raise ValueError("Deletion ledger requires a distinct protected bucket")
        if op["storage"]["access_key"] == op["deletion_ledger_storage"]["access_key"]:
            raise ValueError("Use separate least-privilege credentials for ciphertext and deletion ledger")
        if require_rehearsal and not all(op.get(k) for k in ("storage_semantics_verified", "ledger_policy_reviewed", "backup_is_independent", "backup_destination", "restore_rehearsal_at")):
            raise ValueError("External storage policy and independent restore rehearsal remain unverified")
        image = next((line.split("=", 1)[1].strip("\"'") for line in env.splitlines() if line.startswith("CLOUD_IMAGE=")), "")
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:/-]*@sha256:[a-f0-9]{64}", image):
            raise ValueError("Pin the tested CLOUD_IMAGE to its immutable registry digest")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["init", "render", "check"])
    parser.add_argument("--directory", type=Path, required=True)
    parser.add_argument("--account-origin")
    parser.add_argument("--identity-base")
    parser.add_argument("--application", action="store_true")
    args = parser.parse_args()
    os.umask(0o077)
    try:
        if args.action == "init":
            if not args.account_origin or not args.identity_base:
                raise ValueError("Initialization requires account and identity HTTPS addresses")
            init(args.directory.resolve(), args.account_origin, args.identity_base)
        elif args.action == "render":
            render(args.directory.resolve())
        else:
            check(args.directory.resolve(), args.application)
    except (ValueError, OSError, subprocess.CalledProcessError, KeyError):
        # Do not echo credentials, configuration fragments or subprocess output.
        print("Deployment preparation failed. Check required settings, file permissions and prerequisites.", file=sys.stderr)
        return 1
    print("Deployment material " + ("checked" if args.action == "check" else "prepared") + "; no service was started.")
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
