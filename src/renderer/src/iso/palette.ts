// One limited palette for the whole world, in the spirit of 90s isometric sims.
import type { Species } from "../../../shared/types";

export const INK = "#2b2233";

export const P = {
  grassA: "#5d9f4c",
  grassB: "#65a952",
  grassDark: "#4c8a40",
  grassLight: "#7cc262",
  blade: "#8fd06c",
  pathA: "#cfae76",
  pathB: "#c4a16a",
  pathDark: "#a8865a",
  pathLight: "#e2c894",
  soil: "#5a3a28",
  soilDark: "#472d1f",
  soilLight: "#76503a",
  loose: "#8a5f42",
  woodTop: "#c98a52",
  woodLeft: "#a8683c",
  woodRight: "#87502e",
  woodDark: "#6b3d22",
  woodLight: "#dba26a",
  cliffLeft: "#8a5a3a",
  cliffRight: "#6f4530",
  cliffStrata: "#a06c46",
  cliffDark: "#583624",
  fence: "#f3efe2",
  fenceShade: "#c7bea6",
  mulch: "#e3c47a",
  mulchDark: "#bf9d55",
  bamboo: "#d8c27a",
  bambooDark: "#a8924e",
  twine: "#8a6a44",
  glass: "#bfe6ee",
  glassDark: "#8fc4d2",
  glassLight: "#e6f8fb",
  frame: "#f2f2ea",
  frameDark: "#b9c2bd",
  trunk: "#7a4a2c",
  leafA: "#3f8f3f",
  leafB: "#2f7434",
  leafC: "#5cae4a",
  leafD: "#80c95c",
  water: "#6fc3ea",
  waterLight: "#bfeaff",
  can: "#5f9fb6",
  canDark: "#3f7790",
  bee: "#f5c431",
  white: "#ffffff",
  amber: "#f2b33d",
  amberDark: "#b97d14",
  red: "#e0533f",
  gold: "#ffe27a",
  sparkle: "#fff6b0",
  root: "#f6dc9a",
  cloud: "#ffffff",
  cloudShade: "#d6e6f2",
  rain: "#8fa6c8",
  storm: "#8a94a8",
  stormDark: "#6a7488",
  pot: "#c8643c",
  potDark: "#9a4a2a",
  potLight: "#e8936a",
  paper: "#f6f0dc",
  paperShade: "#c9bf9e",
  notch: "#d9eaa0",
  wicker: "#d8a656",
  wickerDark: "#a8743a",
  passing: "#3fbf4f",
  pending: "#f2b33d",
  failing: "#e0533f",
  awning: "#e0533f",
};

/** The bed's mood, shown as the signpost flag and the block colour in the map view. */
export const MOOD_COLOR = { fallow: "#b8a888", sown: "#8fd06c", growing: "#5fb4ec", tending: "#f2b33d", harvest: "#ffe27a" } as const;

export interface SpeciesStyle {
  petal: string;
  petalDark: string;
  petalLight: string;
  center: string;
}

export const SPECIES_STYLE: Record<Species, SpeciesStyle> = {
  sunflower: { petal: "#ffd23f", petalDark: "#e89c1c", petalLight: "#fff08a", center: "#6b3f1f" },
  tulip: { petal: "#ff6f9f", petalDark: "#d6406f", petalLight: "#ffb3cd", center: "#ffe066" },
  daisy: { petal: "#ffffff", petalDark: "#c9cde0", petalLight: "#ffffff", center: "#ffbd2e" },
  rose: { petal: "#ec3d54", petalDark: "#a8203a", petalLight: "#ff7f8e", center: "#7a1428" },
  lavender: { petal: "#a98ce0", petalDark: "#7b5fc0", petalLight: "#d0bff5", center: "#a98ce0" },
  poppy: { petal: "#ff7a3a", petalDark: "#d4501a", petalLight: "#ffb07a", center: "#2b2233" },
};

export const WILTED: SpeciesStyle = { petal: "#a68458", petalDark: "#7d5f3c", petalLight: "#c4a679", center: "#5a4028" };

/** An ended volunteer: its terminal session is over. */
export const FADED: SpeciesStyle = { petal: "#d8d2c4", petalDark: "#aaa394", petalLight: "#eeeae0", center: "#9a9282" };

export const SPECIES_NAME: Record<Species, string> = {
  sunflower: "Sunflower",
  tulip: "Tulip",
  daisy: "Daisy",
  rose: "Rose",
  lavender: "Lavender",
  poppy: "Poppy",
};

export interface LeafStyle {
  stem: string;
  stemDark: string;
  leaf: string;
  leafDark: string;
  leafLight: string;
}

export const LEAF: LeafStyle = { stem: "#3b8a3f", stemDark: "#2b6a33", leaf: "#4fa64a", leafDark: "#2f7a3a", leafLight: "#7fcc5c" };
export const LEAF_WILTED: LeafStyle = { stem: "#7b7a3a", stemDark: "#5e5c2a", leaf: "#8d8a42", leafDark: "#6a682e", leafLight: "#aaa660" };

export const LEAF_FADED: LeafStyle = { stem: "#8a9a7a", stemDark: "#6e7c60", leaf: "#9cab8a", leafDark: "#7a8a6a", leafLight: "#b8c4a6" };

export type Phase = "dawn" | "day" | "dusk" | "night";

/** Sky bands from top to horizon, drawn with dithered seams. */
export const SKY: Record<Phase, string[]> = {
  dawn: ["#7f8fc9", "#c49ac0", "#f2b8a8", "#ffd9b0"],
  day: ["#5fb4ec", "#7cc6f2", "#a2d8f6", "#c8eafa"],
  dusk: ["#3f3f8a", "#7a4f98", "#d0708a", "#f6a87a"],
  night: ["#0f1530", "#17204a", "#212c60", "#2c3a72"],
};

/** Light over the world, applied on top of everything that is not sky. */
export const TINT: Record<Phase, string | null> = {
  dawn: "rgba(255, 170, 140, 0.16)",
  day: null,
  dusk: "rgba(140, 70, 140, 0.24)",
  night: "rgba(18, 26, 80, 0.52)",
};
