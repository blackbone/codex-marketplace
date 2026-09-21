import { spawnSync } from "node:child_process";
import { startDashboard } from "./dashboard.mjs";

const dashboards = new Map();

export function browserCommand(url, platform = process.platform) {
  if (!/^http:\/\/127\.0\.0\.1:[0-9]+\/\?settings=1$/.test(url)) throw new Error("Invalid local settings URL");
  if (platform === "darwin") return ["open", [url]];
  if (platform === "win32") return ["rundll32.exe", ["url.dll,FileProtocolHandler", url]];
  return ["xdg-open", [url]];
}

export async function openInitSettings(repoRoot, { open = true, launch = spawnSync } = {}) {
  if (!open) return { settingsUrl: null, browserOpened: false };
  // This listener belongs to the MCP session, independently of the task runner.
  if (!dashboards.has(repoRoot)) {
    const pending = startDashboard(repoRoot).then(dashboard => {
      dashboard.server.unref();
      return dashboard;
    }).catch(error => { dashboards.delete(repoRoot); throw error; });
    dashboards.set(repoRoot, pending);
  }
  const dashboard = await dashboards.get(repoRoot);
  const settingsUrl = `${dashboard.url}?settings=1`;
  const [command, args] = browserCommand(settingsUrl);
  const result = launch(command, args, { stdio: "ignore", timeout: 5000, windowsHide: true });
  const browserOpened = result.status === 0;
  return { settingsUrl, browserOpened, ...(browserOpened ? {} : { browserError: result.error?.message || `Could not open browser (${result.status}). Open settingsUrl manually.` }) };
}

export async function closeInitDashboards() {
  for (const pending of dashboards.values()) {
    const dashboard = await pending.catch(() => null);
    dashboard?.server.close();
    dashboard?.server.closeAllConnections?.();
  }
  dashboards.clear();
}
