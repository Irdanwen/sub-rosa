#!/bin/sh
set -e
[ ! -e app.ini ]
[ -f app.toml ]
python3 - <<'PY'
import tomllib, importlib.util
data = tomllib.load(open("app.toml", "rb"))
expected = {
    "server": {"host": "0.0.0.0", "port": 8080, "workers": 4},
    "database": {"url": "postgres://report@db.internal:5432/reports", "pool_size": 10, "timeout_seconds": 2.5},
    "features": {"exports": True, "beta_dashboard": False},
}
assert data == expected, data
for section in expected.values():
    for value in section.values():
        pass
assert isinstance(data["server"]["port"], int) and isinstance(data["features"]["exports"], bool)
spec = importlib.util.spec_from_file_location("load_config", "load_config.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
assert module.load() == expected, module.load()
src = open("load_config.py").read()
assert "tomllib" in src and "configparser" not in src
PY
