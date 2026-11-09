#!/bin/bash
# Sets up the self-hosted macOS runner ouo11y-mac-1 on this Mac (project/kb-archive/ci-runners.md, macOS section).
#
#   sudo RUNNER_TOKEN="$(gh api -X POST orgs/ouo11y/actions/runners/registration-token --jq .token)" \
#     bash .github/scripts/setup-mac-runner.sh
#
# - User ouo-runner: hidden, no password (cannot log in), its own primary group (not staff), so jobs
#   cannot read your home folder. The script refuses to go on if it can.
# - Runner v2.338.2 (osx-arm64, sha256 checked) in /Users/ouo-runner/actions-runner, labels
#   self-hosted,macOS,ARM64. One job at a time.
# - LaunchDaemon com.ouo11y.actions-runner: starts at boot without a login, runs as ouo-runner at
#   nice 10 with low-priority I/O so your apps win the CPU and disk.
# Re-running skips every step that is already done, but it restarts the daemon, which kills a
# job in flight: re-run it when the runner is idle.
set -euo pipefail

RUNNER_USER=ouo-runner
RUNNER_NAME=ouo11y-mac-1
VERSION=2.338.2
SHA256=25a065af409ffa317ab4d5a3b614dd15fc9c40f2172bc1b35a1b1258e919a388
HOME_DIR=/Users/$RUNNER_USER
DIR=$HOME_DIR/actions-runner
LABEL=com.ouo11y.actions-runner
PLIST=/Library/LaunchDaemons/$LABEL.plist
RUNNER_PATH=/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin

[[ $EUID -eq 0 ]] || { echo "run with sudo" >&2; exit 1; }
ADMIN=${SUDO_USER:?run with sudo from your own account}
cd /   # the caller's folder may be one ouo-runner cannot enter (sudo keeps it)
as_runner() { sudo -u "$RUNNER_USER" -H env HOME="$HOME_DIR" PATH="$RUNNER_PATH" "$@"; }

# 1. User and group.
if ! dscl . -read "/Groups/$RUNNER_USER" >/dev/null 2>&1; then
  gid=$(( $(dscl . -list /Groups PrimaryGroupID | awk '$2 >= 600 && $2 < 1000 {print $2}' | sort -n | tail -1) + 1 ))
  (( gid > 600 )) || gid=601
  dscl . -create "/Groups/$RUNNER_USER"
  dscl . -create "/Groups/$RUNNER_USER" PrimaryGroupID "$gid"
  dscl . -create "/Groups/$RUNNER_USER" RealName "ouo CI runner"
fi
gid=$(dscl . -read "/Groups/$RUNNER_USER" PrimaryGroupID | awk '{print $2}')
if ! id "$RUNNER_USER" >/dev/null 2>&1; then
  uid=$(( $(dscl . -list /Users UniqueID | awk '$2 >= 600 && $2 < 1000 {print $2}' | sort -n | tail -1) + 1 ))
  (( uid > 600 )) || uid=601
  dscl . -create "/Users/$RUNNER_USER"
  dscl . -create "/Users/$RUNNER_USER" UniqueID "$uid"
  dscl . -create "/Users/$RUNNER_USER" PrimaryGroupID "$gid"
  dscl . -create "/Users/$RUNNER_USER" RealName "ouo CI runner"
  dscl . -create "/Users/$RUNNER_USER" UserShell /bin/bash
  dscl . -create "/Users/$RUNNER_USER" NFSHomeDirectory "$HOME_DIR"
  dscl . -create "/Users/$RUNNER_USER" Password '*'
  dscl . -create "/Users/$RUNNER_USER" IsHidden 1
fi
if [[ ! -d $HOME_DIR ]]; then
  mkdir -p "$HOME_DIR"
  chown "$RUNNER_USER:$RUNNER_USER" "$HOME_DIR"
  chmod 700 "$HOME_DIR"
fi
# Isolation check: the runner must not see into the admin's home.
if dsmemberutil checkmembership -U "$RUNNER_USER" -G staff | grep -q 'is a member'; then
  echo "$RUNNER_USER is a member of staff: stopping" >&2; exit 1
fi
if as_runner ls "/Users/$ADMIN" >/dev/null 2>&1; then
  echo "$RUNNER_USER can list /Users/$ADMIN: stopping" >&2; exit 1
fi
echo "ok: $RUNNER_USER (uid $(id -u "$RUNNER_USER"), group $RUNNER_USER) cannot read /Users/$ADMIN"

# 2. Runner package.
if [[ ! -x $DIR/config.sh ]]; then
  tgz=$(mktemp -d /private/tmp/ouo-runner.XXXXXX)/actions-runner.tar.gz   # not root's $TMPDIR: ouo-runner must reach it
  curl -fsSL -o "$tgz" "https://github.com/actions/runner/releases/download/v$VERSION/actions-runner-osx-arm64-$VERSION.tar.gz"
  echo "$SHA256  $tgz" | shasum -a 256 -c -
  as_runner mkdir -p "$DIR"
  chmod 644 "$tgz"; chmod 755 "$(dirname "$tgz")"
  as_runner tar xzf "$tgz" -C "$DIR"
  rm -rf "$(dirname "$tgz")"
fi

# 3. Registration (org runner, default group).
if [[ ! -f $DIR/.runner ]]; then
  : "${RUNNER_TOKEN:?set RUNNER_TOKEN (see the usage line at the top)}"
  (cd "$DIR" && as_runner ./config.sh --unattended --url https://github.com/ouo11y \
    --token "$RUNNER_TOKEN" --name "$RUNNER_NAME" --work _work --replace)
fi
as_runner sh -c "printf '%s\n' '$RUNNER_PATH' > '$DIR/.path'"

# 4. LaunchDaemon.
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>UserName</key><string>$RUNNER_USER</string>
  <key>GroupName</key><string>$RUNNER_USER</string>
  <key>ProgramArguments</key><array><string>$DIR/run.sh</string></array>
  <key>WorkingDirectory</key><string>$DIR</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key><string>$HOME_DIR</string>
    <key>USER</key><string>$RUNNER_USER</string>
    <key>PATH</key><string>$RUNNER_PATH</string>
    <key>LANG</key><string>en_US.UTF-8</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>Nice</key><integer>10</integer>
  <key>LowPriorityIO</key><true/>
  <key>StandardOutPath</key><string>$DIR/_diag/launchd.log</string>
  <key>StandardErrorPath</key><string>$DIR/_diag/launchd.log</string>
</dict>
</plist>
EOF
chown root:wheel "$PLIST"; chmod 644 "$PLIST"
as_runner mkdir -p "$DIR/_diag"
launchctl bootout "system/$LABEL" 2>/dev/null || true
launchctl bootstrap system "$PLIST"
launchctl enable "system/$LABEL"
sleep 5
launchctl print "system/$LABEL" | grep -E '^\s*(state|pid) ='
echo "done: $RUNNER_NAME should show online at https://github.com/organizations/ouo11y/settings/actions/runners"
