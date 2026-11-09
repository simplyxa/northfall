#!/usr/bin/env bash
# Расшифровка выгрузки: ./decrypt-export.sh export.key.enc export.tar.gz.enc private.pem out-dir
set -euo pipefail
K="$1"; D="$2"; P="$3"; O="$4"; mkdir -p "$O"
openssl pkeyutl -decrypt -inkey "$P" -pkeyopt rsa_padding_mode:oaep -pkeyopt rsa_oaep_md:sha256 -in "$K" -out "$O/.k"
openssl enc -d -aes-256-cbc -pbkdf2 -pass file:"$O/.k" -in "$D" | tar xz -C "$O"
rm -f "$O/.k"
