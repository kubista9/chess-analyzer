import { afterEach, describe, expect, it, vi } from "vitest";
import { STOCKFISH_PATH, createWorkerTransport, splitEngineOutput } from "./transport";

/** A stand-in for the browser Worker: records what the transport does with it. */
class StubWorker {
  static last: StubWorker | null = null;
  readonly posted: unknown[] = [];
  terminated = false;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: { message: string; preventDefault(): void }) => void) | null = null;
  onmessageerror: (() => void) | null = null;

  constructor(readonly url: string) {
    StubWorker.last = this;
  }

  postMessage(data: unknown): void {
    this.posted.push(data);
  }

  terminate(): void {
    this.terminated = true;
  }
}

function stubbed() {
  vi.stubGlobal("Worker", StubWorker);
  const transport = createWorkerTransport("/stockfish/test.js");
  return { transport, worker: StubWorker.last! };
}

afterEach(() => {
  vi.unstubAllGlobals();
  StubWorker.last = null;
});

describe("splitEngineOutput", () => {
  it("splits multi-line messages and drops empty lines and carriage returns", () => {
    expect(splitEngineOutput("info depth 1 score cp 10 pv e2e4\nbestmove e2e4")).toEqual(["info depth 1 score cp 10 pv e2e4", "bestmove e2e4"]);
    expect(splitEngineOutput("uciok\r\n\r\nreadyok\r\n")).toEqual(["uciok", "readyok"]);
    expect(splitEngineOutput("")).toEqual([]);
    expect(splitEngineOutput("   ")).toEqual([]);
  });

  it("ignores messages that are not strings", () => {
    expect(splitEngineOutput({ percent: 0.5 })).toEqual([]);
    expect(splitEngineOutput(undefined)).toEqual([]);
  });
});

describe("createWorkerTransport", () => {
  it("starts a classic worker from the vendored script under the base URL by default", () => {
    vi.stubGlobal("Worker", StubWorker);
    createWorkerTransport();
    expect(StubWorker.last?.url).toBe(`${import.meta.env.BASE_URL}${STOCKFISH_PATH}`);
    expect(StubWorker.last?.url).toBe("/stockfish/stockfish-19-lite-single.js");
  });

  it("posts commands as strings and delivers output line by line", () => {
    const { transport, worker } = stubbed();
    const lines: string[] = [];
    transport.onLine((line) => lines.push(line));
    transport.send("uci");
    worker.onmessage?.({ data: "id name Stockfish 19 Lite WASM\nuciok" });
    worker.onmessage?.({ data: "readyok" });
    expect(worker.posted).toEqual(["uci"]);
    expect(lines).toEqual(["id name Stockfish 19 Lite WASM", "uciok", "readyok"]);
  });

  it("reports worker errors as Error objects and keeps them out of the console", () => {
    const { transport, worker } = stubbed();
    const errors: Error[] = [];
    transport.onError((error) => errors.push(error));
    const preventDefault = vi.fn();
    worker.onerror?.({ message: "RuntimeError: unreachable", preventDefault });
    worker.onerror?.({ message: "", preventDefault });
    worker.onmessageerror?.();
    expect(preventDefault).toHaveBeenCalledTimes(2);
    expect(errors.map((error) => error.message)).toEqual([
      "The engine worker failed: RuntimeError: unreachable",
      "The engine worker failed to load or run",
      "The engine worker sent a message that could not be read"
    ]);
  });

  it("stops listening after unsubscribe, and one throwing listener does not starve the others", () => {
    const { transport, worker } = stubbed();
    const seen: string[] = [];
    const unsubscribe = transport.onLine((line) => seen.push(`a:${line}`));
    transport.onLine(() => {
      throw new Error("listener bug");
    });
    transport.onLine((line) => seen.push(`c:${line}`));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    worker.onmessage?.({ data: "one" });
    unsubscribe();
    worker.onmessage?.({ data: "two" });
    consoleError.mockRestore();
    expect(seen).toEqual(["a:one", "c:one", "c:two"]);
  });

  it("terminates the worker once and goes quiet afterwards", () => {
    const { transport, worker } = stubbed();
    const lines: string[] = [];
    const errors: Error[] = [];
    transport.onLine((line) => lines.push(line));
    transport.onError((error) => errors.push(error));
    transport.terminate();
    transport.terminate();
    transport.send("isready");
    worker.onmessage?.({ data: "readyok" });
    worker.onerror?.({ message: "late", preventDefault: () => undefined });
    expect(worker.terminated).toBe(true);
    expect(worker.posted).toEqual([]);
    expect(lines).toEqual([]);
    expect(errors).toEqual([]);
  });
});
