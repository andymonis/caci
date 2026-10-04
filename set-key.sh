#!/usr/bin/env bash

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
	printf 'Source this script: source %s\n' "$0" >&2
	exit 1
fi

key_file='../../vault/claude.key'

if [[ ! -r "$key_file" ]]; then
	printf 'Cannot read key file: %s\n' "$key_file" >&2
	return 1
fi

ANTHROPIC_API_KEY=$(<"$key_file")
ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY%$'\n'}
ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY%$'\r'}

if [[ -z "$ANTHROPIC_API_KEY" ]]; then
	printf 'Key file is empty: %s\n' "$key_file" >&2
	return 1
fi

export ANTHROPIC_API_KEY
