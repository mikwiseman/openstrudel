/** A Home preference. Codex owns both execution and automatic review. */
export const approvalModes = ["ask", "auto", "approve_all"] as const;
export type ApprovalMode = typeof approvalModes[number];
export const approvalSetting = "agents.approval_mode";
export const isApprovalMode = (value: unknown): value is ApprovalMode => approvalModes.includes(value as ApprovalMode);
export const readApprovalMode = (value: unknown): ApprovalMode => isApprovalMode(value) ? value : "ask";

export function nativeApprovalPolicy(mode: ApprovalMode, group = false) {
  return {
    approvalPolicy: mode === "approve_all" ? "never" : group
      // A Telegram participant cannot escalate the host's filesystem access.
      // This must be enforced before AutoReview, not in a UI request callback.
      ? { granular: { sandbox_approval: false, rules: false, skill_approval: false, request_permissions: false, mcp_elicitations: true } }
      : "on-request",
    approvalsReviewer: mode === "auto" ? "auto_review" : "user",
  };
}

/** Only approval defaults change. Tool allowlists, credentials and explicit
 * per-tool/managed restrictions remain Codex's own configuration. */
export function nativeApprovalConfig(mode: ApprovalMode, settings: Record<string, any>, plugins: Record<string, string[]> = {}) {
  const behavior = mode === "approve_all" ? "approve" : "prompt";
  const config: Record<string, unknown> = {
    "apps._default.default_tools_approval_mode": behavior,
    "apps._default.approvals_reviewer": mode === "auto" ? "auto_review" : "user",
  };
  const names = new Set(Object.keys(settings.mcp_servers ?? {}));
  for (const key of Object.keys(settings)) if (/^mcp_servers\.[a-zA-Z0-9_-]+$/.test(key)) names.add(key.slice("mcp_servers.".length));
  // App-server config keys are dotted paths, not TOML-quoted paths.
  for (const name of names) config[`mcp_servers.${name}.default_tools_approval_mode`] = behavior;
  for (const [plugin, servers] of Object.entries(plugins)) for (const server of servers)
    config[`plugins.${plugin}.mcp_servers.${server}.default_tools_approval_mode`] = behavior;
  return config;
}
