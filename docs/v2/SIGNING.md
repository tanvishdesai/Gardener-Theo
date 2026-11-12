# Code signing (Windows)

Decided in PLAN M8: an **OV** Authenticode certificate from a public CA, with the key held in the **CA's cloud signing service**. No Azure Trusted Signing, no EV.

## Why this setup

- **OV, not EV.** Since March 2024 an EV certificate no longer skips SmartScreen's reputation check, so EV costs more and installs the same way.
- **The key lives in the CA's HSM.** Since June 2023 the CA/B Forum Baseline Requirements say code-signing keys must sit on FIPS 140-2 Level 2 (or Common Criteria EAL 4+) hardware. A USB token can't sign from GitHub Actions. A cloud HSM can: for example SSL.com **eSigner** or DigiCert **KeyLocker**. We never see the private key and never export it.
- **Validity is at most 460 days** (CA/B Forum, from March 2026). Renew every year (see below).

## What gets signed

`electron-builder.yml` sends every `.exe` through `build/sign.cjs` with SHA-256:

- `Terrarium.exe`;
- the unpacked SDK binary `resources/app.asar.unpacked/node_modules/@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe`;
- the NSIS installer and its uninstaller.

The release workflow then checks each file with `Get-AuthenticodeSignature` and fails if any of them is not `Valid`.

`build/sign.cjs` is vendor-neutral. It runs `SIGN_TOOL_CMD` once per file, with `{file}` replaced by the quoted path, through `cmd.exe`. If `SIGN_TOOL_CMD` is missing, it throws, so a release can't ship unsigned by accident. Set `TERRARIUM_UNSIGNED=1` to skip signing on purpose (local builds).

## GitHub configuration

Create a `release` environment (Settings → Environments) and require a reviewer. Put everything below on that environment, not on the repository.

| Kind | Name | What |
| --- | --- | --- |
| variable | `SIGN_TOOL_CMD` | Signing command template with `{file}`. Reference secrets as `%NAME%` and never paste them into the template. |
| variable | `SIGN_TOOL_SETUP` | PowerShell that installs the vendor CLI on the runner (optional) |
| secret | `ES_USERNAME`, `ES_PASSWORD`, `ES_CREDENTIAL_ID`, `ES_TOTP_SECRET` | SSL.com eSigner. The TOTP secret is the one shown when you enrol eSigner for automation. |
| secret | `SM_HOST`, `SM_API_KEY`, `SM_CLIENT_CERT_FILE_B64`, `SM_CLIENT_CERT_PASSWORD`, `SM_KEYPAIR_ALIAS` | DigiCert KeyLocker. The client certificate `.p12` is stored base64-encoded and decoded by the setup step to `%SM_CLIENT_CERT_FILE%`. |

`GITHUB_TOKEN` is provided by Actions and is enough to publish the draft release.

### SSL.com eSigner

- `SIGN_TOOL_SETUP` downloads and unzips CodeSignTool for Windows (it includes its own JDK) into `$env:RUNNER_TEMP\cst`, then adds that folder to `$env:GITHUB_PATH`.
- `SIGN_TOOL_CMD`:
  ```
  CodeSignTool.bat sign -username=%ES_USERNAME% -password=%ES_PASSWORD% -credential_id=%ES_CREDENTIAL_ID% -totp_secret=%ES_TOTP_SECRET% -input_file_path={file} -override=true
  ```
  CodeSignTool adds an RFC 3161 timestamp itself.

### DigiCert KeyLocker

- `SIGN_TOOL_SETUP` decodes the client certificate and installs the tools:
  ```
  [IO.File]::WriteAllBytes("$env:RUNNER_TEMP\keylocker.p12", [Convert]::FromBase64String($env:SM_CLIENT_CERT_FILE_B64))
  ```
  Then it installs DigiCert's `smtools` MSI and adds its folder to `$env:GITHUB_PATH`.
- `SIGN_TOOL_CMD`:
  ```
  smctl sign --keypair-alias=%SM_KEYPAIR_ALIAS% --input {file}
  ```

Check the vendor's current docs for exact download URLs and flags. They change more often than this file does.

## Renewing (every year; the maximum validity is 460 days)

1. About 30 days before expiry, order the renewal from the same CA, under the **same organization name**. Validation is repeated, so allow a few days.
2. The CA issues the new certificate into the same cloud account. Update `ES_CREDENTIAL_ID` or `SM_KEYPAIR_ALIAS` if it changed.
3. Do an unsigned dry run, then a signed pre-release tag such as `v2.1.0-rc.1`. Confirm that `Get-AuthenticodeSignature` shows the new thumbprint.
4. If `win.publisherName` is set in `electron-builder.yml`, keep it equal to the certificate's CN. electron-updater refuses updates whose signer doesn't match.
5. Write the new expiry date in RELEASE.md's "Certificate" line.

Signatures are timestamped, so files signed before expiry stay valid after it.

## SmartScreen expectations

Reputation builds per certificate and per file hash as people download the files. Expect **"Windows protected your PC → More info → Run anyway"** on the first releases, and again for a while after a certificate renewal. Say this on the download page. Don't tell users to turn SmartScreen off. Submitting each installer at <https://www.microsoft.com/wdsi/filesubmission> as a software developer can speed this up.

## Testing signing locally

- **Unsigned build:** `npm run build`, then `TERRARIUM_UNSIGNED=1 npx electron-builder --win --dir -c electron-builder.yml`.
- **The hook with a throwaway certificate.** This needs signtool from the Windows SDK. In PowerShell:
  ```powershell
  New-SelfSignedCertificate -Type CodeSigningCert -Subject "CN=Terrarium Test" -CertStoreLocation Cert:\CurrentUser\My
  $env:SIGN_TOOL_CMD = 'signtool sign /fd SHA256 /n "Terrarium Test" /tr http://timestamp.digicert.com /td SHA256 {file}'
  npx electron-builder --win --dir -c electron-builder.yml
  Get-AuthenticodeSignature dist\win-unpacked\Terrarium.exe   # NotTrusted is expected for a self-signed certificate
  ```
  Delete the test certificate afterwards with `certmgr.msc` (Personal → Certificates).
- **Real signing** only happens in the `release` workflow. Don't install the production credentials on a laptop.
