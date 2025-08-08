#!/bin/bash

# Test script for WhatsApp Bot API
BASE_URL="https://whatsapp-bot-q2o6.onrender.com"

echo "Testing WhatsApp Bot API..."

echo -e "\n1. Testing status endpoint:"
curl -s "$BASE_URL/" | jq .

echo -e "\n2. Testing QR endpoint:"
curl -s "$BASE_URL/qr" | jq .

echo -e "\n3. Testing send endpoint (should return not ready):"
curl -s -X POST "$BASE_URL/send" \
  -H "Content-Type: application/json" \
  -d '{"number":"919074691700","message":"Hello from the bot"}' | jq .

echo -e "\n4. Testing restart endpoint:"
curl -s -X POST "$BASE_URL/restart" \
  -H "Content-Type: application/json" | jq .

echo -e "\nTests completed!"
