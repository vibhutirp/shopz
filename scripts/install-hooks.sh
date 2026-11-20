#!/usr/bin/env bash
# Installs a pre-push hook that runs the publish check. Usage: bash scripts/install-hooks.sh
set -euo pipefail
ROOT="$(git rev-parse --show-toplevel)"
HOOK="$ROOT/.git/hooks/pre-push"
cat > "$HOOK" <<'EOF'
#!/usr/bin/env bash
exec bash "$(git rev-parse --show-toplevel)/scripts/publish-check.sh"
EOF
chmod +x "$HOOK"
echo "pre-push hook installed: $HOOK"
