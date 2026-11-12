// The Almanac: what your Claude Code work cost, per day, bed, model and plant. Plus the weather (usage limits).
import { useEffect, useState } from "react";
import type { UsageBucket, UsageReport, UsageRow, Weather } from "../../../shared/types";
import { focus, garden, useGarden } from "../store";
import { barHeights, clock, errorText, fillDays, money, tokens } from "./v2/format";
import { Window } from "./v2/ui";
import "./v2.css";

const RANGES = [7, 30, 90] as const;
// Fixed whole-pixel bar width and gap per range so bars stay crisp.
const BAR: Record<number, [number, number]> = { 7: [48, 8], 30: [16, 4], 90: [6, 2] };
const CHART_PX = 120;

const shortDay = (day: string) => new Date(`${day}T12:00:00`).toLocaleDateString([], { month: "short", day: "numeric" });

export function Almanac({ onClose }: { onClose(): void }) {
  const [days, setDays] = useState<number>(30);
  const [report, setReport] = useState<UsageReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const weather = useGarden((s) => s.weather);

  useEffect(() => {
    let live = true;
    setError(null);
    garden()
      .usage(days)
      .then((r) => live && setReport(r))
      .catch((e) => live && setError(errorText(e)));
    return () => {
      live = false;
    };
  }, [days]);

  return (
    <Window title="Almanac" sub="What your Claude Code sessions cost, from their own records" onClose={onClose} wide className="v2-almanac">
      <div className="v2-scroll">
        <div className="v2-row">
          <div className="v2-seg" role="group" aria-label="Range">
            {RANGES.map((n) => (
              <button key={n} className={`btn btn--small ${days === n ? "is-on" : ""}`} aria-pressed={days === n} onClick={() => setDays(n)}>
                {n} days
              </button>
            ))}
          </div>
          {report && <span className="small muted">Scanned {clock(report.scannedAt)}</span>}
        </div>

        <p className="v2-notice small">
          Costs are Claude Code's own estimates at API prices, not a bill.
          {report?.estimated && " Some sessions had no cost data and were priced from averages."}
        </p>

        {weather && <WeatherCard weather={weather} />}
        {error && (
          <div className="v2-err">
            <p>Couldn't read usage.</p>
            <pre>{error}</pre>
          </div>
        )}
        {!report && !error && <div className="muted small">Reading the almanac…</div>}
        {report && <Report report={report} days={days} onClose={onClose} />}
      </div>
    </Window>
  );
}

function Report({ report, days, onClose }: { report: UsageReport; days: number; onClose(): void }) {
  const [hover, setHover] = useState<number | null>(null);
  const series = fillDays(report.days, days, new Date(), (day) => ({ day, costUsd: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }));
  const heights = barHeights(
    series.map((d) => d.costUsd),
    CHART_PX,
  );
  const max = Math.max(0, ...series.map((d) => d.costUsd));
  const [w, gap] = BAR[days] ?? [8, 2];
  const t = series.reduce(
    (a, d) => ({ in: a.in + d.inputTokens, out: a.out + d.outputTokens, cr: a.cr + d.cacheReadTokens, cw: a.cw + d.cacheWriteTokens }),
    { in: 0, out: 0, cr: 0, cw: 0 },
  );
  const shown = hover != null ? series[hover] : null;

  return (
    <>
      <div className="v2-totals">
        <Stat label="Total cost" value={money(report.totalCostUsd)} />
        <Stat label="Tokens" value={tokens(t.in + t.out + t.cr + t.cw)} hint={`${tokens(t.in)} in · ${tokens(t.out)} out · ${tokens(t.cr)} cache read · ${tokens(t.cw)} cache write`} />
        <Stat label="Cache hits" value={`${Math.round(report.cacheHitRatio * 100)}%`} hint="Share of input tokens read from Claude's prompt cache (cheaper)" />
      </div>

      <section className="v2-card">
        <h3>Cost per day</h3>
        <div className="v2-chart" aria-hidden>
          <div className="v2-chart__axis small">
            <span>{money(max)}</span>
            <span>$0</span>
          </div>
          <div className="v2-chart__plot" style={{ height: CHART_PX, gap }} onMouseLeave={() => setHover(null)}>
            {series.map((d, i) => (
              <div key={d.day} className={`v2-chart__col ${hover === i ? "is-on" : ""}`} style={{ width: w }} onMouseEnter={() => setHover(i)}>
                <div className="v2-chart__bar" style={{ height: heights[i] }} />
              </div>
            ))}
          </div>
        </div>
        <div className="v2-chart__x small muted" aria-hidden style={{ width: series.length * (w + gap) - gap + 10 }}>
          <span>{shortDay(series[0].day)}</span>
          <span>{shortDay(series[series.length - 1].day)}</span>
        </div>
        <div className="v2-chart__detail small" aria-hidden>
          {shown ? (
            <>
              <strong>{shortDay(shown.day)}</strong> {money(shown.costUsd)} · {tokens(shown.inputTokens)} input · {tokens(shown.outputTokens)} output · {tokens(shown.cacheReadTokens)} cache read ·{" "}
              {tokens(shown.cacheWriteTokens)} cache write
            </>
          ) : (
            <span className="muted">Point at a bar for that day's tokens and cost.</span>
          )}
        </div>
        <table className="sr-only">
          <caption>Estimated cost and tokens per day</caption>
          <thead>
            <tr>
              <th>Day</th>
              <th>Cost</th>
              <th>Input</th>
              <th>Output</th>
              <th>Cache read</th>
              <th>Cache write</th>
            </tr>
          </thead>
          <tbody>
            {series.map((d) => (
              <tr key={d.day}>
                <td>{d.day}</td>
                <td>{money(d.costUsd)}</td>
                <td>{tokens(d.inputTokens)}</td>
                <td>{tokens(d.outputTokens)}</td>
                <td>{tokens(d.cacheReadTokens)}</td>
                <td>{tokens(d.cacheWriteTokens)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <div className="v2-tables">
        <UsageTable title="By bed (repository)" rows={report.byBed} />
        <UsageTable title="By model" rows={report.byModel} />
      </div>
      <UsageTable
        title="By plant (top 20)"
        rows={report.byPlant.slice(0, 20)}
        onPick={(key) => {
          focus("plant", key);
          onClose();
        }}
      />
    </>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="v2-stat" title={hint}>
      <div className="v2-stat__label">{label}</div>
      <div className="v2-stat__value">{value}</div>
      {hint && <div className="v2-stat__hint small muted">{hint}</div>}
    </div>
  );
}

function UsageTable({ title, rows, onPick }: { title: string; rows: UsageRow[]; onPick?(key: string): void }) {
  const plants = useGarden((s) => s.plants);
  return (
    <section className="v2-card">
      <h3>{title}</h3>
      {rows.length === 0 ? (
        <p className="small muted">Nothing in this range.</p>
      ) : (
        <table className="v2-table">
          <thead>
            <tr>
              <th>Name</th>
              <th className="num">Cost</th>
              <th className="num">Tokens</th>
              <th className="num">Turns</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key}>
                <td className="v2-table__name" title={r.label}>
                  {onPick && plants[r.key] ? (
                    <button className="linkish" onClick={() => onPick(r.key)} title="Show this plant in the garden">
                      {r.label}
                    </button>
                  ) : (
                    r.label
                  )}
                </td>
                <td className="num">{money(r.costUsd)}</td>
                <td className="num">{tokens(r.tokens)}</td>
                <td className="num">{r.turns ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

const WEATHER: Record<Weather["status"], { name: string; text: string }> = {
  clear: { name: "Clear skies", text: "You're well within your Claude usage limit." },
  clouds: { name: "Clouds building", text: "You're getting close to your Claude usage limit." },
  rain: { name: "Raining", text: "You've hit your Claude usage limit. Plants wait until it resets." },
};

/** The SDK doesn't say whether resetsAt is seconds or ms; anything below 1e12 is seconds. */
function resetText(at: number) {
  const ms = at < 1e12 ? at * 1000 : at;
  const d = new Date(ms);
  return d.toDateString() === new Date().toDateString() ? `at ${clock(ms)}` : `${d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" })} at ${clock(ms)}`;
}

function WeatherCard({ weather }: { weather: Weather }) {
  const w = WEATHER[weather.status];
  return (
    <section className={`v2-card v2-weather v2-weather--${weather.status}`}>
      <h3>Weather · {w.name}</h3>
      <p className="small">
        {w.text}
        {weather.utilization != null && ` ${Math.round(weather.utilization * 100)}% used`}
        {weather.limitType && ` (${weather.limitType.replace(/_/g, " ")} limit)`}
        {weather.resetsAt != null && `; resets ${resetText(weather.resetsAt)}`}.
      </p>
      <p className="small muted">The sky over the garden shows this too. It only appears for subscription accounts.</p>
    </section>
  );
}
