import type { Platform } from "./types";

const INSTALL_BASE = "https://raw.githubusercontent.com/jaylordibe/taymna/main/install";

/**
 * The address agents use to reach the API. Kept separate from API_URL (the
 * address this browser uses) because they routinely differ: the dashboard
 * may be on localhost or a LAN IP while agents come in through a tunnel or
 * a public hostname. `||` rather than `??` so an empty build arg counts as
 * unset.
 */
export const AGENT_SERVER_URL =
  process.env.NEXT_PUBLIC_AGENT_SERVER_URL ||
  process.env.NEXT_PUBLIC_API_URL ||
  "http://localhost:3000";

/** The one-line installer for a platform, pre-filled with server and token. */
export function installCommand(platform: Platform, token: string): string {
  if (platform === "WINDOWS") {
    return `$env:TAYMNA_SERVER = '${AGENT_SERVER_URL}'; $env:TAYMNA_TOKEN = '${token}'; irm ${INSTALL_BASE}/install.ps1 | iex`;
  }
  return `curl -fsSL ${INSTALL_BASE}/install.sh | sudo TAYMNA_SERVER=${AGENT_SERVER_URL} TAYMNA_TOKEN=${token} bash`;
}

export function installHint(platform: Platform): string {
  return platform === "WINDOWS"
    ? "Run in PowerShell opened as Administrator on the machine."
    : "Run in a terminal on the machine (it will ask for your sudo password).";
}
