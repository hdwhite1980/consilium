/**
 * OPSIS Compliance Scanner — Type Definitions
 * v1.1 — Updated per design review corrections:
 *  - scan_interval_minutes default: 60 → 240 (4 hours)
 *  - Added MaintenanceWindow to ComplianceTemplate
 *  - Added gpo_policy_path, av_check, domain_policy_check to ComplianceCheck
 *  - Added gpo_controlled status to ComplianceResult
 *  - Added ScanEnvironment block to ComplianceReport
 *  - Added ThirdPartyAVProduct for AV detection
 */

// ─────────────────────────────────────────────────────────────────────────────
// Template & Check Definitions
// ─────────────────────────────────────────────────────────────────────────────

export interface MaintenanceWindow {
  /** Hour (0-23) when maintenance window starts (local time) */
  start_hour: number;
  /** Hour (0-23) when maintenance window ends (local time). Can be < start_hour for overnight windows. */
  end_hour: number;
  /** IANA timezone string, e.g. "America/New_York". Defaults to local system time if omitted. */
  timezone?: string;
}

export interface RemediationAction {
  /**
   * "powershell" — run command automatically
   * "ticket"     — create ticket, do not auto-fix
   * "report"     — log result only, no remediation
   */
  type: 'powershell' | 'ticket' | 'report';
  /** PowerShell command to execute (only used when type = "powershell") */
  command?: string;
  /** Message for ticket body (used when type = "ticket" or "report") */
  message?: string;
  /**
   * If the setting is GPO-controlled and fails, use this message for the ticket
   * instead of attempting local remediation. If omitted and GPO-controlled, falls
   * back to generic GPO ticket message.
   */
  gpo_ticket_message?: string;
}

export interface ComplianceCheck {
  id: string;           // e.g. 'HIPAA-EP-01'
  name: string;         // Human-readable name
  category:
    | 'encryption'
    | 'antivirus'
    | 'firewall'
    | 'password'
    | 'audit'
    | 'patching'
    | 'access'
    | 'session'
    | 'network'
    | 'media';
  priority: 'critical' | 'recommended' | 'optional';
  framework_reference: string;  // e.g. '§164.312(a)(2)(iv)'
  description: string;

  check_type: 'powershell' | 'registry' | 'wmi' | 'service' | 'file';
  check_command: string;
  expected_result: any;
  operator:
    | 'equals'
    | 'not_equals'
    | 'greater_than'
    | 'less_than'
    | 'less_than_or_equal'
    | 'contains'
    | 'not_contains'
    | 'regex'
    | 'boolean_true'
    | 'av_status'
    | 'av_status_strict'
    | 'audit_status'
    | 'password_policy'
    | 'password_policy_cmmc'
    | 'lockout_policy'
    | 'patch_status'
    | 'patch_status_60d'
    | 'bitlocker_media'
    | 'admin_control'
    | 'account_check'
    | 'rdp_status'
    | 'tls_status';

  remediation?: RemediationAction;

  /**
   * Registry path under HKLM\SOFTWARE\Policies\ that indicates this setting
   * is GPO-controlled. If this key exists AND the check fails, the scanner
   * will NOT attempt local remediation — instead it creates a GPO ticket.
   * Example: "HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows\\Personalization"
   */
  gpo_policy_path?: string;

  /**
   * If true, this check uses Windows Defender-specific cmdlets.
   * When a third-party AV is detected (SentinelOne, CrowdStrike, Sophos, etc.),
   * the check result is marked 'not_applicable' and a generic AV verification
   * is substituted instead.
   */
  av_check?: boolean;

  /**
   * If true, this check's remediation behavior changes on domain-joined machines:
   * local policy commands are NOT applied (they'd be overwritten at next GPO refresh).
   * Instead, a ticket is created with the GPO path to update.
   */
  domain_policy_check?: boolean;
}

export interface ComplianceTemplate {
  id: string;           // e.g. 'hipaa-endpoint'
  name: string;
  version: number;
  checks: ComplianceCheck[];
  scoring: {
    critical_weight: number;    // Default: 3
    recommended_weight: number; // Default: 2
    optional_weight: number;    // Default: 1
  };
  minimum_passing_score: number;  // 0-100, e.g. 80
  auto_remediate: boolean;
  /**
   * How often to run a full compliance scan (minutes).
   * Default: 240 (4 hours).
   * Event-driven drift detection handles real-time changes via the event monitor.
   * MSPs requiring tighter intervals (e.g. CMMC-strict environments) can set lower values.
   */
  scan_interval_minutes: number;
  /**
   * Optional maintenance window. If defined, scheduled scans only run during
   * this window to avoid load on production servers during business hours.
   * Drift detection (event-driven) still runs 24/7 regardless of this setting.
   * If null/undefined, scans run at any time.
   */
  maintenance_window?: MaintenanceWindow | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Scan Results
// ─────────────────────────────────────────────────────────────────────────────

export type ComplianceCheckStatus =
  | 'pass'
  | 'fail'
  | 'partial'
  | 'error'
  | 'not_applicable'
  | 'gpo_controlled';  // Setting is managed by Group Policy; local remediation skipped

export interface ComplianceResult {
  check_id: string;
  status: ComplianceCheckStatus;
  actual_value: any;
  expected_value: any;
  remediated: boolean;
  remediation_result?: 'success' | 'failed' | 'skipped';
  timestamp: string;  // ISO
  error_message?: string;
  /** True if the check's policy path was found in GPO registry */
  gpo_controlled?: boolean;
  /** Name of detected third-party AV if av_check was marked not_applicable */
  third_party_av_detected?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Pre-scan Environment Detection
// ─────────────────────────────────────────────────────────────────────────────

export interface ThirdPartyAVProduct {
  display_name: string;
  product_state: number;  // WMI productState code
  /** Parsed from productState: is real-time protection active? */
  realtime_active: boolean;
  /** Parsed from productState: are definitions up to date? */
  definitions_current: boolean;
}

export interface ScanEnvironment {
  /** True if machine is joined to an Active Directory domain */
  domain_joined: boolean;
  /** Domain FQDN if domain_joined, null if workgroup */
  domain_name: string | null;
  /**
   * True if any Group Policy Objects are active on this machine.
   * Determined by checking HKLM\SOFTWARE\Policies presence and gpresult.
   */
  gpo_active: boolean;
  /**
   * Name of detected third-party AV product (e.g. "SentinelOne", "CrowdStrike Falcon"),
   * or null if only Windows Defender is present.
   * When non-null, all checks with av_check=true are marked not_applicable
   * and a generic third-party AV health check is substituted.
   */
  third_party_av: string | null;
  /** Full product details if third-party AV detected */
  third_party_av_details?: ThirdPartyAVProduct;
  /** Windows version string */
  os_version: string;
  /** Detected at scan start time */
  detected_at: string;  // ISO
}

// ─────────────────────────────────────────────────────────────────────────────
// Compliance Report (transmitted to server)
// ─────────────────────────────────────────────────────────────────────────────

export interface ComplianceReport {
  device_id: string;
  hostname: string;
  template_id: string;
  template_version: number;
  score: number;           // 0-100 weighted score
  is_compliant: boolean;   // score >= minimum_passing_score AND all critical checks pass
  total_checks: number;
  passed: number;
  failed: number;
  not_applicable: number;  // checks skipped due to AV/domain context
  gpo_controlled: number;  // checks where GPO owns the policy
  remediated: number;
  results: ComplianceResult[];
  /** Pre-scan environment snapshot — tells server why certain checks were skipped */
  environment: ScanEnvironment;
  evaluated_at: string;    // ISO
  next_evaluation: string; // ISO — when next full scan is scheduled
  drift_detected: boolean;
  drift_details?: string[];  // check IDs that changed status since last scan
}

// ─────────────────────────────────────────────────────────────────────────────
// Drift Events (sent immediately on status change, before next scheduled report)
// ─────────────────────────────────────────────────────────────────────────────

export interface ComplianceDriftEvent {
  device_id: string;
  hostname: string;
  template_id: string;
  check_id: string;
  check_name: string;
  previous_status: ComplianceCheckStatus;
  current_status: ComplianceCheckStatus;
  framework_reference: string;
  priority: 'critical' | 'recommended' | 'optional';
  detected_at: string;  // ISO
  /** True if drift resulted in a critical check failing (triggers immediate ticket) */
  is_compliance_violation: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Stored state on disk (persisted between agent restarts)
// ─────────────────────────────────────────────────────────────────────────────

export interface ComplianceScanData {
  template: ComplianceTemplate;
  last_results: ComplianceResult[];
  last_score: number;
  last_evaluated_at: string;
  pending_reports: ComplianceReport[];  // queued when offline
}

// ─────────────────────────────────────────────────────────────────────────────
// Third-party AV product state decoder
// productState is a 6-digit hex number encoded as decimal
// ─────────────────────────────────────────────────────────────────────────────

/** Known third-party AV display name patterns for classification */
export const KNOWN_THIRD_PARTY_AV_PATTERNS: string[] = [
  'SentinelOne',
  'CrowdStrike',
  'Sophos',
  'Carbon Black',
  'Cylance',
  'Malwarebytes',
  'Trend Micro',
  'Kaspersky',
  'Symantec',
  'Norton',
  'McAfee',
  'ESET',
  'Webroot',
  'Bitdefender',
  'F-Secure',
  'Avast',
  'AVG',
  'Panda',
  'Emsisoft',
];

/** Parse WMI productState to determine AV health */
export function parseAVProductState(productState: number): { realtimeActive: boolean; definitionsCurrent: boolean } {
  // productState is a 6-digit hex number: 0x[AV_STATUS][DEFINITION_STATUS][PRODUCT_FLAGS]
  const hex = productState.toString(16).padStart(6, '0');
  const realtimeHex = hex.substring(0, 2);
  const definitionHex = hex.substring(2, 4);
  return {
    realtimeActive: realtimeHex === '10',
    definitionsCurrent: definitionHex === '00',
  };
}
