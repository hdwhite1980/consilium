"""
Patch: Add GPT-4o retry in agent_routes.py when playbook execution fails on agent.
When an agent reports playbook_result with success=False, and the original source was
Claude (ai_generated), retry with GPT-4o before giving up and marking the ticket as failed.
"""

filepath = '/opt/opsis/backend/api/agent_routes.py'

with open(filepath, 'r') as f:
    content = f.read()

# Find the playbook_result handler where it calls record_playbook_result
# We want to intercept BEFORE recording, and if it failed, try GPT-4o

old_record = """                try:
                    await remediation_service.record_playbook_result(result, db)
                except Exception as e:
                    logger.error(f"Failed to record result: {e}")

                await websocket.send_json({
                    "type": "playbook_result_ack",
                    "playbook_id": playbook_id,
                    "message": "Result recorded"
                })"""

new_record = """                # === GPT-4o RETRY: If playbook failed and was from Claude, try GPT-4o ===
                gpt4o_retry_sent = False
                if not success and result.get('source') in ('ai_generated', 'tier3_claude'):
                    try:
                        from services.openai_service import openai_service
                        if openai_service.enabled:
                            logger.info(f"Playbook failed on agent - attempting GPT-4o retry")

                            # Build context from stored data
                            stored_signal = result.get('signal', {})
                            error_msg = result.get('error', '')
                            step_results = result.get('step_results', [])
                            failed_steps = [s for s in step_results if s.get('status') == 'failed']
                            if failed_steps:
                                error_msg += f" | Failed steps: {json.dumps(failed_steps[:3], default=str)}"

                            # Get endpoint context
                            from models.endpoint import Endpoint
                            from models.client import Client
                            endpoint = db.query(Endpoint).filter(Endpoint.device_id == device_id).first()
                            client = db.query(Client).filter(Client.id == endpoint.client_id).first() if endpoint else None

                            context = {
                                'hostname': endpoint.hostname if endpoint else device_id,
                                'os_type': endpoint.os_type if endpoint else 'Windows',
                                'endpoint_type': endpoint.endpoint_type if endpoint else 'WORKSTATION',
                                'client_name': client.name if client else 'Unknown',
                            }

                            gpt_playbook = await openai_service.generate_fallback_playbook(
                                signal=stored_signal,
                                context=context,
                                failure_reason='execution_failed',
                                failure_source='agent_execution',
                                previous_playbook=result.get('playbook'),
                                agent_error=error_msg,
                            )

                            if gpt_playbook and gpt_playbook.get('confidence', 0) >= 80:
                                # Safety check the GPT-4o playbook
                                from services.safety_validator import safety_validator
                                safety_result = safety_validator.validate(gpt_playbook)

                                if safety_result.passed:
                                    logger.info(f"GPT-4o retry playbook passed safety "
                                               f"(confidence {gpt_playbook['confidence']}%) - sending to agent")

                                    # Transform steps
                                    from services.step_transformer import StepTransformer
                                    transformer = StepTransformer()
                                    gpt_playbook['steps'] = [
                                        transformer.transform(s) for s in gpt_playbook.get('steps', [])
                                    ]

                                    # Generate playbook ID
                                    import hashlib
                                    pb_id = f"gpt4o-retry-{hashlib.md5(json.dumps(gpt_playbook['steps'][:2], default=str).encode()).hexdigest()[:8]}"
                                    gpt_playbook['playbook_id'] = pb_id
                                    gpt_playbook['source'] = 'gpt4o_execution_retry'
                                    gpt_playbook['ticket_id'] = result.get('ticket_id')

                                    # Store metadata for when result comes back
                                    _sent_playbooks[pb_id] = {
                                        'source': 'gpt4o_execution_retry',
                                        'ticket_id': result.get('ticket_id'),
                                        'rule_id': None,
                                        'signal': stored_signal,
                                        'playbook': gpt_playbook,
                                        'sent_at': datetime.now(timezone.utc).isoformat(),
                                        'retry_of': playbook_id,
                                    }

                                    # Send to agent
                                    outgoing = {"type": "playbook", "playbook": gpt_playbook}
                                    if hmac_secret:
                                        outgoing = sign_message(outgoing, hmac_secret)
                                    await websocket.send_json(outgoing)
                                    gpt4o_retry_sent = True
                                    logger.info(f"GPT-4o retry playbook sent to agent (id={pb_id})")
                                else:
                                    logger.warning(f"GPT-4o retry failed safety: {safety_result.violations}")
                            else:
                                logger.info(f"GPT-4o retry: {'no playbook' if not gpt_playbook else f'low confidence {gpt_playbook.get(\"confidence\", 0)}%'}")
                    except ImportError:
                        logger.debug("OpenAI service not available for retry")
                    except Exception as gpt_err:
                        logger.warning(f"GPT-4o retry error (non-blocking): {gpt_err}")

                # Record the original result (even if we sent a GPT-4o retry)
                try:
                    if gpt4o_retry_sent:
                        result['gpt4o_retry_sent'] = True
                    await remediation_service.record_playbook_result(result, db)
                except Exception as e:
                    logger.error(f"Failed to record result: {e}")

                await websocket.send_json({
                    "type": "playbook_result_ack",
                    "playbook_id": playbook_id,
                    "message": "Result recorded" + (" (GPT-4o retry sent)" if gpt4o_retry_sent else "")
                })"""

if old_record in content:
    content = content.replace(old_record, new_record, 1)
    with open(filepath, 'w') as f:
        f.write(content)
    print("SUCCESS: Added GPT-4o execution failure retry to agent_routes.py")
else:
    print("ERROR: Could not find playbook_result handler block")
    # Debug
    import re
    for i, line in enumerate(content.split('\n')):
        if 'record_playbook_result' in line:
            print(f"  Line {i+1}: {line.strip()}")
