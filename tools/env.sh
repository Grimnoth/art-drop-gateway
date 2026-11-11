# Sourced by the shell scripts. Reads .env in the repo root with the same rules as pull_update.py:
# a variable that is already set wins, and one pair of surrounding quotes is removed.
load_env() {
  [ -f "$1" ] || return 0
  local key value
  while IFS='=' read -r key value || [ -n "$key" ]; do  # -r keeps backslashes, as pull_update.py does
    key="${key#$'\xef\xbb\xbf'}"  # a byte-order mark, which Python's utf-8-sig also drops
    key="${key//[[:space:]]/}"
    case "$key" in ''|\#*) continue ;; esac
    [[ "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || continue
    value="${value#"${value%%[![:space:]]*}"}"
    value="${value%"${value##*[![:space:]]}"}"
    if [[ "$value" =~ ^\"(.*)\"$ || "$value" =~ ^\'(.*)\'$ ]]; then value="${BASH_REMATCH[1]}"; fi
    [ -n "${!key+x}" ] || export "$key=$value"
  done < "$1"
}
