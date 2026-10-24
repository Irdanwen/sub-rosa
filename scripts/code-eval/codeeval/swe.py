"""SWE-bench Verified tasks, run without Docker.

The official harness builds one Docker image per instance; this Mac has no
Docker (ADR-0122). Instead, each instance gets, once, under the cache:

- a working copy at its base commit, with a fresh one-commit git history (no
  future commits for the agent to find), installed in editable mode into
- a `uv` virtual environment with the Python version and packages SWE-bench
  uses for that repository and version (`ENV_SPECS`, transcribed from
  `swebench.harness.constants` 4.0.4, MIT), minus what needs a system package
  manager;
- a pristine snapshot of that working copy, cloned back (APFS `cp -c`) before
  every attempt, so the editable install keeps pointing at the right path.

Grading follows the harness: the files the test patch touches are reset, the
test patch is applied, the test command runs on the test files it names, the
log is parsed per repository (parsers adapted from `swebench`, MIT), and the
instance is resolved when every FAIL_TO_PASS and every PASS_TO_PASS test
passes. An instance whose environment cannot be built, or whose gold patch
does not pass its own tests here, is excluded with the reason.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path

from . import paths

# --- environments -----------------------------------------------------------

DJANGO_TEST = ["./tests/runtests.py", "--verbosity", "2", "--settings=test_sqlite", "--parallel", "1"]
SYMPY_TEST = ["bin/test", "-C", "--verbose"]
PYTEST_TEST = ["-m", "pytest", "-rA"]

# (repo, version) -> how to build and test it. `requirements` are read from the
# working copy at its base commit; `install` is the pip target after them.
ENV_SPECS: dict[tuple[str, str], dict] = {}


def _spec(repo: str, versions: list[str], **spec) -> None:
    for version in versions:
        ENV_SPECS[(repo, version)] = spec


_spec(
    "django/django",
    ["4.0"],
    python="3.8",
    requirements=["tests/requirements/py3.txt"],
    pip_packages=[],
    install=".",
    test="django",
)
_spec(
    "django/django",
    ["4.1", "4.2"],
    python="3.9",
    requirements=["tests/requirements/py3.txt"],
    pip_packages=[],
    install=".",
    test="django",
)
_spec(
    "django/django",
    ["5.0"],
    python="3.11",
    requirements=["tests/requirements/py3.txt"],
    pip_packages=[],
    install=".",
    test="django",
)
_spec(
    "sympy/sympy",
    ["1.9", "1.10", "1.11", "1.12"],
    python="3.9",
    requirements=[],
    pip_packages=["mpmath==1.3.0", "flake8-comprehensions"],
    install=".",
    test="sympy",
)
_spec(
    "pytest-dev/pytest",
    ["5.4"],
    python="3.9",
    requirements=[],
    pip_packages=[
        "py==1.11.0",
        "packaging==23.1",
        "attrs==23.1.0",
        "more-itertools==10.1.0",
        "pluggy==0.13.1",
    ],
    install=".",
    test="pytest",
)
_spec(
    "pytest-dev/pytest",
    ["6.0"],
    python="3.9",
    requirements=[],
    pip_packages=[
        "attrs==23.1.0",
        "iniconfig==2.0.0",
        "more-itertools==10.1.0",
        "packaging==23.1",
        "pluggy==0.13.1",
        "py==1.11.0",
        "toml==0.10.2",
    ],
    install=".",
    test="pytest",
)
_spec(
    "pytest-dev/pytest",
    ["7.2"],
    python="3.9",
    requirements=[],
    pip_packages=[
        "attrs==23.1.0",
        "iniconfig==2.0.0",
        "packaging==23.1",
        "pluggy==0.13.1",
        "py==1.11.0",
        "tomli==2.0.1",
    ],
    install=".",
    test="pytest",
)
_spec(
    "pylint-dev/pylint",
    ["2.14", "2.15"],
    python="3.9",
    requirements=["requirements_test.txt"],
    pip_packages=[],
    install=".",
    test="pytest_options",
)
_spec(
    "pylint-dev/pylint",
    ["3.0"],
    python="3.9",
    requirements=["requirements_test.txt"],
    pip_packages=["astroid==3.0.0a6", "setuptools"],
    install=".",
    test="pytest_options",
)
# Requests before 2.9 tests against the live httpbin.org: slow, flaky and a
# network dependency of the score, so those versions are not candidates.
_spec(
    "psf/requests",
    ["2.9", "2.26", "2.27"],
    python="3.9",
    requirements=[],
    pip_packages=["pytest"],
    install=".",
    test="pytest_options",
)
_spec(
    "pallets/flask",
    ["2.3"],
    python="3.11",
    requirements=["requirements/dev.txt"],
    pip_packages=[
        "setuptools==70.0.0",
        "click==8.1.3",
        "itsdangerous==2.1.2",
        "Jinja2==3.1.2",
        "MarkupSafe==2.1.1",
        "Werkzeug==2.3.7",
    ],
    install=".",
    test="pytest",
)
_spec(
    "sphinx-doc/sphinx",
    ["5.0", "5.1", "5.2", "7.1", "7.2"],
    python="3.9",
    requirements=[],
    pip_packages=["Jinja2==3.0.3"],
    install=".[test]",
    test="sphinx",
)
_spec(
    "pydata/xarray",
    ["2022.03", "2022.06", "2022.09"],
    python="3.10",
    requirements=[],
    pip_packages=[
        "numpy==1.23.0",
        "packaging==23.1",
        "pandas==1.5.3",
        "pytest==7.4.0",
        "python-dateutil==2.8.2",
        "pytz==2023.3",
        "six==1.16.0",
        "scipy==1.11.1",
        "setuptools==68.0.0",
        "dask==2022.8.1",
    ],
    install=".",
    test="pytest",
)
_spec(
    "mwaskom/seaborn",
    ["0.12"],
    python="3.9",
    requirements=[],
    pip_packages=[
        "contourpy==1.1.0",
        "cycler==0.11.0",
        "fonttools==4.42.1",
        "importlib-resources==6.0.1",
        "kiwisolver==1.4.5",
        "matplotlib==3.7.2",
        "numpy==1.25.2",
        "packaging==23.1",
        "pandas==2.0.0",
        "pillow==10.0.0",
        "pyparsing==3.0.9",
        "pytest",
        "python-dateutil==2.8.2",
        "pytz==2023.3.post1",
        "scipy==1.11.2",
        "six==1.16.0",
        "tzdata==2023.1",
        "zipp==3.16.2",
    ],
    install=".[dev]",
    test="seaborn",
)

# Test files the harness never treats as test directives.
NON_TEST_EXTS = (
    ".json",
    ".png",
    "csv",
    ".txt",
    ".md",
    ".jpg",
    ".jpeg",
    ".pkl",
    ".yml",
    ".yaml",
    ".toml",
)

TEST_TIMEOUT_S = 900


def spec_for(instance: dict) -> dict:
    return ENV_SPECS[(instance["repo"], instance["version"])]


def supported(repo: str, version: str) -> bool:
    return (repo, version) in ENV_SPECS


# --- test directives and log parsers ---------------------------------------


def patch_files(patch: str) -> list[str]:
    """Every file a unified diff touches, by its post-image path."""
    return re.findall(r"^diff --git a/.* b/(.*)$", patch, re.MULTILINE)


def test_directives(instance: dict) -> list[str]:
    """What the test command is given, as `swebench` computes it."""
    directives = [
        d for d in patch_files(instance["test_patch"]) if not d.endswith(NON_TEST_EXTS)
    ]
    if instance["repo"] == "django/django":
        out = []
        for d in directives:
            d = d[: -len(".py")] if d.endswith(".py") else d
            d = d[len("tests/") :] if d.startswith("tests/") else d
            out.append(d.replace("/", "."))
        return out
    return directives


STATUSES = ("FAILED", "PASSED", "SKIPPED", "ERROR", "XFAIL")


def parse_pytest(log: str) -> dict[str, str]:
    result = {}
    for line in log.split("\n"):
        if line.startswith(STATUSES):
            if line.startswith("FAILED"):
                line = line.replace(" - ", " ")
            parts = line.split()
            if len(parts) > 1:
                result[parts[1]] = parts[0]
    return result


def parse_pytest_options(log: str) -> dict[str, str]:
    option = re.compile(r"(.*?)\[(.*)\]")
    result = {}
    for line in log.split("\n"):
        if line.startswith(STATUSES):
            if line.startswith("FAILED"):
                line = line.replace(" - ", " ")
            parts = line.split()
            if len(parts) <= 1:
                continue
            found = option.search(parts[1])
            if found:
                main, opt = found.groups()
                if opt.startswith("/") and not opt.startswith("//") and "*" not in opt:
                    opt = "/" + opt.split("/")[-1]
                name = f"{main}[{opt}]"
            else:
                name = parts[1]
            result[name] = parts[0]
    return result


def parse_pytest_v2(log: str) -> dict[str, str]:
    result = {}
    escapes = "".join(chr(c) for c in range(1, 32))
    table = str.maketrans("", "", escapes)
    for line in log.split("\n"):
        line = re.sub(r"\[(\d+)m", "", line).translate(table)
        if line.startswith(STATUSES):
            if line.startswith("FAILED"):
                line = line.replace(" - ", " ")
            parts = line.split()
            if len(parts) >= 2:
                result[parts[1]] = parts[0]
        elif line.endswith(STATUSES):
            parts = line.split()
            if len(parts) >= 2:
                result[parts[0]] = parts[1]
    return result


def parse_django(log: str) -> dict[str, str]:
    result = {}
    prev = None
    for raw in log.split("\n"):
        line = raw.strip()
        if "--version is equivalent to version" in line:
            result["--version is equivalent to version"] = "PASSED"
        if " ... " in line:
            prev = line.split(" ... ")[0]
        for suffix in (" ... ok", " ... OK", " ...  OK"):
            if line.endswith(suffix):
                result[line.rsplit(suffix, 1)[0]] = "PASSED"
                break
        if " ... skipped" in line:
            result[line.split(" ... skipped")[0]] = "SKIPPED"
        if line.endswith(" ... FAIL"):
            result[line.split(" ... FAIL")[0]] = "FAILED"
        if line.startswith("FAIL:"):
            result[line.split()[1].strip()] = "FAILED"
        if line.endswith(" ... ERROR"):
            result[line.split(" ... ERROR")[0]] = "ERROR"
        if line.startswith("ERROR:"):
            result[line.split()[1].strip()] = "ERROR"
        if line.lstrip().startswith("ok") and prev is not None:
            result[prev] = "PASSED"
    patterns = [
        r"^(.*?)\s\.\.\.\sTesting\ against\ Django\ installed\ in\ ((?s:.*?))\ silenced\)\.\nok$",
        r"^(.*?)\s\.\.\.\sInternal\ Server\ Error:\ \/(.*)\/\nok$",
        r"^(.*?)\s\.\.\.\sSystem check identified no issues \(0 silenced\)\nok$",
    ]
    for pattern in patterns:
        for match in re.finditer(pattern, log, re.MULTILINE):
            result[match.group(1)] = "PASSED"
    return result


def parse_sympy(log: str) -> dict[str, str]:
    result = {}
    for match in re.findall(r"(_*) (.*)\.py:(.*) (_*)", log):
        result[f"{match[1]}.py:{match[2]}"] = "FAILED"
    for raw in log.split("\n"):
        line = raw.strip()
        if line.startswith("test_"):
            if line.endswith(" E"):
                result[line.split()[0]] = "ERROR"
            if line.endswith(" F"):
                result[line.split()[0]] = "FAILED"
            if line.endswith(" ok"):
                result[line.split()[0]] = "PASSED"
    return result


def parse_seaborn(log: str) -> dict[str, str]:
    result = {}
    for line in log.split("\n"):
        if line.startswith("FAILED"):
            result[line.split()[1]] = "FAILED"
        elif " PASSED " in line:
            parts = line.split()
            if parts[1] == "PASSED":
                result[parts[0]] = "PASSED"
        elif line.startswith("PASSED"):
            result[line.split()[1]] = "PASSED"
    return result


PARSERS = {
    "django": parse_django,
    "sympy": parse_sympy,
    "pytest": parse_pytest,
    "pytest_options": parse_pytest_options,
    "sphinx": parse_pytest_v2,
    "seaborn": parse_seaborn,
}


def grade(status: dict[str, str], fail_to_pass: list[str], pass_to_pass: list[str]) -> dict:
    """The harness's PASS_AND_FAIL rule: a test counts as passing only when it
    is in the log as PASSED or XFAIL."""

    def ok(name: str) -> bool:
        return status.get(name) in ("PASSED", "XFAIL")

    f2p_failed = [t for t in fail_to_pass if not ok(t)]
    p2p_failed = [t for t in pass_to_pass if not ok(t)]
    return {
        "resolved": not f2p_failed and not p2p_failed,
        "f2p_passed": len(fail_to_pass) - len(f2p_failed),
        "f2p_total": len(fail_to_pass),
        "p2p_passed": len(pass_to_pass) - len(p2p_failed),
        "p2p_total": len(pass_to_pass),
        "f2p_failed": f2p_failed[:20],
        "p2p_failed": p2p_failed[:20],
    }


# --- preparation ------------------------------------------------------------


def _run(cmd: list[str], cwd: Path | None = None, env: dict | None = None, timeout: int = 3600):
    return subprocess.run(
        cmd,
        cwd=cwd,
        env=env,
        capture_output=True,
        text=True,
        timeout=timeout,
        check=False,
    )


def _must(cmd: list[str], cwd: Path | None = None, env: dict | None = None, timeout: int = 3600):
    proc = _run(cmd, cwd=cwd, env=env, timeout=timeout)
    if proc.returncode != 0:
        tail = (proc.stdout + proc.stderr)[-1500:]
        raise PrepareError(f"`{' '.join(cmd[:4])}` exited {proc.returncode}: {tail}")
    return proc


class PrepareError(Exception):
    pass


def instance_dir(instance_id: str) -> Path:
    return paths.cache_dir() / "swe" / instance_id


def venv_dir(instance_id: str) -> Path:
    return instance_dir(instance_id) / "venv"


def pristine_dir(instance_id: str) -> Path:
    return instance_dir(instance_id) / "pristine"


def status_path(instance_id: str) -> Path:
    return instance_dir(instance_id) / "status.json"


def read_status(instance_id: str) -> dict | None:
    try:
        return json.loads(status_path(instance_id).read_text())
    except (OSError, ValueError):
        return None


def fetch_base(repo: str, commit: str, work: Path) -> None:
    """The base commit alone, fetched shallow from GitHub. A full clone of
    Django is large enough for a home connection to reset it half way; one
    commit is a few megabytes, and the agent must not see the history after
    it anyway."""
    work.mkdir(parents=True, exist_ok=True)
    _must(["git", "init", "--quiet"], cwd=work)
    url = f"https://github.com/{repo}.git"
    for attempt in range(5):
        proc = _run(["git", "fetch", "--quiet", "--depth", "1", url, commit], cwd=work, timeout=1800)
        if proc.returncode == 0:
            break
        if attempt == 4:
            raise PrepareError(f"fetching {commit[:10]} failed: {(proc.stdout + proc.stderr)[-600:]}")
        time.sleep(10 * (attempt + 1))
    _must(["git", "checkout", "--quiet", "FETCH_HEAD"], cwd=work)


def _uv_env(version: str | None = None) -> dict:
    env = dict(os.environ)
    if version:
        # A shallow copy has no tags: the version setuptools_scm would read
        # from them is given instead (pytest needs a real one).
        env["SETUPTOOLS_SCM_PRETEND_VERSION"] = f"{version}.0"
    env.pop("VIRTUAL_ENV", None)
    env["UV_LINK_MODE"] = "clone"
    return env


def _requirements(work: Path, relative: str, seen: set | None = None) -> list[str]:
    """The lines of a requirements file, `-r` followed, the editable install
    and test extras left out (as `swebench.get_requirements_by_commit`)."""
    seen = seen or set()
    path = (work / relative).resolve()
    if path in seen or not path.exists():
        return []
    seen.add(path)
    out = []
    for raw in path.read_text().splitlines():
        line = raw.strip()
        if not line or line.startswith(("-e .", "#", ".[test")):
            continue
        if line.startswith("-r"):
            child = line[2:].strip()
            out += _requirements(work, str(Path(relative).parent / child), seen)
            continue
        if line.startswith("-"):
            continue
        out.append(line)
    return out


def _pip(venv: Path, args: list[str], cwd: Path | None = None):
    cmd = ["uv", "pip", "install", "--python", str(venv / "bin" / "python"), *args]
    return _run(cmd, cwd=cwd, env=_uv_env(), timeout=3600)


def _python_env(instance: dict, work: Path) -> dict:
    env = dict(os.environ)
    venv = venv_dir(instance["instance_id"])
    env["VIRTUAL_ENV"] = str(venv)
    env["PATH"] = f"{venv / 'bin'}:{env.get('PATH', '')}"
    env.pop("PYTHONPATH", None)
    env.update(
        {
            "LANG": "en_US.UTF-8",
            "LC_ALL": "en_US.UTF-8",
            "PYTHONIOENCODING": "utf8",
            "PYTHONDONTWRITEBYTECODE": "1",
        }
    )
    return env


def prepare(instance: dict, force: bool = False) -> dict:
    """Builds the instance's environment and validates it against the gold
    patch. Returns the status written to `status.json`: `ok`, or `excluded`
    with the reason. Idempotent: a prepared instance is not rebuilt."""
    iid = instance["instance_id"]
    existing = read_status(iid)
    # An environment that failed to build is retried (a network hiccup is not
    # a property of the instance); a validation verdict is final.
    if existing and not force and not existing.get("reason", "").startswith("environment:"):
        return existing
    started = time.time()
    try:
        _build(instance)
        validation = validate(instance)
    except (PrepareError, subprocess.TimeoutExpired) as error:
        # The reason goes into a committed file: no home folder in it.
        reason = str(error).replace(str(paths.cache_dir()), "<cache>").replace(str(Path.home()), "~")
        status = {"state": "excluded", "reason": f"environment: {reason}"[:2000]}
    else:
        if validation["ok"]:
            status = {"state": "ok", **validation}
        else:
            status = {"state": "excluded", **validation}
    status["prepared_s"] = round(time.time() - started, 1)
    status_path(iid).parent.mkdir(parents=True, exist_ok=True)
    status_path(iid).write_text(json.dumps(status, indent=2))
    return status


def _build(instance: dict) -> None:
    iid = instance["instance_id"]
    spec = spec_for(instance)
    work = paths.work_dir("swe", iid)
    venv = venv_dir(iid)
    for stale in (work, venv, pristine_dir(iid)):
        shutil.rmtree(stale, ignore_errors=True)
    work.parent.mkdir(parents=True, exist_ok=True)
    instance_dir(iid).mkdir(parents=True, exist_ok=True)

    fetch_base(instance["repo"], instance["base_commit"], work)

    _must(
        ["uv", "venv", "--quiet", "--python", spec["python"], "--seed", str(venv)],
        env=_uv_env(),
    )
    notes = []
    reqs = []
    for relative in spec["requirements"]:
        reqs += _requirements(work, relative)
    if reqs:
        with tempfile.NamedTemporaryFile("w", suffix=".txt", delete=False) as handle:
            handle.write("\n".join(reqs) + "\n")
        proc = _pip(venv, ["-r", handle.name])
        if proc.returncode != 0:
            # One package without a wheel for this Mac (a C library from a
            # system package manager) must not sink the rest.
            for line in reqs:
                one = _pip(venv, [line])
                if one.returncode != 0:
                    notes.append(f"skipped requirement {line!r}")
        os.unlink(handle.name)
    if spec["pip_packages"]:
        _must(
            ["uv", "pip", "install", "--python", str(venv / "bin" / "python"), *spec["pip_packages"]],
            env=_uv_env(),
        )
    _must(
        ["uv", "pip", "install", "--python", str(venv / "bin" / "python"), "-e", spec["install"]],
        cwd=work,
        env=_uv_env(instance["version"]),
    )
    if spec["pip_packages"]:
        # Pins win over what the editable install pulled in.
        _must(
            ["uv", "pip", "install", "--python", str(venv / "bin" / "python"), *spec["pip_packages"]],
            env=_uv_env(),
        )
    # A fresh history of one commit: the agent cannot read the fix from the
    # future, and `git diff` shows exactly what it changed.
    shutil.rmtree(work / ".git")
    _must(["git", "init", "--quiet", "-b", "main"], cwd=work)
    _must(["git", "add", "-A", "."], cwd=work)
    _must(
        [
            "git",
            "-c",
            "gc.auto=0",
            "-c",
            "maintenance.auto=false",
            "-c",
            "user.name=bench",
            "-c",
            "user.email=bench@localhost",
            "commit",
            "--quiet",
            "--no-verify",
            "-m",
            "base",
        ],
        cwd=work,
    )
    _must(["cp", "-cR", str(work), str(pristine_dir(iid))])
    (instance_dir(iid) / "notes.json").write_text(json.dumps(notes))


def reset_workdir(instance: dict) -> Path:
    """The working copy as it was right after preparation."""
    iid = instance["instance_id"]
    work = paths.work_dir("swe", iid)
    pristine = pristine_dir(iid)
    if not pristine.exists():
        raise PrepareError(f"{iid} is not prepared")
    shutil.rmtree(work, ignore_errors=True)
    _must(["cp", "-cR", str(pristine), str(work)])
    return work


def _apply(work: Path, patch: str) -> None:
    with tempfile.NamedTemporaryFile("w", suffix=".diff", delete=False) as handle:
        handle.write(patch)
    try:
        proc = _run(["git", "apply", "--whitespace=nowarn", handle.name], cwd=work)
        if proc.returncode != 0:
            proc = _run(["patch", "--batch", "--forward", "-p1", "-i", handle.name], cwd=work)
        if proc.returncode != 0:
            raise PrepareError(f"patch did not apply: {(proc.stdout + proc.stderr)[-800:]}")
    finally:
        os.unlink(handle.name)


def _reset_test_files(work: Path, test_patch: str) -> None:
    """The files the test patch touches go back to the base commit, whatever
    the agent did to them (the harness does the same)."""
    for name in patch_files(test_patch):
        tracked = _run(["git", "cat-file", "-e", f"HEAD:{name}"], cwd=work).returncode == 0
        if tracked:
            _run(["git", "checkout", "HEAD", "--", name], cwd=work)
        else:
            try:
                (work / name).unlink()
            except FileNotFoundError:
                pass


def test_command(instance: dict, work: Path) -> list[str]:
    spec = spec_for(instance)
    python = str(venv_dir(instance["instance_id"]) / "bin" / "python")
    directives = test_directives(instance)
    kind = spec["test"]
    if kind == "django":
        return [python, *DJANGO_TEST, *directives]
    if kind == "sympy":
        return [python, *SYMPY_TEST, *directives]
    if kind == "sphinx":
        return [python, "-X", "dev", "-m", "pytest", "-rA", "--durations", "25", *directives]
    if kind == "seaborn":
        return [python, "-m", "pytest", "--no-header", "-rA", *directives]
    return [python, *PYTEST_TEST, *directives]


def run_tests(instance: dict, work: Path, log_path: Path | None = None) -> dict:
    """Applies the test patch to `work` and grades it. Never raises for a
    failing test; a patch that does not apply is a failure."""
    started = time.time()
    try:
        _reset_test_files(work, instance["test_patch"])
        _apply(work, instance["test_patch"])
    except PrepareError as error:
        return {"resolved": False, "error": str(error), "test_s": 0.0}
    spec = spec_for(instance)
    env = _python_env(instance, work)
    if spec["test"] == "sympy":
        env["PYTHONWARNINGS"] = "ignore::UserWarning,ignore::SyntaxWarning"
    if spec["test"] == "sphinx":
        env["PYTHONWARNINGS"] = "all"
    cmd = test_command(instance, work)
    try:
        proc = subprocess.run(
            cmd,
            cwd=work,
            env=env,
            capture_output=True,
            text=True,
            timeout=TEST_TIMEOUT_S,
            check=False,
        )
        log = proc.stdout + "\n" + proc.stderr
        timed_out = False
    except subprocess.TimeoutExpired as error:
        out = error.stdout or ""
        log = out.decode(errors="replace") if isinstance(out, bytes) else out
        timed_out = True
    if log_path:
        log_path.parent.mkdir(parents=True, exist_ok=True)
        log_path.write_text(log)
    status = PARSERS[spec["test"]](log)
    result = grade(status, instance["FAIL_TO_PASS"], instance["PASS_TO_PASS"])
    result["test_s"] = round(time.time() - started, 1)
    if timed_out:
        result["resolved"] = False
        result["error"] = "tests timed out"
    return result


def validate(instance: dict) -> dict:
    """The gold patch must resolve the instance here, and the base must not:
    otherwise the local environment differs from the harness's and the
    instance cannot be scored fairly."""
    logs = instance_dir(instance["instance_id"]) / "validation"
    work = reset_workdir(instance)
    before = run_tests(instance, work, logs / "base.log")
    work = reset_workdir(instance)
    try:
        _apply(work, instance["patch"])
    except PrepareError as error:
        return {"ok": False, "reason": f"gold patch: {error}"}
    after = run_tests(instance, work, logs / "gold.log")
    reset_workdir(instance)
    if not after["resolved"]:
        missing = after.get("f2p_failed", []) + after.get("p2p_failed", [])
        return {
            "ok": False,
            "reason": "gold patch does not pass here"
            + (f": {after['error']}" if after.get("error") else "")
            + (f" (failing: {missing[:5]})" if missing else ""),
            "gold_test_s": after["test_s"],
        }
    if before["f2p_passed"] == before["f2p_total"]:
        return {"ok": False, "reason": "FAIL_TO_PASS already passes at the base commit"}
    return {"ok": True, "gold_test_s": after["test_s"], "base_test_s": before["test_s"]}


# --- the task the runner sees ----------------------------------------------


@dataclass
class SweTask:
    instance: dict
    suite: str = "swe"

    @property
    def id(self) -> str:
        return self.instance["instance_id"]

    def prompt(self, work: Path) -> str:
        venv = venv_dir(self.id)
        return (
            "Resolve the issue below in the repository in the current folder.\n\n"
            f"<issue>\n{self.instance['problem_statement'].strip()}\n</issue>\n\n"
            "Change the source code so the issue is fixed. Do not change or add "
            "tests: hidden tests will check your change. The project is installed "
            f"in editable mode in the Python environment {venv} (use "
            f"`{venv}/bin/python`, or `source {venv}/bin/activate`). That "
            "environment is read-only: do not try to install packages. When the "
            "fix is done, stop."
        )

    def prepare(self) -> Path:
        status = read_status(self.id)
        if not status or status.get("state") != "ok":
            status = prepare(self.instance)
        if status.get("state") != "ok":
            raise PrepareError(status.get("reason", "not prepared"))
        return reset_workdir(self.instance)

    def verify(self, work: Path, log_path: Path) -> dict:
        return run_tests(self.instance, work, log_path)
