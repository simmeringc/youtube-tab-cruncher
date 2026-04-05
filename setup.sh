#!/bin/bash
set -e

if [ ! -f .env ]; then
  echo "Error: .env file not found."
  echo "Copy .env.example to .env and fill in your OAuth client ID."
  exit 1
fi

source .env

if [ -z "$OAUTH_CLIENT_ID" ]; then
  echo "Error: OAUTH_CLIENT_ID not set in .env"
  exit 1
fi

sed "s/__OAUTH_CLIENT_ID__/${OAUTH_CLIENT_ID}/" manifest.template.json > manifest.json
echo "manifest.json generated with client ID: ${OAUTH_CLIENT_ID}"
