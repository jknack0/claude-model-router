#!/bin/sh
# Installs the claude-model-router plugin into Claude Code.
#   curl -fsSL https://raw.githubusercontent.com/jknack0/claude-model-router/master/install.sh | bash
#   ./install.sh --local        install from this clone instead of GitHub
# Flags: --local  --statusline  --no-statusline  --uninstall
set -eu

MARKET=claude-model-router
PLUGIN=router@claude-model-router
GH_REPO=jknack0/claude-model-router
LOCAL=0
UNINSTALL=0
STATUS=ask

for a in "$@"; do
  case $a in
    --local) LOCAL=1 ;;
    --statusline) STATUS=yes ;;
    --no-statusline) STATUS=no ;;
    --uninstall) UNINSTALL=1 ;;
    -h | --help) sed -n '2,5p' "$0"; exit 0 ;;
    *) echo "install.sh: unknown flag $a" >&2; exit 2 ;;
  esac
done

say() { printf '%s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }

command -v claude >/dev/null 2>&1 || { echo "install.sh: 'claude' (Claude Code) is not on PATH. Install it first: https://docs.claude.com/claude-code" >&2; exit 1; }
: "${HOME:?HOME is not set}"

CLAUDE_DIR=$HOME/.claude
DATA=$CLAUDE_DIR/router
SETTINGS=$CLAUDE_DIR/settings.json
KNOWN=$CLAUDE_DIR/plugins/known_marketplaces.json
INSTALLED=$CLAUDE_DIR/plugins/installed_plugins.json
SHIM_CMD='sh ~/.claude/router/statusline.sh'

# Where this script lives, when it is run from a clone (not under curl | bash).
CLONE=
case $0 in
  */*) d=$(cd "${0%/*}" 2>/dev/null && pwd -P) || d=
       if [ -n "$d" ] && [ -f "$d/.claude-plugin/marketplace.json" ] && [ -d "$d/plugin" ]; then CLONE=$d; fi ;;
esac
if [ "$LOCAL" = 1 ] && [ -z "$CLONE" ]; then
  echo "install.sh: --local needs to run from a clone of the repo (./install.sh --local)." >&2
  exit 1
fi

# Any node on PATH, for the JSON edits (plus the Node 22+ finder, below).
JSNODE=$(command -v node 2>/dev/null || true)

# Prints "github:<repo>", "directory:<path>" or nothing for the registered source of our marketplace.
registered_source() {
  [ -n "$JSNODE" ] && [ -f "$KNOWN" ] || return 0
  "$JSNODE" -e '
    try {
      const m = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))[process.argv[2]];
      const s = m && m.source;
      if (s && s.source === "github") console.log("github:" + s.repo);
      else if (s && s.source === "directory") console.log("directory:" + s.path);
      else if (s) console.log(String(s.source) + ":" + (s.url || s.repo || s.path || ""));
    } catch {}
  ' "$KNOWN" "$MARKET" 2>/dev/null || true
}

installed_path() {
  [ -n "$JSNODE" ] && [ -f "$INSTALLED" ] || return 0
  "$JSNODE" -e '
    try {
      const e = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).plugins[process.argv[2]] || [];
      const p = e.find((x) => x && x.installPath);
      if (p) console.log(p.installPath);
    } catch {}
  ' "$INSTALLED" "$PLUGIN" 2>/dev/null || true
}

# Edits settings.json. $1 = add | remove. Prints one word: added, exists, other, removed, none, bad.
edit_statusline() {
  "$JSNODE" -e '
    const fs = require("fs");
    const [file, mode, cmd] = process.argv.slice(1);
    let raw = null, s = {};
    try { raw = fs.readFileSync(file, "utf8"); s = JSON.parse(raw || "{}"); } catch (e) { if (raw !== null) { console.log("bad"); process.exit(0); } }
    const cur = s.statusLine && s.statusLine.command;
    const ours = typeof cur === "string" && cur.includes("router/statusline.sh");
    if (mode === "add") {
      if (cur && !ours) { console.log("other"); process.exit(0); }
      if (ours) { console.log("exists"); process.exit(0); }
      if (raw !== null) fs.writeFileSync(file + ".router-bak", raw);
      else fs.mkdirSync(require("path").dirname(file), { recursive: true });
      s.statusLine = { type: "command", command: cmd };
      fs.writeFileSync(file, JSON.stringify(s, null, 2) + "\n");
      console.log("added");
    } else {
      if (!ours) { console.log("none"); process.exit(0); }
      fs.writeFileSync(file + ".router-bak", raw);
      delete s.statusLine;
      fs.writeFileSync(file, JSON.stringify(s, null, 2) + "\n");
      console.log("removed");
    }
  ' "$SETTINGS" "$1" "$SHIM_CMD"
}

# ---------- uninstall ----------
if [ "$UNINSTALL" = 1 ]; then
  claude plugin uninstall "$PLUGIN" || warn "could not uninstall $PLUGIN (not installed?)"
  claude plugin marketplace remove "$MARKET" || warn "could not remove marketplace $MARKET (not registered?)"
  if [ -n "$JSNODE" ] && [ -f "$SETTINGS" ]; then
    r=$(edit_statusline remove)
    case $r in
      removed) say "Removed the router statusline from $SETTINGS (backup: $SETTINGS.router-bak)." ;;
      bad) warn "$SETTINGS is not valid JSON; left alone." ;;
    esac
  fi
  rm -f "$DATA/statusline.sh" "$DATA/statusline.mjs" "$DATA/node-path"
  say "Uninstalled. Your data in $DATA (ledger, policy, learnings) is kept; delete it by hand if you want it gone."
  exit 0
fi

# ---------- 2. Node 22+ ----------
FIND=
[ -n "$CLONE" ] && FIND=$CLONE/plugin/bin/find-node
NODE22=
if [ -n "$FIND" ]; then NODE22=$(sh "$FIND" 2>/dev/null || true); fi
if [ -n "$FIND" ] && [ -z "$NODE22" ]; then
  warn "no Node 22+ found. The plugin installs, but its hooks do nothing until Node exists."
  warn "Install it: brew install node, or nvm install 22, or https://nodejs.org. Set ROUTER_NODE to pin one."
fi

# ---------- 3. marketplace ----------
if [ "$LOCAL" = 1 ]; then WANT_ID=directory:$CLONE; WANT_ARG=$CLONE; else WANT_ID=github:$GH_REPO; WANT_ARG=$GH_REPO; fi
HAVE=$(registered_source)
if [ -z "$HAVE" ] && [ -z "$JSNODE" ] && [ -d "$CLAUDE_DIR/plugins" ]; then
  warn "no node on PATH, so the registered marketplace source can't be checked."
fi
GH_HTTPS=https://github.com/$GH_REPO.git
# The owner/repo shorthand clones over SSH; machines without GitHub SSH keys fall back to the https URL.
add_market() {
  if [ "$LOCAL" = 1 ]; then
    claude plugin marketplace add "$WANT_ARG"
  elif ! claude plugin marketplace add "$WANT_ARG"; then
    say "Adding $WANT_ARG failed (SSH clone?); trying $GH_HTTPS."
    claude plugin marketplace add "$GH_HTTPS"
  fi
}
if [ "$HAVE" = "$WANT_ID" ] || { [ "$LOCAL" = 0 ] && [ "$HAVE" = "git:$GH_HTTPS" ]; }; then
  claude plugin marketplace update "$MARKET"
elif [ -n "$HAVE" ]; then
  say "Marketplace $MARKET is registered from $HAVE; switching it to $WANT_ID."
  claude plugin marketplace remove "$MARKET"
  add_market
else
  add_market
fi

# ---------- 4. plugin ----------
if claude plugin list 2>/dev/null | grep -q "$PLUGIN"; then
  claude plugin update "$PLUGIN"
else
  claude plugin install "$PLUGIN" --scope user --config "data_dir=$HOME/.claude/router"
fi

# Curl mode: the Node finder comes from the installed plugin.
if [ -z "$FIND" ]; then
  ip=$(installed_path)
  if [ -n "$ip" ] && [ -f "$ip/bin/find-node" ]; then
    FIND=$ip/bin/find-node
    NODE22=$(sh "$FIND" 2>/dev/null || true)
  fi
  if [ -z "$NODE22" ]; then
    warn "no Node 22+ found. The plugin installs, but its hooks do nothing until Node exists."
    warn "Install it: brew install node, or nvm install 22, or https://nodejs.org. Set ROUTER_NODE to pin one."
  fi
fi
if [ -n "$NODE22" ]; then
  mkdir -p "$DATA" && printf '%s\n' "$NODE22" > "$DATA/node-path"
  JSNODE=$NODE22
fi

# ---------- 5. statusline ----------
write_shim() {
  mkdir -p "$DATA"
  cat > "$DATA/statusline.mjs" <<'SHIM'
// Finds the installed router plugin and runs its statusline. Prints nothing if it is not installed.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
try {
  const file = path.join(os.homedir(), '.claude/plugins/installed_plugins.json');
  const entries = JSON.parse(fs.readFileSync(file, 'utf8')).plugins?.['router@claude-model-router'] ?? [];
  const e = entries.find((x) => x?.installPath);
  if (e) await import(pathToFileURL(path.join(e.installPath, 'scripts/statusline.mjs')).href);
} catch {}
SHIM
  cat > "$DATA/statusline.sh" <<'SHIM'
#!/bin/sh
d=$HOME/.claude/router
n=
if [ -n "${ROUTER_NODE:-}" ] && [ -x "$ROUTER_NODE" ]; then n=$ROUTER_NODE
elif [ -r "$d/node-path" ]; then read -r n < "$d/node-path" || :
fi
[ -x "$n" ] || n=$(command -v node 2>/dev/null) || exit 0
exec "$n" "$d/statusline.mjs"
SHIM
}

want_statusline=0
case $STATUS in
  yes) want_statusline=1 ;;
  no) ;;
  ask)
    if [ -t 0 ]; then
      printf 'Add the router statusline to %s? [y/N] ' "$SETTINGS"
      read -r ans || ans=
    elif ( : < /dev/tty ) 2>/dev/null; then
      printf 'Add the router statusline to %s? [y/N] ' "$SETTINGS" > /dev/tty
      read -r ans < /dev/tty || ans=
    else
      ans=
      say "Skipping the statusline (no terminal to ask). Re-run with --statusline to add it."
    fi
    case ${ans:-} in y | Y | yes | YES) want_statusline=1 ;; esac
    ;;
esac

if [ "$want_statusline" = 1 ]; then
  if [ -z "$JSNODE" ]; then
    warn "no Node found, so the statusline was not added."
  else
    write_shim
    r=$(edit_statusline add)
    case $r in
      added) say "Statusline added to $SETTINGS (backup: $SETTINGS.router-bak)." ;;
      exists) say "Statusline already set up." ;;
      other)
        warn "$SETTINGS already has a different statusLine; left it alone. To use the router's, set:"
        say "  \"statusLine\": {\"type\": \"command\", \"command\": \"$SHIM_CMD\"}" ;;
      bad) warn "$SETTINGS is not valid JSON; statusline not added." ;;
    esac
  fi
fi

# ---------- 6. next steps ----------
cat <<'DONE'

Installed. Next:
  1. Start a new Claude Code session. The first one builds your spend baseline in the background.
  2. Run /router:init to review it, then /router:report.
  3. At work, check /status for allowManagedHooksOnly: if set, plugin hooks won't run
     (/router:report and /router:retro still work).
DONE
