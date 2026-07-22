#!/bin/sh
set -eu

LDAP_SERVER_URL=${LDAP_SERVER_URL:-ldaps://ldap-server:636}
LDAP_BIND_DN=${LDAP_BIND_DN:-cn=admin,dc=ing,dc=local}
LDAP_BIND_PASSWORD=${LDAP_BIND_PASSWORD:-admin}
LDAP_BASE_DN=${LDAP_BASE_DN:-ou=users,dc=ing,dc=local}
LDAP_VERIFY_CERTS=${LDAP_VERIFY_CERTS:-false}

CONFIG_FILE=/config/config.yaml
if [ -f "$CONFIG_FILE" ]; then
  parse_value() {
    awk "BEGIN { in=0 }
      /^ldap:/ { in=1; next }
      /^[^[:space:]]/ { in=0 }
      in && /^[[:space:]]*${1}:/ {
        gsub(/^[[:space:]]*${1}:[[:space:]]*/, "")
        gsub(/^['\"]|['\"]$/, "")
        print
      }" "$CONFIG_FILE"
  }

  LDAP_SERVER_URL=$(parse_value serverUrl || echo "$LDAP_SERVER_URL")
  LDAP_BIND_DN=$(parse_value bindDn || echo "$LDAP_BIND_DN")
  LDAP_BIND_PASSWORD=$(parse_value bindPassword || echo "$LDAP_BIND_PASSWORD")
  LDAP_BASE_DN=$(parse_value baseDn || echo "$LDAP_BASE_DN")
  LDAP_VERIFY_CERTS=$(parse_value verifyCertificates || echo "$LDAP_VERIFY_CERTS")
fi

if [ "$LDAP_VERIFY_CERTS" = "false" ]; then
  export LDAPTLS_REQCERT=never
fi

printf '[LDAP-TEST] LDAP endpoint: %s\n' "$LDAP_SERVER_URL"
printf '[LDAP-TEST] Bind DN: %s\n' "$LDAP_BIND_DN"
printf '[LDAP-TEST] Base DN: %s\n' "$LDAP_BASE_DN"
printf '[LDAP-TEST] Verify certs: %s\n' "$LDAP_VERIFY_CERTS"

apk add --no-cache openldap-clients openssl >/dev/null 2>&1

printf '\n[LDAP-TEST] Checking LDAPS certificate chain...\n'
openssl s_client -connect "$(printf '%s' "$LDAP_SERVER_URL" | sed -E 's#^ldaps?://##')" -servername ldap-server -showcerts </dev/null 2>/tmp/openssl.log || true

echo '\n[LDAP-TEST] Attempting LDAP bind as admin...'
ldapwhoami -x -H "$LDAP_SERVER_URL" -D "$LDAP_BIND_DN" -w "$LDAP_BIND_PASSWORD"

echo '\n[LDAP-TEST] Running LDAP search for ada.lovelace...'
ldapsearch -x -H "$LDAP_SERVER_URL" -D "$LDAP_BIND_DN" -w "$LDAP_BIND_PASSWORD" -b "$LDAP_BASE_DN" '(uid=ada.lovelace)' uid

printf '\n[LDAP-TEST] Completed.\n'
