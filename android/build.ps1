# Builds Rooftop.apk on Windows without Gradle: aapt2 -> javac -> d8 -> zipalign -> apksigner.
# Run from project folder: powershell -ExecutionPolicy Bypass -File android/build.ps1
$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

$SDK = if ($env:ANDROID_HOME) { $env:ANDROID_HOME } else { "$env:LOCALAPPDATA\Android\Sdk" }
$BT_DIR = Get-ChildItem "$SDK\build-tools" | Sort-Object Name -Descending | Select-Object -First 1
$PLATFORM_DIR = Get-ChildItem "$SDK\platforms" | Sort-Object Name -Descending | Select-Object -First 1

if (-not $BT_DIR -or -not $PLATFORM_DIR) {
    Write-Error "Android build-tools or platforms not found in $SDK"
    exit 1
}

$BT = $BT_DIR.FullName
$PLATFORM = "$($PLATFORM_DIR.FullName)\android.jar"
$OUT = "android\build"

Write-Host "Using Android SDK: $SDK"
Write-Host "Build tools: $BT"
Write-Host "Platform: $PLATFORM"

if (Test-Path $OUT) { Remove-Item -Recurse -Force $OUT }
New-Item -ItemType Directory -Force "$OUT\gen", "$OUT\classes", "$OUT\assets\web" | Out-Null
Copy-Item "web\index.html", "web\style.css", "web\app.js", "web\e2e.js", "web\display.woff2" "$OUT\assets\web\"

Write-Host "1/5 resources"
& "$BT\aapt2.exe" compile --dir android/res -o "$OUT\res.zip"
& "$BT\aapt2.exe" link -o "$OUT\base.apk" -I $PLATFORM --manifest android/AndroidManifest.xml --java "$OUT\gen" -A "$OUT\assets" "$OUT\res.zip"

Write-Host "2/5 compile (shared Rooftop code + Android screens)"
$SHARED = Get-ChildItem -Recurse -Filter *.java src\rooftop | Where-Object {
    $_.Name -notin @('Main.java', 'DesktopPlatform.java', 'SelfTest.java', 'Benchmark.java') -and
    $_.FullName -notmatch '\\cli\\' -and
    $_.FullName -notmatch '\\ui\\'
} | ForEach-Object { $_.FullName }
$ANDROID_SRC = Get-ChildItem -Recurse -Filter *.java "$OUT\gen", "android\src" | ForEach-Object { $_.FullName }
javac -nowarn --release 17 -classpath $PLATFORM -d "$OUT\classes" ($ANDROID_SRC + $SHARED)

Write-Host "3/5 dex"
$CLASSES = Get-ChildItem -Recurse -Filter *.class "$OUT\classes" | ForEach-Object { $_.FullName }
& "$BT\d8.bat" --min-api 29 --lib $PLATFORM --output $OUT $CLASSES

Write-Host "4/5 package"
Copy-Item "$OUT\base.apk" "$OUT\unsigned.apk" -Force
python -c "import zipfile,sys; zipfile.ZipFile(sys.argv[1],'a').write(sys.argv[2],'classes.dex')" "$OUT\unsigned.apk" "$OUT\classes.dex"
& "$BT\zipalign.exe" -f -p 4 "$OUT\unsigned.apk" "$OUT\aligned.apk"

Write-Host "5/5 sign"
$KEY = "android\rooftop-release.keystore"
if (-not (Test-Path $KEY)) {
    keytool -genkeypair -keystore $KEY -storepass rooftop -keypass rooftop -alias rooftop -keyalg EC -groupname secp256r1 -validity 10000 -dname "CN=Rooftop"
}
& "$BT\apksigner.bat" sign --ks $KEY --ks-pass pass:rooftop --key-pass pass:rooftop --out Rooftop.apk "$OUT\aligned.apk"
& "$BT\apksigner.bat" verify Rooftop.apk

Write-Host "Done! Generated Rooftop.apk:"
Get-Item Rooftop.apk | Select-Object Name, Length, LastWriteTime
