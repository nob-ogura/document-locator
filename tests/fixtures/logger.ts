import { vi } from "vitest";

export const createTestLogger = () => ({
  debug: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
});
