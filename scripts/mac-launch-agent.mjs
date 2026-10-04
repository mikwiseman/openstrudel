import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const xml = value => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
export function launchAgent(root, node, userDirectory, dataRoot = root, version = "development") {
  const strings = values => values.map(value => `<string>${xml(value)}</string>`).join("");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>is.openstrudel.home</string>
<key>ProgramArguments</key><array>${strings([node, root + "/dist/cli.js", "start"])}</array>
<key>WorkingDirectory</key><string>${xml(dataRoot)}</string>
<key>OpenStrudelRuntimeVersion</key><string>${xml(version)}</string>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>5</integer>
<key>EnvironmentVariables</key><dict>
<key>PATH</key><string>${xml(root + "/bin:" + userDirectory + "/.local/bin:/usr/bin:/bin:/usr/sbin:/sbin")}</string>
<key>LANG</key><string>en_US.UTF-8</string>
<key>OPENSTRUDEL_DB</key><string>${xml(dataRoot + "/.data/openstrudel.sqlite")}</string>
</dict>
<key>StandardOutPath</key><string>${xml(dataRoot + "/.data/home.log")}</string>
<key>StandardErrorPath</key><string>${xml(dataRoot + "/.data/home.error.log")}</string>
</dict></plist>`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(process.argv[2]);
  const dataRoot = resolve(process.argv[3] ?? root);
  const directory = resolve(homedir(), "Library/LaunchAgents");
  mkdirSync(directory, { recursive: true });
  let version = "development";
  try { version = readFileSync(resolve(root, "release.txt"), "utf8").trim(); } catch {}
  const target = process.argv[4] ? resolve(process.argv[4]) : resolve(directory, "is.openstrudel.home.plist");
  const temporary = target + ".new";
  writeFileSync(temporary, launchAgent(root, process.execPath, homedir(), dataRoot, version), { mode: 0o600 });
  renameSync(temporary, target);
}
