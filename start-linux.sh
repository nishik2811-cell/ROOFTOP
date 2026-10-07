#!/bin/sh
# Linux: double-click or run ./start-linux.sh. Needs Java 22 or newer (https://adoptium.net).
cd "$(dirname "$0")" && exec java src/rooftop/Main.java
