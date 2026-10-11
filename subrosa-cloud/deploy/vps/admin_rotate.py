#!/usr/bin/env python3
"""Replace Keycloak's temporary bootstrap administrator with a permanent one.

Runs on the deployment host against Keycloak's loopback port (never the
public origin, which blocks the master realm). It signs in with the bootstrap
password in private/keycloak-admin-password, creates the master-realm
administrator `subrosa-admin` with a generated password written to
private/keycloak-admin.password (0600), proves that password signs in and
holds administrator rights, deletes `subrosa-bootstrap`, and removes the
bootstrap password file. Every step is idempotent: a run interrupted anywhere
can be run again.

No credential is ever printed, logged or put in argv: requests are reported
by method and path only, never by body. `--dry-run` reads no credential and
sends nothing: it plays the same steps against an in-memory Keycloak shaped
like the one on the host (from which files exist) and prints that plan.
"""
import json
from pathlib import Path
import re
import secrets
import string
import urllib.error
import urllib.parse
import urllib.request

import bootstrap

BOOTSTRAP_USER = "subrosa-bootstrap"
PERMANENT_USER = "subrosa-admin"
BOOTSTRAP_FILE = "keycloak-admin-password"
PERMANENT_FILE = "keycloak-admin.password"
PASSWORD_LENGTH = 32
ALPHABET = string.ascii_letters + string.digits
# compose.yaml publishes Keycloak's HTTP port here, on loopback only.
LOOPBACK = "http://127.0.0.1:18080"
TOKEN_PATH = "/realms/master/protocol/openid-connect/token"
USERS_PATH = "/admin/realms/master/users"


def generate_password(length=PASSWORD_LENGTH):
    """Letters and digits only, so no shell, JSON or form encoding can bend it."""
    return "".join(secrets.choice(ALPHABET) for _ in range(length))


def base_url(stack_env):
    """Keycloak's loopback root, from the IDENTITY_PATH Compose gives it."""
    path = "/id"
    for line in stack_env.splitlines():
        if line.startswith("IDENTITY_PATH="):
            path = line.split("=", 1)[1].strip().strip("\"'")
    if not re.fullmatch(r"/[A-Za-z0-9/_-]*", path) or "//" in path:
        raise ValueError("IDENTITY_PATH must be an absolute path")
    return LOOPBACK + path.rstrip("/")


class KeycloakError(ValueError):
    pass


class Keycloak:
    """The handful of admin calls this needs. `send(method, path, headers,
    body)` returns `(status, bytes)`; it is urllib on the host and an
    in-memory Keycloak in tests and dry runs. `log` receives one line per
    request: method, path and what it is for, never a body."""

    def __init__(self, send, log):
        self.send = send
        self.log = log

    def _call(self, method, path, token=None, body=None, note="", expect=(200,)):
        headers = {"Accept": "application/json"}
        data = None
        if token:
            headers["Authorization"] = "Bearer " + token
        if body is not None:
            headers["Content-Type"] = "application/json"
            data = json.dumps(body).encode()
        status, raw = self.send(method, path, headers, data)
        self.log(f"{method} {path}{'  ' + note if note else ''} -> {status}")
        if status not in expect:
            raise KeycloakError(f"Keycloak answered {status} to {method} {path.split('?')[0]}")
        return status, (json.loads(raw) if raw else None)

    def token(self, username, password):
        """An admin-cli access token, or None when the credentials are refused."""
        form = urllib.parse.urlencode({"grant_type": "password", "client_id": "admin-cli",
                                       "username": username, "password": password}).encode()
        status, raw = self.send("POST", TOKEN_PATH,
                                {"Content-Type": "application/x-www-form-urlencoded",
                                 "Accept": "application/json"}, form)
        self.log(f"POST {TOKEN_PATH}  password grant as {username} -> {status}")
        if status in (400, 401):
            return None
        if status != 200:
            raise KeycloakError(f"Keycloak answered {status} to a sign-in")
        return json.loads(raw)["access_token"]

    def find_user(self, token, username):
        query = urllib.parse.urlencode({"username": username, "exact": "true"})
        _, users = self._call("GET", f"{USERS_PATH}?{query}", token, note=f"find {username}")
        for user in users or []:
            if user.get("username") == username:
                return user["id"]
        return None

    def create_user(self, token, username):
        self._call("POST", USERS_PATH, token, {"username": username, "enabled": True,
                                               "requiredActions": []},
                   note=f"create {username}", expect=(201, 409))
        user = self.find_user(token, username)
        if not user:
            raise KeycloakError("The new administrator was not found after creation")
        return user

    def set_password(self, token, user, password):
        self._call("PUT", f"{USERS_PATH}/{user}/reset-password", token,
                   {"type": "password", "temporary": False, "value": password},
                   note="set the generated password", expect=(204,))

    def grant_admin(self, token, user):
        _, role = self._call("GET", "/admin/realms/master/roles/admin", token, note="read the admin role")
        self._call("POST", f"{USERS_PATH}/{user}/role-mappings/realm", token,
                   [{"id": role["id"], "name": role["name"]}], note="grant admin", expect=(204,))

    def delete_user(self, token, user, username):
        self._call("DELETE", f"{USERS_PATH}/{user}", token, note=f"delete {username}", expect=(204,))


class Files:
    """The private directory, for real."""

    def __init__(self, private):
        self.private = private

    def exists(self, name):
        return (self.private / name).exists()

    def read(self, name):
        return bootstrap.read_private(self.private / name).strip()

    def write(self, name, value):
        bootstrap.write(self.private / name, value + "\n")

    def remove(self, name):
        (self.private / name).unlink(missing_ok=True)


def rotate(files, keycloak, say):
    """The whole procedure. Raises KeycloakError or ValueError and leaves the
    bootstrap administrator in place on any failure before the permanent one
    is proven."""
    bootstrap_token = None
    if files.exists(BOOTSTRAP_FILE):
        bootstrap_token = keycloak.token(BOOTSTRAP_USER, files.read(BOOTSTRAP_FILE))
        if bootstrap_token is None:
            say(f"{BOOTSTRAP_USER} no longer signs in; continuing with {PERMANENT_USER}.")
    if bootstrap_token:
        # Written before Keycloak hears of it, so an interrupted run reuses the
        # same password instead of locking itself out with a lost one.
        if not files.exists(PERMANENT_FILE):
            files.write(PERMANENT_FILE, generate_password())
            say(f"Generated a password for {PERMANENT_USER} in private/{PERMANENT_FILE} (0600, not shown).")
        user = keycloak.find_user(bootstrap_token, PERMANENT_USER) or keycloak.create_user(
            bootstrap_token, PERMANENT_USER)
        keycloak.set_password(bootstrap_token, user, files.read(PERMANENT_FILE))
        keycloak.grant_admin(bootstrap_token, user)
    if not files.exists(PERMANENT_FILE):
        raise ValueError("Neither the bootstrap nor the permanent administrator can sign in")
    admin_token = keycloak.token(PERMANENT_USER, files.read(PERMANENT_FILE))
    if admin_token is None:
        raise ValueError(f"{PERMANENT_USER} does not sign in; {BOOTSTRAP_USER} was kept")
    # Listing users needs administrator rights: this proves the new account
    # can do what the bootstrap one did before the bootstrap one goes.
    leftover = keycloak.find_user(admin_token, BOOTSTRAP_USER)
    say(f"{PERMANENT_USER} signs in and holds administrator rights.")
    if leftover:
        keycloak.delete_user(admin_token, leftover, BOOTSTRAP_USER)
        say(f"Deleted {BOOTSTRAP_USER}.")
    if files.exists(BOOTSTRAP_FILE):
        files.remove(BOOTSTRAP_FILE)
        say(f"Removed private/{BOOTSTRAP_FILE}.")


def loopback_send(base):
    """urllib against Keycloak's loopback port, without following redirects."""

    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *args, **kwargs):
            return None

    opener = urllib.request.build_opener(NoRedirect)

    def send(method, path, headers, data):
        request = urllib.request.Request(base + path, data=data, headers=headers, method=method)
        try:
            with opener.open(request, timeout=15) as response:
                return response.status, response.read()
        except urllib.error.HTTPError as error:
            return error.code, error.read()

    return send


class FakeKeycloak:
    """A master realm that answers the calls above the way Keycloak 26 does.
    Used by the tests and by `--dry-run`, which seeds it from which files
    exist on the host."""

    def __init__(self, passwords):
        self.users = {}
        self.ids = 0
        self.tokens = {}
        for username, password in passwords.items():
            user = self._add(username)
            user["password"] = password
            user["roles"].add("admin")

    def _add(self, username):
        self.ids += 1
        user = {"id": f"user-{self.ids}", "username": username, "password": None, "roles": set()}
        self.users[username] = user
        return user

    def _admin(self, headers):
        username = self.tokens.get(headers.get("Authorization", "").removeprefix("Bearer "))
        return username in self.users and "admin" in self.users[username]["roles"]

    def send(self, method, path, headers, data):
        if path == TOKEN_PATH:
            form = dict(urllib.parse.parse_qsl(data.decode()))
            user = self.users.get(form["username"])
            if not user or user["password"] is None or user["password"] != form["password"]:
                return 401, b'{"error":"invalid_grant"}'
            token = secrets.token_hex(8)
            self.tokens[token] = user["username"]
            return 200, json.dumps({"access_token": token}).encode()
        if not self._admin(headers):
            return 403, b""
        body = json.loads(data) if data else None
        by_id = {u["id"]: u for u in self.users.values()}
        if method == "GET" and path.startswith(USERS_PATH + "?"):
            name = dict(urllib.parse.parse_qsl(path.split("?", 1)[1]))["username"]
            found = [{"id": u["id"], "username": u["username"]} for u in self.users.values()
                     if u["username"] == name]
            return 200, json.dumps(found).encode()
        if method == "POST" and path == USERS_PATH:
            if body["username"] in self.users:
                return 409, b""
            self._add(body["username"])
            return 201, b""
        if method == "GET" and path == "/admin/realms/master/roles/admin":
            return 200, b'{"id":"role-admin","name":"admin"}'
        match = re.fullmatch(USERS_PATH + r"/([^/]+)(/reset-password|/role-mappings/realm)?", path)
        if match and match[1] in by_id:
            user = by_id[match[1]]
            if method == "PUT" and match[2] == "/reset-password":
                user["password"] = body["value"]
                return 204, b""
            if method == "POST" and match[2] == "/role-mappings/realm":
                user["roles"].update(role["name"] for role in body)
                return 204, b""
            if method == "DELETE" and match[2] is None:
                del self.users[user["username"]]
                return 204, b""
        return 404, b""


class DryRunFiles:
    """Reports which files exist on the host, reads none of them, writes
    nothing. The placeholder passwords only ever meet the in-memory Keycloak."""

    def __init__(self, private):
        self.present = {name for name in (BOOTSTRAP_FILE, PERMANENT_FILE) if (private / name).exists()}
        self.values = {name: "dry-run-placeholder" for name in self.present}

    def exists(self, name):
        return name in self.present

    def read(self, name):
        return self.values[name]

    def write(self, name, value):
        self.present.add(name)
        self.values[name] = value

    def remove(self, name):
        self.present.discard(name)


def dry_run(private, base, say):
    files = DryRunFiles(private)
    say(f"Dry run against an in-memory Keycloak; nothing is read, written or sent. Base: {base}")
    say("Present: " + (", ".join(f"private/{n}" for n in sorted(files.present)) or "neither password file"))
    seeded = {BOOTSTRAP_USER: files.values[BOOTSTRAP_FILE]} if BOOTSTRAP_FILE in files.present else {}
    if PERMANENT_FILE in files.present:
        seeded[PERMANENT_USER] = files.values[PERMANENT_FILE]
    fake = FakeKeycloak(seeded)
    rotate(files, Keycloak(fake.send, lambda line: say("  " + line)), lambda line: say("  would: " + line))


def run(directory, say=print):
    private = directory / "private"
    base = base_url(bootstrap.read_private(directory / "stack.env"))
    rotate(Files(private), Keycloak(loopback_send(base), say), say)
