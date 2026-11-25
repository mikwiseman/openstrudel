#!/bin/sh
# Runs inside the disposable builder. The only host output is one file in /export.
set -eu
target=$1
root=$2
revision=$3
git init -q /work/src
cd /work/src
# Read the mounted snapshot's objects in place. Repacking a media-heavy repository
# would consume the same space twice before Gradle even starts.
printf '%s\n' /wolf-source/objects > .git/objects/info/alternates
if [ -f /wolf-source/shallow ]; then cp /wolf-source/shallow .git/shallow; fi
git -c core.hooksPath=/dev/null checkout -q --detach "$revision"
test "$(git rev-parse HEAD)" = "$revision"
cd "/work/src/$root"
case "$target" in
  android)
    ./gradlew --no-daemon --max-workers=2 :app:assembleDebug
    set -- app/build/outputs/apk/debug/*.apk
    test "$#" -eq 1 && test -s "$1"
    /opt/android/build-tools/36.0.0/apksigner verify "$1"
    cp -- "$1" /export/artifact
    ;;
  web)
    npm ci --no-audit --no-fund
    npm run build
    test -s dist/index.html
    cd dist
    zip -q -r /export/artifact.zip .
    mv /export/artifact.zip /export/artifact
    ;;
  *) exit 2 ;;
esac
