import { describe, expect, it } from "vitest";
import { barHeights, diffBar, duration, explainGitError, fillDays, money, splitRows, tagCovers, tagHunk, tokens, type Block } from "./format";

describe("numbers", () => {
  it("formats cost with two decimals and a floor", () => {
    expect(money(0)).toBe("$0.00");
    expect(money(0.004)).toBe("<$0.01");
    expect(money(0.01)).toBe("$0.01");
    expect(money(1234.5)).toBe("$1,234.50");
    expect(money(undefined)).toBe("—");
  });
  it("formats tokens as k/M", () => {
    expect(tokens(999)).toBe("999");
    expect(tokens(12_345)).toBe("12.3k");
    expect(tokens(4_500_000)).toBe("4.5M");
    expect(tokens(2_000)).toBe("2k");
  });
  it("formats durations", () => {
    expect(duration(42_000)).toBe("42s");
    expect(duration(185_000)).toBe("3m 05s");
    expect(duration(3_720_000)).toBe("1h 02m");
  });
});

describe("diffBar", () => {
  it("is proportional to the biggest change and capped", () => {
    expect(diffBar(100, 0, 100, 20)).toEqual({ plus: 20, minus: 0 });
    expect(diffBar(50, 50, 200, 20)).toEqual({ plus: 5, minus: 5 });
    expect(diffBar(5000, 0, 100, 20)).toEqual({ plus: 20, minus: 0 });
  });
  it("always shows both sides when both changed", () => {
    expect(diffBar(1000, 1, 1001, 20)).toEqual({ plus: 19, minus: 1 });
    expect(diffBar(1, 1, 10_000, 20)).toEqual({ plus: 1, minus: 1 });
    expect(diffBar(0, 0, 10)).toEqual({ plus: 0, minus: 0 });
  });
});

describe("barHeights", () => {
  it("uses whole pixels and keeps tiny values visible", () => {
    expect(barHeights([0, 1, 50, 100], 120)).toEqual([0, 1, 60, 120]);
    expect(barHeights([0.001, 1000], 100)).toEqual([1, 100]);
    expect(barHeights([0, 0], 100)).toEqual([0, 0]);
  });
});

describe("fillDays", () => {
  it("fills missing local days, oldest first", () => {
    const out = fillDays([{ day: "2026-11-10", v: 3 }], 3, new Date(2026, 10, 11), (day) => ({ day, v: 0 }));
    expect(out).toEqual([
      { day: "2026-11-09", v: 0 },
      { day: "2026-11-10", v: 3 },
      { day: "2026-11-11", v: 0 },
    ]);
  });
  it("crosses month boundaries", () => {
    expect(fillDays([], 2, new Date(2026, 2, 1), (day) => ({ day })).map((d) => d.day)).toEqual(["2026-02-28", "2026-03-01"]);
  });
});

const block: Block = {
  oldStartLine: 10,
  newStartLine: 10,
  header: "@@ -10,5 +10,5 @@",
  lines: [
    { type: "context", oldNumber: 10, newNumber: 10, content: " a" },
    { type: "delete", oldNumber: 11, content: "-b" },
    { type: "delete", oldNumber: 12, content: "-c" },
    { type: "insert", newNumber: 11, content: "+B" },
    { type: "context", oldNumber: 13, newNumber: 12, content: " d" },
    { type: "insert", newNumber: 13, content: "+e" },
  ],
};

describe("tagHunk", () => {
  it("rebuilds a mixed selection with correct counts", () => {
    const t = tagHunk(block, 0, 4);
    expect(t.hunk).toBe("@@ -10,4 +10,3 @@\n a\n-b\n-c\n+B\n d");
    expect([t.startLine, t.endLine]).toEqual([10, 12]);
  });
  it("accepts a reversed range", () => {
    expect(tagHunk(block, 4, 0).hunk).toBe(tagHunk(block, 0, 4).hunk);
  });
  it("uses old-file lines when only deletions are selected", () => {
    const t = tagHunk(block, 1, 2);
    expect(t.hunk).toBe("@@ -11,2 +10,0 @@\n-b\n-c");
    expect([t.startLine, t.endLine]).toEqual([11, 12]);
  });
  it("anchors an insert-only selection after the previous old line", () => {
    const t = tagHunk(block, 5, 5);
    expect(t.hunk).toBe("@@ -13,0 +13,1 @@\n+e");
    expect([t.startLine, t.endLine]).toEqual([13, 13]);
  });
  it("marks the lines a tag covers", () => {
    const t = tagHunk(block, 3, 4);
    expect(block.lines.map((l) => tagCovers(t, l))).toEqual([false, false, false, true, true, false]);
    const dels = tagHunk(block, 1, 2);
    expect(block.lines.map((l) => tagCovers(dels, l))).toEqual([false, true, true, false, false, false]);
  });
});

describe("splitRows", () => {
  it("pairs deletions with the insertions after them", () => {
    expect(splitRows(block.lines)).toEqual([
      { left: 0, right: 0 },
      { left: 1, right: 3 },
      { left: 2, right: undefined },
      { left: 4, right: 4 },
      { left: undefined, right: 5 },
    ]);
  });
});

describe("explainGitError", () => {
  it("recognises common push failures", () => {
    expect(explainGitError("! [rejected] main -> main (fetch first)")).toMatch(/commits this one doesn't/);
    expect(explainGitError("fatal: Authentication failed for 'https://github.com/x/y'")).toMatch(/log in/);
    expect(explainGitError("something odd")).toBe("Git stopped with the message above.");
  });
});
