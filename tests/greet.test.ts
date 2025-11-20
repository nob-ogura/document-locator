import { describe, expect, it } from "vitest";

import { greet } from "../src/index.js";

describe("greet", () => {
  it("returns a friendly greeting for the given name", () => {
    expect(greet("Vitest")).toBe("Hello, Vitest!");
  });
});
