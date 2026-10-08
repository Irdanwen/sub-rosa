// What the Python worker does with one run (ADR-0086), written against the
// small slice of Pyodide it uses so the tests can hand it a fake.

import { PYTHON_PRELUDE } from "./prelude";
import { messageOf, type PythonBlock, type WorkerDone, type WorkerRun } from "./protocol";

/** The part of Pyodide's API the runner touches. */
export type PyodideLike = {
  FS: {
    mkdirTree(path: string): void;
    writeFile(path: string, data: string): void;
  };
  setStdout(options: { batched: (text: string) => void }): void;
  setStderr(options: { batched: (text: string) => void }): void;
  loadPackage(names: string[]): Promise<unknown>;
  runPythonAsync(code: string): Promise<unknown>;
  globals: { set(name: string, value: unknown): void };
};

/** Import names the bundle can satisfy, and the package that carries each.
 * Anything else fails with Python's own ModuleNotFoundError, which tells
 * the model plainly what is not there. */
export const BUNDLED_IMPORTS: Record<string, string> = {
  numpy: "numpy",
  pandas: "pandas",
  dateutil: "python-dateutil",
  pytz: "pytz",
  six: "six",
};

const MAX_STDOUT = 12_000;

/** The bundled packages a piece of code imports, by its import statements. */
export function packagesFor(code: string): string[] {
  const wanted = new Set<string>();
  for (const match of code.matchAll(/^\s*(?:from|import)\s+([A-Za-z_][\w]*)/gm)) {
    const name = BUNDLED_IMPORTS[match[1]];
    if (name) wanted.add(name);
  }
  // `import numpy as np, pandas as pd` names more than one module.
  for (const match of code.matchAll(/^\s*import\s+(.+)$/gm)) {
    for (const part of match[1].split(",")) {
      const name = BUNDLED_IMPORTS[part.trim().split(/[\s.]/)[0]];
      if (name) wanted.add(name);
    }
  }
  return [...wanted];
}

export type Runner = { run(request: WorkerRun): Promise<WorkerDone> };

/** One Pyodide, prepared once, running requests one after another. */
export function createRunner(load: () => Promise<PyodideLike>): Runner {
  let ready: Promise<PyodideLike> | null = null;
  let queue: Promise<unknown> = Promise.resolve();
  let output = "";
  const capture = (text: string) => {
    if (output.length < MAX_STDOUT) output += `${text}\n`;
  };
  const prepare = async () => {
    const pyodide = await load();
    pyodide.setStdout({ batched: capture });
    pyodide.setStderr({ batched: capture });
    await pyodide.runPythonAsync(PYTHON_PRELUDE);
    return pyodide;
  };
  const runOne = async (request: WorkerRun): Promise<WorkerDone> => {
    const files = request.files.map((file) => file.path);
    // Read by the model, not the person: the tool result carries it.
    const failed = (error: string): WorkerDone => ({
      type: "done",
      id: request.id,
      stdout: output.slice(0, MAX_STDOUT),
      result: null,
      blocks: [],
      error,
      files,
    });
    let pyodide: PyodideLike;
    try {
      ready ??= prepare();
      pyodide = await ready;
    } catch (error) {
      // Not the code's fault: start over on the next run.
      ready = null;
      return failed(`Python could not start: ${messageOf(error)}`);
    }
    try {
      pyodide.FS.mkdirTree("/data");
      for (const file of request.files) pyodide.FS.writeFile(file.path, file.text);
      const packages = packagesFor(request.code);
      if (packages.length > 0) await pyodide.loadPackage(packages);
      output = "";
      pyodide.globals.set(
        "_subrosa_request",
        JSON.stringify({ session: request.session, code: request.code }),
      );
      const raw = await pyodide.runPythonAsync("await _subrosa_run_request(_subrosa_request)");
      const parsed = JSON.parse(String(raw)) as {
        result: string | null;
        blocks: PythonBlock[];
        error: string | null;
      };
      return {
        type: "done",
        id: request.id,
        stdout: output.slice(0, MAX_STDOUT),
        result: parsed.result,
        blocks: parsed.blocks ?? [],
        error: parsed.error,
        files,
      };
    } catch (error) {
      return failed(`Python could not run: ${messageOf(error)}`);
    }
  };
  return {
    run(request) {
      const next = queue.then(() => runOne(request));
      queue = next.catch(() => undefined);
      return next;
    },
  };
}
