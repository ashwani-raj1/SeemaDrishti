import { describe, expect, test } from "bun:test";
import { formatPlate } from "../src/lib/format";
import { canUse, type SectionMeta } from "../src/features/sections";

describe("watchlist section meta & role permissions", () => {
  const watchlistMeta: SectionMeta = {
    id: "watchlist",
    group: "Configure",
    minRole: "supervisor",
  };

  test("operator cannot access watchlist section", () => {
    expect(canUse(watchlistMeta, "operator")).toBe(false);
  });

  test("supervisor and admin can access watchlist section", () => {
    expect(canUse(watchlistMeta, "supervisor")).toBe(true);
    expect(canUse(watchlistMeta, "admin")).toBe(true);
  });
});

describe("license plate formatting in frontend", () => {
  test("formats unspaced plate strings into standard Indian format", () => {
    expect(formatPlate("PB02AK4821")).toBe("PB 02 AK 4821");
    expect(formatPlate("hr26dq5512")).toBe("HR 26 DQ 5512");
    expect(formatPlate("PB02T9182")).toBe("PB 02 T 9182");
  });

  test("handles empty or irregular strings gracefully", () => {
    expect(formatPlate("")).toBe("");
    expect(formatPlate("ABC")).toBe("ABC");
  });
});
