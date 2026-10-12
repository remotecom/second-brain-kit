#!/bin/bash
# A fake interactive `claude` for session tests. Logs its arguments, writes a
# transcript where Claude Code would, then echoes every line it reads.
echo "ARGS $*" >> "$FAKE_LOG"
id=""; prev=""
for a in "$@"; do
  { [ "$prev" = "--session-id" ] || [ "$prev" = "--resume" ]; } && id="$a"
  prev="$a"
done
enc=$(pwd | sed 's#[^a-zA-Z0-9]#-#g')
mkdir -p "$HOME/.claude/projects/$enc"
echo '{"type":"user","text":"hello"}' >> "$HOME/.claude/projects/$enc/$id.jsonl"
echo "READY $id"
while IFS= read -r line; do echo "ECHO $line"; done
