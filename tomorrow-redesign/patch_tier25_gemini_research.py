"""
Patch: Add Tier 2.5 Gemini Research to remediation_service.py
Inserts Gemini research step between Tier 2 miss and Tier 3 Claude generation.

Also creates the scheduler patch for weekly KB enrichment and monthly compliance scans.
"""

# =============================================================
# PATCH 1: remediation_service.py - Add Tier 2.5
# =============================================================

filepath = '/opt/opsis/backend/services/remediation_service.py'

with open(filepath, 'r') as f:
    content = f.read()

changes = 0

# Find where Tier 2 misses and Tier 3 starts
# Pattern: after "Tier 2: No matching runbook found" -> before Claude generation
# We insert the Gemini research step

old_tier3_start = """            logger.info(f"Tier 2: No matching runbook found - escalating to Tier 3")"""

new_tier3_start = """            logger.info(f"Tier 2: No matching runbook found - trying Tier 2.5 Gemini research")

            # === TIER 2.5: Gemini Research via Google Search Grounding ===
            try:
                from services.kb_enrichment_service import kb_enrichment_service
                from services.gemini_service import gemini_service

                if gemini_service.enabled:
                    research_result = await kb_enrichment_service.research_and_generate(
                        signal=signal,
                        context=context,
                        existing_attempts=None,
                        db=db,
                    )

                    if research_result and research_result.get('action') == 'REMEDIATE':
                        research_playbook = research_result.get('playbook')
                        if research_playbook and research_playbook.get('confidence', 0) >= 80:
                            logger.info(
                                f"Tier 2.5: Gemini research -> Claude generated playbook "
                                f"(confidence {research_playbook['confidence']}%) -> REMEDIATE"
                            )

                            # Run through VerificationService (Claude safety review)
                            global verification_service
                            if verification_service:
                                try:
                                    v_result = await verification_service.verify_playbook(
                                        research_playbook, signal, context
                                    )
                                    if v_result.get('action') == 'REJECT':
                                        logger.warning("Tier 2.5: VerificationService rejected research playbook")
                                    else:
                                        if v_result.get('improved_playbook'):
                                            research_playbook = v_result['improved_playbook']
                                        research_playbook['source'] = 'gemini_research_claude_gen'
                                        research_playbook['ticket_id'] = ticket_id
                                        return {
                                            'action': 'REMEDIATE',
                                            'playbook': research_playbook,
                                            'source': 'gemini_research_claude_gen',
                                            'ticket_id': ticket_id,
                                            'ai_tier': 'tier2.5_gemini_research',
                                            'research': research_result.get('research'),
                                        }
                                except Exception as ve:
                                    logger.warning(f"Tier 2.5 verification error: {ve}")
                            else:
                                # No verification service - send if safety passed
                                research_playbook['source'] = 'gemini_research_claude_gen'
                                research_playbook['ticket_id'] = ticket_id
                                return {
                                    'action': 'REMEDIATE',
                                    'playbook': research_playbook,
                                    'source': 'gemini_research_claude_gen',
                                    'ticket_id': ticket_id,
                                    'ai_tier': 'tier2.5_gemini_research',
                                    'research': research_result.get('research'),
                                }

                    elif research_result and research_result.get('action') == 'CREATE_KB_DRAFT':
                        logger.info(
                            f"Tier 2.5: Research created KB draft for future use - "
                            f"continuing to Tier 3"
                        )
                    else:
                        logger.info("Tier 2.5: Research returned no actionable result")
            except ImportError:
                logger.debug("Gemini/KB enrichment services not available")
            except Exception as gem_err:
                logger.warning(f"Tier 2.5 Gemini research error (non-blocking): {gem_err}")

            logger.info(f"Escalating to Tier 3 Claude generation")"""

if old_tier3_start in content:
    content = content.replace(old_tier3_start, new_tier3_start, 1)
    changes += 1
    print("SUCCESS [1/1]: Added Tier 2.5 Gemini research to remediation pipeline")
else:
    print("SKIP [1/1]: Could not find Tier 2 -> Tier 3 transition")
    # Debug
    import re
    patterns = [
        r'.*Tier 2.*No matching.*',
        r'.*escalating to Tier 3.*',
        r'.*Tier 2.*MISS.*Tier 3.*',
    ]
    for pat in patterns:
        matches = re.findall(pat, content)
        if matches:
            print(f"  Found similar: {matches[0].strip()[:80]}")

if changes > 0:
    with open(filepath, 'w') as f:
        f.write(content)
    print(f"\nPatched remediation_service.py with Tier 2.5 Gemini research")
else:
    print("\nNo changes to remediation_service.py - review manually")
    print("Look for the line where Tier 2 misses and Tier 3 begins, and add the Gemini")
    print("research block between them.")


# =============================================================
# PATCH 2: scheduler_service.py - Add KB enrichment + compliance jobs
# =============================================================

sched_path = '/opt/opsis/backend/services/scheduler_service.py'

try:
    with open(sched_path, 'r') as f:
        sched_content = f.read()

    sched_changes = 0

    # Find the scheduler start method and add new jobs
    old_start = """    print("✅ Scheduler started with service health sync")"""

    new_start = """    # KB Enrichment - Weekly (Sunday 4 AM UTC)
    try:
        from services.kb_enrichment_service import kb_enrichment_service
        if kb_enrichment_service.auto_enrich:
            from apscheduler.triggers.cron import CronTrigger
            scheduler.scheduler.add_job(
                _run_kb_enrichment,
                CronTrigger(day_of_week='sun', hour=4, minute=0),
                id="kb_weekly_enrichment",
                replace_existing=True,
                name="KB Auto-Enrichment (Weekly)"
            )
            print("✅ KB weekly enrichment job scheduled (Sun 4 AM UTC)")
    except ImportError:
        pass
    except Exception as e:
        print(f"⚠️ KB enrichment scheduler error: {e}")

    # Compliance Framework Scan - Monthly (1st of month, 5 AM UTC)
    try:
        from services.kb_enrichment_service import kb_enrichment_service
        if kb_enrichment_service.compliance_scan:
            from apscheduler.triggers.cron import CronTrigger
            scheduler.scheduler.add_job(
                _run_compliance_scan,
                CronTrigger(day=1, hour=5, minute=0),
                id="compliance_monthly_scan",
                replace_existing=True,
                name="Compliance Framework Scan (Monthly)"
            )
            print("✅ Compliance monthly scan job scheduled (1st of month 5 AM UTC)")
    except ImportError:
        pass
    except Exception as e:
        print(f"⚠️ Compliance scan scheduler error: {e}")

    print("✅ Scheduler started with service health sync")"""

    if old_start in sched_content:
        sched_content = sched_content.replace(old_start, new_start, 1)
        sched_changes += 1

    # Add the async runner functions at the end of the file
    runner_functions = '''

# === KB Enrichment and Compliance Scan Runner Functions ===

async def _run_kb_enrichment_async():
    """Run weekly KB enrichment scan."""
    from models.database import SessionLocal
    from services.kb_enrichment_service import kb_enrichment_service

    db = SessionLocal()
    try:
        await kb_enrichment_service.enrich_top_unresolved(db=db, max_categories=10)
    except Exception as e:
        logger.error(f"KB enrichment job failed: {e}")
    finally:
        db.close()


def _run_kb_enrichment():
    """Sync wrapper for async KB enrichment."""
    import asyncio
    try:
        loop = asyncio.get_event_loop()
        if loop.is_running():
            asyncio.ensure_future(_run_kb_enrichment_async())
        else:
            loop.run_until_complete(_run_kb_enrichment_async())
    except Exception:
        asyncio.run(_run_kb_enrichment_async())


async def _run_compliance_scan_async():
    """Run monthly compliance framework scan."""
    from services.kb_enrichment_service import kb_enrichment_service
    try:
        await kb_enrichment_service.scan_all_compliance_frameworks()
    except Exception as e:
        logger.error(f"Compliance scan job failed: {e}")


def _run_compliance_scan():
    """Sync wrapper for async compliance scan."""
    import asyncio
    try:
        loop = asyncio.get_event_loop()
        if loop.is_running():
            asyncio.ensure_future(_run_compliance_scan_async())
        else:
            loop.run_until_complete(_run_compliance_scan_async())
    except Exception:
        asyncio.run(_run_compliance_scan_async())
'''

    if '_run_kb_enrichment' not in sched_content:
        sched_content += runner_functions
        sched_changes += 1

    if sched_changes > 0:
        with open(sched_path, 'w') as f:
            f.write(sched_content)
        print(f"Patched scheduler_service.py ({sched_changes} changes)")
    else:
        print("No changes to scheduler_service.py")

except FileNotFoundError:
    print(f"scheduler_service.py not found at {sched_path} - will need manual integration")
except Exception as e:
    print(f"Scheduler patch error: {e}")
