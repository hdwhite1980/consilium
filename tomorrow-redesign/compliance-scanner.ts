/**
 * OPSIS Compliance Scanner
 * v1.1 — Design review corrections applied:
 *
 *  1. Default scan interval: 240 minutes (4 hours), not 60 minutes
 *  2. Maintenance window support — scans only run in defined off-hours window
 *  3. Pre-scan environment detection:
 *       a. Domain-joined vs. workgroup detection
 *       b. Third-party AV detection via WMI SecurityCenter2
 *       c. GPO activity detection
 *  4. GPO-controlled check handling:
 *       - Checks with gpo_policy_path are pre-tested before remediation
 *       - If GPO owns the key AND the check fails → ticket with GPO path, no local fix
 *  5. Domain-joined machines skip local policy remediation on domain_policy_check=true checks
 *  6. Third-party AV: all av_check=true checks → not_applicable + generic AV health check substituted
 *  7. Drift detection still runs 24/7 via event monitor integration (not subject to maintenance window)
 */

import * as fs from 'fs';
import * as path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

import type {
  ComplianceTemplate,
  ComplianceCheck,
  ComplianceResult,
  ComplianceReport,
  ComplianceDriftEvent,
  ComplianceScanData,
  ScanEnvironment,
  ThirdPartyAVProduct,
  MaintenanceWindow,
} from './compliance-scanner-types';

import {
  KNOWN_THIRD_PARTY_AV_PATTERNS,
  parseAVProductState,
} from './compliance-scanner-types';

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_SCAN_INTERVAL_MINUTES = 240;  // 4 hours
const STARTUP_DELAY_MS = 30_000;            // 30 seconds after agent start
const DATA_DIR = path.join(process.env.APPDATA || 'C:\\ProgramData\\OPSIS', 'compliance');
const SCAN_DATA_FILE = path.join(DATA_DIR, 'scan-data.json');
const PENDING_REPORTS_FILE = path.join(DATA_DIR, 'pending-reports.json');

// ─────────────────────────────────────────────────────────────────────────────
// ComplianceScanner
// ─────────────────────────────────────────────────────────────────────────────

export class ComplianceScanner {
  private template: ComplianceTemplate | null = null;
  private lastResults: ComplianceResult[] = [];
  private lastScore = 0;
  private lastEvaluatedAt: Date | null = null;
  private scanTimer: NodeJS.Timeout | null = null;
  private running = false;

  // Callbacks wired in agent-service.ts
  private onReport: (report: ComplianceReport) => void;
  private onDrift: (event: ComplianceDriftEvent) => void;
  private onEnforcementAction: (checkId: string, action: string) => void;
  private onSend: (type: string, payload: any) => void;

  constructor(callbacks: {
    onReport: (report: ComplianceReport) => void;
    onDrift: (event: ComplianceDriftEvent) => void;
    onEnforcementAction: (checkId: string, action: string) => void;
    onSend: (type: string, payload: any) => void;
  }) {
    this.onReport = callbacks.onReport;
    this.onDrift = callbacks.onDrift;
    this.onEnforcementAction = callbacks.onEnforcementAction;
    this.onSend = callbacks.onSend;

    this.ensureDataDir();
    this.loadStoredData();
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Lifecycle
  // ───────────────────────────────────────────────────────────────────────────

  start(): void {
    if (this.running) return;
    this.running = true;

    // Delay first scan to let the agent fully connect
    setTimeout(() => {
      if (this.template) {
        this.scheduleScan();
      }
    }, STARTUP_DELAY_MS);
  }

  stop(): void {
    this.running = false;
    if (this.scanTimer) {
      clearTimeout(this.scanTimer);
      this.scanTimer = null;
    }
  }

  /** Called when server pushes a compliance_template WebSocket message */
  updateTemplate(template: ComplianceTemplate): void {
    const isNew = !this.template || this.template.id !== template.id;
    const isUpdated = this.template && this.template.version < template.version;

    this.template = template;
    this.saveStoredData();

    if (isNew || isUpdated) {
      console.log(`[ComplianceScanner] Template updated: ${template.name} v${template.version}`, true);
      // Reschedule — new template may have different interval
      this.rescheduleScan();
    }
  }

  /** Called on WebSocket reconnect — flush any pending reports */
  flushPendingReports(): void {
    const pending = this.loadPendingReports();
    if (pending.length === 0) return;

    console.log(`[ComplianceScanner] Flushing ${pending.length} pending compliance reports`, true);
    for (const report of pending) {
      this.onSend('compliance_report', report);
    }
    this.savePendingReports([]);
  }

  /** Run a scan immediately (e.g. triggered by server request_compliance_scan message) */
  async runScan(): Promise<void> {
    if (!this.template) {
      console.log('[ComplianceScanner] No template assigned — skipping scan');
      return;
    }
    await this.executeScan();
    this.rescheduleScan();
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Scheduling
  // ───────────────────────────────────────────────────────────────────────────

  private scheduleScan(): void {
    if (!this.template) return;

    const intervalMs = (this.template.scan_interval_minutes ?? DEFAULT_SCAN_INTERVAL_MINUTES) * 60_000;
    const window = this.template.maintenance_window;

    if (window && !this.isInMaintenanceWindow(window)) {
      // Outside maintenance window — calculate delay until window opens
      const delayMs = this.msUntilWindowOpens(window);
      console.log(`[ComplianceScanner] Outside maintenance window — next scan in ${Math.round(delayMs / 60000)} minutes`);
      this.scanTimer = setTimeout(() => this.runScan(), delayMs);
    } else {
      // No window restriction or currently in window — schedule at normal interval
      this.scanTimer = setTimeout(() => this.runScan(), intervalMs);
    }
  }

  private rescheduleScan(): void {
    if (this.scanTimer) {
      clearTimeout(this.scanTimer);
      this.scanTimer = null;
    }
    this.scheduleScan();
  }

  private isInMaintenanceWindow(window: MaintenanceWindow): boolean {
    const now = new Date();
    const hour = now.getHours(); // TODO: respect window.timezone if needed

    if (window.start_hour <= window.end_hour) {
      // Same-day window, e.g. 22:00-06:00 next day doesn't apply here
      return hour >= window.start_hour && hour < window.end_hour;
    } else {
      // Overnight window, e.g. start=22, end=6 means 22:00-23:59 or 00:00-05:59
      return hour >= window.start_hour || hour < window.end_hour;
    }
  }

  private msUntilWindowOpens(window: MaintenanceWindow): number {
    const now = new Date();
    const target = new Date(now);
    target.setHours(window.start_hour, 0, 0, 0);

    if (target <= now) {
      // Window start is earlier today — next occurrence is tomorrow
      target.setDate(target.getDate() + 1);
    }
    return target.getTime() - now.getTime();
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Pre-scan Environment Detection
  // ───────────────────────────────────────────────────────────────────────────

  private async detectEnvironment(): Promise<ScanEnvironment> {
    const [domainInfo, avInfo, osVersion] = await Promise.allSettled([
      this.detectDomainStatus(),
      this.detectThirdPartyAV(),
      this.detectOSVersion(),
    ]);

    const domain = domainInfo.status === 'fulfilled' ? domainInfo.value : { joined: false, name: null };
    const av = avInfo.status === 'fulfilled' ? avInfo.value : null;
    const os = osVersion.status === 'fulfilled' ? osVersion.value : 'Unknown';

    // GPO active = domain joined OR local policies exist under HKLM\SOFTWARE\Policies
    const gpoActive = domain.joined || await this.detectLocalGPO();

    return {
      domain_joined: domain.joined,
      domain_name: domain.name,
      gpo_active: gpoActive,
      third_party_av: av?.display_name ?? null,
      third_party_av_details: av ?? undefined,
      os_version: os,
      detected_at: new Date().toISOString(),
    };
  }

  private async detectDomainStatus(): Promise<{ joined: boolean; name: string | null }> {
    try {
      const { stdout } = await this.runPS(
        `$cs = Get-WmiObject Win32_ComputerSystem; "$($cs.PartOfDomain)|$($cs.Domain)"`
      );
      const parts = stdout.trim().split('|');
      const joined = parts[0]?.toLowerCase() === 'true';
      const name = joined ? (parts[1]?.trim() || null) : null;
      return { joined, name };
    } catch {
      return { joined: false, name: null };
    }
  }

  private async detectThirdPartyAV(): Promise<ThirdPartyAVProduct | null> {
    try {
      const { stdout } = await this.runPS(
        `Get-WmiObject -Namespace root\\SecurityCenter2 -Class AntiVirusProduct | ` +
        `Select-Object displayName, productState | ConvertTo-Json -Compress`
      );
      if (!stdout.trim()) return null;

      const raw = JSON.parse(stdout.trim());
      const products = Array.isArray(raw) ? raw : [raw];

      for (const product of products) {
        const name: string = product.displayName || '';
        if (!name) continue;

        // Skip Windows Defender itself
        if (name.toLowerCase().includes('windows defender') || name.toLowerCase().includes('microsoft defender')) {
          continue;
        }

        // Check if it matches a known third-party AV
        const isThirdParty = KNOWN_THIRD_PARTY_AV_PATTERNS.some(p =>
          name.toLowerCase().includes(p.toLowerCase())
        );

        if (isThirdParty) {
          const state = parseAVProductState(product.productState || 0);
          return {
            display_name: name,
            product_state: product.productState,
            realtime_active: state.realtimeActive,
            definitions_current: state.definitionsCurrent,
          };
        }
      }
      return null;
    } catch {
      return null;
    }
  }

  private async detectLocalGPO(): Promise<boolean> {
    try {
      const { stdout } = await this.runPS(
        `Test-Path 'HKLM:\\SOFTWARE\\Policies\\Microsoft'`
      );
      return stdout.trim().toLowerCase() === 'true';
    } catch {
      return false;
    }
  }

  private async detectOSVersion(): Promise<string> {
    try {
      const { stdout } = await this.runPS(
        `(Get-WmiObject Win32_OperatingSystem).Caption`
      );
      return stdout.trim();
    } catch {
      return 'Unknown';
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // GPO Detection for individual checks
  // ───────────────────────────────────────────────────────────────────────────

  private async isCheckGPOControlled(check: ComplianceCheck): Promise<boolean> {
    if (!check.gpo_policy_path) return false;
    try {
      const { stdout } = await this.runPS(
        `Test-Path '${check.gpo_policy_path}'`
      );
      return stdout.trim().toLowerCase() === 'true';
    } catch {
      return false;
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Core Scan Execution
  // ───────────────────────────────────────────────────────────────────────────

  private async executeScan(): Promise<void> {
    if (!this.template) return;

    console.log(`[ComplianceScanner] Starting compliance scan — template: ${this.template.name}`, true);
    const startTime = Date.now();

    // 1. Detect environment before running checks
    const environment = await this.detectEnvironment();
    console.log(
      `[ComplianceScanner] Environment: domain=${environment.domain_joined}, ` +
      `gpo=${environment.gpo_active}, thirdPartyAV=${environment.third_party_av || 'none'}`
    );

    const results: ComplianceResult[] = [];
    let thirdPartyAVCheckSubstituted = false;

    for (const check of this.template.checks) {
      try {
        const result = await this.evaluateCheck(check, environment);
        results.push(result);
      } catch (err: any) {
        results.push({
          check_id: check.id,
          status: 'error',
          actual_value: null,
          expected_value: check.expected_result,
          remediated: false,
          timestamp: new Date().toISOString(),
          error_message: err.message || String(err),
        });
      }

      // If this was an AV check skipped due to third-party AV, inject generic check once
      if (check.av_check && environment.third_party_av && !thirdPartyAVCheckSubstituted) {
        thirdPartyAVCheckSubstituted = true;
        const avResult = await this.runGenericThirdPartyAVCheck(environment);
        results.push(avResult);
      }
    }

    // 2. Score
    const { score, isCompliant } = this.calculateScore(results);

    // 3. Drift detection
    const { driftDetected, driftDetails } = this.detectDrift(results);

    // 4. Build report
    const now = new Date();
    const intervalMs = (this.template.scan_interval_minutes ?? DEFAULT_SCAN_INTERVAL_MINUTES) * 60_000;

    const report: ComplianceReport = {
      device_id: this.getDeviceId(),
      hostname: require('os').hostname(),
      template_id: this.template.id,
      template_version: this.template.version,
      score,
      is_compliant: isCompliant,
      total_checks: results.length,
      passed: results.filter(r => r.status === 'pass').length,
      failed: results.filter(r => r.status === 'fail').length,
      not_applicable: results.filter(r => r.status === 'not_applicable').length,
      gpo_controlled: results.filter(r => r.status === 'gpo_controlled').length,
      remediated: results.filter(r => r.remediated).length,
      results,
      environment,
      evaluated_at: now.toISOString(),
      next_evaluation: new Date(now.getTime() + intervalMs).toISOString(),
      drift_detected: driftDetected,
      drift_details: driftDetails,
    };

    // 5. Persist last results for next drift comparison
    this.lastResults = results;
    this.lastScore = score;
    this.lastEvaluatedAt = now;
    this.saveStoredData();

    // 6. Transmit
    this.transmitReport(report);

    // 7. Emit immediate drift events if compliance state worsened
    if (driftDetected) {
      this.emitDriftEvents(driftDetails, results);
    }

    const elapsed = Date.now() - startTime;
    console.log(
      `[ComplianceScanner] Scan complete in ${elapsed}ms — score: ${score.toFixed(1)}%, compliant: ${isCompliant}`,
      true
    );
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Individual Check Evaluation
  // ───────────────────────────────────────────────────────────────────────────

  private async evaluateCheck(
    check: ComplianceCheck,
    environment: ScanEnvironment
  ): Promise<ComplianceResult> {
    const base: Partial<ComplianceResult> = {
      check_id: check.id,
      expected_value: check.expected_result,
      remediated: false,
      timestamp: new Date().toISOString(),
    };

    // ── AV check: skip if third-party AV detected ──────────────────────────
    if (check.av_check && environment.third_party_av) {
      return {
        ...base,
        status: 'not_applicable',
        actual_value: null,
        error_message: `Third-party AV detected: ${environment.third_party_av}. Defender-specific check not applicable.`,
        third_party_av_detected: environment.third_party_av,
      } as ComplianceResult;
    }

    // ── Run the actual check ───────────────────────────────────────────────
    let actualValue: any;
    try {
      actualValue = await this.runCheck(check);
    } catch (err: any) {
      return {
        ...base,
        status: 'error',
        actual_value: null,
        error_message: err.message || String(err),
      } as ComplianceResult;
    }

    const passed = this.evaluateOperator(check, actualValue);

    if (passed) {
      return {
        ...base,
        status: 'pass',
        actual_value: actualValue,
      } as ComplianceResult;
    }

    // ── Check failed — determine remediation path ──────────────────────────

    // Check GPO control (if this check has a gpo_policy_path)
    const gpoControlled = await this.isCheckGPOControlled(check);

    if (gpoControlled) {
      // GPO owns this setting — local fix would be overwritten. Create ticket instead.
      const ticketMessage = check.remediation?.gpo_ticket_message
        || `This setting is enforced by Group Policy with a weaker value than ${check.name} requires. `
        + `Update the GPO at path: ${check.gpo_policy_path}. `
        + `Framework reference: ${check.framework_reference}.`;

      this.onEnforcementAction(check.id, `gpo_ticket:${ticketMessage}`);

      return {
        ...base,
        status: 'gpo_controlled',
        actual_value: actualValue,
        gpo_controlled: true,
        error_message: ticketMessage,
      } as ComplianceResult;
    }

    // Check domain-joined + domain_policy_check flag
    if (check.domain_policy_check && environment.domain_joined) {
      // On a domain machine, local policy changes are overwritten at next GPO refresh.
      // Create a ticket instead of attempting local remediation.
      const ticketMessage = check.remediation?.gpo_ticket_message
        || `Machine is domain-joined. Setting '${check.name}' should be enforced via Group Policy, `
        + `not local policy. Verify domain GPO includes this control. `
        + `Framework reference: ${check.framework_reference}.`;

      this.onEnforcementAction(check.id, `domain_ticket:${ticketMessage}`);

      return {
        ...base,
        status: 'fail',
        actual_value: actualValue,
        remediation_result: 'skipped',
        error_message: `Domain-joined machine: ${ticketMessage}`,
      } as ComplianceResult;
    }

    // ── Attempt auto-remediation ───────────────────────────────────────────
    if (this.template?.auto_remediate && check.remediation) {
      const remResult = await this.attemptRemediation(check, actualValue);
      return {
        ...base,
        status: remResult.nowPasses ? 'pass' : 'fail',
        actual_value: remResult.newValue ?? actualValue,
        remediated: remResult.attempted,
        remediation_result: remResult.result,
        error_message: remResult.error,
      } as ComplianceResult;
    }

    return {
      ...base,
      status: 'fail',
      actual_value: actualValue,
    } as ComplianceResult;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Remediation
  // ───────────────────────────────────────────────────────────────────────────

  private async attemptRemediation(
    check: ComplianceCheck,
    currentValue: any
  ): Promise<{ attempted: boolean; result: 'success' | 'failed' | 'skipped'; nowPasses: boolean; newValue?: any; error?: string }> {
    const rem = check.remediation!;

    if (rem.type === 'ticket') {
      this.onEnforcementAction(check.id, `create_ticket:${rem.message}`);
      return { attempted: false, result: 'skipped', nowPasses: false };
    }

    if (rem.type === 'report') {
      this.onEnforcementAction(check.id, `report:${rem.message}`);
      return { attempted: false, result: 'skipped', nowPasses: false };
    }

    if (rem.type === 'powershell' && rem.command) {
      try {
        await this.runPS(rem.command);

        // Re-verify the check
        const newValue = await this.runCheck(check);
        const nowPasses = this.evaluateOperator(check, newValue);

        return {
          attempted: true,
          result: nowPasses ? 'success' : 'failed',
          nowPasses,
          newValue,
        };
      } catch (err: any) {
        return {
          attempted: true,
          result: 'failed',
          nowPasses: false,
          error: err.message,
        };
      }
    }

    return { attempted: false, result: 'skipped', nowPasses: false };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Generic Third-Party AV Health Check (substituted for Defender checks)
  // ───────────────────────────────────────────────────────────────────────────

  private async runGenericThirdPartyAVCheck(environment: ScanEnvironment): Promise<ComplianceResult> {
    const avDetails = environment.third_party_av_details;
    const now = new Date().toISOString();

    if (!avDetails) {
      return {
        check_id: 'GENERIC-AV-01',
        status: 'error',
        actual_value: null,
        expected_value: { realtime_active: true },
        remediated: false,
        timestamp: now,
        error_message: 'Third-party AV details not available',
      };
    }

    const passes = avDetails.realtime_active;

    if (!passes) {
      this.onEnforcementAction(
        'GENERIC-AV-01',
        `create_ticket:Third-party AV "${avDetails.display_name}" detected but real-time protection appears inactive (productState: ${avDetails.product_state}). Verify AV service health in the ${avDetails.display_name} management console.`
      );
    }

    return {
      check_id: 'GENERIC-AV-01',
      status: passes ? 'pass' : 'fail',
      actual_value: {
        product: avDetails.display_name,
        realtime_active: avDetails.realtime_active,
        definitions_current: avDetails.definitions_current,
        product_state: avDetails.product_state,
      },
      expected_value: { realtime_active: true },
      remediated: false,
      timestamp: now,
      third_party_av_detected: avDetails.display_name,
    };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Operator Evaluation
  // ───────────────────────────────────────────────────────────────────────────

  private evaluateOperator(check: ComplianceCheck, actual: any): boolean {
    const expected = check.expected_result;

    switch (check.operator) {
      case 'equals':
        return actual === expected || String(actual).trim() === String(expected).trim();

      case 'not_equals':
        return actual !== expected;

      case 'boolean_true':
        return actual === true || actual === 'True' || actual === '1';

      case 'greater_than':
        return Number(actual) > Number(expected);

      case 'less_than':
        return Number(actual) < Number(expected);

      case 'less_than_or_equal':
        return Number(actual) <= Number(expected);

      case 'contains':
        return String(actual).includes(String(expected));

      case 'not_contains':
        return !String(actual).includes(String(expected));

      case 'regex':
        return new RegExp(String(expected)).test(String(actual));

      case 'av_status': {
        if (typeof actual !== 'object' || actual === null) return false;
        return actual.RTPEnabled === true && actual.Enabled === true && (actual.DefAge <= 72);
      }

      case 'av_status_strict': {
        if (typeof actual !== 'object' || actual === null) return false;
        return actual.RTEnabled === true && actual.TamperProtected === true && actual.Enabled === true && (actual.DefAge <= 24);
      }

      case 'audit_status': {
        if (typeof actual !== 'object' || actual === null) return false;
        return Object.values(actual).every(v => v === true);
      }

      case 'password_policy': {
        if (typeof actual !== 'object' || actual === null) return false;
        return actual.MinLen >= expected.MinLen && actual.LockoutThreshold <= expected.LockoutThreshold;
      }

      case 'password_policy_cmmc': {
        if (typeof actual !== 'object' || actual === null) return false;
        return actual.MinLen >= expected.MinLen &&
          actual.MaxAgeDays <= expected.MaxAgeDays &&
          actual.History >= expected.History;
      }

      case 'lockout_policy': {
        if (typeof actual !== 'object' || actual === null) return false;
        return actual.Threshold <= expected.Threshold && actual.Duration >= expected.Duration;
      }

      case 'patch_status': {
        if (typeof actual !== 'object' || actual === null) return false;
        return actual.CriticalPending === 0;
      }

      case 'patch_status_60d': {
        if (typeof actual !== 'object' || actual === null) return false;
        return actual.TotalPending === 0;
      }

      case 'bitlocker_media': {
        if (typeof actual !== 'object' || actual === null) return false;
        return actual.BitLockerOn === true;
      }

      case 'admin_control': {
        if (typeof actual !== 'object' || actual === null) return false;
        return actual.BuiltinAdminEnabled === false;
      }

      case 'account_check': {
        if (typeof actual !== 'object' || actual === null) return false;
        return actual.GuestEnabled === false;
      }

      case 'rdp_status': {
        if (typeof actual !== 'object' || actual === null) return false;
        return actual.RDPDisabled === true || actual.NLARequired === true;
      }

      case 'tls_status': {
        if (typeof actual !== 'object' || actual === null) return false;
        return actual.TLS10Disabled === true && actual.TLS11Disabled === true;
      }

      default:
        return false;
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Scoring
  // ───────────────────────────────────────────────────────────────────────────

  private calculateScore(results: ComplianceResult[]): { score: number; isCompliant: boolean } {
    if (!this.template) return { score: 0, isCompliant: false };

    const weights = this.template.scoring;
    const checks = this.template.checks;

    // Build a map from check_id → check definition (includes GENERIC-AV-01 if injected)
    const checkMap = new Map<string, ComplianceCheck>();
    for (const c of checks) checkMap.set(c.id, c);

    let totalWeight = 0;
    let earnedWeight = 0;
    let allCriticalPass = true;

    for (const result of results) {
      // Skip not_applicable and error statuses in scoring
      if (result.status === 'not_applicable' || result.status === 'error') continue;

      // GENERIC-AV-01 counts as 'recommended' if substituted
      const check = checkMap.get(result.check_id);
      const priority = check?.priority ?? 'recommended';
      const weight = priority === 'critical'
        ? weights.critical_weight
        : priority === 'recommended'
          ? weights.recommended_weight
          : weights.optional_weight;

      totalWeight += weight;

      const passes = result.status === 'pass';
      // gpo_controlled: counts as partial (half credit) — MSP knows about it but can't auto-fix
      const gpoControlled = result.status === 'gpo_controlled';

      if (passes) {
        earnedWeight += weight;
      } else if (gpoControlled) {
        earnedWeight += weight * 0.5;
      }

      if (priority === 'critical' && !passes && !gpoControlled) {
        allCriticalPass = false;
      }
    }

    const score = totalWeight > 0 ? (earnedWeight / totalWeight) * 100 : 0;
    const meetsMinScore = score >= this.template.minimum_passing_score;
    const isCompliant = meetsMinScore && allCriticalPass;

    return { score: Math.round(score * 10) / 10, isCompliant };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Drift Detection
  // ───────────────────────────────────────────────────────────────────────────

  private detectDrift(newResults: ComplianceResult[]): { driftDetected: boolean; driftDetails: string[] } {
    if (this.lastResults.length === 0) return { driftDetected: false, driftDetails: [] };

    const previousMap = new Map<string, ComplianceResult>();
    for (const r of this.lastResults) previousMap.set(r.check_id, r);

    const driftDetails: string[] = [];

    for (const newResult of newResults) {
      const prev = previousMap.get(newResult.check_id);
      if (prev && prev.status !== newResult.status) {
        driftDetails.push(newResult.check_id);
      }
    }

    return { driftDetected: driftDetails.length > 0, driftDetails };
  }

  private emitDriftEvents(driftCheckIds: string[], results: ComplianceResult[]): void {
    if (!this.template) return;

    const checkMap = new Map<string, ComplianceCheck>();
    for (const c of this.template.checks) checkMap.set(c.id, c);

    const previousMap = new Map<string, ComplianceResult>();
    for (const r of this.lastResults) previousMap.set(r.check_id, r);

    for (const checkId of driftCheckIds) {
      const newResult = results.find(r => r.check_id === checkId);
      const prevResult = previousMap.get(checkId);
      const check = checkMap.get(checkId);

      if (!newResult || !prevResult) continue;

      const isViolation = newResult.status === 'fail' && (check?.priority === 'critical');

      const event: ComplianceDriftEvent = {
        device_id: this.getDeviceId(),
        hostname: require('os').hostname(),
        template_id: this.template.id,
        check_id: checkId,
        check_name: check?.name ?? checkId,
        previous_status: prevResult.status,
        current_status: newResult.status,
        framework_reference: check?.framework_reference ?? '',
        priority: check?.priority ?? 'recommended',
        detected_at: new Date().toISOString(),
        is_compliance_violation: isViolation,
      };

      this.onDrift(event);
      this.onSend('compliance_drift', event);
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Transmission
  // ───────────────────────────────────────────────────────────────────────────

  private transmitReport(report: ComplianceReport): void {
    try {
      this.onReport(report);
      this.onSend('compliance_report', report);
    } catch {
      // Store for later flush (offline)
      const pending = this.loadPendingReports();
      pending.push(report);
      // Keep last 48 reports max (4hr interval = ~12/day, 48 = ~4 days offline)
      const trimmed = pending.slice(-48);
      this.savePendingReports(trimmed);
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // PowerShell Execution
  // ───────────────────────────────────────────────────────────────────────────

  private async runCheck(check: ComplianceCheck): Promise<any> {
    const { stdout } = await this.runPS(check.check_command);
    const raw = stdout.trim();

    // Try JSON parse for complex result objects
    try {
      return JSON.parse(raw);
    } catch {
      // Try numeric
      const num = Number(raw);
      if (!isNaN(num) && raw !== '') return num;
      // Boolean
      if (raw.toLowerCase() === 'true') return true;
      if (raw.toLowerCase() === 'false') return false;
      return raw;
    }
  }

  private async runPS(command: string): Promise<{ stdout: string; stderr: string }> {
    return execAsync(
      `powershell.exe -NonInteractive -NoProfile -ExecutionPolicy Bypass -Command "${command.replace(/"/g, '\\"')}"`,
      { timeout: 30_000 }
    );
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Persistence
  // ───────────────────────────────────────────────────────────────────────────

  private ensureDataDir(): void {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
  }

  private loadStoredData(): void {
    try {
      if (fs.existsSync(SCAN_DATA_FILE)) {
        const data: ComplianceScanData = JSON.parse(fs.readFileSync(SCAN_DATA_FILE, 'utf-8'));
        this.template = data.template ?? null;
        this.lastResults = data.last_results ?? [];
        this.lastScore = data.last_score ?? 0;
        this.lastEvaluatedAt = data.last_evaluated_at ? new Date(data.last_evaluated_at) : null;
      }
    } catch {
      // Corrupt data — start fresh
    }
  }

  private saveStoredData(): void {
    try {
      const data: ComplianceScanData = {
        template: this.template!,
        last_results: this.lastResults,
        last_score: this.lastScore,
        last_evaluated_at: this.lastEvaluatedAt?.toISOString() ?? '',
        pending_reports: [],
      };
      fs.writeFileSync(SCAN_DATA_FILE, JSON.stringify(data, null, 2));
    } catch {
      // Non-fatal
    }
  }

  private loadPendingReports(): ComplianceReport[] {
    try {
      if (fs.existsSync(PENDING_REPORTS_FILE)) {
        return JSON.parse(fs.readFileSync(PENDING_REPORTS_FILE, 'utf-8'));
      }
    } catch {}
    return [];
  }

  private savePendingReports(reports: ComplianceReport[]): void {
    try {
      fs.writeFileSync(PENDING_REPORTS_FILE, JSON.stringify(reports, null, 2));
    } catch {}
  }

  private getDeviceId(): string {
    // Reuse the device ID established by the main agent
    try {
      const agentConfig = path.join(process.env.APPDATA || 'C:\\ProgramData\\OPSIS', 'agent-config.json');
      if (fs.existsSync(agentConfig)) {
        const cfg = JSON.parse(fs.readFileSync(agentConfig, 'utf-8'));
        return cfg.device_id || require('os').hostname();
      }
    } catch {}
    return require('os').hostname();
  }
}
