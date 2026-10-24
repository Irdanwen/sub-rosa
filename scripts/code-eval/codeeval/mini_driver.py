"""Runs mini-swe-agent (MIT) on one task, for the bench's reference column.

Executed by the mini-swe-agent virtual environment's Python (`engines.py`),
never imported by the bench itself. It uses the stock `mini.yaml` prompts
and the stock non-interactive `DefaultAgent`, with two changes that keep the
comparison fair:

- the model is any Carpe Diem id through the OpenAI-compatible endpoint, and
  the cost is what Carpe Diem metered (`usage.carpe_cost_usdc_micro`), the
  same ledger the Sub Rosa engine reads;
- every command runs under a Seatbelt profile shaped like Sub Rosa's jail
  (writes only to the working copy and the temporary folders), so neither
  engine can write where the other could not.

Writes a summary JSON the runner reads: status, cost, tokens, steps, and the
commands that exited non-zero.
"""

from __future__ import annotations

import argparse
import json
import os
import shlex
import time
from pathlib import Path

from minisweagent.agents.default import DefaultAgent
from minisweagent.config import get_config_from_spec
from minisweagent.environments.local import LocalEnvironment
from minisweagent.models.litellm_model import LitellmModel

SANDBOX_EXEC = "/usr/bin/sandbox-exec"


def seatbelt_profile(workdir: str) -> str:
    tmp = os.environ.get("TMPDIR", "/private/var/folders")
    grants = [workdir, "/private/tmp", "/private/var/tmp", os.path.realpath(tmp), "/dev"]
    allowed = " ".join(f'(subpath "{g}")' for g in grants)
    return f"(version 1)(allow default)(deny file-write*)(allow file-write* {allowed})"


class JailedEnvironment(LocalEnvironment):
    """Each command through `sandbox-exec`, like Sub Rosa's terminal tool."""

    def execute(self, action: dict, cwd: str = "", *, timeout: int | None = None):
        command = action.get("command", "")
        if os.path.exists(SANDBOX_EXEC):
            profile = seatbelt_profile(os.path.realpath(self.config.cwd))
            command = f"{SANDBOX_EXEC} -p {shlex.quote(profile)} /bin/bash -c {shlex.quote(command)}"
        output = super().execute({**action, "command": command}, cwd, timeout=timeout)
        COMMANDS.append(output.get("returncode", -1))
        return output


class CarpeDiemModel(LitellmModel):
    """Prices a completion with Carpe Diem's own metering."""

    def _calculate_cost(self, response) -> dict[str, float]:
        usage = getattr(response, "usage", None)
        dumped = {}
        try:
            dumped = response.model_dump().get("usage") or {}
        except Exception:  # noqa: BLE001 - a response we cannot dump has no price
            dumped = {}
        micro = dumped.get("carpe_cost_usdc_micro") or getattr(usage, "carpe_cost_usdc_micro", None)
        TOKENS["input"] += int(dumped.get("prompt_tokens") or 0)
        TOKENS["output"] += int(dumped.get("completion_tokens") or 0)
        cached = (dumped.get("prompt_tokens_details") or {}).get("cached_tokens") or 0
        TOKENS["cached"] += int(cached)
        if micro is None:
            TOKENS["unpriced_calls"] += 1
            return {"cost": 0.0}
        return {"cost": float(micro) / 1_000_000}


COMMANDS: list[int] = []
TOKENS = {"input": 0, "output": 0, "cached": 0, "unpriced_calls": 0}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", required=True)
    parser.add_argument("--base-url", required=True)
    parser.add_argument("--workdir", required=True)
    parser.add_argument("--prompt-file", required=True)
    parser.add_argument("--budget", type=float, required=True)
    parser.add_argument("--trajectory", required=True)
    parser.add_argument("--summary", required=True)
    parser.add_argument("--step-limit", type=int, default=250)
    args = parser.parse_args()

    config = get_config_from_spec("mini.yaml")
    agent_config = {k: v for k, v in config["agent"].items() if k != "mode"}
    agent_config.update(
        cost_limit=args.budget,
        step_limit=args.step_limit,
        output_path=Path(args.trajectory),
    )
    model_config = dict(config.get("model", {}))
    model_config.update(
        model_name=f"openai/{args.model}",
        model_kwargs={
            "api_base": args.base_url,
            "api_key": os.environ["CARPE_DIEM_API_KEY"],
            "drop_params": True,
        },
        cost_tracking="ignore_errors",
    )
    env_config = dict(config.get("environment", {}))
    env_config.update(cwd=os.path.realpath(args.workdir), timeout=900)

    model = CarpeDiemModel(**model_config)
    environment = JailedEnvironment(**env_config)
    agent = DefaultAgent(model, environment, **agent_config)
    started = time.time()
    status = "completed"
    error = None
    try:
        info = agent.run(Path(args.prompt_file).read_text())
        exit_status = info.get("exit_status", "")
        if exit_status == "LimitsExceeded":
            status = "budget_exceeded"
        elif exit_status not in ("Submitted", ""):
            status = "failed"
            error = exit_status
    except Exception as exc:  # noqa: BLE001 - the summary must be written
        status = "failed"
        error = f"{type(exc).__name__}: {exc}"[:500]
    summary = {
        "status": status,
        "reason": error,
        "cost_usd": round(agent.cost, 6),
        "input_tokens": TOKENS["input"],
        "output_tokens": TOKENS["output"],
        "cached_tokens": TOKENS["cached"],
        "unpriced_calls": TOKENS["unpriced_calls"],
        "api_calls": agent.n_calls,
        "tool_calls": len(COMMANDS),
        "tool_failures": sum(1 for code in COMMANDS if code != 0),
        # mini-swe-agent edits through bash: a modification is not a tool call
        # the bench can tell apart, so these stay unobserved.
        "edits": None,
        "edit_failures": None,
        "fuzzy_strategies": None,
        "duration_s": round(time.time() - started, 1),
    }
    Path(args.summary).write_text(json.dumps(summary, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
