#!/bin/sh
set -eu

LDAP_BASE_DN="${LDAP_BASE_DN:-dc=ing,dc=local}"
LDAP_ADMIN_DN="${LDAP_ADMIN_DN:-cn=admin,dc=ing,dc=local}"
LDAP_ADMIN_PASSWORD="${LDAP_ADMIN_PASSWORD:-admin}"
LDAP_DATA_DIR="/var/lib/openldap/openldap-data"
LDAP_CONF="/etc/openldap/slapd.conf"

mkdir -p /run/openldap "$LDAP_DATA_DIR"

sed \
  -e "s|{{LDAP_BASE_DN}}|$LDAP_BASE_DN|g" \
  -e "s|{{LDAP_ADMIN_DN}}|$LDAP_ADMIN_DN|g" \
  -e "s|{{LDAP_ADMIN_PASSWORD}}|$LDAP_ADMIN_PASSWORD|g" \
  /etc/openldap/slapd.conf.template > "$LDAP_CONF"

if [ ! -f "$LDAP_DATA_DIR/.initialized" ]; then
  echo "[LDAP] Initializing directory data for $LDAP_BASE_DN"
  rm -rf "$LDAP_DATA_DIR"/*
  for ldif in /bootstrap/*.ldif; do
    if [ -f "$ldif" ]; then
      echo "[LDAP] Loading $ldif"
      slapadd -f "$LDAP_CONF" -l "$ldif"
    fi
  done
  touch "$LDAP_DATA_DIR/.initialized"
fi

echo "[LDAP] Starting OpenLDAP on ldap://0.0.0.0:389 and ldaps://0.0.0.0:636"
exec slapd -f "$LDAP_CONF" -h "ldap://0.0.0.0:389 ldaps://0.0.0.0:636" -d 256
