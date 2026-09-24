import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

// Execute the shipped, patched AudioWorklet with its real embedded WASM. Only
// the browser host/port is simulated; these assertions exercise the DSP and
// its future schedule, rather than a second implementation of the adapter.
async function processor() {
  const source = readFileSync(
    createRequire(import.meta.url).resolve("signalsmith-stretch"),
    "utf8",
  );
  let Processor;
  let ready;
  const initialized = new Promise((resolve) => {
    ready = resolve;
  });
  const sandbox = {
    console,
    WebAssembly,
    performance,
    setTimeout,
    clearTimeout,
    atob,
    sampleRate: 48000,
    currentTime: 0,
    AudioWorkletProcessor: class {
      port = {
        postMessage(message) {
          if (message[0] === "ready") ready();
        },
        onmessage: null,
      };
    },
    registerProcessor(_name, implementation) {
      Processor = implementation;
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(source.replace(/export default _export;/, ""), sandbox);
  const node = new Processor({ numberOfOutputs: 1, outputChannelCount: [1] });
  await initialized;
  let id = 0;
  const send = (name, ...args) => node.port.onmessage({ data: [id++, name, ...args] });
  return { node, send, sandbox };
}

describe("pinned Signalsmith audio worklet", () => {
  it("retains future schedule entries, renders sound only inside the scheduled window, and preserves pitch at 2x", async () => {
    const { node, send, sandbox } = await processor();
    const input = Float32Array.from(
      { length: 48000 * 3 },
      (_, i) => 0.3 * Math.sin((2 * Math.PI * 440 * i) / 48000),
    );
    send("addBuffers", [input]);
    send("schedule", {
      active: true,
      input: 0,
      output: 0.2,
      rate: 1,
      semitones: 0,
      formantCompensation: true,
    });
    send("schedule", { active: true, input: 0.4, output: 0.6, rate: 2 });
    send("schedule", { active: false, output: 1.2 });
    expect(node.timeMap.map((segment) => segment.output)).toEqual([0, 0.2, 0.6, 1.2]);
    const rendered = new Float32Array(48000 * 2);
    for (let offset = 0; offset + 128 <= rendered.length; offset += 128) {
      sandbox.currentTime = offset / 48000;
      const output = new Float32Array(128);
      node.process([[]], [[output]]);
      rendered.set(output, offset);
    }
    const rms = (from, until) =>
      Math.sqrt(
        rendered
          .slice(Math.floor(from * 48000), Math.floor(until * 48000))
          .reduce((sum, n) => sum + n * n, 0) /
          ((until - from) * 48000),
      );
    expect(rms(0, 0.1)).toBeLessThan(0.001);
    expect(rms(0.3, 0.5)).toBeGreaterThan(0.1);
    expect(rms(0.8, 1)).toBeGreaterThan(0.1);
    expect(rms(1.5, 1.8)).toBeLessThan(0.001);
    let crossings = 0;
    for (let i = Math.floor(0.8 * 48000); i < 48000; i++)
      if (rendered[i] <= 0 && rendered[i + 1] > 0) crossings++;
    expect(crossings / 0.2).toBeGreaterThan(430);
    expect(crossings / 0.2).toBeLessThan(450);
  });
});
