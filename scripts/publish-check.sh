#!/usr/bin/env bash
# Shopz publish check – run before every push (installed as pre-push hook by scripts/install-hooks.sh).
# Fails if a file that would be published contains a secret, a private term, or if a commit
# carries an unexpected author. Private terms live in .publish-denylist (gitignored, one per line).
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

RED=$'\033[31m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; RESET=$'\033[0m'
fail=0
note() { printf '%s\n' "$*"; }
bad() { printf '%s✗ %s%s\n' "$RED" "$*" "$RESET"; fail=1; }

# Files that would be published: tracked + untracked-but-not-ignored (binary files skipped by grep -I).
mapfile -t FILES < <(git ls-files -co --exclude-standard | grep -v -E '^(node_modules/|\.publish-denylist$)' || true)
note "Checking ${#FILES[@]} files …"

# 1) Files that must never be published.
for f in "${FILES[@]}"; do
  case "$f" in
    .env|*/.env|.env.*|*/.env.*) [[ "$f" == *.env.example ]] || bad "env file would be published: $f" ;;
    *.pem|*.key|*id_rsa*|*id_ed25519*|*.p12|*.pfx) bad "key material would be published: $f" ;;
  esac
done

# 2) Secret patterns (generic, safe to keep in the repo).
SECRET_PATTERNS=(
  'AKIA[0-9A-Z]{16}'
  'ASIA[0-9A-Z]{16}'
  '(aws_secret_access_key|aws_session_token)[[:space:]]*[:=][[:space:]]*[^[:space:]]{8,}'
  '-----BEGIN [A-Z ]*PRIVATE KEY-----'
  'mongodb(\+srv)?://[^[:space:]/:@]+:[^[:space:]@]+@'
  'gh[pousr]_[A-Za-z0-9]{30,}'
  'github_pat_[A-Za-z0-9_]{20,}'
  'xox[abprs]-[A-Za-z0-9-]{10,}'
  'sk-[A-Za-z0-9_-]{20,}'
  'AIza[0-9A-Za-z_-]{35}'
  'eyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{10,}'
  '(api[_-]?key|secret|token|password)[\"'"'"']?[[:space:]]*[:=][[:space:]]*[\"'"'"'][A-Za-z0-9_/+=-]{16,}[\"'"'"']'
)
for pat in "${SECRET_PATTERNS[@]}"; do
  hits=$(printf '%s\0' "${FILES[@]}" | xargs -0 grep -I -n -E -- "$pat" 2>/dev/null | grep -v -E '^scripts/publish-check\.sh:' || true)
  [[ -n "$hits" ]] && bad "secret pattern /$pat/:"$'\n'"$(printf '%s\n' "$hits" | cut -c1-160)"
done

# 3) Values that only belong to one machine: absolute home paths, e-mail addresses, IPv4 addresses.
hits=$(printf '%s\0' "${FILES[@]}" | xargs -0 grep -I -n -E -- '(/home/[a-z]|/Users/[A-Za-z]|/root/|C:\\Users\\)' 2>/dev/null | grep -v -E '^scripts/publish-check\.sh:' || true)
[[ -n "$hits" ]] && bad "absolute user paths:"$'\n'"$(printf '%s\n' "$hits" | cut -c1-160)"

hits=$(printf '%s\0' "${FILES[@]}" | xargs -0 grep -I -n -o -E -- '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}' 2>/dev/null \
  | grep -v -E '@(example\.(com|org|net)|shopz\.invalid)$' \
  | grep -v -E '^package-lock\.json:' \
  | grep -v -E ':(git@github\.com|[^:]*@aws-sdk|[^:]*@smithy)' || true)
[[ -n "$hits" ]] && bad "e-mail addresses (use name@example.com):"$'\n'"$(printf '%s\n' "$hits" | cut -c1-160)"

hits=$(printf '%s\0' "${FILES[@]}" | xargs -0 grep -I -n -o -E -- '\b([0-9]{1,3}\.){3}[0-9]{1,3}\b' 2>/dev/null \
  | grep -v -E ':(127\.0\.0\.1|0\.0\.0\.0|255\.255\.255\.[0-9]+)$' \
  | grep -v -E '^package-lock\.json:' || true)
# four-part version strings would also match; review the list if it fires.
[[ -n "$hits" ]] && bad "IPv4 addresses:"$'\n'"$(printf '%s\n' "$hits" | head -20 | cut -c1-160)"

# 4) The lockfile must only point at the public npm registry.
if [[ -f package-lock.json ]]; then
  hits=$(grep -n -o -E '"resolved": "https?://[^/"]+' package-lock.json | grep -v 'https://registry.npmjs.org' || true)
  [[ -n "$hits" ]] && bad "package-lock.json resolves from a non-public registry:"$'\n'"$(printf '%s\n' "$hits" | head -5)"
fi

# 5) Private terms from the local denylist (company, people, internal tools, hosts).
#    Short all-alphanumeric terms (≤ 4 chars) match as whole words, everything else as substring.
DENY="$ROOT/.publish-denylist"
if [[ -f "$DENY" ]]; then
  terms=0
  while IFS= read -r raw || [[ -n "$raw" ]]; do
    term="${raw%%#*}"; term="$(printf '%s' "$term" | sed -E 's/^[[:space:]]+|[[:space:]]+$//g')"
    [[ -z "$term" ]] && continue
    terms=$((terms + 1))
    if [[ ${#term} -le 4 && "$term" =~ ^[A-Za-z0-9]+$ ]]; then mode=(-w); else mode=(); fi
    hits=$(printf '%s\0' "${FILES[@]}" | grep -z -v -x -F 'package-lock.json' | xargs -0 grep -I -n -i -F "${mode[@]}" -- "$term" 2>/dev/null || true)
    [[ -n "$hits" ]] && bad "private term #$terms found:"$'\n'"$(printf '%s\n' "$hits" | cut -c1-160)"
    # file names, too
    names=$(printf '%s\n' "${FILES[@]}" | grep -i -F "${mode[@]}" -- "$term" || true)
    [[ -n "$names" ]] && bad "private term #$terms in a file name: $names"
    # commit messages and commit identities
    if git rev-parse --verify -q HEAD >/dev/null; then
      msg=$(git log --format='%H %an <%ae> %cn <%ce> %s%n%b' | grep -i -F "${mode[@]}" -- "$term" || true)
      [[ -n "$msg" ]] && bad "private term #$terms in git history:"$'\n'"$(printf '%s\n' "$msg" | head -5 | cut -c1-160)"
    fi
  done < "$DENY"
  note "Denylist: $terms terms checked."
else
  printf '%s! no .publish-denylist – only generic checks ran%s\n' "$YELLOW" "$RESET"
fi

# 6) Commit identities: every commit must use the neutral team identity.
EXPECTED_ID="${SHOPZ_COMMIT_ID:-Shopz Team <team@shopz.invalid>}"
if [[ "${SHOPZ_SKIP_IDENTITY:-}" != "1" ]] && git rev-parse --verify -q HEAD >/dev/null; then
  ids=$(git log --format='%an <%ae>%n%cn <%ce>' | sort -u | grep -v -x -F "$EXPECTED_ID" || true)
  [[ -n "$ids" ]] && bad "unexpected commit identity (expected '$EXPECTED_ID'):"$'\n'"$ids"
  trailers=$(git log --format='%b' | grep -i -E '^(signed-off-by|co-authored-by):' | sort -u | grep -v -i -E 'noreply@anthropic\.com|@shopz\.invalid|@example\.com' || true)
  [[ -n "$trailers" ]] && bad "unexpected commit trailers:"$'\n'"$trailers"
fi

if [[ $fail -ne 0 ]]; then
  printf '%sPublish check FAILED – nothing should be pushed until this is clean.%s\n' "$RED" "$RESET"
  exit 1
fi
printf '%s✓ Publish check passed.%s\n' "$GREEN" "$RESET"
