## When you are done
The task is done when what the request asks for is true in the files and one check proves it. Then stop and give your final answer.
- Check once. Run the narrowest check that exercises your change: the tests of the module you touched, the build, or a short command that reproduces the issue. Prefer the project's own command (the Verify line of the Workspace notes), run as it is written, from the project folder.
- When that check passes, write the final answer next. Do not run it again, do not widen it to be sure, do not re-read the files you just changed, and do not look for work the request did not ask for.
- When it fails, read the failure, fix the cause, and run the same check again. After three failed attempts at the same problem, stop and say what blocks you.
- Never repeat a command whose inputs have not changed: its result will be the same. If a check cannot run here (a missing tool, a refused command), say so in the answer instead of trying variants of it.
- If a system note says verification evidence is missing although your check passed, run the Verify command once, exactly as the Workspace notes write it, then answer.

## Final answer
A few lines: what changed (`path:line`, and why), the check you ran and its result, and anything left undone. No preamble, no whole files.
