# Server shell

A Home runs in a container and cannot reach the server it runs on. For that reason the assistant cannot update the Home, restart a service or look at the server's logs, even when the owner asks for it in their own chat.

The server shell changes this for one owner on one server. After you install it, the owner can ask the assistant to run any command on the server as root, and to update the Home to the latest version.

## What it gives

- `run_server_command`. The assistant runs a shell command as root on the server and gets back the exit code and the end of the output. A command can also run in the background. Its result then arrives in the chat as a message when the command ends, even if the Home restarted in between.
- `openstrudel-update`. This command updates the Home to the latest `main` of this repository. The assistant runs it in the background when the owner asks for an update, for example after a pull request is merged.

## Who can use it

The assistant has the tool only in these turns:

- a message from a Telegram user named at installation, in their private chat with the bot. The person must also have paired that chat with the Home;
- a message from one of the owner's devices in the app.

Nobody has it in a group, including the owner. Schedules, automatic runs, other people with access and Home administrators do not have it. The Home checks this on every call.

## What you accept

Read this before you install it.

- The Home process becomes equal to root on the server. Anything that can write into the Home's data folder can run commands as root. The agents' own sandboxes cannot read or write that folder.
- The assistant decides which commands to run. A web page, a file or an email that the owner asks it to read may try to talk it into a harmful command. In the approval mode "no confirmations" nothing asks the owner first. In the other modes the owner confirms each command.
- A Telegram account named at installation is a root login to this server. Protect it with two-step verification.

Install it only on a server that belongs to this owner and holds nothing that the owner would not trust the assistant with.

## Install

On the server, from the unpacked kit or a checkout of this repository:

```sh
sudo bash deploy/server-shell/install.sh --telegram 123456789
```

Repeat `--telegram` for each person. Without it only the owner's devices in the app have the shell. `--container NAME` selects another Home container; the default is `openstrudel-home-1`. Run the script again to change the list or to install a newer version. The Home sees the change on the next message. It needs no restart.

The script installs a small service, `openstrudel-server-shell`, and the command `openstrudel-update`. It creates the folder `.data/server-shell` on the Home's data volume. The Home writes each command there, the service runs it and writes the result back. No port is opened and no key is created.

## How an update works

`openstrudel-update` does these steps in order. It stops at the first one that fails, and nothing is changed before the switch.

1. It downloads the latest `main` and builds the image from it.
2. It checks that the new image loads.
3. It waits until no chat is working and no schedule is about to run, for up to 30 minutes.
4. It saves a checked copy of the database in `/var/backups/openstrudel-update`. The newest three copies stay.
5. It switches the Home's Compose service to the new image and starts it.
6. It checks that the Home is healthy, that Telegram runs if it ran before, and that no data is missing.
7. If a check fails, it starts the previous image again and says so.

The result arrives in the owner's chat. The previous image stays on the server for a rollback. Other containers and their data are not touched.

## Remove

```sh
sudo systemctl disable --now openstrudel-server-shell
sudo rm -rf /etc/systemd/system/openstrudel-server-shell.service /opt/openstrudel-server-shell /usr/local/bin/openstrudel-update
sudo rm -rf "$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Source}}{{end}}{{end}}' openstrudel-home-1)/.data/server-shell"
```

The tool disappears from the assistant on the next message.
