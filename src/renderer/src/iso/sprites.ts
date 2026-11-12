// Hand-placed pixels. Each map is drawn with a palette; '.' is transparent.
import type { Activity } from "../../../shared/types";
import { INK, P } from "./palette";
import type { Palette, PixelMap } from "./raster";

// ---------- the gardener (11 x 22) ----------

const GARDENER_TOP = [
  "...kkkkk...",
  "..khhhhhk..",
  "..khhhhHk..",
  ".krrrrrrrk.",
  "khhhhhhhhHk",
  ".kkkkkkkkk.",
];

const FACE = ["..kSsssSk..", "..ksesesk..", "..kssssSk..", "...kkkkk..."];
const NAPE = ["..kSSSSSk..", "..kSSSSSk..", "..kSSSSSk..", "...kkkkk..."];

const BODY_FRONT = [
  "..kwwwwwk..",
  ".kwowwwowk.",
  ".kwoooooWk.",
  "kswoooooWsk",
  "kskoooooksk",
  "..kooOook..",
  "..kooOook..",
];
const BODY_BACK = [
  "..kwwwwwk..",
  ".kwwowowwk.",
  ".kwoooooWk.",
  "kswoooooWsk",
  "kskoooooksk",
  "..kooOook..",
  "..kooOook..",
];

const LEGS_STAND = ["..koo.ook..", "..koo.ook..", "..kbb.bbk..", ".kbbb.bbbk.", ".kkkk.kkkk."];
const LEGS_WALK = ["..koo.ook..", ".koo...ook.", ".kbb...bbk.", "kbbbk..kbbk", "kkkk....kk."];
const mirror = (rows: string[]) => rows.map((r) => [...r].reverse().join(""));

export const GARDENER = {
  front: [
    [...GARDENER_TOP, ...FACE, ...BODY_FRONT, ...LEGS_STAND],
    [...GARDENER_TOP, ...FACE, ...BODY_FRONT, ...LEGS_WALK],
    [...GARDENER_TOP, ...FACE, ...BODY_FRONT, ...mirror(LEGS_WALK)],
  ],
  back: [
    [...GARDENER_TOP, ...NAPE, ...BODY_BACK, ...LEGS_STAND],
    [...GARDENER_TOP, ...NAPE, ...BODY_BACK, ...LEGS_WALK],
    [...GARDENER_TOP, ...NAPE, ...BODY_BACK, ...mirror(LEGS_WALK)],
  ],
};

export const GARDENER_PAL: Palette = {
  k: INK,
  h: "#f2c94c",
  H: "#c9962e",
  r: "#d9473f",
  s: "#f5c79a",
  S: "#d99a6c",
  e: INK,
  w: "#f4efe0",
  W: "#cfc6b0",
  o: "#3f8f4f",
  O: "#2e6a3a",
  b: "#6b3f24",
};

// ---------- critters and tools ----------

export const BEE: PixelMap = [".ww..", "ykykk", ".yky."];
export const BEE_PAL: Palette = { w: "#ffffff", y: P.bee, k: INK };

export const BUTTERFLY: PixelMap[] = [
  ["p...p", "pp.pp", ".pkp.", "p.k.p"],
  [".p.p.", ".pkp.", "..k..", "....."],
];

export const CAN: PixelMap = [".kkk.....", "k...k....", "kbbbbk..k", "kbbbbkkbk", "kbbbbbbk.", "kBBBBk...", ".kkkk...."];
export const CAN_PAL: Palette = { k: INK, b: P.can, B: P.canDark };

export const WEED: PixelMap = [".g...g.", ".gg.gg.", "..ggg..", "g.gGg.g", "ggGgGg.", "..g.g.."];
export const WEED_PAL: Palette = { g: "#8a9a3a", G: "#6a7a2a" };

export const RAINCLOUD: PixelMap = ["...kkk.....", ".kkcccckk..", "kcccccccck.", "kcCCCCCCck.", ".kkkkkkkk.."];
export const RAINCLOUD_PAL: Palette = { k: P.stormDark, c: P.storm, C: P.stormDark };

export const SHOVEL: PixelMap = ["....kk", "...kwk", "..kwk.", ".kwk..", "kmmk..", "kmmk..", ".kk..."];
export const SHOVEL_PAL: Palette = { k: INK, w: "#a8683c", m: "#b9c2c8" };

// ---------- flower heads (anchored at their centre) ----------

export const HEADS: Record<string, PixelMap> = {
  sunflower: ["..pLpLp..", ".pdpppdp.", "pppcccppp", "LpcCcCcpL", "ppcccccpp", "dpcCcCcpd", "pppcccppp", ".pdpppdp.", "..pdpdp.."],
  daisy: ["...pLp...", ".p.pLp.p.", "..ppLpp..", "pppcccppp", "LLpcCcpLL", "pppcccppp", "..ppdpp..", ".p.pdp.p.", "...pdp..."],
  poppy: ["..pp.pp..", ".pLpppLp.", "pLpppppdp", "ppppcpppp", "pppcCcppd", "ppppcpppd", ".ppppppd.", "..pdpdd.."],
  tulip: ["p..L..p", "pp.p.pp", "pLpppdp", "pLppppd", "ppppppd", ".ppppd.", ".dpppd.", "..ddd.."],
  rose: ["..ddd..", ".dLppd.", "dLpccpd", "dpcLcpd", "dpccppd", ".dpppd.", "..ddd.."],
  lavender: ["..L..", ".pdp.", "..p..", ".dpd.", ".pLp.", "..d..", ".pdp.", ".dpd.", "..p..", ".pdp.", "..d.."],
};

export const BUD: PixelMap = ["..p..", ".pLp.", ".gpg.", "ggpgg", ".ggg.", "..g.."];
export const LAVENDER_BUD: PixelMap = [".g.", "gdg", ".g.", "gdg", ".g.", "gdg", ".g."];

// ---------- thought bubbles (7 x 7 icons) ----------

export const ICONS: Record<string, PixelMap> = {
  think: [".......", ".......", ".......", "k.k.k..", ".......", ".......", "......."],
  read: [".......", "kk...kk", "kwk.kwk", "kwwkwwk", "kwwkwwk", "kkkkkkk", "......."],
  search: [".kkk...", "kwwwk..", "kwwwk..", "kwwwk..", ".kkkk..", "....kk.", ".....kk"],
  edit: [".....rr", "....kyr", "...kyk.", "..kyk..", ".kyk...", "kkk....", "k......"],
  run: ["kkkkkkk", "kbbbbbk", "kgbbbbk", "kbgbbbk", "kgbggbk", "kbbbbbk", "kkkkkkk"],
  web: ["..kkk..", ".kbgbk.", "kggbbgk", "kbgggbk", "kbbggbk", ".kbgbk.", "..kkk.."],
  delegate: [".......", ".g...g.", "ggg.ggg", ".g...g.", ".g...g.", "kkkkkkk", "......."],
  todo: [".......", "g.kkkkk", ".......", "g.kkkkk", ".......", "w.kkkkk", "......."],
  plan: ["k.k.k.k", "kkkkkkk", "k.k.k.k", "kkkkkkk", "k.k.k.k", "kkkkkkk", "k.k.k.k"],
  other: [".......", "..kkk..", ".k...k.", ".k.k.k.", ".k...k.", "..kkk..", "......."],
  waiting: ["..kk...", "..kk...", "..kk...", "..kk...", ".......", "..kk...", "..kk..."],
  question: [".kkkk..", "kk..kk.", "....kk.", "...kk..", "..kk...", ".......", "..kk..."],
  plan_ask: ["kkkkk..", "kwwwkk.", "kwkkwk.", "kwwwwk.", "kwkkwk.", "kwwwwk.", "kkkkkk."],
  error: [".......", "kk...kk", ".kk.kk.", "..kkk..", ".kk.kk.", "kk...kk", "......."],
  harvest: [".rr.rr.", "rrrrrrr", "rrrrrrr", ".rrrrr.", "..rrr..", "...r...", "......."],
  queued: ["kkkk...", "..k....", ".k.....", "kkkk...", "...kkk.", "....k..", "...kkk."],
};

export const ICON_PAL: Palette = {
  k: INK,
  w: "#ffffff",
  y: "#f2c94c",
  r: "#e0533f",
  g: "#3f9a48",
  b: "#2f3550",
};

export type BubbleKind = Activity | "waiting" | "question" | "plan_ask" | "error" | "harvest" | "queued";

export const BUBBLE_FILL: Record<string, string> = {
  waiting: P.amber,
  question: P.amber,
  plan_ask: P.amber,
  error: "#ff9a86",
  harvest: "#fff1a8",
  queued: "#d6e6f2",
};

// ---------- V2 props: pots, baskets, wild flowers, puffs ----------

/** Terracotta pot, 9 x 6, bottom row on the soil. */
export const POT: PixelMap = ["kkkkkkkkk", "kLLLLLLDk", ".kpppppk.", ".kpppDpk.", ".kppppDk.", "..kkkkk.."];
export const POT_PAL: Palette = { k: INK, L: P.potLight, p: P.pot, D: P.potDark };

/** Harvest basket with produce, 7 x 6. */
export const BASKET: PixelMap = ["..kkk..", ".k...k.", "krgyrgk", "kwWwWwk", ".kWwWk.", "..kkk.."];
export const BASKET_PAL: Palette = { k: INK, r: "#e0533f", g: "#5cae4a", y: "#ffd23f", w: P.wicker, W: P.wickerDark };

/** A wild flower head (volunteers), 5 x 5. */
export const WILD: PixelMap = [".p.p.", "pLpLp", ".pcp.", "pLpdp", ".p.d."];

/** Seed tray with packets, 12 x 6. */
export const TRAY: PixelMap = ["..aa.bb.cc..", "..aa.bb.cc..", "kkkkkkkkkkkk", "kwwwwwwwwwwk", "kWWWWWWWWWWk", ".kkkkkkkkkk."];
export const TRAY_PAL: Palette = { k: INK, w: P.woodTop, W: P.woodRight, a: "#ffd23f", b: "#ff8fb1", c: "#fbf4e3" };

/** Teleport puff, 3 frames of 9 x 7. */
export const PUFF: PixelMap[] = [
  ["....w....", "...www...", "..wwWww..", ".wwWWWww.", "..wwWww..", "...www...", "....w...."],
  ["..w...w..", ".ww.w.ww.", "w..www..w", ".wwW.Www.", "w..www..w", ".ww.w.ww.", "..w...w.."],
  ["w...w...w", ".........", "..w...w..", "w...W...w", "..w...w..", ".........", "w...w...w"],
];
export const PUFF_PAL: Palette = { w: "#ffffff", W: "#d6e6f2" };
