# GitHub repositories

People with access to a Home can ask its assistant about the team's GitHub repositories and ask it to change them. The assistant uses three Home tools:

- `github_repositories` lists the repositories the Home's GitHub App can open.
- `github_checkout` clones a repository into the current chat's workspace, at `github/<owner>/<repo>`, so the model can read the code, edit it, and run the tests and the build in its sandbox.
- `github_open_pull_request` publishes one branch from that copy and opens a pull request into the default branch. If a pull request for the branch is already open, the tool pushes the new commits and returns that pull request.

A person reviews and merges every pull request on GitHub. The Home never merges.

## Setup

Each Home uses its own GitHub App, and the operator sets it up once:

- Create a private GitHub App with two repository permissions, Contents read and write and Pull requests read and write. GitHub adds Metadata read by itself. The App needs no webhook.
- Generate a private key and install the App on the repositories the team may use.
- Put two files in the Home's `.data/github` folder. The first is `app.json` with `{"clientId": "<the App's client ID>"}`, and the second is `private-key.pem` with mode 600.

The tools appear only on a Home that has both files. On Wolf the App is "WAI Wolf", owned by mikwiseman.

## Who can use the tools

Paired owners and the people on the Home's access list can use the tools in their own requests. That covers a private chat with the bot, the OpenStrudel app, and their own messages in a group. Scheduled runs, other people in a group and paused groups get no GitHub tools. The Home checks access again on every call and once more right before it pushes, so removing someone from the access list stops a request that is already running.

## How the Home keeps the key away from the model

The model works only inside its sandbox, and the Home process holds the App's key. The rules are:

- For each step the Home creates a token that covers one repository and only the permissions of that step, and GitHub expires the token within an hour. Git gets the token as a request header in its environment, so the token is never written to disk, and the copy in the workspace keeps no credentials.
- The Home pushes only a branch whose name starts with `wolf/`. It never pushes the default branch or any other branch, and it never pushes with force. The App has no permission for workflow files, so GitHub refuses a push that changes `.github/workflows`.
- The Home never runs Git inside the copy, because the model controls the copy's Git configuration and hooks. To publish, the Home creates an empty repository of its own and fetches the branch from the copy through Git's upload-pack. Git keeps upload-pack safe to run against untrusted repositories, so settings such as `core.fsmonitor`, hooks and `uploadpack.packObjectsHook` in the copy never run. The Home then pushes from its own repository.
- The Home refuses a copy when a folder on the path to it was replaced by a link, or when its Git store points to other storage.
- Commits made in a copy carry the App's bot account as the author. The Home adds the name of the person who asked to the end of the pull request description.

A branch pushed by the Home can still run the repository's existing GitHub Actions, as a branch from any collaborator would. The bot cannot change the workflow files themselves.

## Limits

- On each checkout the Home deletes copies that nobody opened or published for seven days. The branches already pushed stay on GitHub.
- The Home makes no new copy when the workspace volume has less than 20 GB free.
- The sandbox has Node.js, npm, corepack for pnpm and Yarn, Python 3 without pip, Git and ripgrep. It has no compilers, Xcode, Flutter, Android SDK or Ruby. For those projects the assistant still makes the change and opens the pull request, and the project's CI or a Mac runs the checks.
- Cloning or pushing a large repository can take several minutes. The per-turn tool bridge allows 30 minutes for one call.

`tests/github.test.ts` covers access, cloning without credentials, the branch rules, a copy with hostile Git settings and hooks, replaced folders and the cleanup of old copies. It uses local repositories and a fake GitHub API.
