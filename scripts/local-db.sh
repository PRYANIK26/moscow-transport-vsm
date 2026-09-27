#!/usr/bin/env bash
set -euo pipefail
project_dir="$(cd "$(dirname "$0")/.." && pwd)"
vsm_pg_bin="${VSM_PG_BIN:-/usr/lib/postgresql/17/bin}"
vsm_pg_port="${VSM_PG_PORT:-55432}"
vsm_pg_data="$project_dir/.runtime/pg"
vsm_pg_socket="$project_dir/.runtime/pg-socket"
if [[ ! -x "$vsm_pg_bin/pg_ctl" ]]; then
  echo "PostgreSQL 17 binaries missing. Set VSM_PG_BIN or use compose." >&2
  exit 1
fi
case "${1:-start}" in
  start)
    mkdir -p "$vsm_pg_data" "$vsm_pg_socket"
    chmod 700 "$project_dir/.runtime" "$vsm_pg_data" "$vsm_pg_socket"
    if [[ ! -f "$vsm_pg_data/PG_VERSION" ]]; then
      "$vsm_pg_bin/initdb" -D "$vsm_pg_data" --username=vsm --auth-local=trust --auth-host=trust --encoding=UTF8 --no-locale > "$project_dir/.runtime/pg-init.log"
    fi
    if ! "$vsm_pg_bin/pg_ctl" -D "$vsm_pg_data" status >/dev/null 2>&1; then
      "$vsm_pg_bin/pg_ctl" -D "$vsm_pg_data" -l "$project_dir/.runtime/pg.log" -o "-p $vsm_pg_port -h 127.0.0.1 -k $vsm_pg_socket" -w start
    fi
    if [[ "$("$vsm_pg_bin/psql" -h 127.0.0.1 -p "$vsm_pg_port" -U vsm -d postgres -Atqc "SELECT 1 FROM pg_database WHERE datname='vsm'")" != "1" ]]; then
      "$vsm_pg_bin/createdb" -h 127.0.0.1 -p "$vsm_pg_port" -U vsm vsm
    fi
    echo "VSM development PostgreSQL ready on 127.0.0.1:$vsm_pg_port (isolated local demo cluster)."
    ;;
  stop)
    if [[ -f "$vsm_pg_data/PG_VERSION" ]] && "$vsm_pg_bin/pg_ctl" -D "$vsm_pg_data" status >/dev/null 2>&1; then
      "$vsm_pg_bin/pg_ctl" -D "$vsm_pg_data" -m fast -w stop
    fi
    ;;
  status) "$vsm_pg_bin/pg_ctl" -D "$vsm_pg_data" status ;;
  *) echo "Usage: bash scripts/local-db.sh start|stop|status" >&2; exit 2 ;;
esac
