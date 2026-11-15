#!/bin/bash
# ============================================================
#  FBWeb: Debian-/Ubuntu-Paket (.deb) bauen
#
#  Aufruf:   ./build-deb.sh            -> fbweb_<VERSION>_amd64.deb
#
#  Inhalt des Pakets:
#    /usr/lib/fbweb/app/          app.py, static/, beispiele/
#    /usr/lib/fbweb/freebasic/    FreeBASIC 1.10.1 mit FBWeb-Patch (fbc, libs, include)
#    /usr/lib/fbweb/wheels/       Python-Pakete (offline, Python 3.10 - 3.14)
#    /usr/bin/fbweb-fbc           Link auf den gepatchten fbc
#    /etc/fbweb/config.yaml       Konfiguration
#    /lib/systemd/system/fbweb.service
#  Bei der Installation (postinst): Benutzer fbrun, venv in /var/lib/fbweb/venv,
#  Verzeichnisse /srv/fbweb/work und /var/tmp/fbweb, Dienst starten.
#
#  FreeBASIC liegt unter /usr (nicht /usr/local), weil die Sandbox (bubblewrap)
#  nur /usr ins Programm einblendet und fbc dort läuft.
# ============================================================
set -euo pipefail
cd "$(dirname "$0")"
HERE=$PWD
APP=$(dirname "$HERE")
VERSION=${VERSION:-1.0.0}
FB_PREFIX=/usr/local            # vorhandene, gepatchte FreeBASIC-Installation
PIP=${PIP:-$APP/venv/bin/pip}
STAGE=$HERE/build/fbweb_${VERSION}_amd64
OUT=$HERE/fbweb_${VERSION}_amd64.deb

# ---- Python-Wheels (einmalig herunterladen, danach Cache)
if [ ! -d wheels ] || [ -z "$(ls wheels)" ]; then
    mkdir -p wheels
    for v in 3.10 3.11 3.12 3.13 3.14; do
        "$PIP" download -q -d wheels --only-binary=:all: --implementation cp --python-version "$v" \
            --platform manylinux2014_x86_64 --platform manylinux_2_17_x86_64 \
            --platform manylinux_2_28_x86_64 --platform manylinux_2_34_x86_64 -r requirements.txt
    done
fi

# ---- Prüfen, dass die gepatchten Bibliotheken installiert sind
LIBDIR=$FB_PREFIX/lib/freebasic/linux-x86_64
if [ -f "$LIBDIR/orig/libfbgfx.a" ] && cmp -s "$LIBDIR/libfbgfx.a" "$LIBDIR/orig/libfbgfx.a"; then
    echo "FEHLER: $LIBDIR enthält die ORIGINAL-Bibliotheken. Erst fbsrc/build-and-install.sh ausführen." >&2
    exit 1
fi

rm -rf "$HERE/build"
mkdir -p "$STAGE"/{DEBIAN,usr/lib/fbweb/app,usr/lib/fbweb/freebasic/bin,usr/lib/fbweb/freebasic/lib/freebasic,usr/lib/fbweb/freebasic/include,usr/bin,etc/fbweb,lib/systemd/system,usr/share/doc/fbweb}

# ---- App
cp -a "$APP/app.py" "$APP/static" "$APP/beispiele" "$STAGE/usr/lib/fbweb/app/"
sed -i 's#"fbc": "/usr/local/bin/fbc"#"fbc": "/usr/lib/fbweb/freebasic/bin/fbc"#' "$STAGE/usr/lib/fbweb/app/app.py"
cp requirements.txt "$STAGE/usr/lib/fbweb/"
cp -a wheels "$STAGE/usr/lib/fbweb/wheels"

# ---- FreeBASIC (gepatcht)
cp -a "$FB_PREFIX/bin/fbc" "$STAGE/usr/lib/fbweb/freebasic/bin/"
mkdir -p "$STAGE/usr/lib/fbweb/freebasic/lib/freebasic/linux-x86_64"
find "$LIBDIR" -maxdepth 1 -type f -exec cp -a {} "$STAGE/usr/lib/fbweb/freebasic/lib/freebasic/linux-x86_64/" \;
cp -a "$FB_PREFIX/include/freebasic" "$STAGE/usr/lib/fbweb/freebasic/include/"
ln -s ../lib/fbweb/freebasic/bin/fbc "$STAGE/usr/bin/fbweb-fbc"

# ---- Konfiguration
sed -e 's#^\(  fbc:\).*#\1 /usr/lib/fbweb/freebasic/bin/fbc#' \
    -e 's#systemctl restart fbweb#sudo systemctl restart fbweb#' \
    "$APP/config.yaml" > "$STAGE/etc/fbweb/config.yaml"
grep -q '^  fbc: /usr/lib/fbweb/freebasic/bin/fbc' "$STAGE/etc/fbweb/config.yaml"

# ---- systemd
cat > "$STAGE/lib/systemd/system/fbweb.service" <<'EOF'
[Unit]
Description=FBWeb - FreeBASIC Web-IDE
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/usr/lib/fbweb/app
Environment=FBWEB_CONFIG=/etc/fbweb/config.yaml
ExecStart=/var/lib/fbweb/venv/bin/python /usr/lib/fbweb/app/app.py
Restart=on-failure
RestartSec=3
KillMode=control-group

[Install]
WantedBy=multi-user.target
EOF

# ---- Doku
cp "$APP/README.md" "$STAGE/usr/share/doc/fbweb/"
cp "$APP/fbsrc/fbweb-freebasic-1.10.1.patch" "$STAGE/usr/share/doc/fbweb/"
cat > "$STAGE/usr/share/doc/fbweb/copyright" <<'EOF'
FBWeb - FreeBASIC Web-IDE

Enthält FreeBASIC 1.10.1 (https://www.freebasic.net) mit FBWeb-Patch
(fbweb-freebasic-1.10.1.patch). Compiler: GPL-2.0+, Laufzeitbibliotheken:
LGPL-2.1+ mit Linking-Ausnahme. Quellen: https://sourceforge.net/projects/fbc/
CodeMirror 5 und xterm.js: MIT-Lizenz.
EOF

# ---- DEBIAN/control
SIZE=$(du -sk --exclude=DEBIAN "$STAGE" | cut -f1)
cat > "$STAGE/DEBIAN/control" <<EOF
Package: fbweb
Version: $VERSION
Section: devel
Priority: optional
Architecture: amd64
Maintainer: FBWeb <root@localhost>
Installed-Size: $SIZE
Depends: python3 (>= 3.10), python3-venv, gcc, binutils, libc6-dev, libncurses-dev, libgpm-dev, libx11-dev, libxext-dev, libxpm-dev, libxrandr-dev, libxrender-dev, libffi-dev, libgl-dev, bubblewrap, adduser, systemd
Recommends: sshfs, fuse3
Description: FreeBASIC Web-IDE (Editor, Konsole, Grafik im Browser)
 Web-Oberfläche für FreeBASIC auf Port 8090: Editor mit Syntaxfarben,
 Konsole (xterm.js) und Grafik (SCREEN/SCREENRES) direkt im Browser-Canvas
 über einen eigenen gfxlib2-Treiber, ohne X-Server und ohne VNC.
 Enthält FreeBASIC 1.10.1 mit FBWeb-Patch unter /usr/lib/fbweb/freebasic.
EOF

echo "/etc/fbweb/config.yaml" > "$STAGE/DEBIAN/conffiles"

# ---- postinst
cat > "$STAGE/DEBIAN/postinst" <<'EOF'
#!/bin/sh
set -e
[ "$1" = "configure" ] || exit 0

# Benutzer für die FreeBASIC-Programme
if ! getent passwd fbrun >/dev/null; then
    adduser --system --group --no-create-home --home /nonexistent --quiet fbrun
fi

mkdir -p /srv/fbweb/work /srv/fbweb/mnt /var/tmp/fbweb /var/lib/fbweb
chown fbrun:fbrun /srv/fbweb/work /var/tmp/fbweb

# Python-Umgebung (offline aus den mitgelieferten Wheels)
VENV=/var/lib/fbweb/venv
rm -rf "$VENV"
python3 -m venv "$VENV"
if ! "$VENV/bin/pip" install -q --no-index --find-links /usr/lib/fbweb/wheels -r /usr/lib/fbweb/requirements.txt; then
    echo "fbweb: Offline-Installation fehlgeschlagen, versuche Internet (pip) ..."
    "$VENV/bin/pip" install -q -r /usr/lib/fbweb/requirements.txt
fi

# Ubuntu 23.10+: AppArmor verbietet unprivilegierten Benutzern oft User-Namespaces,
# die bubblewrap braucht. Dann ein Profil für /usr/bin/bwrap einrichten.
if [ "$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns 2>/dev/null)" = "1" ] \
   && [ -d /etc/apparmor.d ] && command -v apparmor_parser >/dev/null \
   && ! runuser -u fbrun -- bwrap --ro-bind / / --unshare-all true 2>/dev/null \
   && ! grep -lqs '/usr/bin/bwrap' /etc/apparmor.d/* ; then
    cat > /etc/apparmor.d/fbweb-bwrap <<'AA'
# Angelegt vom Paket fbweb: erlaubt bubblewrap User-Namespaces (Sandbox)
abi <abi/4.0>,
include <tunables/global>

profile fbweb-bwrap /usr/bin/bwrap flags=(unconfined) {
  userns,
  include if exists <local/fbweb-bwrap>
}
AA
    apparmor_parser -r /etc/apparmor.d/fbweb-bwrap || echo "fbweb: AppArmor-Profil konnte nicht geladen werden"
fi

if [ -d /run/systemd/system ]; then
    systemctl daemon-reload
    systemctl enable fbweb.service >/dev/null 2>&1 || true
    systemctl restart fbweb.service || true
fi

IP=$(hostname -I 2>/dev/null | awk '{print $1}')
echo ""
echo "FBWeb ist installiert:  http://${IP:-localhost}:8090"
echo "Konfiguration:          /etc/fbweb/config.yaml  (danach: sudo systemctl restart fbweb)"
echo ""
exit 0
EOF

# ---- prerm
cat > "$STAGE/DEBIAN/prerm" <<'EOF'
#!/bin/sh
set -e
if [ -d /run/systemd/system ] && [ "$1" = "remove" ]; then
    systemctl stop fbweb.service || true
    systemctl disable fbweb.service >/dev/null 2>&1 || true
fi
exit 0
EOF

# ---- postrm
cat > "$STAGE/DEBIAN/postrm" <<'EOF'
#!/bin/sh
set -e
case "$1" in
    remove)
        rm -rf /var/lib/fbweb/venv
        [ -d /run/systemd/system ] && systemctl daemon-reload || true
        ;;
    purge)
        rm -rf /var/lib/fbweb /var/tmp/fbweb
        if [ -f /etc/apparmor.d/fbweb-bwrap ]; then
            apparmor_parser -R /etc/apparmor.d/fbweb-bwrap 2>/dev/null || true
            rm -f /etc/apparmor.d/fbweb-bwrap
        fi
        # /srv/fbweb/work (Programme des Benutzers) und der Benutzer fbrun bleiben erhalten
        ;;
esac
exit 0
EOF

chmod 755 "$STAGE/DEBIAN/postinst" "$STAGE/DEBIAN/prerm" "$STAGE/DEBIAN/postrm"
find "$STAGE" -name '__pycache__' -prune -exec rm -rf {} +

fakeroot dpkg-deb --build -Zxz "$STAGE" "$OUT" >/dev/null
echo "Fertig: $OUT ($(du -h "$OUT" | cut -f1))"
