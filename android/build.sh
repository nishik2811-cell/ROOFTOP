#!/bin/sh
# Builds Rooftop.apk without Gradle: aapt2 (resources) -> javac -> d8 (dex) -> zipalign -> apksigner.
# Needs a JDK 17+ and an Android SDK with platforms;android-35 and build-tools;35.0.0.
# Run from the project folder: sh android/build.sh
set -e
cd "$(dirname "$0")/.."
SDK="${ANDROID_HOME:-$HOME/Android/sdk}"
JDK="${JAVA_HOME:-$(ls -d "$HOME"/Android/jdk-* 2>/dev/null | head -1)}"
BT="$SDK/build-tools/35.0.0"
PLATFORM="$SDK/platforms/android-35/android.jar"
OUT=android/build
export PATH="$JDK/bin:$PATH"

[ -f "$PLATFORM" ] || { echo "Android platform missing: $PLATFORM"; exit 1; }
[ -x "$JDK/bin/javac" ] || { echo "JDK with javac not found (set JAVA_HOME)"; exit 1; }

rm -rf "$OUT"
mkdir -p "$OUT/gen" "$OUT/classes" "$OUT/assets/web"
cp web/index.html web/style.css web/app.js web/e2e.js web/display.woff2 "$OUT/assets/web/"

echo "1/5 resources"
"$BT/aapt2" compile --dir android/res -o "$OUT/res.zip"
"$BT/aapt2" link -o "$OUT/base.apk" -I "$PLATFORM" --manifest android/AndroidManifest.xml \
    --java "$OUT/gen" -A "$OUT/assets" "$OUT/res.zip"

echo "2/5 compile (shared Rooftop code + Android screens)"
SHARED=$(find src/rooftop -name '*.java' ! -name Main.java ! -name DesktopPlatform.java ! -name SelfTest.java \
    ! -path '*/cli/*' ! -path '*/ui/*')
javac -nowarn --release 17 -classpath "$PLATFORM" -d "$OUT/classes" $(find "$OUT/gen" android/src -name '*.java') $SHARED

echo "3/5 dex"
"$BT/d8" --min-api 29 --lib "$PLATFORM" --output "$OUT" $(find "$OUT/classes" -name '*.class')

echo "4/5 package"
cp "$OUT/base.apk" "$OUT/unsigned.apk"
python3 -c "import zipfile,sys; zipfile.ZipFile(sys.argv[1],'a').write(sys.argv[2],'classes.dex')" "$OUT/unsigned.apk" "$OUT/classes.dex"
"$BT/zipalign" -f -p 4 "$OUT/unsigned.apk" "$OUT/aligned.apk"

echo "5/5 sign"
KEY=android/rooftop-release.keystore # keep this file: Android only accepts updates signed with the same key
[ -f "$KEY" ] || keytool -genkeypair -keystore "$KEY" -storepass rooftop -keypass rooftop -alias rooftop \
    -keyalg EC -groupname secp256r1 -validity 10000 -dname "CN=Rooftop" >/dev/null
"$BT/apksigner" sign --ks "$KEY" --ks-pass pass:rooftop --key-pass pass:rooftop --out Rooftop.apk "$OUT/aligned.apk"
"$BT/apksigner" verify Rooftop.apk
ls -lh Rooftop.apk
