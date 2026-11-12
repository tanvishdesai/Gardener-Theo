// electron-builder custom Windows signer (win.signtoolOptions.sign). Called once per file.
// Signs through the CA's cloud signing CLI (key in the CA's HSM; see docs/v2/SIGNING.md):
//   SIGN_TOOL_CMD   command template with a {file} placeholder, e.g.
//                   CodeSignTool.bat sign -username=%ES_USERNAME% -password=%ES_PASSWORD% -credential_id=%ES_CREDENTIAL_ID% -totp_secret=%ES_TOTP_SECRET% -input_file_path={file} -override=true
//                   Reference secrets as %VARS% so they are expanded by the shell, never written in the template.
//   TERRARIUM_UNSIGNED=1   local/unsigned build: skip signing.
// With neither set, the build fails: a release must never ship unsigned by accident.
const { spawnSync } = require("node:child_process");

module.exports = async function sign(config) {
  const file = config.path;
  if (process.env.TERRARIUM_UNSIGNED === "1") {
    console.log(`  • not signing (TERRARIUM_UNSIGNED=1)  file=${file}`);
    return;
  }
  const template = process.env.SIGN_TOOL_CMD;
  if (!template || !template.includes("{file}")) {
    throw new Error(
      "Code signing is not configured: set SIGN_TOOL_CMD (a command with a {file} placeholder; see docs/v2/SIGNING.md), or TERRARIUM_UNSIGNED=1 for a local unsigned build.",
    );
  }
  const cmd = template.split("{file}").join(`"${file}"`);
  console.log(`  • signing  file=${file}`);
  // shell: true → cmd.exe on Windows, so %SECRET% references expand from the environment.
  const r = spawnSync(cmd, { shell: true, stdio: "inherit", windowsHide: true });
  // Don't echo the command in the error: it may contain expanded credentials.
  if (r.status !== 0) throw new Error(`Signing failed for ${file} (exit ${r.status ?? r.error?.message})`);
};
