import { describe, expect, it } from "vitest";
import { parseStatus } from "./soil";

describe("parseStatus", () => {
  it("reads branch, ahead/behind and dirty count", () => {
    expect(parseStatus("## main...origin/main [ahead 2, behind 1]\n M src/a.ts\n?? new.txt\n")).toEqual({ branch: "main", dirty: 2, ahead: 2, behind: 1 });
  });
  it("handles a fresh repo and a detached head", () => {
    expect(parseStatus("## No commits yet on trunk\n").branch).toBe("trunk");
    expect(parseStatus("## HEAD (no branch)\n").branch).toBe("detached");
  });
});
