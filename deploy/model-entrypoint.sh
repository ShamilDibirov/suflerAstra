#!/bin/sh
set -eu
install -d -o worker -g worker /models/huggingface /models/torch /models/cache
exec gosu worker "$@"
