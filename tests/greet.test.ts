import { describe, expect, it } from "vitest";

import { greet } from "../src/index.js";

describe("greet", () => {
  it("指定した名前に親しみのある挨拶を返す", () => {
    expect(greet("Vitest")).toBe("Hello, Vitest!");
  });
});
