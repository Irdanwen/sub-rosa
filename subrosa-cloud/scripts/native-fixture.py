#!/usr/bin/env python3
"""Provision disposable native E2E credentials in the loopback QA harness only.

No identity-provider bypass is added to the production service. This test utility
requires PostgreSQL administrative access to the specifically named QA database,
checks both resulting sessions against the running API, and prints only the path
of a mode-0600 temporary fixture. Never use this utility with a production tunnel.
"""

import argparse
import base64
import datetime
import hashlib
import json
import os
from pathlib import Path
import secrets
import subprocess
import sys
import tempfile
import urllib.error
import urllib.parse
import urllib.request
import uuid


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def token():
    return base64.urlsafe_b64encode(secrets.token_bytes(32)).decode().rstrip("=")


def checked_urls(base, database_url):
    api = urllib.parse.urlsplit(base)
    database = urllib.parse.urlsplit(database_url)
    loopback = {"127.0.0.1", "localhost", "::1"}
    if (
        api.scheme != "http"
        or api.hostname not in loopback
        or api.username is not None
        or api.password is not None
        or api.path not in {"", "/"}
        or api.query
        or api.fragment
    ):
        raise ValueError("The fixture API must be an HTTP loopback origin.")
    if (
        database.scheme not in {"postgres", "postgresql"}
        or database.hostname not in loopback
        or database.path != "/subrosa_browser_qa"
        or database.query
        or database.fragment
    ):
        raise ValueError("Only the loopback subrosa_browser_qa database is allowed.")
    return base.rstrip("/")


def sql(database_url, statements):
    # psql receives SQL through stdin. Refresh/access secrets never appear in SQL;
    # only their SHA-256 hashes are persisted. Captured errors cannot leak URLs.
    subprocess.run(
        ["psql", database_url, "-X", "-v", "ON_ERROR_STOP=1", "-q"],
        input="BEGIN;\n" + "\n".join(statements) + "\nCOMMIT;\n",
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=True,
        timeout=15,
    )


def read_api(base, path, bearer=None):
    request = urllib.request.Request(base + path)
    if bearer is not None:
        request.add_header("Authorization", "Bearer " + bearer)
    # Environment proxies and redirects must never receive even these test tokens.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    with opener.open(request, timeout=10) as response:
        body = response.read(1024 * 1024 + 1)
        if len(body) > 1024 * 1024:
            raise ValueError("Unexpected fixture API response size.")
        return json.loads(body)["data"]


def generate(base, database_url):
    base = checked_urls(base, database_url)
    if read_api(base, "/readyz") != {"status": "ready"}:
        raise ValueError("Start the local_identity example before creating a fixture.")
    now = datetime.datetime.now(datetime.timezone.utc)
    account = {
        "id": str(uuid.uuid4()),
        "email": "native-e2e-" + uuid.uuid4().hex[:12] + "@example.test",
        "created_at": now.isoformat(),
    }
    fixture = {"base": base, "account": account, "key": token()}
    # Every interpolated SQL value below is generated locally, never caller text.
    statements = [
        "INSERT INTO accounts(id,issuer,subject,email,created_at) "
        f"VALUES('{account['id']}','http://127.0.0.1:8788',"
        f"'{uuid.uuid4()}','{account['email']}','{account['created_at']}');"
    ]
    for name in ("device_a", "device_b"):
        access, refresh = token(), token()
        device, family = str(uuid.uuid4()), str(uuid.uuid4())
        expires = (now + datetime.timedelta(minutes=15)).isoformat()
        refresh_expires = (now + datetime.timedelta(days=30)).isoformat()
        access_hash = hashlib.sha256(access.encode()).hexdigest()
        refresh_hash = hashlib.sha256(refresh.encode()).hexdigest()
        statements.extend(
            [
                "INSERT INTO devices(id,account_id,name) "
                f"VALUES('{device}','{account['id']}','Native E2E {name}');",
                "INSERT INTO session_families(id,account_id,device_id,authenticated_at,expires_at) "
                f"VALUES('{family}','{account['id']}','{device}','{now.isoformat()}','{refresh_expires}');",
                "INSERT INTO refresh_tokens(token_hash,family_id) "
                f"VALUES(decode('{refresh_hash}','hex'),'{family}');",
                "INSERT INTO sessions(token_hash,account_id,device_id,browser,authenticated_at,expires_at,family_id) "
                f"VALUES(decode('{access_hash}','hex'),'{account['id']}','{device}',"
                f"false,'{now.isoformat()}','{expires}','{family}');",
            ]
        )
        fixture[name] = {
            "access_token": access,
            "refresh_token": refresh,
            "expires_at": expires,
            "refresh_expires_at": refresh_expires,
            "device_id": device,
            "account": account,
        }
    sql(database_url, statements)
    try:
        for name in ("device_a", "device_b"):
            found = read_api(base, "/api/v1/me", fixture[name]["access_token"])
            if found["id"] != account["id"] or found["email"] != account["email"]:
                raise ValueError("Fixture database and API do not match.")
        with tempfile.NamedTemporaryFile(
            prefix="subrosa-native-e2e-", suffix=".json", mode="w", delete=False
        ) as output:
            os.fchmod(output.fileno(), 0o600)
            json.dump(fixture, output)
            output.flush()
            os.fsync(output.fileno())
            return str(Path(output.name).resolve())
    except Exception:
        sql(database_url, [f"DELETE FROM accounts WHERE id='{account['id']}';"])
        raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--local-test-only",
        action="store_true",
        required=True,
        help="Acknowledge disposable local QA data; never a production tunnel.",
    )
    parser.add_argument("--base", default="http://127.0.0.1:8088")
    parser.add_argument(
        "--database-url",
        default="postgres://postgres@127.0.0.1:55439/subrosa_browser_qa",
        help="Only the specifically named database on loopback is permitted.",
    )
    args = parser.parse_args()
    try:
        filename = generate(args.base, args.database_url)
    except (OSError, ValueError, KeyError, subprocess.SubprocessError):
        print(
            "Fixture generation failed. Check the local_identity example, "
            "PostgreSQL QA database and migrations. No credentials were printed.",
            file=sys.stderr,
        )
        return 1
    print(filename)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
