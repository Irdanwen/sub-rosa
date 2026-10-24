"""The frozen task files are complete and self-consistent (no network)."""

from codeeval import subrosa, swe, tasks
from codeeval.swe import patch_files


def test_suite_sizes():
    assert len(tasks.load_suite("swe")) == 40
    assert len(tasks.load_suite("term")) == 10
    assert len(tasks.load_suite("subrosa")) == 10


def test_swe_instances_have_everything_the_runner_reads():
    for task in tasks.load_suite("swe"):
        instance = task.instance
        for key in ("instance_id", "repo", "version", "base_commit", "problem_statement", "test_patch", "patch"):
            assert instance[key], (task.id, key)
        assert instance["FAIL_TO_PASS"], task.id
        assert swe.supported(instance["repo"], instance["version"]), task.id
        assert swe.test_directives(instance), task.id


def test_term_tasks_ship_a_check_and_a_reference_solution():
    for task in tasks.load_suite("term"):
        assert (task.folder / "verify.sh").exists(), task.id
        assert (task.folder / "solution.sh").exists(), task.id
        assert task.spec["prompt"].strip(), task.id
        assert task.id.startswith("term-")


def test_subrosa_patches_split_tests_from_the_fix():
    for raw in subrosa.load_tasks():
        tests = set(raw["tests"])
        assert set(patch_files(raw["test_patch"])) == tests, raw["id"]
        assert raw["gold_patch"].strip(), raw["id"]
        assert not tests & set(patch_files(raw["gold_patch"])), raw["id"]
        assert raw["kind"] in ("ts", "rust")
        if raw["kind"] == "rust":
            assert raw["cargo_test"], raw["id"]


def test_ids_are_unique_across_suites():
    ids = [t.id for s in tasks.SUITES for t in tasks.load_suite(s)]
    assert len(ids) == len(set(ids)) == 60
