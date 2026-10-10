#!/bin/bash
# Install agentboard as a systemd user service running the release binary.
#
# The release (bin/agentboard + dist/client) is installed under
# ~/.agentboard/app — the same root the in-app updater owns — downloading the
# latest platform tarball when nothing is installed yet. The unit runs the
# binary directly (no bun, no source checkout) with Restart=always so the
# service comes back after a clean exit, which is what lets a completed
# self-update restart the deployment.

set -e

SERVICE_NAME="agentboard.service"
USER_SYSTEMD_DIR="$HOME/.config/systemd/user"
AGENTBOARD_DIR="$HOME/.agentboard"
APP_DIR="$AGENTBOARD_DIR/app"
BIN_PATH="$APP_DIR/bin/agentboard"

# PATH for the tmux windows and agent CLIs the sessions launch; bun is no
# longer required to run the server itself, so it is only prepended when
# present.
EXTRA_PATH="$HOME/.local/bin:$HOME/bin:/usr/local/bin:/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin"
BUN_PATH="$(command -v bun || true)"
if [ -n "$BUN_PATH" ]; then
    EXTRA_PATH="$(dirname "$BUN_PATH"):$EXTRA_PATH"
fi

# --- Install the release binary unless one is already present.
if [ ! -x "$BIN_PATH" ]; then
    case "$(uname -s)/$(uname -m)" in
        Linux/x86_64)  PLATFORM="linux-x64" ;;
        Linux/aarch64|Linux/arm64) PLATFORM="linux-arm64" ;;
        Darwin/arm64)  PLATFORM="darwin-arm64" ;;
        Darwin/x86_64) PLATFORM="darwin-x64" ;;
        *) echo "Error: unsupported platform $(uname -s)/$(uname -m)"; exit 1 ;;
    esac
    TARBALL="agentboard-$PLATFORM.tar.gz"
    echo "Downloading latest release ($TARBALL) to $APP_DIR"
    mkdir -p "$APP_DIR"
    TMP_TARBALL="$(mktemp "${AGENTBOARD_DIR}/install-XXXXXX.tar.gz")"
    trap 'rm -f "$TMP_TARBALL"' EXIT
    curl -fsSL "https://github.com/MotusLabs/kawai/releases/latest/download/$TARBALL" -o "$TMP_TARBALL"
    tar -xzf "$TMP_TARBALL" -C "$APP_DIR"
    rm -f "$TMP_TARBALL"
    trap - EXIT
fi

echo "Installing $SERVICE_NAME with:"
echo "  Binary:  $BIN_PATH"
echo "  Root:    $APP_DIR"

# --- Generate the service file directly into the user unit directory (the
# git checkout is never a write target).
mkdir -p "$USER_SYSTEMD_DIR"
cat > "$USER_SYSTEMD_DIR/$SERVICE_NAME" << EOF
[Unit]
Description=Agentboard - Terminal session dashboard
After=network.target

[Service]
Type=simple
WorkingDirectory=$APP_DIR
ExecStart=$BIN_PATH
Restart=always
RestartSec=5
Environment=NODE_ENV=production
Environment=AGENTBOARD_SYSTEMD_UNIT=$SERVICE_NAME
Environment=PATH=$EXTRA_PATH

[Install]
WantedBy=default.target
EOF

# Reload systemd
systemctl --user daemon-reload

# Enable and start the service
systemctl --user enable "$SERVICE_NAME"
systemctl --user start "$SERVICE_NAME"

echo ""
echo "Agentboard service installed and started!"
echo ""
echo "Useful commands:"
echo "  systemctl --user status agentboard   # Check status"
echo "  systemctl --user restart agentboard  # Restart"
echo "  systemctl --user stop agentboard     # Stop"
