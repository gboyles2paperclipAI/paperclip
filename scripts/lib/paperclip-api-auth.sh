#!/usr/bin/env bash

# Source-only helper. It never prints or resolves credential values. Callers
# supply PAPERCLIP_API_KEY through their normal environment/secret_ref path.
# PAPERCLIP_AUTH_HEADER and PAPERCLIP_COOKIE remain compatibility paths for
# interactive operator smoke runs; new non-session callers should use the key.

paperclip__freeze_timeout_constant() {
  local name="$1"
  local expected="$2"
  local declaration=""
  declaration="$(declare -p "$name" 2>/dev/null || true)"

  if [[ "$declaration" =~ ^declare\ -[^[:space:]]*r ]]; then
    if [[ "${!name}" != "$expected" ]]; then
      printf 'Paperclip auth helper timeout constant %s was already frozen to an unexpected value.\n' "$name" >&2
      return 1
    fi
  else
    printf -v "$name" '%s' "$expected"
    readonly "$name"
  fi
  export -n "$name" 2>/dev/null || true

  if [[ ! "${!name}" =~ ^[1-9][0-9]*$ ]]; then
    printf 'Paperclip auth helper timeout constant %s is invalid.\n' "$name" >&2
    return 1
  fi
}

paperclip__freeze_timeout_constant _PAPERCLIP_AUTH_CONNECT_TIMEOUT_SECONDS 10 || return 1
paperclip__freeze_timeout_constant _PAPERCLIP_AUTH_HEALTH_TIMEOUT_SECONDS 30 || return 1
paperclip__freeze_timeout_constant _PAPERCLIP_AUTH_REQUEST_TIMEOUT_SECONDS 300 || return 1
unset -f paperclip__freeze_timeout_constant

paperclip__trim_to_var() {
  local value="$1"
  local target="$2"
  while [[ "$value" == [[:space:]]* ]]; do value="${value:1}"; done
  while [[ "$value" == *[[:space:]] ]]; do value="${value:0:${#value}-1}"; done
  printf -v "$target" '%s' "$value"
}

paperclip__escape_curl_config_to_var() {
  local value="$1"
  local target="$2"
  if [[ "$value" == *$'\r'* || "$value" == *$'\n'* ]]; then
    return 1
  fi
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  printf -v "$target" '%s' "$value"
}

paperclip_cleanup_protected_auth() {
  local xtrace_was_enabled=0
  case "$-" in *x*) xtrace_was_enabled=1; set +x ;; esac
  if [[ -n "${PAPERCLIP_PROTECTED_CURL_CONFIG:-}" ]]; then
    rm -f -- "$PAPERCLIP_PROTECTED_CURL_CONFIG"
  fi
  PAPERCLIP_PROTECTED_CURL_CONFIG=""
  PAPERCLIP_HAS_PROTECTED_AUTH=0
  PAPERCLIP_PROTECTED_AUTH_PREPARED=0
  if (( xtrace_was_enabled )); then set -x; fi
}

paperclip_prepare_protected_auth() {
  local xtrace_was_enabled=0
  case "$-" in *x*) xtrace_was_enabled=1; set +x ;; esac

  local api_key="${PAPERCLIP_API_KEY:-}"
  local legacy_header="${PAPERCLIP_AUTH_HEADER:-}"
  local cookie="${PAPERCLIP_COOKIE:-}"
  local auth_header=""
  local escaped_header=""
  local escaped_cookie=""
  local config_path=""
  local previous_umask=""
  local status=0

  if [[ -n "${PAPERCLIP_PROTECTED_CURL_CONFIG:-}" ]]; then
    rm -f -- "$PAPERCLIP_PROTECTED_CURL_CONFIG"
  fi

  paperclip__trim_to_var "$api_key" api_key
  paperclip__trim_to_var "$legacy_header" legacy_header
  paperclip__trim_to_var "$cookie" cookie

  PAPERCLIP_PROTECTED_CURL_CONFIG=""
  PAPERCLIP_HAS_PROTECTED_AUTH=0
  PAPERCLIP_PROTECTED_AUTH_PREPARED=0

  if [[ -n "$api_key" ]]; then
    auth_header="Authorization: Bearer ${api_key}"
  elif [[ -n "$legacy_header" ]]; then
    auth_header="Authorization: ${legacy_header}"
  fi

  if [[ -n "$auth_header" || -n "$cookie" ]]; then
    if ! paperclip__escape_curl_config_to_var "$auth_header" escaped_header \
      || ! paperclip__escape_curl_config_to_var "$cookie" escaped_cookie; then
      status=1
    else
      previous_umask="$(umask)"
      umask 077
      config_path="$(mktemp "${TMPDIR:-/tmp}/paperclip-curl-auth.XXXXXX")" || status=1
      umask "$previous_umask"
    fi
  fi

  if (( status == 0 )) && [[ -n "$config_path" ]]; then
    {
      if [[ -n "$escaped_header" ]]; then
        printf 'header = "%s"\n' "$escaped_header"
      fi
      if [[ -n "$escaped_cookie" ]]; then
        printf 'header = "Cookie: %s"\n' "$escaped_cookie"
      fi
    } > "$config_path" || status=1
    chmod 600 "$config_path" || status=1
  fi

  if (( status == 0 )) && [[ -n "$config_path" ]]; then
    PAPERCLIP_PROTECTED_CURL_CONFIG="$config_path"
    PAPERCLIP_HAS_PROTECTED_AUTH=1
  elif [[ -n "$config_path" ]]; then
    rm -f -- "$config_path"
  fi
  if (( status == 0 )); then
    PAPERCLIP_PROTECTED_AUTH_PREPARED=1
  fi

  api_key=""
  legacy_header=""
  cookie=""
  auth_header=""
  escaped_header=""
  escaped_cookie=""

  if (( xtrace_was_enabled )); then set -x; fi
  if (( status != 0 )); then
    printf '%s\n' 'Could not prepare protected Paperclip API authentication.' >&2
  fi
  return "$status"
}

paperclip_require_api_key() {
  local xtrace_was_enabled=0
  case "$-" in *x*) xtrace_was_enabled=1; set +x ;; esac

  local api_key="${PAPERCLIP_API_KEY:-}"
  paperclip__trim_to_var "$api_key" api_key
  local status=0
  if [[ -z "$api_key" ]]; then status=1; fi
  api_key=""

  if (( xtrace_was_enabled )); then set -x; fi
  if (( status != 0 )); then
    printf '%s\n' 'PAPERCLIP_API_KEY is required for this Paperclip API request.' >&2
  fi
  return "$status"
}

paperclip_require_protected_auth_for_mode() {
  local deployment_mode="$1"
  paperclip__trim_to_var "$deployment_mode" deployment_mode
  case "$deployment_mode" in
    local_trusted)
      return 0
      ;;
    authenticated)
      if [[ "${PAPERCLIP_HAS_PROTECTED_AUTH:-0}" != "1" ]]; then
        printf '%s\n' \
          'PAPERCLIP_API_KEY is required for protected Paperclip API requests in authenticated mode.' >&2
        return 1
      fi
      ;;
    *)
      printf '%s\n' 'Paperclip health returned an unsupported deployment mode.' >&2
      return 1
      ;;
  esac
}

paperclip_resolve_api_url() {
  local api_url="$1"
  local request_url="$2"
  local xtrace_was_enabled=0
  case "$-" in *x*) xtrace_was_enabled=1; set +x ;; esac

  local resolved=""
  local status=0
  resolved="$(
    PAPERCLIP_AUTH_BASE_URL="$api_url" PAPERCLIP_AUTH_REQUEST_URL="$request_url" \
      node -e '
        const base = new URL(process.env.PAPERCLIP_AUTH_BASE_URL);
        const request = new URL(process.env.PAPERCLIP_AUTH_REQUEST_URL, base);
        if (!["http:", "https:"].includes(base.protocol) || base.username || base.password) process.exit(2);
        if (!["http:", "https:"].includes(request.protocol) || request.username || request.password) process.exit(2);
        if (request.origin !== base.origin) process.exit(3);
        process.stdout.write(request.href);
      '
  )" || status=$?

  if (( xtrace_was_enabled )); then set -x; fi
  if (( status != 0 )); then
    printf '%s\n' 'Refusing a Paperclip API request outside the configured HTTP(S) origin.' >&2
    return 1
  fi
  printf '%s\n' "$resolved"
}

paperclip_protected_curl() {
  local api_url="$1"
  local request_url="$2"
  shift 2

  # This is intentionally a semantic request interface, not a curl-argument
  # passthrough. Keep the accepted fields closed so callers cannot enable curl
  # tracing, redirects, extra transfers, alternate configs, proxies, or URLs.

  if [[ "${PAPERCLIP_PROTECTED_AUTH_PREPARED:-0}" != "1" ]]; then
    printf '%s\n' 'Protected Paperclip API authentication was not prepared.' >&2
    return 1
  fi

  local method="GET"
  local output_file=""
  local write_http_code=0
  local json_data=""
  local has_json_data=0
  local run_id=""
  local browser_origin=""
  while (( $# > 0 )); do
    case "$1" in
      --method)
        [[ $# -ge 2 ]] || { printf '%s\n' 'Missing protected Paperclip request method.' >&2; return 1; }
        method="$2"
        shift 2
        ;;
      --output)
        [[ $# -ge 2 ]] || { printf '%s\n' 'Missing protected Paperclip response output path.' >&2; return 1; }
        output_file="$2"
        shift 2
        ;;
      --write-http-code)
        write_http_code=1
        shift
        ;;
      --json-data)
        [[ $# -ge 2 ]] || { printf '%s\n' 'Missing protected Paperclip JSON request body.' >&2; return 1; }
        json_data="$2"
        has_json_data=1
        shift 2
        ;;
      --run-id)
        [[ $# -ge 2 ]] || { printf '%s\n' 'Missing protected Paperclip run id.' >&2; return 1; }
        run_id="$2"
        shift 2
        ;;
      --browser-origin)
        [[ $# -ge 2 ]] || { printf '%s\n' 'Missing protected Paperclip browser origin.' >&2; return 1; }
        browser_origin="$2"
        shift 2
        ;;
      *)
        printf '%s\n' 'Refusing an unsupported protected Paperclip request option.' >&2
        return 1
        ;;
    esac
  done

  case "$method" in
    GET|POST|PUT|PATCH|DELETE) ;;
    *)
      printf '%s\n' 'Refusing an unsupported protected Paperclip request method.' >&2
      return 1
      ;;
  esac
  if [[ "$output_file" == *$'\r'* || "$output_file" == *$'\n'* ]]; then
    printf '%s\n' 'Refusing an invalid protected Paperclip response output path.' >&2
    return 1
  fi
  if [[ "$run_id" == *$'\r'* || "$run_id" == *$'\n'* ]]; then
    printf '%s\n' 'Refusing an invalid protected Paperclip run id.' >&2
    return 1
  fi
  if [[ -n "$browser_origin" ]]; then
    if [[ "$browser_origin" == *$'\r'* || "$browser_origin" == *$'\n'* ]] \
      || ! PAPERCLIP_AUTH_BROWSER_ORIGIN="$browser_origin" node -e '
        try {
          const url = new URL(process.env.PAPERCLIP_AUTH_BROWSER_ORIGIN);
          if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) process.exit(2);
        } catch {
          process.exit(2);
        }
      '; then
      printf '%s\n' 'Refusing an invalid protected Paperclip browser origin.' >&2
      return 1
    fi
  fi

  local resolved_url=""
  resolved_url="$(paperclip_resolve_api_url "$api_url" "$request_url")" || return 1

  local -a curl_args=(
    --disable
    --silent
    --show-error
    --request "$method"
  )
  if [[ -n "$output_file" ]]; then
    curl_args+=(--output "$output_file")
  fi
  if (( write_http_code )); then
    curl_args+=(--write-out '%{http_code}')
  fi
  if [[ -n "${PAPERCLIP_PROTECTED_CURL_CONFIG:-}" ]]; then
    curl_args+=(--config "$PAPERCLIP_PROTECTED_CURL_CONFIG")
  fi
  curl_args+=(
    --connect-timeout "$_PAPERCLIP_AUTH_CONNECT_TIMEOUT_SECONDS"
    --max-time "$_PAPERCLIP_AUTH_REQUEST_TIMEOUT_SECONDS"
    --max-redirs 0
    --noproxy '*'
    --proto '=http,https'
  )
  if [[ -n "$run_id" ]]; then
    curl_args+=(--header "X-Paperclip-Run-Id: $run_id")
  fi
  if [[ -n "$browser_origin" ]]; then
    curl_args+=(
      --header "Origin: $browser_origin"
      --header "Referer: ${browser_origin%/}/"
    )
  fi
  if (( has_json_data )); then
    curl_args+=(
      --header 'Content-Type: application/json'
      --data-raw "$json_data"
    )
  fi
  curl_args+=("$resolved_url")
  command curl "${curl_args[@]}"
}

paperclip_public_health_preflight() {
  local api_url="$1"
  local health_url=""
  health_url="$(paperclip_resolve_api_url "$api_url" "/api/health")" || return 1

  local temp_dir=""
  local previous_umask="$(umask)"
  umask 077
  temp_dir="$(mktemp -d "${TMPDIR:-/tmp}/paperclip-health.XXXXXX")" || {
    umask "$previous_umask"
    return 1
  }
  umask "$previous_umask"

  local metadata=""
  local status=0
  metadata="$(
    command curl --disable -sS \
      --connect-timeout "$_PAPERCLIP_AUTH_CONNECT_TIMEOUT_SECONDS" \
      --max-time "$_PAPERCLIP_AUTH_HEALTH_TIMEOUT_SECONDS" \
      --max-redirs 0 \
      --noproxy '*' \
      --proto '=http,https' \
      -D "$temp_dir/headers" \
      -o "$temp_dir/body" \
      -w '%{http_code}\n%{url_effective}\n' \
      "$health_url"
  )" || status=1

  local http_code="${metadata%%$'\n'*}"
  local effective_url="${metadata#*$'\n'}"
  effective_url="${effective_url%%$'\n'*}"
  if (( status == 0 )) && [[ "$http_code" != "200" ]]; then status=1; fi
  if (( status == 0 )); then
    paperclip_resolve_api_url "$api_url" "$effective_url" >/dev/null || status=1
  fi

  local content_type=""
  if (( status == 0 )); then
    content_type="$(awk 'BEGIN { IGNORECASE=1 } /^content-type:/ { value=$0; sub(/^[^:]*:[[:space:]]*/, "", value); sub(/\r$/, "", value) } END { print value }' "$temp_dir/headers")"
    if [[ ! "$content_type" =~ ^application/([a-zA-Z0-9!#$\&^_.+-]+\+)?json([[:space:]]*\;|$) ]]; then
      status=1
    fi
  fi

  local parsed=""
  if (( status == 0 )); then
    parsed="$(node -e '
      const fs = require("node:fs");
      const body = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      if (!body || typeof body !== "object" || Array.isArray(body)) process.exit(2);
      const mode = typeof body.deploymentMode === "string" ? body.deploymentMode.trim() : "";
      const exposure = typeof body.deploymentExposure === "string" ? body.deploymentExposure.trim() : "unknown";
      process.stdout.write(`${mode}\n${exposure}\n`);
    ' "$temp_dir/body")" || status=1
  fi

  if (( status == 0 )); then
    PAPERCLIP_DEPLOYMENT_MODE="${parsed%%$'\n'*}"
    PAPERCLIP_DEPLOYMENT_EXPOSURE="${parsed#*$'\n'}"
    PAPERCLIP_DEPLOYMENT_EXPOSURE="${PAPERCLIP_DEPLOYMENT_EXPOSURE%%$'\n'*}"
  fi

  rm -rf -- "$temp_dir"
  if (( status != 0 )); then
    printf '%s\n' 'Paperclip public health preflight failed.' >&2
    return 1
  fi
}
