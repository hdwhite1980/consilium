"""
OPSIS KB Enrichment Service
Orchestrates the Gemini research -> Claude runbook generation pipeline.

When a new issue has no existing runbook, this service:
  1. Asks Gemini to research the issue via Google Search Grounding
  2. Feeds the research brief to Claude to generate a safe, validated runbook
  3. Validates the runbook through SafetyValidator
  4. Stores it as a draft KB entry pending admin review (or auto-approved)

Also handles:
  - Scheduled weekly enrichment of top unresolved ticket categories
  - Manual "research this" requests from the dashboard
  - Compliance framework auto-updates (monthly)
"""

import logging
import json
import os
import hashlib
from typing import Dict, Optional, Any, List
from datetime import datetime, timezone

logger = logging.getLogger(__name__)

KB_AUTO_ENRICH = os.getenv("KB_AUTO_ENRICH", "true").lower() == "true"
KB_AUTO_APPROVE_THRESHOLD = int(os.getenv("KB_AUTO_APPROVE_THRESHOLD", "85"))
COMPLIANCE_AUTO_SCAN = os.getenv("COMPLIANCE_AUTO_SCAN", "true").lower() == "true"


class KBEnrichmentService:
    """Orchestrates Gemini research -> Claude runbook generation."""

    def __init__(self):
        self.auto_enrich = KB_AUTO_ENRICH
        self.auto_approve_threshold = KB_AUTO_APPROVE_THRESHOLD
        self.compliance_scan = COMPLIANCE_AUTO_SCAN
        logger.info(
            f"KB Enrichment initialized: auto_enrich={self.auto_enrich}, "
            f"auto_approve_threshold={self.auto_approve_threshold}, "
            f"compliance_scan={self.compliance_scan}"
        )

    # =========================================================================
    # CORE: Research and Generate Runbook for a Signal
    # =========================================================================

    async def research_and_generate(
        self,
        signal: Dict,
        context: Optional[Dict] = None,
        existing_attempts: Optional[List[Dict]] = None,
        db=None,
    ) -> Optional[Dict]:
        """
        Full pipeline: Gemini researches -> Claude generates -> SafetyValidator checks.

        Returns:
            {
                'action': 'REMEDIATE' or 'CREATE_KB_DRAFT' or None,
                'playbook': {...},
                'research': {...},
                'source': 'gemini_research_claude_gen',
            }
        """
        try:
            # Step 1: Gemini research via Google Search Grounding
            from services.gemini_service import gemini_service

            if not gemini_service.enabled:
                logger.debug("Gemini not configured - skipping KB enrichment")
                return None

            logger.info(
                f"KB Enrichment: Researching {signal.get('category', '?')}/"
                f"{signal.get('metric', '?')} via Gemini"
            )

            research = await gemini_service.research_issue(
                signal=signal,
                context=context,
                existing_attempts=existing_attempts,
            )

            if not research:
                logger.info("KB Enrichment: Gemini returned no research results")
                return None

            sources_count = len(research.get('sources', []))
            fixes_count = len(research.get('known_fixes', []))
            research_confidence = research.get('confidence', 0)

            logger.info(
                f"KB Enrichment: Gemini found {sources_count} sources, "
                f"{fixes_count} fixes (confidence: {research_confidence}%)"
            )

            if fixes_count == 0:
                logger.info("KB Enrichment: No known fixes found - cannot generate runbook")
                return {
                    'action': None,
                    'research': research,
                    'source': 'gemini_research_no_fixes',
                    'reason': 'No known fixes found in web research',
                }

            # Step 2: Claude generates a safe runbook from the research
            playbook = await self._claude_generate_from_research(
                signal=signal,
                research=research,
                context=context,
            )

            if not playbook:
                logger.warning("KB Enrichment: Claude failed to generate runbook from research")
                return {
                    'action': None,
                    'research': research,
                    'source': 'gemini_research_claude_failed',
                    'reason': 'Claude could not generate a safe runbook from research',
                }

            # Step 3: SafetyValidator check
            from services.safety_validator import safety_validator
            safety_result = safety_validator.validate(playbook)

            if not safety_result.passed:
                logger.warning(
                    f"KB Enrichment: Generated runbook failed safety: "
                    f"{safety_result.violations}"
                )
                return {
                    'action': None,
                    'research': research,
                    'playbook': playbook,
                    'source': 'gemini_research_safety_failed',
                    'reason': f"Safety violation: {safety_result.violations[0].get('description', 'Unknown') if safety_result.violations else 'Unknown'}",
                }

            # Step 4: Determine action based on confidence
            playbook_confidence = playbook.get('confidence', 0)
            playbook['source'] = 'gemini_research_claude_gen'
            playbook['research'] = {
                'title': research.get('title'),
                'sources': research.get('sources', [])[:5],
                'researched_at': research.get('researched_at'),
            }

            if playbook_confidence >= 80 and research_confidence >= 70:
                # High confidence from both research and generation
                logger.info(
                    f"KB Enrichment: High confidence playbook generated "
                    f"(research: {research_confidence}%, playbook: {playbook_confidence}%)"
                )

                # Store as KB entry if auto-approve threshold met
                if playbook_confidence >= self.auto_approve_threshold and db:
                    await self._store_as_kb_entry(
                        playbook=playbook,
                        research=research,
                        signal=signal,
                        auto_approved=True,
                        db=db,
                    )

                return {
                    'action': 'REMEDIATE',
                    'playbook': playbook,
                    'research': research,
                    'source': 'gemini_research_claude_gen',
                    'ai_tier': 'tier2.5_gemini_research',
                }
            else:
                # Store as draft for admin review
                if db:
                    await self._store_as_kb_entry(
                        playbook=playbook,
                        research=research,
                        signal=signal,
                        auto_approved=False,
                        db=db,
                    )

                logger.info(
                    f"KB Enrichment: Draft runbook created for review "
                    f"(research: {research_confidence}%, playbook: {playbook_confidence}%)"
                )
                return {
                    'action': 'CREATE_KB_DRAFT',
                    'playbook': playbook,
                    'research': research,
                    'source': 'gemini_research_claude_gen',
                    'reason': 'Confidence below auto-remediate threshold, stored as draft',
                }

        except Exception as e:
            logger.error(f"KB Enrichment pipeline error: {e}")
            return None

    # =========================================================================
    # Claude Runbook Generation from Research
    # =========================================================================

    async def _claude_generate_from_research(
        self,
        signal: Dict,
        research: Dict,
        context: Optional[Dict] = None,
    ) -> Optional[Dict]:
        """Use Claude to generate a safe, validated runbook from Gemini's research."""
        try:
            import anthropic

            client = anthropic.AsyncAnthropic()
            model = os.getenv("ANTHROPIC_MODEL", "claude-sonnet-4-5-20250929")

            # Build the research-enriched prompt
            sources_text = "\n".join([
                f"  - [{s.get('type', 'web')}] {s.get('title', 'Unknown')}: {s.get('summary', '')}"
                f" ({s.get('url', 'no url')})"
                for s in research.get('sources', [])[:8]
            ])

            fixes_text = "\n".join([
                f"  Fix {i+1}: {f.get('title', 'Unknown')}\n"
                f"    Description: {f.get('description', '')}\n"
                f"    Commands: {json.dumps(f.get('commands', []))}\n"
                f"    Risk: {f.get('risk_level', 'unknown')}, "
                f"Community confidence: {f.get('community_confidence', 'unknown')}"
                for i, f in enumerate(research.get('known_fixes', [])[:5])
            ])

            caveats_text = "\n".join([
                f"  - {c}" for c in research.get('caveats', [])
            ])

            prompt = f"""You are an expert Windows IT remediation system generating a safe, automated playbook.

You have been provided with REAL-TIME WEB RESEARCH about this issue. Use it to generate a
higher-quality playbook than you could from training data alone.

SAFETY RULES (MANDATORY - violations will be blocked):
1. NEVER include reboot/restart-computer/shutdown commands
2. NEVER terminate protected processes (svchost, lsass, csrss, winlogon, dwm, explorer)
3. NEVER modify boot configuration (bcdedit, msconfig, bootcfg)
4. ALWAYS preserve user data - never delete from C:\\Users, Documents, Desktop, Downloads
5. ALWAYS include rollback steps for every change
6. NEVER change network topology, DNS settings, or firewall rules
7. Limit scope to the specific reported issue only

CURRENT ISSUE:
  Category: {signal.get('category', 'unknown')}
  Metric: {signal.get('metric', 'unknown')}
  Severity: {signal.get('severity', 'unknown')}
  Message: {signal.get('message', 'No message')}

ENDPOINT:
  Hostname: {context.get('hostname', 'Unknown') if context else 'Unknown'}
  OS: {context.get('os_type', 'Windows') if context else 'Windows'}

WEB RESEARCH RESULTS:
  Root Cause: {research.get('root_cause_analysis', 'Unknown')}
  Summary: {research.get('summary', 'No summary')}

  Sources:
{sources_text}

  Known Fixes:
{fixes_text}

  Caveats:
{caveats_text}

  Affected Versions: {', '.join(research.get('affected_versions', ['Unknown']))}
  Related CVEs: {', '.join(research.get('related_cves', ['None']))}

INSTRUCTIONS:
- Synthesize the research into a single, coherent playbook
- Prefer fixes from Microsoft official sources over community solutions
- Include diagnostic steps FIRST to confirm the root cause before applying fixes
- Every step must have a clear rollback
- Set confidence based on research quality and fix reliability

ALLOWED STEP TYPES: powershell, cmd, service, registry, file, diagnostic, wmi

Respond with ONLY valid JSON:
{{
  "title": "Short descriptive title",
  "confidence": 85,
  "root_cause": "Based on research, the root cause is...",
  "research_attribution": "Solution based on [source names]",
  "steps": [
    {{
      "step_type": "diagnostic|powershell|cmd|service|registry|file|wmi",
      "description": "What this step does",
      "command": "The command to execute",
      "timeout": 30000,
      "continue_on_error": false
    }}
  ],
  "verification_steps": [
    {{"description": "How to verify", "command": "verification command"}}
  ],
  "rollback_steps": [
    {{"description": "How to undo", "command": "rollback command"}}
  ],
  "expected_conditions": {{
    "service_running": "service_name",
    "process_exists": "process_name"
  }},
  "prevention_tips": ["How to prevent recurrence"]
}}"""

            response = await client.messages.create(
                model=model,
                max_tokens=3000,
                temperature=0.2,
                messages=[{"role": "user", "content": prompt}],
            )

            if not response.content:
                return None

            text = response.content[0].text
            usage = response.usage
            logger.info(
                f"Claude runbook generation - input: {usage.input_tokens}, "
                f"output: {usage.output_tokens}"
            )

            return self._parse_playbook(text)

        except Exception as e:
            logger.error(f"Claude research-based generation failed: {e}")
            return None

    # =========================================================================
    # KB Storage
    # =========================================================================

    async def _store_as_kb_entry(
        self,
        playbook: Dict,
        research: Dict,
        signal: Dict,
        auto_approved: bool,
        db,
    ):
        """Store the generated runbook as a Knowledge Base entry."""
        try:
            from sqlalchemy import text as sql_text

            category = signal.get('category', 'unknown')
            metric = signal.get('metric', 'unknown')
            severity = signal.get('severity', 'medium')

            # Generate hash for deduplication
            sig_str = f"{category}:{metric}:{severity}"
            rule_hash = hashlib.md5(sig_str.encode()).hexdigest()

            # Check for existing rule with same hash
            existing = db.execute(sql_text(
                "SELECT id FROM resolution_rules WHERE rule_hash = :hash"
            ), {"hash": rule_hash}).fetchone()

            if existing:
                logger.info(f"KB entry already exists for {sig_str} (rule #{existing[0]})")
                return

            # Build trigger metadata for KB matching
            trigger_metadata = {
                'categories': [category],
                'symptoms': [signal.get('message', '')[:200]],
                'metrics': [metric],
                'research_sources': [
                    s.get('url', '') for s in research.get('sources', [])[:5]
                ],
                'generated_from': 'gemini_research_claude_gen',
                'researched_at': research.get('researched_at'),
            }

            db.execute(sql_text("""
                INSERT INTO resolution_rules (
                    rule_hash, title, category, issue_signature,
                    resolution_steps, verification_steps, expected_conditions,
                    rollback_steps, confidence_score, action_type, verified_by,
                    is_active, times_applied, success_count, failure_count,
                    success_rate, needs_reverification, trigger_metadata,
                    expires_at, created_at
                ) VALUES (
                    :hash, :title, :category, :signature,
                    :steps, :verify, :expected, :rollback,
                    :confidence, 'custom_runbook', 'gemini_research',
                    :active, 0, 0, 0, 0.0, false, :triggers,
                    NOW() + INTERVAL '90 days', NOW()
                )
            """), {
                "hash": rule_hash,
                "title": f"[Research] {playbook.get('title', 'Unknown')}",
                "category": category,
                "signature": sig_str,
                "steps": json.dumps(playbook.get('steps', [])),
                "verify": json.dumps(playbook.get('verification_steps', [])),
                "expected": json.dumps(playbook.get('expected_conditions', {})),
                "rollback": json.dumps(playbook.get('rollback_steps', [])),
                "confidence": playbook.get('confidence', 0),
                "active": auto_approved,
                "triggers": json.dumps(trigger_metadata),
            })
            db.commit()

            status = "auto-approved" if auto_approved else "draft (pending review)"
            logger.info(
                f"KB Enrichment: Stored runbook '{playbook.get('title', 'Unknown')}' "
                f"as {status} (hash={rule_hash})"
            )

        except Exception as e:
            logger.error(f"Failed to store KB entry: {e}")
            try:
                db.rollback()
            except Exception:
                pass

    # =========================================================================
    # Scheduled: Weekly Enrichment of Top Unresolved Categories
    # =========================================================================

    async def enrich_top_unresolved(self, db, max_categories: int = 10):
        """
        Find the top unresolved ticket categories and research solutions.
        Called by the weekly scheduler.
        """
        if not self.auto_enrich:
            logger.debug("KB auto-enrichment disabled")
            return

        try:
            from sqlalchemy import text as sql_text

            # Find categories with the most open/unresolved tickets that have no KB match
            rows = db.execute(sql_text("""
                SELECT
                    t.category,
                    COUNT(*) as ticket_count,
                    MAX(t.subject) as sample_subject,
                    MAX(t.description) as sample_description
                FROM tickets t
                LEFT JOIN resolution_rules rr
                    ON rr.category = t.category AND rr.is_active = true
                WHERE t.status NOT IN ('resolved', 'closed')
                    AND rr.id IS NULL
                GROUP BY t.category
                ORDER BY ticket_count DESC
                LIMIT :limit
            """), {"limit": max_categories}).fetchall()

            if not rows:
                logger.info("KB Enrichment: No unresolved categories without KB entries")
                return

            logger.info(f"KB Enrichment: Researching {len(rows)} unresolved categories")

            for row in rows:
                category = row[0]
                count = row[1]
                sample_subject = row[2] or ""
                sample_desc = row[3] or ""

                signal = {
                    'category': category,
                    'metric': category,
                    'severity': 'medium',
                    'message': f"{sample_subject} - {sample_desc[:200]}",
                    'details': {'ticket_count': count},
                }

                result = await self.research_and_generate(
                    signal=signal,
                    db=db,
                )

                if result and result.get('action'):
                    logger.info(
                        f"KB Enrichment: Generated runbook for '{category}' "
                        f"({count} open tickets) -> {result['action']}"
                    )

        except Exception as e:
            logger.error(f"KB enrichment scan error: {e}")

    # =========================================================================
    # Scheduled: Monthly Compliance Framework Scan
    # =========================================================================

    async def scan_all_compliance_frameworks(self):
        """
        Scan all configured compliance frameworks for updates.
        Called by the monthly scheduler.
        """
        if not self.compliance_scan:
            logger.debug("Compliance auto-scan disabled")
            return

        try:
            from services.gemini_service import gemini_service

            if not gemini_service.enabled:
                return

            frameworks = [
                ("HIPAA", "Health Insurance Portability and Accountability Act"),
                ("SOX", "Sarbanes-Oxley Act"),
                ("PCI-DSS", "Payment Card Industry Data Security Standard"),
                ("CMMC", "Cybersecurity Maturity Model Certification"),
                ("FERPA", "Family Educational Rights and Privacy Act"),
                ("SOC2", "Service Organization Control Type 2"),
                ("GLBA", "Gramm-Leach-Bliley Act"),
                ("NIST-800-171", "NIST Special Publication 800-171"),
            ]

            results = []
            for short_name, full_name in frameworks:
                result = await gemini_service.scan_compliance_updates(
                    framework=f"{full_name} ({short_name})"
                )
                if result and result.get('has_updates'):
                    results.append({
                        'framework': short_name,
                        'updates': result.get('updates', []),
                        'summary': result.get('summary'),
                    })

            if results:
                logger.info(
                    f"Compliance scan found updates in "
                    f"{len(results)} frameworks: "
                    f"{', '.join(r['framework'] for r in results)}"
                )
                # TODO: Create notification for admin review
                # TODO: Propose ComplianceContext updates
            else:
                logger.info("Compliance scan: No framework updates found")

            return results

        except Exception as e:
            logger.error(f"Compliance scan error: {e}")
            return None

    # =========================================================================
    # Helpers
    # =========================================================================

    def _parse_playbook(self, text: str) -> Optional[Dict]:
        """Parse Claude's response into a playbook dict."""
        try:
            cleaned = text.strip()
            if cleaned.startswith("```"):
                lines = cleaned.split("\n")
                cleaned = "\n".join(lines[1:-1]).strip()

            start = cleaned.find("{")
            end = cleaned.rfind("}") + 1
            if start == -1 or end == 0:
                return None

            playbook = json.loads(cleaned[start:end])

            if not playbook.get('steps'):
                return None

            # Normalize confidence
            conf = playbook.get('confidence', 0)
            if isinstance(conf, str):
                conf = int(conf.replace('%', ''))
            playbook['confidence'] = max(0, min(100, conf))

            # Ensure required fields
            playbook.setdefault('verification_steps', [])
            playbook.setdefault('rollback_steps', [])
            playbook.setdefault('expected_conditions', {})

            return playbook

        except Exception as e:
            logger.error(f"Failed to parse Claude playbook: {e}")
            return None

    def get_status(self) -> Dict[str, Any]:
        """Return service status."""
        from services.gemini_service import gemini_service
        return {
            "auto_enrich": self.auto_enrich,
            "auto_approve_threshold": self.auto_approve_threshold,
            "compliance_scan": self.compliance_scan,
            "gemini_available": gemini_service.enabled,
        }


# Singleton
kb_enrichment_service = KBEnrichmentService()
