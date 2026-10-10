#!/bin/sh
# Build the signed release APK: scripts/release-apk.sh
#
# The signing key stays outside the repo. Gradle reads its location and
# passwords from ~/.gradle/gradle.properties:
#
#   t2hv.storeFile=/path/to/tex2html-viewer-release.jks
#   t2hv.storePassword=...
#   t2hv.keyAlias=tex2html-viewer
#   t2hv.keyPassword=...
#
# Every release must be signed with this same key, or Android refuses to
# install it over the previous one: keep a backup of the keystore and its
# password.
set -e
# the release key's certificate (keytool -list -v)
CERT=62bae7fc2b55094f72714ef316268d5471b946c3e06f94d5c5a8896ed9828c84
cd "$(dirname "$0")/../android"
: "${JAVA_HOME:=/usr/lib/jvm/java-17-openjdk-amd64}"
export JAVA_HOME
./gradlew clean assembleRelease --console=plain -q

version=$(sed -n 's/.*versionName = "\(.*\)".*/\1/p' app/build.gradle.kts)
apk=app/build/outputs/apk/release/app-release.apk
out=app/build/outputs/apk/release/tex2html-viewer-$version.apk
sdk=${ANDROID_HOME:-$(sed -n 's/^sdk.dir=//p' local.properties 2>/dev/null)}
apksigner=$(ls "$sdk"/build-tools/*/apksigner | sort -V | tail -1)
"$apksigner" verify --print-certs "$apk" | grep -q "certificate SHA-256 digest: $CERT" ||
  { echo "the APK is not signed with the release key" >&2; exit 1; }
cp "$apk" "$out"
echo "$out"
