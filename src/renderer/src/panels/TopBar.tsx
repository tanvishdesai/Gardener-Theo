import { useState } from "react";
import type { Plant, PoolInfo, Weather } from "../../../shared/types";
import { focus, getState, isGrowing, isHarvest, nextNeedingYou, openSow, setState, setView, useGarden } from "../store";
import { Window } from "./v2/ui";

/** Where the demo sends people for the source and the desktop app. Keep in step with the git remote. */
const GITHUB_URL = "https://github.com/tanvishdesai/Terrarium-TD";

const RELEASES_URL = `${GITHUB_URL}/releases/latest`;

/** Desktop builds on the latest GitHub Release. Version-free names (electron-builder.yml) keep these links stable. */
const DOWNLOADS = [
  { os: "windows", name: "Windows", detail: "10 / 11, x64 installer", file: "Terrarium-Setup-x64.exe", note: 'Unsigned: SmartScreen says "Windows protected your PC". Click More info, then Run anyway.' },
  { os: "mac", name: "macOS", detail: "Apple Silicon", file: "Terrarium-mac-arm64.dmg", note: "Unsigned: open it once, then System Settings, Privacy & Security, Open Anyway." },
  { os: "linux", name: "Linux", detail: "x64 AppImage", file: "Terrarium-linux-x86_64.AppImage", note: "Unsigned: chmod +x the AppImage, then run it." },
] as const;

function visitorOs(): (typeof DOWNLOADS)[number]["os"] {
  const p = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform || navigator.userAgent;
  if (/win/i.test(p)) return "windows";
  if (/mac|iphone|ipad/i.test(p)) return "mac";
  return /linux|x11|cros/i.test(p) ? "linux" : "windows";
}

/** The web demo's way to the desktop app: the visitor's OS first, the other two below. */
function DownloadWindow({ onClose }: { onClose(): void }) {
  const os = visitorOs();
  const mine = DOWNLOADS.find((d) => d.os === os)!;
  const others = DOWNLOADS.filter((d) => d !== mine);
  const link = (d: (typeof DOWNLOADS)[number], primary: boolean) => (
    <a key={d.os} className={`btn download__btn ${primary ? "btn--primary" : "btn--ghost"}`} href={`${GITHUB_URL}/releases/latest/download/${d.file}`}>
      <span>Download for {d.name}</span>
      <span className="download__detail">{d.detail}</span>
    </a>
  );
  return (
    <Window title="Get Terrarium" sub="The desktop app, for your own repos" onClose={onClose}>
      <div className="v2-scroll download">
        {link(mine, true)}
        <p className="download__note">{mine.note}</p>
        <div className="download__others">{others.map((d) => link(d, false))}</div>
        <p>Needs Claude Code installed and logged in.</p>
        <p>
          <a href={RELEASES_URL} target="_blank" rel="noreferrer">
            All releases & install notes
          </a>
        </p>
        <p className="download__foot">
          <a href={GITHUB_URL} target="_blank" rel="noreferrer">
            ★ Star on GitHub
          </a>
          <span>
            Built by{" "}
            <a href="https://tanvish-port.vercel.app" target="_blank" rel="noreferrer">
              Tanvish Desai
            </a>
          </span>
        </p>
      </div>
    </Window>
  );
}

let lastCycled: string | undefined;

/** Visit the next plant in a list, so repeated clicks walk the gardener down the row. */
function cycle(ids: string[]) {
  if (!ids.length) return;
  const next = ids[(ids.indexOf(lastCycled ?? "") + 1) % ids.length];
  lastCycled = next;
  focus("plant", next);
}

const idsWhere = (pred: (p: Plant) => boolean) =>
  Object.values(getState().plants)
    .filter(pred)
    .sort((a, b) => a.createdAt - b.createdAt)
    .map((p) => p.id);

const gb = (b: number) => `${(b / 1024 ** 3).toFixed(1)} GB`;
const mb = (b: number) => `${Math.round(b / 1024 ** 2)} MB`;

export function poolLabel(pool: PoolInfo): { text: string; short: string; tip: string } {
  const room = pool.live + pool.canAdmit;
  // "~" reads as a minus sign in the pixel fonts ("Pots 0 of -1"), so the estimate is spelled out.
  const text = `Pots ${pool.live} of about ${room}${pool.queued ? ` · ${pool.queued} waiting` : ""}`;
  const short = `Pots ${pool.live}/${room}${pool.queued ? ` +${pool.queued}` : ""}`;
  const decided = pool.userMax !== undefined ? `capped at ${pool.userMax} in Settings` : "decided by this machine's memory";
  return { text, short, tip: `${text}: ${gb(pool.freeBytes)} free · about ${mb(pool.perProcessBytes)} per agent · ${decided}` };
}

const LIMIT_NAME: Record<string, string> = { five_hour: "5-hour", seven_day: "weekly", seven_day_opus: "weekly Opus" };

export function weatherLabel(w: Weather | undefined): string | null {
  if (!w || w.status === "clear") return null;
  const reset = w.resetsAt ? new Date(w.resetsAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : null;
  if (w.status === "rain") return `Rain: usage limit reached${reset ? ` · resets ${reset}` : ""}`;
  const pct = w.utilization !== undefined ? `${Math.round(w.utilization * 100)}% of your ` : "close to your ";
  return `Clouds: ${pct}${LIMIT_NAME[w.limitType ?? ""] ?? w.limitType ?? "usage"} limit used`;
}

/** Compact weather chip for narrow windows; the full sentence stays in the tooltip. */
export function weatherShort(w: Weather | undefined): string | null {
  if (!w || w.status === "clear") return null;
  const reset = w.resetsAt ? new Date(w.resetsAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : null;
  if (w.status === "rain") return `Limit hit${reset ? ` · ${reset}` : ""}`;
  return w.utilization !== undefined ? `Limit ${Math.round(w.utilization * 100)}%` : "Near limit";
}

export function TopBar({ onAddBed }: { onAddBed(): void }) {
  const demo = useGarden((s) => s.demo);
  const hasBeds = useGarden((s) => s.beds.length > 0);
  const needy = useGarden((s) => s.counts.needsYou);
  const harvest = useGarden((s) => s.counts.harvest);
  const growing = useGarden((s) => s.counts.growing);
  const pool = useGarden((s) => s.pool);
  const weather = useGarden((s) => s.weather);
  const catalogueOpen = useGarden((s) => s.catalogueOpen);
  const almanac = useGarden((s) => s.view.almanac);
  const settings = useGarden((s) => s.view.settings);
  const sky = weatherLabel(weather);
  const pots = poolLabel(pool);
  const [download, setDownload] = useState(false);

  return (
    <header className={`topbar ${demo ? "topbar--demo" : ""}`}>
      <div className="brand">
        <svg width="24" height="24" viewBox="0 0 12 12" shapeRendering="crispEdges" aria-hidden>
          <path fill="#2b2233" d="M5 4h2v8H5zM1 2h3v1H1zM0 3h1v2H0zM1 5h3v1H1zM4 3h1v2H4zM8 1h3v1H8zM11 2h1v2h-1zM8 4h3v1H8zM7 2h1v2H7z" />
          <path fill="#6cc45a" d="M1 3h3v2H1zM8 2h3v2H8z" />
          <path fill="#3f8f4f" d="M6 4h1v8H6z" />
          <path fill="#5aa848" d="M5 4h1v8H5z" />
        </svg>
        <span className="brand__name">Terrarium</span>
        {demo && (
          <span className="chip chip--demo" title="Interactive browser demo with simulated agents. Click GitHub to get the desktop app for your own repos.">
            live demo
          </span>
        )}
      </div>

      <button className={`pxbtn topbar__toggle ${catalogueOpen ? "is-on" : ""}`} aria-pressed={catalogueOpen} onClick={() => setState((s) => ({ catalogueOpen: !s.catalogueOpen }))} title="Seed Catalogue: every plant in a list ( \\ )">
        Catalogue
      </button>

      <nav className="tally" aria-label="Garden status">
        <button className={`tally__item tally__item--need ${needy ? "is-on" : ""}`} onClick={() => nextNeedingYou(1)} disabled={!needy} title="Waiting on you or wilted. Click (or press n) to visit each, oldest wait first.">
          <span className="tally__n">{needy}</span> need you
        </button>
        <button className={`tally__item tally__item--grow ${growing ? "is-on" : ""}`} onClick={() => cycle(idsWhere(isGrowing))} disabled={!growing} title="Working on a turn right now">
          <span className="tally__n">{growing}</span> growing
        </button>
        <button className={`tally__item tally__item--harvest ${harvest ? "is-on" : ""}`} onClick={() => cycle(idsWhere(isHarvest))} disabled={!harvest} title="Finished turns you have not read yet">
          <span className="tally__n">{harvest}</span> ready
        </button>
      </nav>

      <div className="topbar__info">
        <span className={`chip chip--pool ${pool.canAdmit === 0 ? "chip--warn" : ""}`} title={pots.tip}>
          <span className="chip__long">{pots.text}</span>
          <span className="chip__short" aria-hidden="true">
            {pots.short}
          </span>
        </span>
        {sky && (
          <span
            className={`chip chip--weather chip--${weather!.status}`}
            title={`${sky}${weather?.resetsAt ? ` · resets at ${new Date(weather.resetsAt).toLocaleString()}` : ""}`}
          >
            <span className="chip__long">{sky}</span>
            <span className="chip__short" aria-hidden="true">
              {weatherShort(weather)}
            </span>
          </span>
        )}
      </div>

      <div className="topbar__actions">
        <button className={`pxbtn topbar__toggle ${almanac ? "is-on" : ""}`} onClick={() => setView({ almanac: !almanac, settings: false })} title="Almanac: usage and cost">
          Almanac
        </button>
        <button className={`pxbtn topbar__toggle ${settings ? "is-on" : ""}`} onClick={() => setView({ settings: !settings, almanac: false })} title="Settings">
          Settings
        </button>
        <button className="btn btn--ghost" onClick={onAddBed}>
          Add bed
        </button>
        <button className="btn btn--primary" onClick={() => openSow(getState().selection?.kind === "bed" ? getState().selection!.id : "")} disabled={!hasBeds}>
          Sow
        </button>
        {/* btn--github: demo-only, and the promo capture overlays hide that class */}
        {demo && (
          <button className="btn btn--github" onClick={() => setDownload(true)} aria-haspopup="dialog" title="Get the desktop app for Windows, macOS or Linux">
            Download
          </button>
        )}
        {demo && (
          <a className="btn btn--github" href={GITHUB_URL} target="_blank" rel="noreferrer" title="View source and download the desktop app on GitHub">
            ★ GitHub
          </a>
        )}
      </div>
      {download && <DownloadWindow onClose={() => setDownload(false)} />}
    </header>
  );
}
