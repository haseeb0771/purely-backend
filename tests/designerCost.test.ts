import { describe, expect, it } from "vitest";
import {
  computeDesignerCharge,
  monthKeyForDate,
  monthRangeFor,
  normalizeMonthKey,
  shiftMonthKey,
} from "../src/utils/designerCost";

describe("designer cost helpers", () => {
  it("charges Rs. 500 per distinct label size", () => {
    expect(computeDesignerCharge(0)).toBe(0);
    expect(computeDesignerCharge(1)).toBe(500);
    expect(computeDesignerCharge(2)).toBe(1000);
    expect(computeDesignerCharge(4)).toBe(2000);
  });

  it("groups dates by the Asia/Karachi month", () => {
    expect(monthKeyForDate(new Date("2026-10-31T18:59:59.000Z"))).toBe(
      "2026-10"
    );
    expect(monthKeyForDate(new Date("2026-10-31T19:00:00.000Z"))).toBe(
      "2026-11"
    );
    expect(monthKeyForDate(new Date("2026-11-30T18:59:59.000Z"))).toBe(
      "2026-11"
    );
  });

  it("returns UTC boundaries for a Pakistan calendar month", () => {
    const { start, end } = monthRangeFor("2026-11");
    expect(start.toISOString()).toBe("2026-10-31T19:00:00.000Z");
    expect(end.toISOString()).toBe("2026-11-30T19:00:00.000Z");
  });

  it("validates and shifts month keys", () => {
    expect(normalizeMonthKey("2026-11")).toBe("2026-11");
    expect(normalizeMonthKey("2026-13")).toBeNull();
    expect(normalizeMonthKey("not-a-month")).toBeNull();
    expect(shiftMonthKey("2026-12", 1)).toBe("2027-01");
    expect(shiftMonthKey("2026-01", -1)).toBe("2025-12");
  });
});
