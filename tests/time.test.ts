import { describe, expect, it } from "vitest";

import { isAfter, toDate, toRFC3339 } from "../src/time.js";

describe("time helpers", () => {
  it("RFC3339 文字列を Date に変換して元に戻せる", () => {
    const isoString = "2024-09-01T10:00:00Z";

    const date = toDate(isoString);
    const roundTripped = toRFC3339(date);

    expect(roundTripped).toBe(isoString);
  });

  it("modifiedTime 比較ヘルパーが新旧を判定できる", () => {
    const earlier = "2024-09-01T09:00:00Z";
    const later = "2024-09-01T10:00:00Z";

    expect(isAfter(later, earlier)).toBe(true);
    expect(isAfter(earlier, later)).toBe(false);
  });

  it("指定したタイムゾーンで RFC3339 文字列へ変換できる", () => {
    const utcDate = toDate("2024-09-01T10:00:00Z");

    const tokyo = toRFC3339(utcDate, "Asia/Tokyo");

    expect(tokyo).toBe("2024-09-01T19:00:00+09:00");
  });
});
