#!/bin/bash

# Cleanup scratch files accumulated from agent heartbeat runs
# Removes .NNNNN-*.{cjs,json,txt} files older than 48 hours
# Prevents deletion of files from active execution runs

set -euo pipefail

# Configuration
SCRATCH_DIR="${1:-.}"
OLDER_THAN_HOURS="${2:-48}"
MAX_AGE_SECONDS=$((OLDER_THAN_HOURS * 3600))
LOG_FILE="${SCRATCH_DIR}/.cleanup-scratch-$(date +%Y%m%d-%H%M%S).log"

echo "Starting scratch file cleanup at $(date -u)" | tee -a "$LOG_FILE"
echo "Directory: $SCRATCH_DIR" | tee -a "$LOG_FILE"
echo "Age threshold: $OLDER_THAN_HOURS hours" | tee -a "$LOG_FILE"

# Find all matching scratch files older than the threshold
count=0
deleted=0
skipped=0

while IFS= read -r file; do
  ((count++))

  if [[ ! -f "$file" ]]; then
    continue
  fi

  # Check file age (seconds since modification)
  mtime=$(stat -c %Y "$file" 2>/dev/null || echo 0)
  now=$(date +%s)
  age=$((now - mtime))

  if (( age >= MAX_AGE_SECONDS )); then
    # Safe to delete - older than threshold
    if rm -f "$file"; then
      ((deleted++))
      echo "Deleted: $file (age: $((age / 3600))h)" >> "$LOG_FILE"
    else
      ((skipped++))
      echo "Failed to delete: $file" >> "$LOG_FILE"
    fi
  else
    ((skipped++))
    echo "Skipped (too recent): $file (age: $((age / 3600))h)" >> "$LOG_FILE"
  fi
done < <(find "$SCRATCH_DIR" -maxdepth 1 -type f -regex '\./\.[0-9]+.*\.\(cjs\|json\|txt\)$' 2>/dev/null)

# Summary
echo "" | tee -a "$LOG_FILE"
echo "Cleanup complete at $(date -u)" | tee -a "$LOG_FILE"
echo "Results: $count files checked, $deleted deleted, $skipped skipped" | tee -a "$LOG_FILE"

# Print log summary to stdout
echo ""
cat "$LOG_FILE"
