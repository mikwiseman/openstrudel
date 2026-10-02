#!/bin/sh
set -eu
mkdir -p /data
node /opt/openstrudel/scripts/check-sandbox.mjs
exec node /opt/openstrudel/dist/cli.js start
