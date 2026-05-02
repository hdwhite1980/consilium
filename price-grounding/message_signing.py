"""
HMAC message signing for WebSocket communication
Server signs all outgoing commands/playbooks so agents can verify authenticity.
Includes safety validation integration.

CRITICAL: This signing implementation MUST match the agent's verification logic exactly.
Agent verification reference (credential-manager.ts / agent-service.ts):
  - Timestamp: ISO 8601 string with milliseconds + Z  (e.g. "2026-02-07T12:00:00.000Z")
  - Nonce: 16 random bytes as hex string (32 hex chars)
  - Key sorting: TOP-LEVEL ONLY (not recursive)
  - Signature: HMAC-SHA256 hex digest
  - Replay protection: reject if _timestamp older than 5 minutes
  - Clock skew: allow up to 1 minute in the future
  - Nonce dedup: agent tracks nonces for 10 minutes
"""
import hmac
import hashlib
import json
import secrets
import logging
from datetime import datetime, timezone
from typing import Optional

logger = logging.getLogger(__name__)

ALLOWED_PLAYBOOK_ACTIONS = {"REMEDIATE", "CREATE_TICKET", "REQUEST_DIAGNOSTICS", "REQUEST_MORE_DIAGNOSTICS"}

ALLOWED_DIAGNOSTIC_SCENARIOS = {"custom", "disk", "memory", "network", "cpu", "service", "process"}

# Allowed step types - aligned with what the agent actually supports
ALLOWED_STEP_TYPES = {
    "powershell", "cmd", "service", "registry", "file",
    "diagnostic", "wmi", "reboot", "user-prompt"
}


def _top_level_sorted_json(message: dict) -> str:
    """
    Serialize a dict with TOP-LEVEL keys sorted alphabetically only.
    Nested objects retain their original key order.
    Uses compact format (no spaces) to match Node.js JSON.stringify output.
    
    This matches the agent's: JSON.stringify(obj, Object.keys(obj).sort())
    which only sorts the top-level keys, not nested ones.
    
    Node.js JSON.stringify produces compact JSON: {"key":value,"key2":value2}
    Python json.dumps defaults to spaces: {"key": value, "key2": value2}
    We must use separators=(',', ':') for compact format.
    """
    sorted_keys = sorted(message.keys())
    pairs = []
    for key in sorted_keys:
        # Compact separators to match Node.js: no space after : or ,
        pairs.append(json.dumps(key, separators=(',', ':')) + ':' + json.dumps(message[key], separators=(',', ':')))
    return '{' + ','.join(pairs) + '}'


def sign_message(message: dict, secret: str) -> dict:
    """
    Sign a WebSocket message with HMAC-SHA256.
    
    Matches agent verification in agent-service.ts:
      1. Add _timestamp (ISO 8601 with ms) and _nonce (16 random bytes hex)
      2. Sort top-level keys only
      3. JSON.stringify → HMAC-SHA256 → hex digest
      4. Attach as _signature
    """
    # ISO 8601 timestamp with milliseconds and Z suffix
    # Agent parses this and checks: reject if older than 5 min, allow 1 min future
    now = datetime.now(timezone.utc)
    message["_timestamp"] = now.strftime('%Y-%m-%dT%H:%M:%S.') + f"{now.microsecond // 1000:03d}Z"
    
    # 16 random bytes as hex = 32 hex chars
    # Agent tracks nonces for 10 minutes to prevent replay
    message["_nonce"] = secrets.token_hex(16)
    
    # Build payload with top-level-only key sorting (matching agent's JSON.stringify behavior)
    payload = _top_level_sorted_json(message)
    
    # HMAC-SHA256
    signature = hmac.new(
        secret.encode('utf-8'),
        payload.encode('utf-8'),
        hashlib.sha256
    ).hexdigest()
    
    message["_signature"] = signature
    return message


def verify_agent_signature(message: dict, secret: str) -> bool:
    """
    Verify an HMAC signature from the agent (agent → server direction).
    The agent signs using signMessage() in credential-manager.ts with the same logic.
    
    Returns True if signature is valid, False otherwise.
    """
    if not secret:
        return False
    
    signature = message.get("_signature")
    if not signature:
        return False
    
    # Check timestamp freshness (5 min window + 1 min future allowance)
    timestamp_str = message.get("_timestamp", "")
    if timestamp_str:
        try:
            # Parse ISO 8601
            ts = datetime.fromisoformat(timestamp_str.replace('Z', '+00:00'))
            now = datetime.now(timezone.utc)
            age = (now - ts).total_seconds()
            if age > 300:  # 5 minutes
                logger.warning(f"Agent message too old: {age:.0f}s")
                return False
            if age < -60:  # 1 minute future allowance
                logger.warning(f"Agent message from future: {age:.0f}s")
                return False
        except (ValueError, TypeError) as e:
            logger.warning(f"Invalid timestamp format: {timestamp_str} ({e})")
            return False
    
    # Rebuild payload without _signature, top-level sorted
    verify_msg = {k: v for k, v in message.items() if k != "_signature"}
    payload = _top_level_sorted_json(verify_msg)
    
    expected = hmac.new(
        secret.encode('utf-8'),
        payload.encode('utf-8'),
        hashlib.sha256
    ).hexdigest()
    
    return hmac.compare_digest(signature, expected)


def validate_playbook_schema(playbook: dict) -> tuple[bool, Optional[str]]:
    """
    Validate playbook structure AND run safety validation before sending to agent.
    Returns (is_valid, error_message)
    """
    if not isinstance(playbook, dict):
        return False, "Playbook must be a dict"

    action = playbook.get("action")
    if action and action not in ALLOWED_PLAYBOOK_ACTIONS:
        return False, f"Invalid action: {action}. Allowed: {ALLOWED_PLAYBOOK_ACTIONS}"

    steps = playbook.get("steps", [])
    if not isinstance(steps, list):
        return False, "Steps must be a list"

    # Step count limit
    if len(steps) > 50:
        return False, f"Too many steps: {len(steps)} (max 50)"

    # Step type validation
    for i, step in enumerate(steps):
        if not isinstance(step, dict):
            return False, f"Step {i} must be a dict"

        step_type = step.get("type", "")
        if step_type and step_type not in ALLOWED_STEP_TYPES:
            return False, f"Step {i} has invalid type: {step_type}. Allowed: {ALLOWED_STEP_TYPES}"

    # Run safety validator if action is REMEDIATE
    if action == "REMEDIATE" or not action:
        try:
            from services.safety_validator import safety_validator
            safety_result = safety_validator.validate(playbook)

            if not safety_result.passed:
                violations = "; ".join(v['description'] for v in safety_result.violations[:3])
                return False, f"Safety validation failed: {violations}"

            if safety_result.warnings:
                for w in safety_result.warnings:
                    logger.warning(f"Safety warning: {w['description']}")

        except ImportError:
            logger.warning("Safety validator not available - skipping safety checks")
        except Exception as e:
            logger.error(f"Safety validator error: {e}")

    return True, None


def validate_diagnostic_schema(diagnostic_data: dict) -> tuple[bool, Optional[str]]:
    """Validate diagnostic request before sending to agent"""
    if not isinstance(diagnostic_data, dict):
        return False, "Diagnostic data must be a dict"

    scenario = diagnostic_data.get("scenario", "")
    if scenario and scenario not in ALLOWED_DIAGNOSTIC_SCENARIOS:
        return False, f"Invalid scenario: {scenario}"

    commands = diagnostic_data.get("commands", [])
    if not isinstance(commands, list):
        return False, "Commands must be a list"

    if len(commands) > 20:
        return False, f"Too many diagnostic commands: {len(commands)} (max 20)"

    for i, cmd in enumerate(commands):
        if isinstance(cmd, dict):
            cmd_str = cmd.get("command") or cmd.get("script") or ""
        elif isinstance(cmd, str):
            cmd_str = cmd
        else:
            return False, f"Command {i} must be a string or dict"

        if isinstance(cmd_str, str):
            dangerous = ['rm -rf', 'format c:', 'del /s /q C:\\Windows',
                         'Remove-Item -Recurse -Force C:\\Windows',
                         'Restart-Computer -Force']
            for d in dangerous:
                if d.lower() in cmd_str.lower():
                    return False, f"Command {i} contains dangerous operation: {d}"

    return True, None
