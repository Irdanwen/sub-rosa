"""The code bench (ADR-0122): tasks, engines, results and the report.

Everything that is not a task definition lives outside the repository, under
the cache folder (`paths.cache_dir()`): repository clones, Python
environments, the working copies the agent edits, and the raw logs.
"""
