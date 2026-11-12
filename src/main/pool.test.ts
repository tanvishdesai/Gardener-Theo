import { describe, expect, it } from "vitest";
import { canAdmit, ceiling, memoryFloor, parseProcessTable, reapOrder, treeSizes } from "./pool";

const GB = 1024 ** 3;
const MB = 1024 ** 2;

describe("process pool admission (memory based)", () => {
  it.each([
    // free, total, estimate, live, userMax, expected
    ["the first user's machine right now", 4.4 * GB, 15.7 * GB, 600 * MB, 0, undefined, 3],
    ["same machine with apps closed", 11 * GB, 15.7 * GB, 600 * MB, 0, undefined, 14],
    ["memory below the floor, nothing live: still one", 1 * GB, 16 * GB, 600 * MB, 0, undefined, 1],
    ["memory below the floor, one live: none", 1 * GB, 16 * GB, 600 * MB, 1, undefined, 0],
    ["user maximum caps it", 30 * GB, 32 * GB, 600 * MB, 2, 4, 2],
    ["ceiling caps a huge machine", 60 * GB, 64 * GB, 600 * MB, 102, undefined, 0],
    ["bigger sessions fit fewer", 8 * GB, 16 * GB, 1.2 * GB, 1, undefined, 4],
  ])("%s", (_name, free, total, estimate, live, userMax, expected) => {
    expect(canAdmit({ free, total, estimate, live, userMax })).toBe(expected);
  });

  it("floor and ceiling follow the machine", () => {
    expect(memoryFloor(8 * GB)).toBe(2 * GB);
    expect(memoryFloor(32 * GB)).toBeCloseTo(4.8 * GB);
    expect(ceiling(15.7 * GB, 600 * MB)).toBe(19);
    expect(ceiling(4 * GB, 600 * MB)).toBe(2);
  });

  it("reaps the longest-idle plant first and never a busy one", () => {
    expect(
      reapOrder([
        { id: "a", busy: false, idleSince: 300 },
        { id: "b", busy: true, idleSince: 100 },
        { id: "c", busy: false, idleSince: 200 },
      ]),
    ).toEqual(["c", "a"]);
  });
});

describe("process table parsing", () => {
  it("reads Windows CIM csv and sums process trees", () => {
    const csv = ['"ProcessId","ParentProcessId","WorkingSetSize"', '"10","1","100"', '"11","10","50"', '"12","11","25"', '"20","1","999"'].join("\r\n");
    const rows = parseProcessTable(csv, "csv");
    expect(rows).toHaveLength(4);
    expect(treeSizes(rows, [10, 99]).get(10)).toBe(175);
    expect(treeSizes(rows, [10, 99]).has(99)).toBe(false);
  });

  it("reads ps output in KB", () => {
    expect(parseProcessTable("  5   1  2048\n  6 5 1024\n", "ps")).toEqual([
      { pid: 5, ppid: 1, bytes: 2048 * 1024 },
      { pid: 6, ppid: 5, bytes: 1024 * 1024 },
    ]);
  });
});
