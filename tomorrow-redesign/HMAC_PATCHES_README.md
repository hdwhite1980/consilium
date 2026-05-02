# OPSIS Server HMAC Compatibility Patches
## agent_routes.py — Required Changes

These are the specific edits needed in `/opt/opsis/backend/api/agent_routes.py` to match the agent's HMAC verification.

---

### PATCH 1: Welcome message must include hmac_secret for agent auto-provisioning

The agent's `websocket-client.ts` checks the welcome message for `hmac_secret` and stores it
in Windows Credential Manager on first connect. Without this, fresh agents never get their HMAC
key via WebSocket (only via the agent-setup REST endpoint).

**Find this block (around the welcome_msg construction):**
```python
        welcome_msg = {
            "type": "welcome",
            "device_id": device_id,
            "tenant_id": tenant_id,
            "server_time": datetime.now(timezone.utc).isoformat(),
            "message": "Connected to OPSIS server",
```

**Add `hmac_secret` to the welcome message, BEFORE the `config` key:**
```python
        welcome_msg = {
            "type": "welcome",
            "device_id": device_id,
            "tenant_id": tenant_id,
            "server_time": datetime.now(timezone.utc).isoformat(),
            "message": "Connected to OPSIS server",
            "hmac_secret": hmac_secret if hmac_secret else None,
            "config": {
```

**Why:** Agent checks `data.hmac_secret` on welcome. If it doesn't have one stored yet, it saves it.
If it already has one, it ignores the field. This is the auto-provisioning path described in the
HMAC spec doc.

---

### PATCH 2: Fix undefined `escalation_ticket` variable in CREATE_TICKET block

**Find this block (in the CREATE_TICKET handler, around the ticket_created message):**
```python
                try:
                    ticket_msg = {
                        "type": "ticket_created",
                        "escalation_id": signature_id,
                        "ticket_id": escalation_ticket.id,
                        "message": "Ticket created for manual review",
                        "priority": severity_val
                    }
```

**The variable `escalation_ticket` is not defined** — the upsert uses `result_proxy` from
`db.execute(stmt)`. Since it's an upsert (INSERT ... ON CONFLICT UPDATE), we need to query
back the ticket to get its ID.

**Replace with:**
```python
                # Query the ticket we just upserted to get its ID
                from sqlalchemy import text as _text
                upserted_ticket = db.execute(_text(
                    "SELECT id FROM endpoint_escalation_tickets WHERE escalation_id = :eid"
                ), {"eid": signature_id}).fetchone()
                ticket_id = upserted_ticket[0] if upserted_ticket else None

                try:
                    ticket_msg = {
                        "type": "ticket_created",
                        "escalation_id": signature_id,
                        "ticket_id": ticket_id,
                        "message": "Ticket created for manual review",
                        "priority": severity_val
                    }
```

---

### PATCH 3: Fix regenerate_client_api_key to store previous key and timestamps

In `client_routes.py`, the `regenerate_client_api_key` endpoint should store the old key
for the 5-minute grace period, as described in the security report.

**Find:**
```python
    # Generate new API key
    old_key = client.api_key
    new_key = f"opsis_{uuid.uuid4().hex}"

    client.api_key = new_key
    db.commit()
```

**Replace with:**
```python
    # Generate new API key with grace period
    from datetime import datetime, timezone
    old_key = client.api_key
    new_key = f"opsis_{uuid.uuid4().hex}"

    client.previous_api_key = old_key
    client.key_rotated_at = datetime.now(timezone.utc)
    client.api_key = new_key
    db.commit()
```

---

### PATCH 4 (Post-Launch): Key rotation WebSocket push

When you're ready to implement the `key_rotation` message type, here's the server-side code
to add after the key regeneration in `client_routes.py`:

```python
    # Push key rotation to connected agents
    from api.agent_routes import active_agent_connections
    from utils.message_signing import sign_message

    # Find all connected devices for this client
    endpoints = db.query(Endpoint).filter(Endpoint.client_id == client_id).all()
    rotated_agents = 0
    for ep in endpoints:
        ws = active_agent_connections.get(ep.device_id)
        if ws:
            try:
                rotation_msg = {
                    "type": "key_rotation",
                    "new_api_key": new_key,
                }
                # Sign with current HMAC secret (agent verifies with current before rotating)
                if client.hmac_secret:
                    rotation_msg = sign_message(rotation_msg, client.hmac_secret)
                import asyncio
                asyncio.create_task(ws.send_json(rotation_msg))
                rotated_agents += 1
            except Exception as e:
                logger.error(f"Failed to push key rotation to {ep.device_id}: {e}")
```

For HMAC secret rotation, send both in one message:
```python
    rotation_msg = {
        "type": "key_rotation",
        "new_api_key": new_key,           # optional
        "new_hmac_secret": new_hmac,      # optional
    }
    # MUST be signed with the OLD HMAC secret
    rotation_msg = sign_message(rotation_msg, old_hmac_secret)
```

The agent will:
1. Verify signature with OLD secret
2. Rotate API key first (if `new_api_key` present)
3. Rotate HMAC secret last (if `new_hmac_secret` present)
4. Send `key_rotation_ack` back

---

## Deployment Steps

```bash
# 1. Backup current files
cp /opt/opsis/backend/utils/message_signing.py /opt/opsis/backend/utils/message_signing.py.backup
cp /opt/opsis/backend/api/agent_routes.py /opt/opsis/backend/api/agent_routes.py.backup

# 2. Replace message_signing.py (the new file from outputs)
cp /path/to/new/message_signing.py /opt/opsis/backend/utils/message_signing.py

# 3. Apply patches 1-3 to agent_routes.py (manual edits per above)

# 4. Copy to container and restart
docker cp /opt/opsis/backend/utils/message_signing.py opsis-backend:/app/utils/message_signing.py
docker cp /opt/opsis/backend/api/agent_routes.py opsis-backend:/app/api/agent_routes.py
docker exec opsis-backend python -c "import utils.message_signing; print('Import OK')"
docker restart opsis-backend

# 5. Verify in logs
docker logs opsis-backend --tail 50 | grep -i "hmac\|signature\|welcome"
```

## Testing

After deployment, connect an agent and check:
1. Welcome message includes `hmac_secret` field
2. Agent logs: "HMAC secret provisioned from server welcome" (first connect only)
3. Playbook messages include `_timestamp` (ISO format), `_nonce`, and `_signature`
4. Agent logs: NO "Playbook signature verification failed" errors
