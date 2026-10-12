#!/bin/sh
set -eu
install -d -o worker -g worker /models/huggingface /models/torch /models/cache
if [ -n "${SPEECH_PROFILE_DIR:-}" ]; then
  install -d -m 700 -o worker -g worker "$SPEECH_PROFILE_DIR"
fi
exec gosu worker "$@"
