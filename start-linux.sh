#!/bin/sh
# Linux: double-click or run ./start-linux.sh. Needs Java 22 or newer (https://adoptium.net).
cd "$(dirname "$0")" || exit 1
# a firewall that is on blocks phones and other PCs; say how to let Rooftop through
if grep -qs '^ENABLED=yes' /etc/ufw/ufw.conf; then
  echo "The ufw firewall is on. If phones or other PCs can't connect, run this once:"
  echo "  sudo ufw allow 8443/tcp && sudo ufw allow 45454/udp && sudo ufw allow 45455/tcp"
  echo
elif command -v systemctl >/dev/null 2>&1 && systemctl is-active --quiet firewalld 2>/dev/null; then
  echo "The firewalld firewall is on. If phones or other PCs can't connect, run this once:"
  echo "  sudo firewall-cmd --permanent --add-port=8443/tcp --add-port=45454/udp --add-port=45455/tcp && sudo firewall-cmd --reload"
  echo
fi
exec java src/rooftop/Main.java
