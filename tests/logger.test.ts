import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createLogger } from "../src/logger.js";

describe("logger", () => {
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  it("LOG_LEVEL=info では info ログが 1 行でメッセージとコンテキストを JSON 出力する", () => {
    const logger = createLogger("info");

    logger.info("crawler started", { files: 10 });

    expect(stdoutSpy).toHaveBeenCalledTimes(1);
    const [output] = stdoutSpy.mock.calls[0];

    expect(output.endsWith("\n")).toBe(true);
    expect(output.slice(0, -1)).not.toContain("\n");
    expect(output).toContain('"level":"info"');
    expect(output).toContain('"message":"crawler started"');
    expect(output).toContain('"context":{"files":10}');
  });

  it("LOG_LEVEL=info では debug ログが出力されない", () => {
    const logger = createLogger("info");

    logger.debug("verbose detail");

    expect(stdoutSpy).not.toHaveBeenCalled();
    expect(stderrSpy).not.toHaveBeenCalled();
  });
});
