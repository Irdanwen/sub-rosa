// The Python the worker runs once after Pyodide starts (ADR-0086). It gives
// the model's code two helpers that turn a result into a chat block the app
// renders (`subrosa_chart`, `subrosa_table`), and `_subrosa_run_request`, the
// one entry point the worker calls: run the code in the conversation's own
// namespace, from /data where the attached files are, and hand back what it
// printed, the value of its last expression, the blocks it made, or the
// traceback it raised. pandas is imported only when the code uses it, so a
// plain arithmetic question never pays for loading it.

export const PYTHON_PRELUDE = String.raw`
import json as _json
import math as _math
import os as _os
import traceback as _traceback

_subrosa_blocks = []
_subrosa_sessions = {}
_SUBROSA_MAX_ROWS = 500


def _subrosa_plain(value):
    if hasattr(value, "item") and not isinstance(value, (str, bytes)):
        try:
            value = value.item()
        except Exception:
            pass
    if value is None or isinstance(value, (bool, int, str)):
        return value
    if isinstance(value, float):
        return None if _math.isnan(value) or _math.isinf(value) else value
    if hasattr(value, "isoformat"):
        try:
            return value.isoformat()
        except Exception:
            pass
    text = str(value)
    return None if text in ("NaT", "nan", "<NA>") else text


def _subrosa_is_frame(value):
    return type(value).__name__ == "DataFrame" and hasattr(value, "columns")


def _subrosa_is_series(value):
    return type(value).__name__ == "Series" and hasattr(value, "index")


def _subrosa_emit(kind, block):
    text = _json.dumps(block, ensure_ascii=False, allow_nan=False)
    _subrosa_blocks.append({"kind": kind, "json": text})
    return text


def subrosa_table(data, title=None, columns=None, max_rows=200, source=None, index=None):
    """A sortable table card in the reply. data: a DataFrame, a Series, a list
    of dicts or a list of rows (then pass columns). Returns the block JSON."""
    max_rows = max(1, min(int(max_rows), _SUBROSA_MAX_ROWS))
    if _subrosa_is_series(data):
        data = data.to_frame()
    if _subrosa_is_frame(data):
        frame = data
        keep_index = index if index is not None else not (
            frame.index.name is None and type(frame.index).__name__ == "RangeIndex"
        )
        if keep_index:
            frame = frame.reset_index()
        names = [str(name) for name in frame.columns]
        rows = [[_subrosa_plain(cell) for cell in row] for row in frame.head(max_rows).itertuples(index=False)]
    elif data and isinstance(data[0], dict):
        names = list(columns or data[0].keys())
        rows = [[_subrosa_plain(item.get(name)) for name in names] for item in data[:max_rows]]
    else:
        names = [str(name) for name in (columns or [])]
        rows = [[_subrosa_plain(cell) for cell in row] for row in list(data)[:max_rows]]
        if not names and rows:
            names = ["Column %d" % (i + 1) for i in range(len(rows[0]))]
    block = {"v": 1, "columns": names, "rows": rows}
    if title:
        block["title"] = str(title)
    if source:
        block["source"] = str(source)
    return _subrosa_emit("table", block)


def subrosa_chart(type, data=None, x=None, y=None, categories=None, series=None, title=None,
                  x_title=None, y_title=None, unit=None, x_unit=None, stacked=False, source=None):
    """A chart card in the reply. type: bar, line, area, pie, donut or scatter.
    Either data (a DataFrame) with x (a column, or the index when omitted) and
    y (one column or a list), or categories plus series ({name: values} or
    [{"name", "values"}]; for scatter [{"name", "points": [[x, y], ...]}]).
    Returns the block JSON."""
    block = {"v": 1, "type": str(type)}
    if title:
        block["title"] = str(title)
    if source:
        block["source"] = str(source)
    if stacked:
        block["stacked"] = True
    if _subrosa_is_series(data):
        data = data.to_frame()
    if _subrosa_is_frame(data):
        columns = [y] if isinstance(y, str) else list(y or [])
        if not columns:
            columns = [name for name in data.columns if name != x and str(data[name].dtype)[:3] in ("int", "flo", "uin")]
        if type == "scatter":
            xs = data[x] if x is not None else data.index
            series = [
                {"name": str(name), "points": [[_subrosa_plain(a), _subrosa_plain(b)] for a, b in zip(xs, data[name])]}
                for name in columns
            ]
        else:
            labels = data[x] if x is not None else data.index
            categories = [str(_subrosa_plain(label)) for label in labels]
            series = [{"name": str(name), "values": [_subrosa_plain(v) for v in data[name]]} for name in columns]
        if x_title is None and x is not None:
            x_title = str(x)
        if y_title is None and len(columns) == 1 and type != "pie" and type != "donut":
            y_title = str(columns[0])
    elif isinstance(series, dict):
        series = [{"name": str(name), "values": [_subrosa_plain(v) for v in values]} for name, values in series.items()]
    elif series is not None:
        series = [dict(entry) for entry in series]
        for entry in series:
            if "values" in entry:
                entry["values"] = [_subrosa_plain(v) for v in entry["values"]]
            if "points" in entry:
                entry["points"] = [[_subrosa_plain(a), _subrosa_plain(b)] for a, b in entry["points"]]
    block["series"] = series or []
    if type != "scatter":
        block["categories"] = [str(_subrosa_plain(c)) for c in (categories or [])]
    if x_title or x_unit:
        block["x"] = {key: value for key, value in (("title", x_title), ("unit", x_unit)) if value}
    if y_title or unit:
        block["y"] = {key: value for key, value in (("title", y_title), ("unit", unit)) if value}
    return _subrosa_emit("chart", block)


def _subrosa_repr(value):
    if _subrosa_is_frame(value) or _subrosa_is_series(value):
        text = value.to_string(max_rows=30, max_cols=12)
    elif hasattr(value, "item") and getattr(value, "ndim", 1) == 0:
        text = repr(value.item())
    else:
        text = repr(value)
    return text if len(text) <= 4000 else text[:4000] + "\n[truncated]"


async def _subrosa_run_request(request_json):
    from pyodide.code import eval_code_async

    request = _json.loads(request_json)
    session = request.get("session") or "default"
    namespace = _subrosa_sessions.get(session)
    if namespace is None:
        # A few conversations' variables at most: each holds its data frames.
        while len(_subrosa_sessions) >= 4:
            _subrosa_sessions.pop(next(iter(_subrosa_sessions)))
        namespace = {"__name__": "__main__", "subrosa_chart": subrosa_chart, "subrosa_table": subrosa_table}
        _subrosa_sessions[session] = namespace
    _subrosa_blocks.clear()
    _os.makedirs("/data", exist_ok=True)
    _os.chdir("/data")
    result = None
    error = None
    try:
        value = await eval_code_async(request["code"], namespace, filename="<analysis>")
        if value is not None and not any(block["json"] == value for block in _subrosa_blocks):
            result = _subrosa_repr(value)
    except BaseException:
        lines = _traceback.format_exc().splitlines()
        # The worker's own frames say nothing to the model; its code's do.
        start = next((i for i, line in enumerate(lines) if '"<analysis>"' in line), len(lines) - 1)
        error = "\n".join(lines[:1] + lines[start:])[-3000:]
    return _json.dumps({"result": result, "blocks": list(_subrosa_blocks), "error": error})
`;
