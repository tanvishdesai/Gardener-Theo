# Release checklist (Windows, V2.0)

Certificate: OV, cloud HSM. Expires **YYYY-MM-DD**; start renewing 30 days before (see SIGNING.md).

## Before tagging

- [ ] `main` is green in CI, including the Windows benchmark against `bench/baseline.json`.
- [ ] Locally: `npm ci && npm run typecheck && npm test && npm run build` all pass.
- [ ] Unsigned package smoke test:
  - [ ] `GARDENER_UNSIGNED=1 npx electron-builder --win --dir -c electron-builder.yml`.
  - [ ] Start `dist\win-unpacked\Gardener.exe`.
  - [ ] Sow a plant in a scratch repo and see one turn through: the stake runs, and the diff and ring show.
  - [ ] Confirm `claude.exe` runs from `resources\app.asar.unpacked\…`.
- [ ] A database migration in this release? Check that the pre-migration backup is written, and that opening an old `garden.db` works.
- [ ] README (vocabulary table) and CLAUDE.md (layout) are up to date.
- [ ] Bump `version` in `package.json`, and write the release notes (what changed, known issues, the SmartScreen note).
- [ ] The certificate is more than 30 days from expiry.

## Tag

- [ ] `git tag vX.Y.Z && git push origin vX.Y.Z`. The tag must equal `v` + `package.json` version, or the workflow stops.
- [ ] Approve the `release` environment deployment in Actions.
- [ ] The workflow runs typecheck, tests, build, package, signs every `.exe`, and runs the `Get-AuthenticodeSignature` step. All must pass.

## After the workflow

- [ ] Download `Gardener-Setup-X.Y.Z.exe` from the **draft** release on a clean Windows VM (no dev tools):
  - [ ] Installs per user, with no admin prompt. The install folder can be changed.
  - [ ] The signature shows the organization name (Properties → Digital Signatures).
  - [ ] SmartScreen behaviour is as expected (see SIGNING.md).
  - [ ] First run: checks for git, Claude Code login and `gh`.
  - [ ] Help → "Copy diagnostics" works and contains no home paths or tokens.
  - [ ] Uninstall keeps `%APPDATA%\Gardener` (the garden survives a reinstall).
- [ ] Update from the previous release works (once electron-updater is wired), and the backup is written before migrating.
- [ ] Publish the draft release. The release notes link to the "Run anyway" explanation.

## If something is wrong

- Delete the draft release and the tag (`git push --delete origin vX.Y.Z`), fix the problem, and bump the patch version. Never re-sign or re-upload under a published version.
