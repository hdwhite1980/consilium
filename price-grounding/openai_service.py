"""
OPSIS OpenAI Service - GPT-4o Fallback for Tier 3
Activates ONLY when Claude fails: low confidence, safety rejection, API error, or agent execution failure.
Receives Claude's failure context to avoid repeating the same mistakes.
"""

import logging
import json
import os
import httpx
from typing import Dict, Optional, Any
from datetime import datetime, timezone

logger = logging.getLogger(__name__)

OPENAI_API_KEY = os.getenv("OPENAI_API_KEY", "")
OPENAI_MODEL = os.getenv("OPENAI_MODEL", "gpt-4o")
OPENAI_TIMEOUT = int(os.getenv("OPENAI_TIMEOUT", "90"))


class OpenAIService:
    """GPT-4o fallback service for Tier 3 remediation when Claude fails."""

    def __init__(self):
        self.api_key = OPENAI_API_KEY
        self.model = OPENAI_MODEL
        self.timeout = OPENAI_TIMEOUT
        self.enabled = bool(self.api_key)
        if not self.enabled:
            logger.warning("OpenAI API key not configured - GPT-4o fallback disabled")
        else:
            logger.info(f"OpenAI fallback initialized: model={self.model}, timeout={self.timeout}s")

    async def generate_fallback_playbook(
        self,
        signal: Dict,
        context: Dict,
        failure_reason: str,
        failure_source: str,
        previous_playbook: Optional[Dict] = None,
        agent_error: Optional[str] = None,
        pre_escalation_diagnostics: Optional[Dict] = None,
    ) -> Optional[Dict]:
        """
        Generate a playbook using GPT-4o after Claude has failed.

        Args:
            signal: The original telemetry signal
            context: Endpoint context (hostname, os_type, client_name)
            failure_reason: Why Claude failed (low_confidence, safety_rejected, api_error, execution_failed)
            failure_source: Which component failed (claude_tier3, safety_validator, verification_service, agent_execution)
            previous_playbook: Claude's rejected/failed playbook (if available)
            agent_error: Error message from agent if playbook execution failed
            pre_escalation_diagnostics: Agent's diagnostic data
        """
        if not self.enabled:
            logger.warning("GPT-4o fallback requested but OPENAI_API_KEY not configured")
            return None

        try:
            prompt = self._build_fallback_prompt(
                signal, context, failure_reason, failure_source,
                previous_playbook, agent_error, pre_escalation_diagnostics
            )

            logger.info(f"Tier 3 GPT-4o fallback: reason={failure_reason}, source={failure_source}")

            response = await self._call_openai(prompt)

            if not response:
                logger.error("GPT-4o returned empty response")
                return None

            playbook = self._parse_playbook(response)

            if playbook:
                playbook['ai_model'] = 'gpt-4o'
                playbook['ai_tier'] = 'tier3_gpt4o_fallback'
                playbook['fallback_reason'] = failure_reason
                playbook['fallback_source'] = failure_source
                logger.info(f"GPT-4o generated playbook: {playbook.get('title', 'Unknown')} "
                           f"(confidence: {playbook.get('confidence', 0)}%)")

            return playbook

        except Exception as e:
            logger.error(f"GPT-4o fallback failed: {e}")
            return None

    def _build_fallback_prompt(
        self, signal, context, failure_reason, failure_source,
        previous_playbook, agent_error, pre_escalation_diagnostics
    ) -> str:
        """Build the GPT-4o prompt with Claude's failure context."""

        # Base system context
        system_parts = [
            "You are an expert Windows IT remediation system generating playbooks for autonomous execution.",
            "You are being called as a FALLBACK because another AI system (Claude) failed to resolve this issue.",
            "You have DIFFERENT training data and should bring a fresh perspective.",
            "",
            "CRITICAL SAFETY RULES (violations will be blocked):",
            "1. NEVER include reboot/restart-computer/shutdown commands",
            "2. NEVER terminate protected processes (svchost, lsass, csrss, winlogon, dwm, explorer)",
            "3. NEVER modify boot configuration (bcdedit, msconfig, bootcfg)",
            "4. ALWAYS preserve user data - never delete from C:\\Users, Documents, Desktop, Downloads",
            "5. ALWAYS include rollback steps for every change",
            "6. NEVER change network topology, DNS settings, or firewall rules",
            "7. Limit scope to the specific reported issue only",
            "",
            "ALLOWED STEP TYPES:",
            "  powershell - PowerShell commands",
            "  cmd - Windows command line",
            "  service - start/stop/restart a service (provide service_name)",
            "  registry - set/delete registry values",
            "  file - create/delete/copy files (NOT in user directories)",
            "  diagnostic - read-only data collection",
            "  wmi - WMI/CIM queries",
            "",
            "CONFIDENCE SCORING:",
            "  90-100: Root cause identified with certainty, proven fix",
            "  80-89: High confidence diagnosis, standard resolution",
            "  70-79: Likely diagnosis, resolution should work",
            "  60-69: Possible diagnosis, may need more info",
            "  Below 60: Uncertain - better to create a ticket",
        ]

        # Add failure context - this is the key differentiator
        failure_parts = [
            "",
            "=== PREVIOUS FAILURE CONTEXT ===",
            f"Failure reason: {failure_reason}",
            f"Failed component: {failure_source}",
        ]

        if failure_reason == 'low_confidence':
            failure_parts.append("The previous AI had LOW CONFIDENCE in its diagnosis. Try a different diagnostic approach.")
        elif failure_reason == 'safety_rejected':
            failure_parts.append("The previous playbook was REJECTED by safety validation. Avoid the same dangerous patterns.")
            if previous_playbook:
                # Extract what was blocked
                rejected_steps = json.dumps(previous_playbook.get('steps', [])[:3], indent=2, default=str)
                failure_parts.append(f"Rejected steps (DO NOT repeat these patterns):\n{rejected_steps}")
        elif failure_reason == 'api_error':
            failure_parts.append("The previous AI API call failed. Generate a fresh solution.")
        elif failure_reason == 'execution_failed':
            failure_parts.append("The previous playbook was EXECUTED ON THE ENDPOINT but FAILED.")
            if agent_error:
                failure_parts.append(f"Agent execution error: {agent_error}")
            if previous_playbook:
                failed_steps = json.dumps(previous_playbook.get('steps', []), indent=2, default=str)
                failure_parts.append(f"Failed playbook steps (learn from these failures):\n{failed_steps}")

        if previous_playbook and previous_playbook.get('title'):
            failure_parts.append(f"Previous attempt title: {previous_playbook['title']}")
        if previous_playbook and previous_playbook.get('confidence'):
            failure_parts.append(f"Previous attempt confidence: {previous_playbook['confidence']}%")

        # Signal details
        signal_parts = [
            "",
            "=== CURRENT ISSUE ===",
            f"Category: {signal.get('category', 'unknown')}",
            f"Metric: {signal.get('metric', 'unknown')}",
            f"Severity: {signal.get('severity', 'unknown')}",
            f"Message: {signal.get('message', 'No message')}",
            f"Details: {json.dumps(signal.get('details', {}), indent=2, default=str)}",
        ]

        # Context
        context_parts = [
            "",
            "=== ENDPOINT CONTEXT ===",
            f"Hostname: {context.get('hostname', 'Unknown')}",
            f"OS: {context.get('os_type', 'Windows')}",
            f"Type: {context.get('endpoint_type', 'WORKSTATION')}",
            f"Client: {context.get('client_name', 'Unknown')}",
        ]

        # Pre-escalation diagnostics
        diag_parts = []
        if pre_escalation_diagnostics:
            diag_parts = [
                "",
                "=== AGENT DIAGNOSTIC DATA ===",
                f"Category: {pre_escalation_diagnostics.get('category', 'unknown')}",
                f"Runbook: {pre_escalation_diagnostics.get('runbook_id', 'unknown')}",
            ]
            if isinstance(pre_escalation_diagnostics, dict):
                for key, val in pre_escalation_diagnostics.items():
                    if key not in ('category', 'runbook_id') and val:
                        diag_parts.append(f"{key}: {json.dumps(val, default=str)[:500]}")

        # Output format
        output_parts = [
            "",
            "=== REQUIRED OUTPUT FORMAT (JSON only) ===",
            '{',
            '  "title": "Short descriptive title",',
            '  "confidence": 85,',
            '  "root_cause": "What is causing this issue",',
            '  "steps": [',
            '    {',
            '      "step_type": "powershell|cmd|service|diagnostic|registry|file|wmi",',
            '      "description": "What this step does",',
            '      "command": "The command to execute",',
            '      "timeout": 30000,',
            '      "continue_on_error": false',
            '    }',
            '  ],',
            '  "verification_steps": [',
            '    {"description": "How to verify the fix worked", "command": "verification command"}',
            '  ],',
            '  "rollback_steps": [',
            '    {"description": "How to undo if needed", "command": "rollback command"}',
            '  ],',
            '  "expected_conditions": {',
            '    "service_running": "service_name",',
            '    "process_exists": "process_name"',
            '  }',
            '}',
            "",
            "Respond with ONLY valid JSON. No markdown, no explanation.",
        ]

        full_prompt = "\n".join(
            system_parts + failure_parts + signal_parts +
            context_parts + diag_parts + output_parts
        )

        return full_prompt

    async def _call_openai(self, prompt: str) -> Optional[str]:
        """Call OpenAI GPT-4o API."""
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }

        payload = {
            "model": self.model,
            "messages": [
                {
                    "role": "system",
                    "content": (
                        "You are an expert Windows IT remediation system. "
                        "You generate safe, effective playbooks for autonomous execution on Windows endpoints. "
                        "You ALWAYS respond with valid JSON only. No markdown, no explanation outside JSON."
                    )
                },
                {
                    "role": "user",
                    "content": prompt
                }
            ],
            "temperature": 0.2,
            "max_tokens": 3000,
            "response_format": {"type": "json_object"},
        }

        async with httpx.AsyncClient(timeout=self.timeout) as client:
            response = await client.post(
                "https://api.openai.com/v1/chat/completions",
                headers=headers,
                json=payload,
            )
            response.raise_for_status()

            data = response.json()
            if data.get("choices") and len(data["choices"]) > 0:
                content = data["choices"][0]["message"]["content"]
                usage = data.get("usage", {})
                logger.info(
                    f"GPT-4o usage - input: {usage.get('prompt_tokens', '?')}, "
                    f"output: {usage.get('completion_tokens', '?')}, "
                    f"total: {usage.get('total_tokens', '?')}"
                )
                return content

        return None

    def _parse_playbook(self, response_text: str) -> Optional[Dict]:
        """Parse GPT-4o response into playbook format."""
        try:
            # Strip markdown if present
            text = response_text.strip()
            if text.startswith("```"):
                lines = text.split("\n")
                text = "\n".join(lines[1:-1]).strip()

            # Find JSON boundaries
            start = text.find("{")
            end = text.rfind("}") + 1
            if start == -1 or end == 0:
                logger.error("No JSON found in GPT-4o response")
                return None

            playbook = json.loads(text[start:end])

            # Validate required fields
            if not playbook.get("steps"):
                logger.error("GPT-4o playbook missing steps")
                return None

            # Normalize confidence
            confidence = playbook.get("confidence", 0)
            if isinstance(confidence, str):
                confidence = int(confidence.replace("%", ""))
            playbook["confidence"] = max(0, min(100, confidence))

            # Normalize step types
            valid_types = {"powershell", "cmd", "service", "registry", "file", "diagnostic", "wmi", "reboot", "user-prompt"}
            for step in playbook.get("steps", []):
                st = step.get("step_type", "powershell").lower().replace("-", "_").replace(" ", "_")
                if st not in valid_types:
                    step["step_type"] = "powershell"
                else:
                    step["step_type"] = st

                # Ensure timeout is in milliseconds
                timeout = step.get("timeout", 30000)
                if isinstance(timeout, (int, float)) and timeout < 1000:
                    step["timeout"] = int(timeout * 1000)

            # Ensure rollback and verification exist
            if not playbook.get("verification_steps"):
                playbook["verification_steps"] = []
            if not playbook.get("rollback_steps"):
                playbook["rollback_steps"] = []
            if not playbook.get("expected_conditions"):
                playbook["expected_conditions"] = {}

            return playbook

        except json.JSONDecodeError as e:
            logger.error(f"Failed to parse GPT-4o JSON: {e}")
            return None
        except Exception as e:
            logger.error(f"Error parsing GPT-4o playbook: {e}")
            return None

    def get_status(self) -> Dict[str, Any]:
        """Return service status for health checks."""
        return {
            "enabled": self.enabled,
            "model": self.model,
            "timeout": self.timeout,
            "has_api_key": bool(self.api_key),
        }


# Singleton
openai_service = OpenAIService()
