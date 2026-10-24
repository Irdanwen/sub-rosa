import json

import report


def rec(task, suite, pass_, resolved, cost=0.1, engine="subrosa", model="kimi", **extra):
    return {
        "task": task,
        "suite": suite,
        "pass": pass_,
        "engine": engine,
        "model": model,
        "resolved": resolved,
        "cost_usd": cost,
        "duration_s": 60.0,
        "edits": 4,
        "edit_failures": 1,
        "input_tokens": 1000,
        "output_tokens": 100,
        **extra,
    }


def fake_results():
    rows = []
    for p in (1, 2):
        for i in range(10):
            rows.append(rec(f"swe-{i}", "swe", p, i < (6 if p == 1 else 5)))
        rows.append(rec("term-a", "term", p, True))
    rows.append(rec("swe-x", "swe", 1, None, bench_error="prepare: boom"))
    return rows


def test_summary_counts_pass_at_1_cost_and_edit_failures():
    s = report.summarize(fake_results())
    assert s["attempts"] == 22
    assert s["resolved"] == 13
    assert s["bench_errors"] == 1
    assert s["by_suite"] == {"swe": (11, 20), "term": (2, 2)}
    assert abs(s["total_cost"] - 2.2) < 1e-9
    assert abs(s["cost_per_resolved"] - 2.2 / 13) < 1e-9
    assert (s["edits"], s["edit_failures"]) == (88, 22)
    assert s["median_s"] == 60.0


def test_pass_gap_uses_tasks_scored_in_every_pass():
    rows = fake_results() + [rec("only-in-1", "swe", 1, True)]
    gap = report.pass_gap(rows)
    assert gap["common"] == 11
    assert round(gap["scores"][1], 2) == round(700 / 11, 2)
    assert round(gap["scores"][2], 2) == round(600 / 11, 2)
    assert round(gap["gap"], 2) == round(100 / 11, 2)


def test_one_pass_has_no_gap():
    assert report.pass_gap([rec("a", "swe", 1, True)])["gap"] is None


def test_render_has_one_row_per_engine_and_model_and_the_gate(tmp_path):
    rows = fake_results() + [rec("swe-0", "swe", 1, False, engine="mini-swe-agent", edits=None, edit_failures=None)]
    path = tmp_path / "r.jsonl"
    path.write_text("\n".join(json.dumps(r) for r in rows) + "\n")
    out = tmp_path / "report.md"
    assert report.main([str(path), "--out", str(out)]) == 0
    text = out.read_text()
    assert "| subrosa | kimi | 55.0 % (11/20) | 100.0 % (2/2) | n/a | 59.1 % | 22 (+1 bench errors) |" in text
    assert "| mini-swe-agent | kimi |" in text
    assert "not observed" in text
    assert "9.1 pts | OUT |" in text
    assert "not observable" in text


def test_within_three_points_passes_the_gate():
    rows = []
    for p in (1, 2):
        for i in range(40):
            rows.append(rec(f"t{i}", "swe", p, i < (20 if p == 1 else 21)))
    assert "2.5 pts | within |" in report.render(rows)
