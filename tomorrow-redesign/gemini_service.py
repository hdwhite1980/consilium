"""
OPSIS Gemini Service - The Researcher
Google Gemini 2.5 Pro with Google Search Grounding for real-time knowledge acquisition.

Responsibilities:
  - KB enrichment: Search for Microsoft KB articles, community fixes, CVE advisories
  - Compliance monitoring: Scan for regulatory framework updates
  - API doc verification: Validate Graph API calls against current Microsoft docs
  - Large document analysis: Process massive docs via 1M token context
  - Structured research briefs: Feed research to Claude for safe runbook generation
"""

import logging
import json
import os
import httpx
from typing import Dict, Optional, Any, List
from datetime import datetime, timezone

logger = logging.getLogger(__name__)

GOOGLE_API_KEY = os.getenv("GOOGLE_API_KEY", "")
GEMINI_MODEL = os.getenv("GEMINI_MODEL", "gemini-2.5-pro")
GEMINI_FLASH_MODEL = os.getenv("GEMINI_FLASH_MODEL", "gemini-2.5-flash")
GEMINI_TIMEOUT = int(os.getenv("GEMINI_TIMEOUT", "120"))
GEMINI_API_URL = "https://generativelanguage.googleapis.com/v1beta/models"


class GeminiService:
    """Gemini 2.5 Pro research service with Google Search Grounding."""

    def __init__(self):
        self.api_key = GOOGLE_API_KEY
        self.model = GEMINI_MODEL
        self.flash_model = GEMINI_FLASH_MODEL
        self.timeout = GEMINI_TIMEOUT
        self.enabled = bool(self.api_key)
        if not self.enabled:
            logger.warning("GOOGLE_API_KEY not configured - Gemini research disabled")
        else:
            logger.info(f"Gemini research initialized: model={self.model}, flash={self.flash_model}")

    # =========================================================================
    # CORE: Issue Research with Google Search Grounding
    # =========================================================================

    async def research_issue(
        self,
        signal: Dict,
        context: Optional[Dict] = None,
        existing_attempts: Optional[List[Dict]] = None,
    ) -> Optional[Dict]:
        """
        Research an issue using Google Search Grounding to find known fixes,
        Microsoft KB articles, CVE advisories, and community solutions.

        Returns a structured research brief that Claude uses to generate a runbook.
        """
        if not self.enabled:
            return None

        try:
            category = signal.get('category', 'unknown')
            metric = signal.get('metric', 'unknown')
            message = signal.get('message', '')
            severity = signal.get('severity', 'medium')
            details = signal.get('details', {})

            # Build targeted search queries from the signal
            search_context = self._build_search_context(category, metric, message, details)

            prompt = f"""You are an expert Windows IT researcher. Search the web for solutions to this endpoint issue.

ISSUE DETAILS:
  Category: {category}
  Metric: {metric}
  Severity: {severity}
  Message: {message}
  Details: {json.dumps(details, default=str)[:1000]}
  OS: {context.get('os_type', 'Windows') if context else 'Windows'}
  Hostname: {context.get('hostname', 'Unknown') if context else 'Unknown'}

SEARCH FOCUS:
  {search_context}

{"PREVIOUS ATTEMPTS THAT FAILED:" + chr(10) + json.dumps(existing_attempts[:3], default=str, indent=2) if existing_attempts else ""}

INSTRUCTIONS:
1. Search for Microsoft KB articles, support pages, and official documentation
2. Search for community solutions from reputable IT forums and blogs
3. Search for any known CVE advisories related to this issue
4. Focus on Windows 10/11 and Windows Server 2016-2022
5. Prioritize solutions that can be automated via PowerShell

Respond with ONLY valid JSON in this exact format:
{{
  "title": "Brief title of the issue and fix",
  "summary": "2-3 sentence summary of what causes this and how to fix it",
  "confidence": 85,
  "sources": [
    {{
      "title": "Source title",
      "url": "https://...",
      "type": "microsoft_kb|community|vendor|cve",
      "relevance": "high|medium|low",
      "summary": "What this source says about the fix"
    }}
  ],
  "known_fixes": [
    {{
      "title": "Fix title",
      "description": "What this fix does",
      "commands": ["PowerShell or cmd commands"],
      "risk_level": "low|medium|high",
      "community_confidence": "high|medium|low",
      "source_url": "https://..."
    }}
  ],
  "caveats": ["Any warnings or things to watch out for"],
  "affected_versions": ["Windows 10 22H2", "Windows 11 23H2"],
  "related_cves": ["CVE-2024-XXXXX"],
  "root_cause_analysis": "Technical explanation of why this happens",
  "prevention_tips": ["How to prevent this in the future"]
}}"""

            response = await self._call_gemini(
                prompt=prompt,
                use_search_grounding=True,
                model=self.model,
                temperature=0.3,
                max_tokens=4000,
            )

            if not response:
                return None

            research = self._parse_json_response(response)
            if research:
                research['researched_at'] = datetime.now(timezone.utc).isoformat()
                research['research_model'] = self.model
                research['signal_category'] = category
                research['signal_metric'] = metric
                logger.info(
                    f"Gemini research complete: '{research.get('title', 'Unknown')}' "
                    f"({len(research.get('sources', []))} sources, "
                    f"{len(research.get('known_fixes', []))} fixes)"
                )
            return research

        except Exception as e:
            logger.error(f"Gemini research_issue failed: {e}")
            return None

    # =========================================================================
    # Compliance Framework Monitoring
    # =========================================================================

    async def scan_compliance_updates(
        self,
        framework: str,
        current_version: Optional[str] = None,
    ) -> Optional[Dict]:
        """
        Search for recent updates to a compliance framework.
        Used by the monthly compliance auto-update pipeline.
        """
        if not self.enabled:
            return None

        try:
            prompt = f"""Search the web for the latest updates and changes to the {framework} compliance framework.

Current known version/date: {current_version or 'Unknown'}

Focus on:
1. Any new requirements, amendments, or guidance published in the last 90 days
2. Changes that affect IT security practices for Managed Service Providers (MSPs)
3. New technical controls or audit requirements
4. Changes to data protection, access control, or incident response requirements

Respond with ONLY valid JSON:
{{
  "framework": "{framework}",
  "has_updates": true/false,
  "last_update_date": "YYYY-MM-DD or null",
  "updates": [
    {{
      "title": "Update title",
      "description": "What changed",
      "effective_date": "YYYY-MM-DD or null",
      "impact_on_msps": "high|medium|low",
      "affected_controls": ["list of affected security controls"],
      "source_url": "https://...",
      "action_required": "What MSPs need to do"
    }}
  ],
  "summary": "Brief summary of current framework status",
  "next_review_date": "When the next major update is expected"
}}"""

            response = await self._call_gemini(
                prompt=prompt,
                use_search_grounding=True,
                model=self.flash_model,  # Flash is cheaper for research scans
                temperature=0.2,
                max_tokens=3000,
            )

            if not response:
                return None

            result = self._parse_json_response(response)
            if result:
                result['scanned_at'] = datetime.now(timezone.utc).isoformat()
                logger.info(
                    f"Compliance scan for {framework}: "
                    f"{'updates found' if result.get('has_updates') else 'no updates'}"
                )
            return result

        except Exception as e:
            logger.error(f"Gemini compliance scan failed for {framework}: {e}")
            return None

    # =========================================================================
    # Microsoft API Documentation Verification
    # =========================================================================

    async def verify_graph_api_calls(
        self,
        api_calls: List[Dict],
        action_type: str,
    ) -> Optional[Dict]:
        """
        Verify Microsoft Graph API calls against current documentation.
        Catches API changes that would break M365 action templates.
        """
        if not self.enabled:
            return None

        try:
            calls_str = json.dumps(api_calls, indent=2, default=str)

            prompt = f"""Search for the current Microsoft Graph API documentation and verify these API calls.

ACTION TYPE: {action_type}

API CALLS TO VERIFY:
{calls_str}

For each API call, verify:
1. The endpoint URL is correct and not deprecated
2. The HTTP method is correct
3. The request body format matches current documentation
4. Required permissions are listed correctly
5. Any breaking changes in recent API versions

Search Microsoft Learn (learn.microsoft.com) and the Graph API reference for verification.

Respond with ONLY valid JSON:
{{
  "all_valid": true/false,
  "calls_verified": {len(api_calls)},
  "results": [
    {{
      "endpoint": "the endpoint",
      "valid": true/false,
      "issues": ["list of issues found"],
      "corrections": ["suggested corrections"],
      "current_doc_url": "https://learn.microsoft.com/...",
      "deprecation_warning": null or "warning text"
    }}
  ],
  "overall_notes": "Any general observations"
}}"""

            response = await self._call_gemini(
                prompt=prompt,
                use_search_grounding=True,
                model=self.flash_model,
                temperature=0.1,
                max_tokens=3000,
            )

            if not response:
                return None

            result = self._parse_json_response(response)
            if result:
                logger.info(
                    f"Graph API verification for {action_type}: "
                    f"{'all valid' if result.get('all_valid') else 'issues found'}"
                )
            return result

        except Exception as e:
            logger.error(f"Gemini API verification failed: {e}")
            return None

    # =========================================================================
    # Patch & CVE Monitoring
    # =========================================================================

    async def scan_recent_patches(
        self,
        os_versions: Optional[List[str]] = None,
        days_back: int = 7,
    ) -> Optional[Dict]:
        """
        Search for recently released Microsoft patches and known issues.
        Feeds into proactive alerting for managed endpoints.
        """
        if not self.enabled:
            return None

        versions = os_versions or ["Windows 10 22H2", "Windows 11 23H2", "Windows Server 2022"]

        try:
            prompt = f"""Search for Microsoft patches, updates, and known issues released in the last {days_back} days
for these Windows versions: {', '.join(versions)}

Focus on:
1. Patch Tuesday updates and out-of-band patches
2. Known issues with recently released updates
3. CVEs that affect these Windows versions
4. Updates that require reboots or have breaking changes

Respond with ONLY valid JSON:
{{
  "scan_date": "{datetime.now(timezone.utc).strftime('%Y-%m-%d')}",
  "patches": [
    {{
      "kb_number": "KB5XXXXXX",
      "title": "Patch title",
      "release_date": "YYYY-MM-DD",
      "affected_versions": ["Windows 10 22H2"],
      "severity": "critical|important|moderate|low",
      "requires_reboot": true/false,
      "known_issues": ["any known issues with this patch"],
      "cves_fixed": ["CVE-XXXX-XXXXX"],
      "source_url": "https://..."
    }}
  ],
  "active_known_issues": [
    {{
      "title": "Issue title",
      "description": "What's broken",
      "affected_versions": ["Windows 11 23H2"],
      "workaround": "Temporary fix if available",
      "status": "investigating|mitigated|resolved",
      "source_url": "https://..."
    }}
  ],
  "summary": "Brief overview of the patch landscape"
}}"""

            response = await self._call_gemini(
                prompt=prompt,
                use_search_grounding=True,
                model=self.flash_model,
                temperature=0.2,
                max_tokens=4000,
            )

            if not response:
                return None

            return self._parse_json_response(response)

        except Exception as e:
            logger.error(f"Gemini patch scan failed: {e}")
            return None

    # =========================================================================
    # Large Document Analysis (uses 1M context window)
    # =========================================================================

    async def analyze_document(
        self,
        content: str,
        analysis_prompt: str,
    ) -> Optional[str]:
        """
        Analyze a large document using Gemini's 1M token context window.
        Useful for processing vendor documentation, audit logs, or compliance reports.
        """
        if not self.enabled:
            return None

        try:
            full_prompt = f"""{analysis_prompt}

DOCUMENT CONTENT:
{content}"""

            response = await self._call_gemini(
                prompt=full_prompt,
                use_search_grounding=False,  # No search needed for document analysis
                model=self.model,
                temperature=0.3,
                max_tokens=4000,
            )

            return response

        except Exception as e:
            logger.error(f"Gemini document analysis failed: {e}")
            return None

    # =========================================================================
    # Internal: API Communication
    # =========================================================================

    async def _call_gemini(
        self,
        prompt: str,
        use_search_grounding: bool = False,
        model: Optional[str] = None,
        temperature: float = 0.3,
        max_tokens: int = 4000,
    ) -> Optional[str]:
        """Call Gemini API with optional Google Search Grounding."""

        model = model or self.model
        url = f"{GEMINI_API_URL}/{model}:generateContent?key={self.api_key}"

        payload = {
            "contents": [
                {
                    "parts": [{"text": prompt}]
                }
            ],
            "generationConfig": {
                "temperature": temperature,
                "maxOutputTokens": max_tokens,
                "responseMimeType": "text/plain",
            },
        }

        # Enable Google Search Grounding
        if use_search_grounding:
            payload["tools"] = [
                {
                    "google_search": {}
                }
            ]

        try:
            async with httpx.AsyncClient(timeout=self.timeout) as client:
                response = await client.post(
                    url,
                    json=payload,
                    headers={"Content-Type": "application/json"},
                )
                response.raise_for_status()
                data = response.json()

            # Extract text from response
            candidates = data.get("candidates", [])
            if not candidates:
                logger.warning("Gemini returned no candidates")
                return None

            parts = candidates[0].get("content", {}).get("parts", [])
            text_parts = [p.get("text", "") for p in parts if "text" in p]
            full_text = "\n".join(text_parts)

            # Log grounding metadata if available
            grounding = candidates[0].get("groundingMetadata", {})
            if grounding:
                chunks = grounding.get("groundingChunks", [])
                supports = grounding.get("groundingSupports", [])
                search_queries = grounding.get("webSearchQueries", [])
                logger.info(
                    f"Gemini grounding: {len(chunks)} sources, "
                    f"{len(supports)} supports, "
                    f"queries={search_queries[:3]}"
                )

            # Log usage
            usage = data.get("usageMetadata", {})
            if usage:
                logger.info(
                    f"Gemini usage - input: {usage.get('promptTokenCount', '?')}, "
                    f"output: {usage.get('candidatesTokenCount', '?')}, "
                    f"total: {usage.get('totalTokenCount', '?')}"
                )

            return full_text

        except httpx.HTTPStatusError as e:
            logger.error(f"Gemini API HTTP error: {e.response.status_code} - {e.response.text[:200]}")
            return None
        except httpx.TimeoutException:
            logger.error(f"Gemini API timeout after {self.timeout}s")
            return None
        except Exception as e:
            logger.error(f"Gemini API error: {e}")
            return None

    # =========================================================================
    # Internal: Helpers
    # =========================================================================

    def _build_search_context(self, category, metric, message, details) -> str:
        """Build targeted search guidance from signal data."""
        contexts = {
            'service': f"Search for: Windows service '{details.get('service_name', metric)}' stopped or crashing, PowerShell fix",
            'performance': f"Search for: Windows {metric} high usage fix, PowerShell remediation for {details.get('process_name', 'system')}",
            'disk': f"Search for: Windows disk space low fix, automated cleanup PowerShell script",
            'network': f"Search for: Windows network connectivity issue fix, DNS resolution problems PowerShell",
            'security': f"Search for: Windows security issue {metric}, Microsoft security advisory",
            'application': f"Search for: {details.get('process_name', 'application')} crash fix Windows, error {details.get('error_code', '')}",
            'hardware': f"Search for: Windows hardware issue {metric}, SMART disk health, driver problems",
            'update': f"Search for: Windows Update error {details.get('error_code', metric)}, fix stuck updates PowerShell",
            'memory': f"Search for: Windows memory leak fix, high memory usage {details.get('process_name', '')} PowerShell",
            'event_log': f"Search for: Windows Event ID {details.get('event_id', '')} source {details.get('source', '')} fix",
        }
        base = contexts.get(category, f"Search for: Windows {category} {metric} {message[:100]} fix PowerShell")
        return f"{base}\nAdditional context from error message: {message[:200]}"

    def _parse_json_response(self, text: str) -> Optional[Dict]:
        """Parse Gemini's response, handling markdown wrappers."""
        try:
            cleaned = text.strip()

            # Strip markdown code blocks
            if cleaned.startswith("```"):
                lines = cleaned.split("\n")
                # Remove first line (```json) and last line (```)
                cleaned = "\n".join(lines[1:])
                if cleaned.rstrip().endswith("```"):
                    cleaned = cleaned.rstrip()[:-3]
                cleaned = cleaned.strip()

            # Find JSON boundaries
            start = cleaned.find("{")
            end = cleaned.rfind("}") + 1
            if start == -1 or end == 0:
                logger.error("No JSON found in Gemini response")
                return None

            return json.loads(cleaned[start:end])

        except json.JSONDecodeError as e:
            logger.error(f"Failed to parse Gemini JSON: {e}")
            # Try to salvage partial JSON
            try:
                # Sometimes Gemini adds trailing text after JSON
                partial = cleaned[start:end]
                # Fix common issues: trailing commas
                import re
                partial = re.sub(r',\s*}', '}', partial)
                partial = re.sub(r',\s*]', ']', partial)
                return json.loads(partial)
            except Exception:
                return None

    def get_status(self) -> Dict[str, Any]:
        """Return service status for health checks."""
        return {
            "enabled": self.enabled,
            "model": self.model,
            "flash_model": self.flash_model,
            "timeout": self.timeout,
            "has_api_key": bool(self.api_key),
            "features": {
                "search_grounding": True,
                "document_analysis": True,
                "compliance_monitoring": True,
                "patch_scanning": True,
                "api_verification": True,
            }
        }


# Singleton
gemini_service = GeminiService()
