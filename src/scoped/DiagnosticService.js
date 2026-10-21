// Copyright 2026 GMG Technology LLC
// SPDX-License-Identifier: Apache-2.0
var DiagnosticService = Class.create();

/**
 * Centralized diagnostics, error classification, correlation ID tracking,
 * secret redaction, and structured audit observability.
 * Compatible with ServiceNow Rhino (ECMAScript 5).
 */

DiagnosticService.ERRORS = {
    CONFIG_ERROR: 'CONFIG_ERROR',
    AUTH_ERROR: 'AUTH_ERROR',
    RATE_LIMIT: 'RATE_LIMIT',
    TIMEOUT: 'TIMEOUT',
    NETWORK_ERROR: 'NETWORK_ERROR',
    INVALID_RESPONSE: 'INVALID_RESPONSE',
    TOOL_ERROR: 'TOOL_ERROR',
    RECORD_ACCESS_ERROR: 'RECORD_ACCESS_ERROR',
    PROPOSAL_ERROR: 'PROPOSAL_ERROR',
    STALE_CONFLICT: 'STALE_CONFLICT',
    BUDGET_EXHAUSTED: 'BUDGET_EXHAUSTED',
    INTERNAL_ERROR: 'INTERNAL_ERROR'
};

DiagnosticService.EVENT_TYPES = {
    REQUEST_STARTED: 'agent_request_started',
    WORKFLOW_PLAN_CREATED: 'workflow_plan_created',
    TOOL_STARTED: 'tool_execution_started',
    TOOL_COMPLETED: 'tool_execution_completed',
    PROVIDER_FAILED: 'provider_request_failed',
    PROPOSAL_CREATED: 'proposal_created',
    APPROVAL_ACCEPTED: 'approval_accepted',
    APPROVAL_REJECTED: 'approval_rejected',
    CHANGE_APPLIED: 'record_change_applied',
    CHANGE_REJECTED: 'record_change_rejected',
    WORKFLOW_COMPLETED: 'workflow_completed',
    WORKFLOW_FAILED: 'workflow_failed'
};

/**
 * Redact secrets, keys, and authorization tokens from text
 */
DiagnosticService.redact = function(s) {
    if (s === null || s === undefined) return '';
    return String(s)
        .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+\/=-]{8,}/gi, '$1 [redacted]')
        .replace(/\b(sk|xai|pk|rk|ghp|glpat|xoxb|xoxp)-[A-Za-z0-9_-]{8,}/gi, '[redacted key]')
        .replace(/\b(api[_-]?key|x-api-key|password|passwd|secret|token|authorization)(["']?\s*[:=]\s*["']?)[^\s"',;&]+/gi, '$1$2[redacted]')
        .replace(/([?&](?:key|api_key|token|password)=)[^&#\s]+/gi, '$1[redacted]');
};

/**
 * Check if outbound PII redaction is enabled via system property
 * Default: true
 */
DiagnosticService.isPIIRedactionEnabled = function() {
    try {
        if (typeof gs !== 'undefined' && gs.getProperty) {
            return String(gs.getProperty('x_gmg_ai.redact_outbound_pii', 'true')) !== 'false';
        }
    } catch (e) {}
    return true;
};

/**
 * Comprehensive outbound PII and credential sanitizer.
 * Protects emails, phone numbers, SSNs, credit cards, API keys, and credentials
 * before payloads are sent to external LLM providers or recorded in logs.
 * ServiceNow platform records remain completely unchanged.
 */
DiagnosticService.redactPII = function(s) {
    if (s === null || s === undefined) return '';
    if (!DiagnosticService.isPIIRedactionEnabled()) return String(s);

    return String(s)
        // Redact bearer tokens and authorization headers
        .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+\/=-]{8,}/gi, '$1 [redacted_token]')
        // Redact standard provider API keys
        .replace(/\b(sk|xai|pk|rk|ghp|glpat|xoxb|xoxp)-[A-Za-z0-9_-]{8,}/gi, '[redacted_key]')
        // Redact credential parameters / assignments
        .replace(/\b(api[_-]?key|x-api-key|password|passwd|secret|token|authorization)(["']?\s*[:=]\s*["']?)[^\s"',;&]+/gi, '$1$2[redacted]')
        // Redact URL credential query parameters
        .replace(/([?&](?:key|api_key|token|password)=)[^&#\s]+/gi, '$1[redacted]')
        // Redact email addresses
        .replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '[redacted_email]')
        // Redact phone numbers (international, US standard, dashed, parenthesized)
        .replace(/\b(?:\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g, '[redacted_phone]')
        // Redact US Social Security Numbers (SSN)
        .replace(/\b\d{3}-\d{2}-\d{4}\b/g, '[redacted_ssn]')
        // Redact 16-digit credit card / payment card numbers
        .replace(/\b(?:\d{4}[- ]?){3}\d{4}\b/g, '[redacted_card]');
};

/**
 * Calculate bounded exponential backoff with jitter and Retry-After support
 */
DiagnosticService.calculateBackoff = function(attempt, retryAfterSec, maxBackoffMs) {
    maxBackoffMs = maxBackoffMs || 3000;
    var base = Math.min(maxBackoffMs, 200 * Math.pow(2, attempt || 1));
    var jitter = Math.floor(Math.random() * 150);
    var delay = base + jitter;
    if (retryAfterSec && retryAfterSec > 0 && retryAfterSec <= 10) {
        delay = Math.max(delay, (retryAfterSec * 1000) + Math.floor(Math.random() * 100));
    }
    return Math.min(delay, maxBackoffMs + 200);
};

/**
 * Generate a server-side authoritative correlation ID
 */
DiagnosticService.generateCorrelationId = function() {
    var ts = new Date().getTime().toString(36);
    var rand = Math.floor(Math.random() * 0xFFFFFFF).toString(36);
    return 'corr_' + ts + '_' + rand;
};

/**
 * Validate untrusted client correlation ID or assign a new authoritative server ID
 */
DiagnosticService.validateOrAssign = function(clientId) {
    if (clientId && typeof clientId === 'string') {
        var trimmed = clientId.replace(/^\s+|\s+$/g, '');
        if (/^corr_[a-zA-Z0-9_\-]{6,64}$/.test(trimmed)) {
            return trimmed;
        }
    }
    return DiagnosticService.generateCorrelationId();
};

/**
 * Classify error string or object into standardized diagnostic format
 */
DiagnosticService.classify = function(err, httpStatus) {
    var status = parseInt(httpStatus, 10) || 0;
    var errStr = '';
    var rawCategory = '';

    if (err && typeof err === 'object') {
        errStr = err.message || err.error || String(err);
        rawCategory = err.category || err.code || '';
    } else {
        errStr = String(err || '');
    }

    var lower = errStr.toLowerCase();
    var code = DiagnosticService.ERRORS.INTERNAL_ERROR;
    var retryable = false;
    var safeMessage = 'An internal system error occurred. Please contact your system administrator.';

    // 1. Rate limits
    if (status === 429 || rawCategory === 'rate_limit' || lower.indexOf('rate limit') >= 0 || lower.indexOf('quota exceeded') >= 0 || lower.indexOf('too many requests') >= 0) {
        code = DiagnosticService.ERRORS.RATE_LIMIT;
        retryable = true;
        safeMessage = 'AI provider rate limit or quota reached. Please wait a moment before trying again.';
    }
    // 2. Authentication & Authorization
    else if (status === 401 || status === 403 || rawCategory === 'auth_error' || lower.indexOf('unauthorized') >= 0 || lower.indexOf('forbidden') >= 0 || lower.indexOf('invalid api key') >= 0 || lower.indexOf('role required') >= 0) {
        code = DiagnosticService.ERRORS.AUTH_ERROR;
        retryable = false;
        safeMessage = 'Authentication or authorization failure. Check provider credentials and user roles.';
    }
    // 3. Timeouts & Budget Deadlines
    else if (status === 408 || status === 504 || rawCategory === 'timeout' || lower.indexOf('timeout') >= 0 || lower.indexOf('deadline') >= 0 || lower.indexOf('budget margin') >= 0 || lower.indexOf('timed out') >= 0) {
        code = DiagnosticService.ERRORS.TIMEOUT;
        retryable = true; // only for safe reads; writes handled separately
        safeMessage = 'Operation timed out while waiting for a response. Please try again with a narrower query.';
    }
    // 4. Budget exhaustion
    else if (rawCategory === 'budget_exhausted' || lower.indexOf('budget blocked') >= 0 || lower.indexOf('budget exhausted') >= 0 || lower.indexOf('spend cap') >= 0) {
        code = DiagnosticService.ERRORS.BUDGET_EXHAUSTED;
        retryable = false;
        safeMessage = 'Spend or token budget cap reached for this provider. Contact your ServiceNow administrator.';
    }
    // 5. Configuration & Model Allowlist
    else if (rawCategory === 'config_error' || lower.indexOf('not authorized') >= 0 || lower.indexOf('allowlist') >= 0 || lower.indexOf('no active ai provider') >= 0 || lower.indexOf('unknown ai provider') >= 0 || lower.indexOf('endpoint url is empty') >= 0) {
        code = DiagnosticService.ERRORS.CONFIG_ERROR;
        retryable = false;
        safeMessage = 'AI provider or model configuration error. Verify provider settings and allowlist.';
    }
    // 6. Network & SSRF errors
    else if (rawCategory === 'network_error' || status === 502 || status === 503 || lower.indexOf('ssrf') >= 0 || lower.indexOf('connection refused') >= 0 || lower.indexOf('forbidden by ssrf') >= 0 || lower.indexOf('econnrefused') >= 0) {
        code = DiagnosticService.ERRORS.NETWORK_ERROR;
        retryable = (status === 502 || status === 503);
        safeMessage = 'Network connectivity or security policy prevented connecting to the AI provider.';
    }
    // 7. Stale record conflicts
    else if (rawCategory === 'stale_conflict' || lower.indexOf('stale') >= 0 || lower.indexOf('modified since') >= 0 || lower.indexOf('sys_mod_count') >= 0) {
        code = DiagnosticService.ERRORS.STALE_CONFLICT;
        retryable = false;
        safeMessage = 'Target record was modified by another transaction. Please review the updated record and re-propose.';
    }
    // 8. Proposal & Seal tampering
    else if (rawCategory === 'proposal_error' || lower.indexOf('seal') >= 0 || lower.indexOf('tamper') >= 0 || lower.indexOf('review gate') >= 0 || lower.indexOf('hash mismatch') >= 0) {
        code = DiagnosticService.ERRORS.PROPOSAL_ERROR;
        retryable = false;
        safeMessage = 'Proposal integrity verification failed. Action rejected for security reasons.';
    }
    // 9. Record access & ACLs
    else if (rawCategory === 'record_access_error' || lower.indexOf('gliderecordsecure') >= 0 || lower.indexOf('acl') >= 0 || lower.indexOf('access denied') >= 0 || lower.indexOf('read permission') >= 0) {
        code = DiagnosticService.ERRORS.RECORD_ACCESS_ERROR;
        retryable = false;
        safeMessage = 'Access denied: your ServiceNow user lacks required permissions to access this record or field.';
    }
    // 10. Tool errors
    else if (rawCategory === 'tool_error' || lower.indexOf('tool') >= 0 && (lower.indexOf('not authorized') >= 0 || lower.indexOf('not in the allowlist') >= 0 || lower.indexOf('exceeds maximum allowed size') >= 0)) {
        code = DiagnosticService.ERRORS.TOOL_ERROR;
        retryable = false;
        safeMessage = 'Tool execution validation failed: parameters invalid or tool unauthorized.';
    }
    // 11. Invalid model responses
    else if (rawCategory === 'invalid_response' || lower.indexOf('syntaxerror') >= 0 || lower.indexOf('unexpected token') >= 0 || lower.indexOf('malformed json') >= 0 || lower.indexOf('no response from model') >= 0) {
        code = DiagnosticService.ERRORS.INVALID_RESPONSE;
        retryable = false;
        safeMessage = 'Received an invalid or malformed response from the AI provider.';
    }

    return {
        code: code,
        retryable: retryable,
        safe_message: safeMessage,
        details: DiagnosticService.redact(errStr)
    };
};

/**
 * Determine whether an operation can be safely retried
 * Strict Invariant: Write operations are NEVER automatically retried!
 */
DiagnosticService.isRetryable = function(code, isWriteOp) {
    if (isWriteOp === true) return false;
    return (code === DiagnosticService.ERRORS.RATE_LIMIT ||
            code === DiagnosticService.ERRORS.TIMEOUT ||
            code === DiagnosticService.ERRORS.NETWORK_ERROR);
};

/**
 * Format error response safely for users vs administrators
 */
DiagnosticService.formatUserError = function(diagObj, correlationId, isAdmin) {
    diagObj = diagObj || {};
    var out = {
        ok: false,
        error: diagObj.safe_message || 'An error occurred during agent execution.',
        error_code: diagObj.code || DiagnosticService.ERRORS.INTERNAL_ERROR,
        correlation_id: correlationId || DiagnosticService.generateCorrelationId(),
        retryable: !!diagObj.retryable
    };

    // Administrators receive redacted diagnostic details
    if (isAdmin === true && diagObj.details) {
        out.admin_details = DiagnosticService.redact(diagObj.details);
    }

    return out;
};

/**
 * Log a structured, minimal audit event to x_gmg_ai_log
 * Fail-safe: handles logging failures without turning failures into successes
 */
DiagnosticService.logAuditEvent = function(params) {
    params = params || {};
    var eventType = params.eventType || 'unknown_event';
    var corrId = params.correlationId || DiagnosticService.generateCorrelationId();
    var userId = (typeof gs !== 'undefined' && gs.getUserID) ? gs.getUserID() : (params.userId || '');

    var auditPayload = {
        event_type: eventType,
        correlation_id: corrId,
        timestamp: new Date().toISOString ? new Date().toISOString() : new GlideDateTime().getValue(),
        workflow_id: params.workflowId || null,
        tool: params.tool || null,
        outcome: params.outcome || 'info',
        error_code: params.errorCode || null,
        target_table: params.targetTable || null,
        target_sys_id: params.targetSysId || null
    };

    if (params.details) {
        auditPayload.details = DiagnosticService.redact(String(params.details)).substring(0, 500);
    }

    try {
        if (typeof GlideRecord === 'undefined') {
            return { ok: true, audit: auditPayload, mocked: true };
        }

        var l = new GlideRecord('x_gmg_ai_log');
        l.initialize();
        l.setValue('user', userId);
        l.setValue('status', 'audit_event');
        l.setValue('tools', ('audit:' + eventType + (params.tool ? ':' + params.tool : '')).substring(0, 1000));
        l.setValue('prompt', ('Audit event ' + eventType + ' [' + corrId + ']').substring(0, 4000));
        l.setValue('response', JSON.stringify(auditPayload).substring(0, 4000));
        
        if (params.targetTable) l.setValue('table_name', String(params.targetTable).substring(0, 80));
        if (params.targetSysId) l.setValue('record_sys_id', String(params.targetSysId).substring(0, 32));
        if (l.isValidField('conversation_id') && params.workflowId) {
            l.setValue('conversation_id', String(params.workflowId).substring(0, 64));
        }
        if (params.durationMs) {
            l.setValue('duration_ms', parseInt(params.durationMs, 10) || 0);
        }

        l.insert();
        return { ok: true, audit: auditPayload };
    } catch (ex) {
        if (typeof gs !== 'undefined' && gs.error) {
            gs.error('GMG AI audit event logging failed: ' + ex);
        }
        return { ok: false, error: 'Audit logging failed: ' + String(ex) };
    }
};

DiagnosticService.prototype = {
    initialize: function() {},
    type: 'DiagnosticService'
};
