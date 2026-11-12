// First run: check the tools Gardener needs, offer to import past sessions, offer the terminal hook.
import { useEffect, useState } from "react";
import type { FirstRunCheck } from "../../../shared/types";
import { attempt, garden, setState } from "../store";
import { errorText, plural } from "./v2/format";
import { HookCard } from "./SettingsPanel";
import { Window } from "./v2/ui";
import "./v2.css";

export function FirstRun({ onDone }: { onDone(): void }) {
  const [check, setCheck] = useState<FirstRunCheck | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [importing, setImporting] = useState<"idle" | "busy" | "done">("idle");
  const [added, setAdded] = useState(0);
  const [importError, setImportError] = useState<string | null>(null);

  const run = () => {
    setError(null);
    garden()
      .firstRunCheck()
      .then(setCheck)
      .catch((e) => setError(errorText(e)));
  };
  useEffect(run, []);

  const finish = async () => {
    const s = await attempt(() => garden().setSettings({ onboarded: true }));
    if (s) setState({ settings: s });
    onDone();
  };

  const doImport = async () => {
    setImporting("busy");
    setImportError(null);
    try {
      const r = await garden().importHistory();
      setAdded(r.added);
      setImporting("done");
    } catch (e) {
      setImportError(errorText(e));
      setImporting("idle");
    }
  };

  return (
    <Window title="Welcome to the garden" sub="Three quick checks, then you can start sowing" onClose={finish} className="v2-firstrun">
      <div className="v2-scroll">
        <p className="small">
          Every repository is a <strong>bed</strong>; every Claude Code agent is a <strong>plant</strong> growing in it. Gardener runs Claude Code on this computer with the account it is logged into.
        </p>

        <section className="v2-card">
          <h3>1 · Tools in the shed</h3>
          {error && (
            <div className="v2-err">
              <p>Couldn't run the checks.</p>
              <pre>{error}</pre>
            </div>
          )}
          {!check && !error && <p className="small muted">Checking…</p>}
          {check && (
            <ul className="v2-checks">
              <Check ok={check.git.ok} name="Git" detail={check.git.ok ? check.git.version ?? "installed" : undefined} fix="Install Git for Windows from git-scm.com, then press Check again. Claude Code needs it too." />
              <Check ok={check.claude.ok} name="Claude Code login" detail={check.claude.note} fix="Run `claude` once in a terminal and log in." />
              <Check
                ok={check.gh.ok}
                name="GitHub CLI (optional)"
                detail={check.gh.note}
                fix="To open pull requests from Gardener, install GitHub CLI (cli.github.com) and run `gh auth login`. Without it, Gardener opens GitHub's compare page in your browser."
                optional
              />
            </ul>
          )}
          <button className="btn btn--small" onClick={run}>
            Check again
          </button>
        </section>

        <section className="v2-card">
          <h3>2 · Bring in past sessions</h3>
          {check && check.historySessions === 0 ? (
            <p className="small muted">No past Claude Code sessions were found on this computer (~/.claude/projects).</p>
          ) : (
            <>
              <p className="small">
                {check
                  ? `Found ${plural(check.historySessions, "past Claude Code session")} in ${plural(check.historyBeds, "folder")}.`
                  : "Looking for past Claude Code sessions…"}{" "}
                Importing turns each folder into a bed and each session into a plant you can read and resume. Your session files are only read, never changed.
              </p>
              {importing === "done" ? (
                <p className="small">
                  <strong>Added {plural(added, "plant")}.</strong>
                </p>
              ) : (
                <button className="btn btn--small" onClick={doImport} disabled={!check || importing === "busy"}>
                  {importing === "busy" ? "Importing… (reading ~/.claude/projects)" : "Import your Claude Code history"}
                </button>
              )}
              {importing === "busy" && <div className="v2-progress" role="progressbar" aria-label="Importing history" />}
              {importError && (
                <div className="v2-err">
                  <p>The import stopped.</p>
                  <pre>{importError}</pre>
                </div>
              )}
            </>
          )}
        </section>

        <section className="v2-card">
          <h3>3 · Watch terminal sessions <span className="chip">recommended, optional</span></h3>
          <p className="small">
            Sessions you start in a terminal appear in the garden as volunteers either way. The hook lets Gardener tell you when one is waiting for your permission.
          </p>
          <HookCard />
        </section>

        <div className="dialog__actions">
          <button className="btn btn--ghost" onClick={finish}>
            Skip for now
          </button>
          <button className="btn btn--primary" onClick={finish}>
            Start gardening
          </button>
        </div>
      </div>
    </Window>
  );
}

function Check({ ok, name, detail, fix, optional }: { ok: boolean; name: string; detail?: string; fix: string; optional?: boolean }) {
  return (
    <li className={`v2-checkrow ${ok ? "is-ok" : optional ? "is-opt" : "is-bad"}`}>
      <span className="v2-checkrow__mark" aria-hidden>
        {ok ? "✓" : optional ? "–" : "!"}
      </span>
      <div>
        <div>
          <strong>{name}</strong> {ok ? <span className="muted small">{detail}</span> : <span className="small">{optional ? "not set up" : "missing"}</span>}
        </div>
        {!ok && (
          <div className="small">
            {fix.split("`").map((part, i) => (i % 2 ? <code key={i}>{part}</code> : part))}
          </div>
        )}
      </div>
    </li>
  );
}
