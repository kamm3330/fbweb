#!/bin/bash
# ============================================================
#  FBWeb: FreeBASIC-Laufzeitbibliotheken mit FBWeb-Patch bauen
#  und in die vorhandene FreeBASIC-Installation kopieren.
#
#  Gepatcht werden nur die Bibliotheken (libfb*, libfbgfx*), nicht der
#  Compiler. Die Originale werden einmalig nach .../orig/ gesichert.
#
#  Aufruf:   ./build-and-install.sh            (bauen + installieren)
#            ./build-and-install.sh --restore  (Originale zurückspielen)
# ============================================================
set -euo pipefail
cd "$(dirname "$0")"

VER=1.10.1
SRC=FreeBASIC-$VER-source
PATCH=fbweb-freebasic-$VER.patch
LIB=/usr/local/lib/freebasic/linux-x86_64
FILES="libfb.a libfbmt.a libfbpic.a libfbmtpic.a fbrt0.o fbrt0pic.o libfbgfx.a libfbgfxmt.a libfbgfxpic.a libfbgfxmtpic.a"

if [ "${1:-}" = "--restore" ]; then
    for f in $FILES; do command cp -f "$LIB/orig/$f" "$LIB/$f"; done
    echo "Original-Bibliotheken wiederhergestellt."
    exit 0
fi

if [ ! -d "$SRC" ]; then
    [ -f src.tar.xz ] || curl -sL -o src.tar.xz \
        "https://sourceforge.net/projects/fbc/files/FreeBASIC-$VER/Source/$SRC.tar.xz/download"
    tar xf src.tar.xz
    (cd "$SRC" && patch -p1 < "../$PATCH")
fi

make -C "$SRC" rtlib gfxlib2 -j"$(nproc)"

mkdir -p "$LIB/orig"
for f in $FILES; do
    [ -f "$LIB/orig/$f" ] || command cp -f "$LIB/$f" "$LIB/orig/$f"
    command cp -f "$SRC/lib/freebasic/linux-x86_64/$f" "$LIB/$f"
done
echo "FBWeb-Bibliotheken installiert nach $LIB (Originale in $LIB/orig)."
