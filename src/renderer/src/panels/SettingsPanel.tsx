// Settings: how many agents run, watching terminal sessions (the hook), PR checks, diagnostics.
import { useEffect, useState } from "react";
import type { HookStatus, Settings } from "../../../shared/types";
import { attempt, garden, setState, useGarden } from "../store";
import { bytes, errorText } from "./v2/format";
import { Window } from "./v2/ui";
import "./v2.css";

async function save(patch: Partial<Settings>) {
  const next = await attempt(() => garden().setSettings(patch));
  if (next) setState({ settings: next });
}

export function SettingsPanel({ onClose }: { onClose(): void }) {
  const settings = useGarden((s) => s.settings);
  const pool = useGarden((s) => s.pool);
  const [diag, setDiag] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  return (
    <Window title="Settings" onClose={onClose} className="v2-settings">
      <div className="v2-scroll">
        <section className="v2-card">
          <h3>Agents</h3>
          <NumberField
            label="Close an idle plant's process after (minutes)"
            hint="The plant stays in the garden; its Claude Code process is closed to free memory and starts again when you water it."
            value={settings.idleMinutes}
            min={1}
            onSave={(v) => v != null && save({ idleMinutes: v })}
          />
          <NumberField
            label="Maximum live plants"
            hint="Leave empty to let this machine's free memory decide."
            value={settings.maxLive}
            min={1}
            placeholder="decided by this machine's memory"
            onSave={(v) => save({ maxLive: v })}
          />
          <div className="v2-pool small">
            <p>
              Right now {bytes(pool.freeBytes)} of {bytes(pool.totalBytes)} memory is free, and one plant's Claude Code process uses about {bytes(pool.perProcessBytes)}. So{" "}
              <strong>{pool.canAdmit} more</strong> can start now, with {pool.live} live.
            </p>
            <p className="muted">
              Ceiling from total memory: {pool.ceiling}.{pool.userMax != null && ` Your maximum: ${pool.userMax}.`}
              {pool.queued > 0 && ` ${pool.queued} waiting for a free pot (queued until memory frees up).`}
            </p>
          </div>
        </section>

        <section className="v2-card">
          <h3>Terminal sessions</h3>
          <p className="small">
            Claude Code sessions you start in a terminal show up as <strong>volunteers</strong>. Gardener always reads their transcripts, with no setup: they appear within a few seconds and show their tools, but
            a session waiting for your permission looks the same as one running a long command.
          </p>
          <HookCard />
        </section>

        <section className="v2-card">
          <h3>Pull requests</h3>
          <label className="v2-check">
            <input type="checkbox" checked={settings.wakeOnRedStake} onChange={(e) => save({ wakeOnRedStake: e.target.checked })} />
            <span>
              <strong>Wake on a red stake</strong>: when a plant's pull request checks fail, offer to send it a message with the failing checks so it can fix them. Nothing is sent without you.
            </span>
          </label>
        </section>

        <section className="v2-card">
          <h3>Storage</h3>
          <p className="small">Diagnostics: versions, database size, live processes and recent errors. Nothing leaves this computer unless you paste it somewhere.</p>
          <div className="v2-row">
            <button
              className="btn btn--small"
              onClick={async () => {
                try {
                  setDiag(await garden().diagnostics());
                } catch (e) {
                  setDiag(errorText(e));
                }
              }}
            >
              Collect diagnostics
            </button>
            {diag && (
              <button
                className="btn btn--small"
                onClick={() =>
                  navigator.clipboard.writeText(diag).then(
                    () => setCopied(true),
                    () => setCopied(false),
                  )
                }
              >
                {copied ? "Copied" : "Copy"}
              </button>
            )}
          </div>
          {diag && <textarea className="v2-diag mono" readOnly value={diag} rows={10} aria-label="Diagnostics" onFocus={(e) => e.currentTarget.select()} />}
        </section>
      </div>
    </Window>
  );
}

/** Edits a number, saving on blur or Enter. Empty saves undefined. */
function NumberField({ label, hint, value, min, placeholder, onSave }: { label: string; hint: string; value?: number; min: number; placeholder?: string; onSave(v: number | undefined): void }) {
  const [draft, setDraft] = useState(value == null ? "" : String(value));
  useEffect(() => setDraft(value == null ? "" : String(value)), [value]);
  const commit = () => {
    const n = draft.trim() === "" ? undefined : Math.max(min, Math.round(Number(draft)));
    if (n !== undefined && !Number.isFinite(n)) return setDraft(value == null ? "" : String(value));
    if (n !== value) onSave(n);
  };
  return (
    <label className="field v2-field">
      <span>{label}</span>
      <input type="number" min={min} value={draft} placeholder={placeholder} onChange={(e) => setDraft(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === "Enter" && commit()} />
      <small className="muted">{hint}</small>
    </label>
  );
}

/** Layer 2 of watching terminal sessions: the opt-in Claude Code hook. Also used on first run. */
export function HookCard() {
  const [status, setStatus] = useState<HookStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const port = useGarden((s) => s.settings.hookPort);

  useEffect(() => {
    garden()
      .hookStatus()
      .then(setStatus)
      .catch((e) => setError(errorText(e)));
  }, []);

  const change = async (fn: () => Promise<HookStatus>) => {
    setBusy(true);
    setError(null);
    try {
      setStatus(await fn());
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="v2-hook">
      <h4>
        Watch terminal sessions precisely{" "}
        <span className={`chip ${status?.installed ? "v2-chip--ok" : ""}`}>{status ? (status.installed ? "installed" : "not installed") : "checking…"}</span>
      </h4>
      <p className="small">
        This adds one HTTP hook to {status ? <code>{status.settingsPath}</code> : "Claude Code's user settings"}, so Claude Code tells Gardener, on this computer only (127.0.0.1:{port}), the moment a terminal
        session starts, uses a tool, or is waiting for your permission. Gardener backs up the file first and merges its entry in without touching anything else. You can remove it in one click.
      </p>
      {status?.installed && !status.listening && (
        <div className="v2-err small">
          <p>
            The hook is installed, but Gardener couldn't listen on port {port}, so its events aren't arriving here. Another program may be using that port.
          </p>
        </div>
      )}
      {status?.note && <p className="small muted">{status.note}</p>}
      {status && (
        <details className="v2-details">
          <summary className="small">Show exactly what gets added</summary>
          <pre className="mono">{status.preview}</pre>
        </details>
      )}
      {error && (
        <div className="v2-err">
          <p>Couldn't change Claude Code's settings.</p>
          <pre>{error}</pre>
        </div>
      )}
      <div className="v2-row">
        {status?.installed ? (
          <button className="btn btn--small" disabled={busy} onClick={() => change(() => garden().uninstallHook())}>
            {busy ? "Removing…" : "Remove the hook"}
          </button>
        ) : (
          <button className="btn btn--primary btn--small" disabled={busy || !status} onClick={() => change(() => garden().installHook())}>
            {busy ? "Installing…" : "Install the hook"}
          </button>
        )}
      </div>
    </div>
  );
}
