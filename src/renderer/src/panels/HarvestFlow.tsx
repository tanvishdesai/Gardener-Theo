// Harvest: review → gather → bundle → to market. Each step says the real git operation underneath.
import { useEffect, useState } from "react";
import type { HarvestInfo, Plant, PullRequestInfo } from "../../../shared/types";
import { attempt, garden } from "../store";
import { DiffView } from "./DiffView";
import { errorText, plural } from "./v2/format";
import { Counts, GitError, StatusLetter } from "./v2/ui";
import "./v2.css";

const STEPS = [
  { name: "Review", plain: "look over the changes" },
  { name: "Gather", plain: "pick files, write the message" },
  { name: "Bundle", plain: "git commit" },
  { name: "To market", plain: "git push, open a PR" },
];

const isGitHub = (url?: string) => !!url && /github\.com[:/]/i.test(url);

export function HarvestFlow({ plant }: { plant: Plant }) {
  const [info, setInfo] = useState<HarvestInfo | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [step, setStep] = useState(0);
  const [diff, setDiff] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [writing, setWriting] = useState(false);
  const [newBranchOk, setNewBranchOk] = useState(false);
  const [busy, setBusy] = useState<null | "commit" | "push" | "pr" | "fix">(null);
  const [opError, setOpError] = useState<unknown>(null);
  const [sha, setSha] = useState<string | null>(null);
  const [pushed, setPushed] = useState(false);
  const [opened, setOpened] = useState<{ url: string; viaBrowser: boolean } | null>(null);
  const [asked, setAsked] = useState(false);

  const load = async () => {
    try {
      const i = await garden().harvestInfo(plant.id);
      setInfo(i);
      setLoadError(null);
      setPicked(new Set(i.files.map((f) => f.path)));
      return i;
    } catch (e) {
      setLoadError(errorText(e));
    }
  };
  useEffect(() => {
    void load();
  }, [plant.id, plant.turns, plant.pr?.checkedAt]);

  // Run a git step; failures stay on screen verbatim instead of a toast.
  const run = async <T,>(kind: NonNullable<typeof busy>, fn: () => Promise<T>): Promise<T | undefined> => {
    setBusy(kind);
    setOpError(null);
    try {
      return await fn();
    } catch (e) {
      setOpError(e);
    } finally {
      setBusy(null);
    }
  };

  if (loadError)
    return (
      <div className="v2-harvest">
        <GitError error={loadError} />
        <button className="btn btn--small" onClick={load}>
          Try again
        </button>
      </div>
    );
  if (!info) return <div className="v2-harvest muted small">Checking the branch and remote…</div>;
  if (!info.isGitRepo)
    return (
      <div className="v2-harvest v2-empty small">
        <strong>Nothing to harvest here.</strong> This bed isn't a git repository, so there's no commit, push or pull request to make.
      </div>
    );

  const pr = info.pr ?? plant.pr;
  const branch = info.branch ?? "(detached)";
  const blocked = info.onDefaultBranch && (plant.plot !== "bed" || !newBranchOk);
  const files = info.files;

  const writeMessage = async () => {
    setWriting(true);
    const m = await attempt(() => garden().commitMessage(plant.id));
    setWriting(false);
    if (m) (setSubject(m.subject), setBody(m.body));
  };
  const commit = async () => {
    const r = await run("commit", () => garden().commit(plant.id, { subject: subject.trim(), body: body.trim() }, [...picked]));
    if (r) {
      setSha(r.sha);
      await load();
      setStep(3);
    }
  };
  // push() resolves to void, so success is "didn't throw".
  const doPush = async () => {
    let ok = false;
    await run("push", async () => {
      await garden().push(plant.id);
      ok = true;
    });
    if (ok) {
      setPushed(true);
      await load();
    }
  };
  const openPr = async () => {
    const r = await run("pr", () => garden().openPullRequest(plant.id, { title: subject.trim() || plant.name, body: body.trim() }));
    if (r) {
      setOpened(r);
      void load();
    }
  };
  const askFix = async () => {
    const msg = `The checks on pull request ${pr?.number ? `#${pr.number}` : pr?.url ?? ""} are failing. Find out which checks failed and why (for example with \`gh pr checks\` and \`gh run view --log-failed\`), fix the cause, and commit the fix.`;
    const r = await run("fix", async () => {
      await garden().send(plant.id, msg);
      return true;
    });
    if (r) setAsked(true);
  };

  return (
    <div className="v2-harvest">
      <ol className="v2-steps">
        {STEPS.map((s, i) => (
          <li key={s.name}>
            <button className={`v2-step ${i === step ? "is-on" : ""} ${i < step ? "is-done" : ""}`} onClick={() => setStep(i)} aria-current={i === step ? "step" : undefined}>
              <span className="v2-step__n">{i + 1}</span>
              <span className="v2-step__name">{s.name}</span>
              <span className="v2-step__plain">{s.plain}</span>
            </button>
          </li>
        ))}
      </ol>

      <div className="v2-branchline small">
        On branch <code>{branch}</code>
        {info.base && (
          <>
            {" "}
            from <code>{info.base}</code>
          </>
        )}
        {info.unpushed > 0 && <span> · {plural(info.unpushed, "commit")} not pushed yet</span>}
      </div>

      {step === 0 && (
        <section className="v2-stepbox">
          <h3>Review</h3>
          <p className="v2-git">Everything this plant changed since it was sown: git diff {info.base ?? "<base>"} against the files now.</p>
          {files.length === 0 ? (
            <p className="small">{info.unpushed > 0 ? "No uncommitted changes. There are commits ready to push: go to step 4." : "Nothing has changed yet, so there's nothing to harvest."}</p>
          ) : (
            <FileList files={files} />
          )}
          <div className="v2-row">
            <button className="btn btn--small" onClick={() => setDiff(true)} disabled={files.length === 0}>
              Open diff
            </button>
            <button className="btn btn--primary btn--small" onClick={() => setStep(files.length ? 1 : 3)}>
              Next: {files.length ? "Gather" : "To market"}
            </button>
          </div>
        </section>
      )}

      {step === 1 && (
        <section className="v2-stepbox">
          <h3>Gather</h3>
          <p className="v2-git">Choose which files go in the commit (git add for those paths only), then write the message.</p>
          {files.length > 0 && (
            <>
              <div className="v2-row small">
                <button className="linkish" onClick={() => setPicked(new Set(files.map((f) => f.path)))}>
                  Select all
                </button>
                <button className="linkish" onClick={() => setPicked(new Set())}>
                  Select none
                </button>
                <span className="muted">
                  {picked.size} of {files.length} chosen
                </span>
              </div>
              <ul className="v2-checklist">
                {files.map((f) => (
                  <li key={f.path}>
                    <label>
                      <input
                        type="checkbox"
                        checked={picked.has(f.path)}
                        onChange={(e) => {
                          const next = new Set(picked);
                          e.target.checked ? next.add(f.path) : next.delete(f.path);
                          setPicked(next);
                        }}
                      />
                      <StatusLetter status={f.status} />
                      <span className="v2-checklist__path mono">{f.path}</span>
                      {f.status !== "binary" && <Counts ins={f.insertions} del={f.deletions} />}
                    </label>
                  </li>
                ))}
              </ul>
            </>
          )}
          <label className="field">
            <span>Subject</span>
            <input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="One line: what this change does" maxLength={200} />
          </label>
          <label className="field">
            <span>Body</span>
            <textarea rows={5} value={body} onChange={(e) => setBody(e.target.value)} placeholder="Why, and anything a reviewer should know" />
          </label>
          <p className="muted small">
            "Write the message" drafts one from the staged changes, matching the style of this repo's recent commit subjects (git log -n 20). You can edit it before committing.
          </p>
          <div className="v2-row">
            <button className="btn btn--small" onClick={writeMessage} disabled={writing || picked.size === 0}>
              {writing ? "Writing…" : "Write the message"}
            </button>
            <button className="btn btn--primary btn--small" onClick={() => setStep(2)} disabled={!subject.trim() || picked.size === 0}>
              Next: Bundle
            </button>
          </div>
        </section>
      )}

      {step === 2 && (
        <section className="v2-stepbox">
          <h3>Bundle</h3>
          <p className="v2-git">
            git commit of {plural(picked.size, "file")} on <code>{branch}</code>.
          </p>
          {info.onDefaultBranch &&
            (plant.plot === "bed" ? (
              <div className="v2-notice small">
                <p>
                  <strong>{branch} is the repo's default branch.</strong> Terrarium won't commit straight to it. Instead it will create a new branch named <code>garden/…</code> after this plant (git switch -c
                  garden/…), commit there, and leave {branch} untouched.
                </p>
                <label className="v2-check">
                  <input type="checkbox" checked={newBranchOk} onChange={(e) => setNewBranchOk(e.target.checked)} /> Create the garden/… branch and commit there
                </label>
              </div>
            ) : (
              <div className="v2-err">
                <p>
                  <strong>This pot is on {branch}, the repo's default branch.</strong> Terrarium won't commit straight to the default branch. Switch the pot to its own branch (ask the plant to run{" "}
                  <code>git switch -c your-branch</code>), then come back.
                </p>
              </div>
            ))}
          {!subject.trim() && <p className="small">Write a commit subject in step 2 first.</p>}
          <div className="v2-preview mono">
            <div>{subject || "(no subject)"}</div>
            {body && <div className="muted">{body}</div>}
          </div>
          {busy !== "commit" && opError != null && <GitError error={opError} />}
          {sha && <p className="small">Committed {sha.slice(0, 7)}.</p>}
          <div className="v2-row">
            <button className="btn btn--primary btn--small" onClick={commit} disabled={blocked || !subject.trim() || picked.size === 0 || busy === "commit"}>
              {busy === "commit" ? "Committing…" : "Commit · git commit"}
            </button>
          </div>
        </section>
      )}

      {step === 3 && (
        <section className="v2-stepbox">
          <h3>To market</h3>
          {sha && <p className="small">Committed {sha.slice(0, 7)}.</p>}
          {!info.hasRemote ? (
            <p className="small">
              This repo has no remote to push to (no <code>origin</code>). The commit is saved locally on <code>{branch}</code>.
            </p>
          ) : (
            <>
              <p className="v2-git">
                git push -u origin {branch}
                {info.remoteUrl && <span className="muted"> → {info.remoteUrl}</span>}
              </p>
              {info.unpushed === 0 && !pushed && <p className="small muted">Nothing new to push: the remote already has every commit on this branch.</p>}
              {pushed && <p className="small">Pushed to origin/{branch}.</p>}
              <div className="v2-row">
                <button className="btn btn--small" onClick={doPush} disabled={busy === "push" || info.unpushed === 0}>
                  {busy === "push" ? "Pushing…" : `Push · git push -u origin ${branch}`}
                </button>
              </div>
            </>
          )}

          {info.hasRemote && !isGitHub(info.remoteUrl) && (
            <p className="small">
              This remote isn't on GitHub, so Terrarium stops after the push. Open the merge or pull request on your git host's website.
            </p>
          )}

          {info.hasRemote && isGitHub(info.remoteUrl) && !pr && (
            <div className="v2-subbox">
              <h4>Open a pull request</h4>
              <p className="v2-git">
                {info.ghReady ? `gh pr create --base ${info.base ?? "<default>"} --head ${branch}` : "GitHub CLI (gh) isn't logged in, so Terrarium opens GitHub's compare page in your browser instead."}
              </p>
              <label className="field">
                <span>Title</span>
                <input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder={plant.name} />
              </label>
              <label className="field">
                <span>Description</span>
                <textarea rows={4} value={body} onChange={(e) => setBody(e.target.value)} />
              </label>
              <button className="btn btn--primary btn--small" onClick={openPr} disabled={busy === "pr" || (info.unpushed > 0 && !pushed)}>
                {busy === "pr" ? "Opening…" : "Open pull request"}
              </button>
              {info.unpushed > 0 && !pushed && <span className="small muted"> Push first.</span>}
            </div>
          )}

          {opened && (opened.viaBrowser ? <p className="small">Opened GitHub's compare page in your browser. Finish the pull request there.</p> : <PrLink url={opened.url} />)}

          {pr && <PrStatus pr={pr} />}
          {pr?.checks === "failing" && (
            <div className="v2-row">
              <button className="btn btn--small" onClick={askFix} disabled={busy === "fix" || asked}>
                {asked ? "Sent to the plant" : "Ask the plant to fix failing checks"}
              </button>
              <span className="small muted">Sends the plant a message asking it to read the failing checks and fix them.</span>
            </div>
          )}

          {busy === null && opError != null && <GitError error={opError} />}
        </section>
      )}

      {diff && <DiffView plant={plant} scope={{ kind: "sown" }} onClose={() => setDiff(false)} />}
    </div>
  );
}

function FileList({ files }: { files: HarvestInfo["files"] }) {
  return (
    <ul className="v2-filelist">
      {files.map((f) => (
        <li key={f.path}>
          <StatusLetter status={f.status} />
          <span className="mono v2-filelist__path" title={f.path}>
            {f.path}
          </span>
          {f.status !== "binary" && <Counts ins={f.insertions} del={f.deletions} />}
        </li>
      ))}
    </ul>
  );
}

function PrLink({ url }: { url: string }) {
  return (
    <p className="small">
      Pull request opened:{" "}
      <a href={url} target="_blank" rel="noreferrer">
        {url}
      </a>
    </p>
  );
}

const CHECKS: Record<PullRequestInfo["checks"], string> = { none: "no checks", pending: "checks running", passing: "checks passing", failing: "checks failing" };
const REVIEW: Record<NonNullable<PullRequestInfo["review"]>, string> = { approved: "approved ✓", changes_requested: "changes requested", review_required: "review required" };

function PrStatus({ pr }: { pr: PullRequestInfo }) {
  const ribbon = pr.checks === "passing" ? "passing" : pr.checks === "failing" ? "failing" : pr.checks === "pending" ? "running" : null;
  return (
    <div className="v2-subbox v2-pr">
      <h4>
        Market stall: pull request{" "}
        <a href={pr.url} target="_blank" rel="noreferrer">
          {pr.number ? `#${pr.number}` : pr.url}
        </a>
      </h4>
      <div className="v2-row small">
        <span className={`chip v2-prstate--${pr.state}`}>{pr.state}</span>
        <span className={`chip v2-stake ${ribbon ? `v2-stake--${ribbon}` : ""}`} title="The stake ribbon shows the PR's CI checks">
          {ribbon && <span className="v2-ribbon" aria-hidden />} {CHECKS[pr.checks]}
        </span>
        {pr.review && <span className="chip">{REVIEW[pr.review]}</span>}
        <span className="muted">checked {new Date(pr.checkedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
      </div>
      {pr.state === "merged" && <p className="small">Merged: the plant is transplanted to the Seed Catalogue, and its pot can be cleaned up.</p>}
    </div>
  );
}
