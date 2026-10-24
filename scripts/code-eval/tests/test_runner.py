import json
from dataclasses import dataclass
from pathlib import Path

import pytest

import run
from codeeval import paths, results, tasks


@dataclass
class FakeTask:
    id: str
    suite: str = "term"
    solved_by: str = "good"

    def prepare(self) -> Path:
        work = paths.work_dir(self.suite, self.id)
        work.mkdir(parents=True, exist_ok=True)
        return work

    def prompt(self, work):
        return f"do {self.id}"

    def verify(self, work, log_path):
        return {"resolved": (work / "done").exists(), "test_s": 0.1}


class FakeEngine:
    name = "fake"

    def __init__(self, model, budget, timeout, key, fail_on=()):
        self.model = model
        self.calls = []
        self.fail_on = fail_on

    def run(self, prompt, work, logs, slot):
        self.calls.append(prompt)
        if prompt in self.fail_on:
            raise RuntimeError("engine crashed")
        if "good" in prompt:
            (work / "done").write_text("yes")
        return {"status": "completed", "cost_usd": 0.25, "edits": 1, "edit_failures": 0, "exit_code": 0}


@pytest.fixture
def bench(tmp_path, monkeypatch):
    monkeypatch.setenv("SUBROSA_CODE_EVAL_CACHE", str(tmp_path / "cache"))
    monkeypatch.setenv("SUBROSA_DEV_API_KEY", "cdm_test")
    fake = [FakeTask("good-1"), FakeTask("good-2"), FakeTask("bad-1")]
    monkeypatch.setattr(tasks, "load", lambda selection: list(fake))
    return tmp_path


def run_with(engine, out, *extra):
    return run.main(
        ["--model", "m", "--suite", "term", "--out", str(out), "--jobs", "2", *extra],
        engine_factory=lambda *args: engine,
    )


def test_scores_each_task_and_pass(bench):
    out = bench / "r.jsonl"
    engine = FakeEngine("m", 1, 10, "k")
    assert run_with(engine, out, "--passes", "2") == 0
    rows = results.read(out)
    assert len(rows) == 6
    assert {(r["task"], r["pass"]) for r in rows} == {
        (t, p) for t in ("good-1", "good-2", "bad-1") for p in (1, 2)
    }
    assert sum(r["resolved"] for r in rows) == 4
    assert all(r["cost_usd"] == 0.25 and r["engine"] == "fake" for r in rows)


def test_resume_skips_scored_tasks_and_retries_bench_errors(bench):
    out = bench / "r.jsonl"
    first = FakeEngine("m", 1, 10, "k", fail_on=("do good-2",))
    run_with(first, out)
    rows = results.read(out)
    assert [r for r in rows if r["task"] == "good-2"][0]["bench_error"].startswith("engine:")
    second = FakeEngine("m", 1, 10, "k")
    run_with(second, out)
    assert second.calls == ["do good-2"]
    assert results.done_keys(out) == {("good-1", 1), ("good-2", 1), ("bad-1", 1)}


def test_total_cap_stops_starting_tasks(bench):
    out = bench / "r.jsonl"
    engine = FakeEngine("m", 1, 10, "k")
    run.main(
        ["--model", "m", "--out", str(out), "--jobs", "1", "--max-total-usd", "0.4"],
        engine_factory=lambda *args: engine,
    )
    assert len(engine.calls) == 2


def test_gate20_is_twenty_known_tasks_from_the_three_suites():
    ids = json.loads((paths.TASKS_DIR / "gate20.json").read_text())["tasks"]
    assert len(ids) == len(set(ids)) == 20
    everything = {t.id: t.suite for s in tasks.SUITES for t in tasks.load_suite(s)}
    assert set(ids) <= set(everything)
    assert {everything[i] for i in ids} == {"swe", "term", "subrosa"}
