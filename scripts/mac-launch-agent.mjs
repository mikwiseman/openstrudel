import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const xml = value => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
const networkKeys = ["OPENSTRUDEL_PUBLIC_HOST", "OPENSTRUDEL_PUBLIC_PORT", "OPENSTRUDEL_TLS_CERT", "OPENSTRUDEL_TLS_KEY"];

export function retainedNetworkEnvironment(environment = {}) {
  return Object.fromEntries(networkKeys.filter(key => typeof environment[key] === "string" && environment[key].length > 0).map(key => [key, environment[key]]));
}

export function launchAgent(root, node, userDirectory, dataRoot = root, version = "development", networkEnvironment = {}) {
  const strings = values => values.map(value => `<string>${xml(value)}</string>`).join("");
  const network = Object.entries(retainedNetworkEnvironment(networkEnvironment)).map(([key, value]) => `<key>${key}</key><string>${xml(value)}</string>`).join("\n");
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
${network}
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
  // Older installations kept their public address and TLS paths in launchd.
  // Regenerating the program paths during an app update must retain these.
  // New installations can keep the same settings in the data directory's .env.
  const installed = resolve(directory, "is.openstrudel.home.plist");
  let networkEnvironment = {};
  if (process.platform === "darwin" && existsSync(installed)) {
    const previous = JSON.parse(execFileSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", installed], { encoding: "utf8" }));
    networkEnvironment = retainedNetworkEnvironment(previous.EnvironmentVariables);
  }
  const temporary = target + ".new";
  writeFileSync(temporary, launchAgent(root, process.execPath, homedir(), dataRoot, version, networkEnvironment), { mode: 0o600 });
  renameSync(temporary, target);
}
