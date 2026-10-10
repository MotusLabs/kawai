# Systemd User Service

Run agentboard as a persistent systemd user service that starts on boot,
executing the release binary — no bun or source checkout required.

## Prerequisites

- Linux with systemd
- `loginctl enable-linger $USER` (allows user services to run without an active session)

## Installation

```bash
# Enable lingering for your user (required for service to run after logout)
loginctl enable-linger $USER

# Run the install script
./systemd/install.sh
```

The install script will:
1. Install the latest release (`bin/agentboard` + `dist/client`) under
   `~/.agentboard/app`, downloading the platform tarball when nothing is
   installed yet
2. Generate `agentboard.service` in `~/.config/systemd/user` with
   `ExecStart` pointing at the installed binary and `Restart=always`, so the
   service comes back after a clean exit and a completed in-app update can
   restart the deployment
3. Enable and start the service

Self-updates land in the same `~/.agentboard/app` root and restart the unit
through `systemctl --user restart agentboard`.

## Commands

```bash
# Check status
systemctl --user status agentboard

# View logs
journalctl --user -u agentboard -f

# Restart (also how a completed self-update takes over)
systemctl --user restart agentboard

# Stop the service
systemctl --user stop agentboard

# Disable (won't start on boot)
systemctl --user disable agentboard
```

## Uninstall

```bash
systemctl --user stop agentboard
systemctl --user disable agentboard
rm ~/.config/systemd/user/agentboard.service
systemctl --user daemon-reload
```
