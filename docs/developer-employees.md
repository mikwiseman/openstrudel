# Developer employees

An owner can connect an existing source checkout to an employee, then ask that employee to change the project in its private Telegram chat or the app. The request runs through the existing message queue and native Codex app-server. Codex owns its thread, tools, edits, tests, approvals and delegation. OpenStrudel supplies the trusted checkout and records the result; it does not start a second execution loop or create a Codex desktop chat.

Project access is limited to interactive owner-private requests. A shared Telegram group, another participant, an operational administrator or a scheduled run does not receive the project's filesystem grant, including when the employee is bound to that group. Queued Telegram work rechecks its sender and paused-chat state before execution. Existing access to ordinary employee chat does not grant project access.

## Registration contract

Only the authenticated owner API may register a filesystem path. A model cannot register or invent one. `MessageService.projects` exposes these methods for the HTTP handlers:

```ts
// canManageAccount comes from the server's authenticated device/owner check.
messages.projects.read(canManageAccount);
await messages.projects.save({
  revision: 0, id: null, name: "My project",
  path: "/canonical/existing/source-checkout", enabled: true,
}, canManageAccount);
messages.projects.bind({
  revision: 1, employeeId: "existing-employee-id", projectId: "returned-project-id",
}, canManageAccount);
```

Use `GET /v1/settings/projects` to read the catalog, `POST /v1/settings/projects` to save a registration, and `POST /v1/profiles/:id/project` to bind it. The server supplies the path employee ID and authenticated owner flag, never a `byOwner` value from the request body. Bind accepts `{revision, projectId}`; `projectId: null` disconnects. The root employee ID is `main`.

Every save/bind uses the latest catalog revision; a stale revision returns 409. Save accepts `id: null` for a new project or the existing ID to update/disable it. An idle employee may also be bound through the owner-only `bind_employee_project` tool after `list_projects`. This uses registered IDs and affects the next request, never the current sandbox. Busy employees and checkouts reject binding/registration changes.

Registration requires a canonical Git checkout root with an existing commit. Symlink aliases, Home's private data, credential directories and installed `.app` bundles are rejected. The checkout's device/inode and Git common directory are checked again when work starts. A replaced or redirected repository must be reconnected. Register a separate source checkout for Home self-improvement, not its installed Runtime or its live data directory.

## Execution and evidence

The native Codex thread uses the registered checkout as `cwd`. Its existing audience workspace and the checkout/Git metadata receive write access; existing source reads and native approval rules remain. The project revision participates in the thread's configuration and identity. A changed or removed binding resumes the existing native history with updated instructions and permissions.

One active Home turn may write a checkout at a time, even across different employees and conversations in that Home process. This lease does not lock out a human editor, another Home process, or a deliberately detached command. Codex must inspect pre-existing changes and follow the repository's branch/worktree instructions without resetting others' work. Different registered checkouts can run independently.

`read_project_result` returns the actual before/after Git HEAD, branch and dirty state, native thread ID, observed completed command item IDs, command hashes, status/exit codes, and successful native `create_pull_request` result URLs. Hashes avoid duplicating potentially sensitive command arguments; use the native item ID for its command details. Up to 100 command receipts are retained, with truncation explicitly marked. A PR created through shell remains visible in native command history but is not independently labeled as verified by this receipt.

A completed turn does not mean tests passed. Nonzero command results remain failures; unavailable Git readback is marked unverified. Assistant prose cannot create a test or PR receipt. The receipt covers the native events observed by the parent turn, not unobserved helper commands or deployment health. Interrupted requests are not replayed; inspect Git and the native history before requesting a retry.

## Self-improvement and release

Standing configuration changes continue to use existing tools such as `update_employee`, model settings and schedules. Code changes use the registered source checkout, its AGENTS.md, native Codex tools, relevant tests, and the repository's normal review/release process. An active turn must not restart or replace the Home executing it. There is no new self-update endpoint, deployment runner, recurring automation, paid service, or shortcut around native approvals.

Live Telegram execution and a real project PR/deployment still require acceptance against the intended Home and checkout. Protocol tests validate the pinned Codex app-server without inference; isolated Git tests validate registration, leases, access and receipts without modifying a real project.
