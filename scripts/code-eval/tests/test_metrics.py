import json

from codeeval import metrics


def line(seq, **event):
    return json.dumps({"schema": 1, "run_id": "run_x", "seq": seq, "at": "2026-10-23T10:00:00Z", **event})


def test_reads_cost_tokens_edits_and_strategies(tmp_path):
    path = tmp_path / "events.jsonl"
    path.write_text(
        "\n".join(
            [
                line(1, type="run.started", engine="hermes", model="m", mode="build", dir="/w", resumed=False, sandboxed=True),
                line(2, type="tool.completed", call_id="a", name="patch", kind="edit", ok=True,
                     detail={"path": "a.py", "edit": {"added": 1, "removed": 1, "strategy": "exact"}}),
                line(3, type="tool.completed", call_id="b", name="patch", kind="edit", ok=False, error="no match"),
                line(4, type="tool.completed", call_id="c", name="terminal", kind="shell", ok=False),
                line(5, type="usage", input_tokens=100, output_tokens=10, cached_tokens=5, cost_usd=0.01),
                line(6, type="usage", input_tokens=300, output_tokens=40, cached_tokens=50, cost_usd=0.03),
                "not json",
                line(7, type="run.finished", status="completed", cost_usd=0.03, turns=1),
            ]
        )
    )
    summary = metrics.summarize(metrics.read_events(path))
    assert summary["status"] == "completed"
    assert summary["cost_usd"] == 0.03
    assert (summary["input_tokens"], summary["output_tokens"], summary["cached_tokens"]) == (300, 40, 50)
    assert (summary["edits"], summary["edit_failures"]) == (2, 1)
    assert (summary["tool_calls"], summary["tool_failures"]) == (3, 2)
    assert summary["fuzzy_strategies"] == {"exact": 1}


def test_a_stream_without_finish_or_strategy_says_so(tmp_path):
    path = tmp_path / "events.jsonl"
    path.write_text(
        line(1, type="tool.completed", call_id="a", name="write_file", kind="edit", ok=True,
             detail={"edit": {"added": 3, "removed": 0}})
    )
    summary = metrics.summarize(metrics.read_events(path))
    assert summary["status"] == "no_finish"
    assert summary["cost_usd"] is None
    assert summary["fuzzy_strategies"] is None
    assert summary["edits"] == 1


def test_a_missing_file_is_an_empty_run(tmp_path):
    assert metrics.read_events(tmp_path / "absent.jsonl") == []
