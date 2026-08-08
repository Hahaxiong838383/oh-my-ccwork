#!/bin/sh
set -eu

docker_path=/share/CACHEDEV1_DATA/.qpkg/container-station/bin/docker
project_root=${PROJECT_ROOT:-/share/CACHEDEV1_DATA/ai-ontology/foundation}
backup_root=${BACKUP_ROOT:-/share/CACHEDEV2_DATA/ai-ontology-backup}
public_key=${OFFSITE_PUBLIC_KEY:-$project_root/config/offsite-backup-public.pem}
run_id=${OFFSITE_RUN_ID:-$(date +%Y%m%d-%H%M%S)}
work_dir=$backup_root/offsite/staging-$run_id
output_dir=$backup_root/offsite/packages

[ -f "$public_key" ] || { echo 'offsite public key is missing' >&2; exit 2; }
mkdir -p "$work_dir" "$output_dir"
chmod 700 "$backup_root/offsite" "$work_dir" "$output_dir"

cleanup() {
  rm -f "$work_dir/data-key.bin" "$work_dir/ontology.sql.gz"
}
trap cleanup EXIT INT TERM

cd "$project_root"
set -a
. ./.env
set +a

"$docker_path" compose exec -T postgres pg_dump \
  --username ontology_admin --dbname ontology \
  --format=plain --no-owner --no-privileges \
  | gzip -9 > "$work_dir/ontology.sql.gz"

dump_sha=$(sha256sum "$work_dir/ontology.sql.gz" | awk '{print $1}')
cat > "$work_dir/manifest.txt" <<EOF
format=postgres-plain-sql-gzip
source=company-ai-ontology-qnap
run_id=$run_id
tenant_id=$FUTURUS_TENANT_ID
dump_sha256=$dump_sha
encrypted=true
key_encryption=rsa-oaep-sha256
data_encryption=aes-256-cbc-pbkdf2
EOF

openssl rand 32 > "$work_dir/data-key.bin"
openssl enc -aes-256-cbc -salt -pbkdf2 -iter 200000 \
  -in "$work_dir/ontology.sql.gz" -out "$work_dir/ontology.sql.gz.enc" \
  -pass file:"$work_dir/data-key.bin"
openssl pkeyutl -encrypt -pubin -inkey "$public_key" \
  -in "$work_dir/data-key.bin" -out "$work_dir/data-key.bin.enc" \
  -pkeyopt rsa_padding_mode:oaep -pkeyopt rsa_oaep_md:sha256

package=$output_dir/company-ai-ontology-$run_id.tar.gz
tar -czf "$package" -C "$work_dir" manifest.txt ontology.sql.gz.enc data-key.bin.enc
package_sha=$(sha256sum "$package" | awk '{print $1}')
printf 'package=%s\npackage_sha256=%s\ndump_sha256=%s\n' "$package" "$package_sha" "$dump_sha"
