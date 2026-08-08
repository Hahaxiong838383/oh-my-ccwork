#!/bin/sh
set -eu

package=${1:?backup package path is required}
private_key=${2:?private key path is required}
result_dir=${3:?result directory is required}
work_dir=$(mktemp -d "${TMPDIR:-/tmp}/ontology-offsite-verify.XXXXXX")

cleanup() {
  rm -rf "$work_dir"
}
trap cleanup EXIT INT TERM

mkdir -p "$result_dir"
chmod 700 "$result_dir"
tar -xzf "$package" -C "$work_dir"
openssl pkeyutl -decrypt -inkey "$private_key" \
  -in "$work_dir/data-key.bin.enc" -out "$work_dir/data-key.bin" \
  -pkeyopt rsa_padding_mode:oaep -pkeyopt rsa_oaep_md:sha256
openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 \
  -in "$work_dir/ontology.sql.gz.enc" -out "$work_dir/ontology.sql.gz" \
  -pass file:"$work_dir/data-key.bin"

expected=$(awk -F= '$1 == "dump_sha256" {print $2}' "$work_dir/manifest.txt")
actual=$(shasum -a 256 "$work_dir/ontology.sql.gz" | awk '{print $1}')
[ "$expected" = "$actual" ] || { echo 'offsite dump checksum mismatch' >&2; exit 3; }
gzip -t "$work_dir/ontology.sql.gz"
gzip -dc "$work_dir/ontology.sql.gz" | grep -q 'CREATE TABLE actions.intents'
gzip -dc "$work_dir/ontology.sql.gz" | grep -q 'CREATE TABLE workflow.tasks'
cp "$work_dir/manifest.txt" "$result_dir/manifest.txt"
cat > "$result_dir/verification.txt" <<EOF
package=$package
checksum_verified=true
gzip_verified=true
schema_actions_intents=true
schema_workflow_tasks=true
logical_dump_recoverable=true
EOF
printf 'verification_dir=%s\nchecksum_verified=true\nlogical_dump_recoverable=true\n' "$result_dir"
