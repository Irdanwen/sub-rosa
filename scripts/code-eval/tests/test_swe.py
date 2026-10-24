from codeeval import swe

TEST_PATCH = """diff --git a/tests/forms_tests/tests/test_forms.py b/tests/forms_tests/tests/test_forms.py
--- a/tests/forms_tests/tests/test_forms.py
+++ b/tests/forms_tests/tests/test_forms.py
@@ -1 +1 @@
-a
+b
diff --git a/tests/forms_tests/fixtures/data.json b/tests/forms_tests/fixtures/data.json
--- a/tests/forms_tests/fixtures/data.json
+++ b/tests/forms_tests/fixtures/data.json
@@ -1 +1 @@
-1
+2
"""


def test_django_directives_are_module_labels_without_data_files():
    instance = {"repo": "django/django", "test_patch": TEST_PATCH}
    assert swe.test_directives(instance) == ["forms_tests.tests.test_forms"]


def test_other_repositories_keep_paths():
    patch = TEST_PATCH.replace("tests/forms_tests/tests/test_forms.py", "testing/test_x.py")
    instance = {"repo": "pytest-dev/pytest", "test_patch": patch}
    assert swe.test_directives(instance) == ["testing/test_x.py"]


def test_parse_django_log():
    log = "\n".join(
        [
            "test_a (forms_tests.tests.FormTests) ... ok",
            "test_b (forms_tests.tests.FormTests) ... FAIL",
            "test_c (forms_tests.tests.FormTests) ... ERROR",
            "test_d (forms_tests.tests.FormTests) ... skipped 'no'",
            "test_e (forms_tests.tests.FormTests) ... some output",
            "ok",
        ]
    )
    status = swe.parse_django(log)
    assert status["test_a (forms_tests.tests.FormTests)"] == "PASSED"
    assert status["test_b (forms_tests.tests.FormTests)"] == "FAILED"
    assert status["test_c (forms_tests.tests.FormTests)"] == "ERROR"
    assert status["test_d (forms_tests.tests.FormTests)"] == "SKIPPED"
    assert status["test_e (forms_tests.tests.FormTests)"] == "PASSED"


def test_parse_pytest_and_options():
    log = "PASSED testing/test_x.py::test_a\nFAILED testing/test_x.py::test_b - AssertionError\nXFAIL testing/test_x.py::test_c"
    assert swe.parse_pytest(log) == {
        "testing/test_x.py::test_a": "PASSED",
        "testing/test_x.py::test_b": "FAILED",
        "testing/test_x.py::test_c": "XFAIL",
    }
    opts = swe.parse_pytest_options("PASSED tests/t.py::test_p[/tmp/abc/file.txt]")
    assert opts == {"tests/t.py::test_p[/file.txt]": "PASSED"}


def test_parse_sympy():
    log = "test_one ok\ntest_two F\ntest_three E\n________ sympy/core/tests/test_x.py:test_four ________"
    status = swe.parse_sympy(log)
    assert status["test_one"] == "PASSED"
    assert status["test_two"] == "FAILED"
    assert status["test_three"] == "ERROR"
    assert status["sympy/core/tests/test_x.py:test_four"] == "FAILED"


def test_grade_requires_every_listed_test_to_pass():
    status = {"a": "PASSED", "b": "XFAIL", "c": "FAILED"}
    assert swe.grade(status, ["a"], ["b"])["resolved"]
    missing = swe.grade(status, ["a", "z"], ["b"])
    assert not missing["resolved"] and missing["f2p_failed"] == ["z"]
    broke = swe.grade(status, ["a"], ["c"])
    assert not broke["resolved"] and broke["p2p_passed"] == 0


def test_every_supported_version_has_a_known_parser():
    for spec in swe.ENV_SPECS.values():
        assert spec["test"] in swe.PARSERS
