// Copyright 2026 GMG Technology LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Upgrade 5: Production Readiness, Observability & End-to-End Validation Test Suite
 * Release: v1.5.0
 * 
 * Verifies all 20 required production readiness test cases:
 * 1. Secret redaction in errors
 * 2. Correlation ID propagation
 * 3. Safe audit-event construction
 * 4. Audit logging failure handling
 * 5. Provider authentication failure
 * 6. Provider rate-limit handling
 * 7. Retry classification
 * 8. Deadline exhaustion
 * 9. Duplicate submission protection
 * 10. Invalid workflow state transitions
 * 11. Unauthorized workflow access
 * 12. Approval replay rejection
 * 13. Stale-record rejection
 * 14. Ambiguous write timeout handling
 * 15. Safe interrupted-workflow recovery
 * 16. UI error-state rendering
 * 17. Provider configuration validation
 * 18. Update-set packaging integrity
 * 19. Documentation and manifest consistency
 * 20. Regression coverage for all existing capabilities
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

// Setup minimal ServiceNow Rhino environment mock
global.Class = { create: function() { return function() { if (this.initialize) this.initialize.apply(this, arguments); }; } };

let passCount = 0;
let totalCount = 0;

function assert(condition, message) {
    totalCount++;
    if (!condition) {
        console.error(`[FAIL] ${message}`);
        throw new Error(`Assertion failed: ${message}`);
    } else {
        console.log(`[PASS] ${message}`);
        passCount++;
    }
}

// Load scoped scripts into test sandbox
function loadScript(relPath) {
    const fullPath = path.resolve(__dirname, '../../', relPath);
    const code = fs.readFileSync(fullPath, 'utf8');
    vm.runInThisContext(code);
}

const mockState = {
    currentUserId: '6816f79cc0a8016401c5a33be04be441',
    roles: ['x_gmg_ai.user', 'admin'],
    properties: {
        'x_gmg_ai.model_allowlist': 'claude-3-5-sonnet-20241022,gpt-4o,omniroute/gpt-4o-mini',
        'x_gmg_ai.time_budget_ms': '30000',
        'instance_name': 'dev_instance'
    },
    tables: {
        x_gmg_ai_provider: [
            {
                sys_id: 'prov_default_01',
                name: 'Default OmniRoute',
                type: 'omniroute',
                model: 'omniroute/gpt-4o-mini',
                active: '1',
                api_url: 'http://127.0.0.1:20128/v1',
                api_key: { getDecryptedValue: () => 'sk-test-key-12345' }
            }
        ],
        x_gmg_ai_pending_action: [],
        x_gmg_ai_log: [],
        incident: [
            {
                sys_id: 'inc_test_01',
                number: 'INC0000060',
                short_description: 'Network connectivity degraded in Dallas datacenter',
                description: 'Users reporting packet loss across switch cluster',
                category: 'network',
                active: '1',
                sys_mod_count: '1',
                sys_updated_on: '2026-10-21 10:00:00'
            }
        ]
    }
};

// Global gs mock
global.gs = {
    getUserID: function() { return mockState.currentUserId; },
    getUserName: function() { return mockState.currentUserId === 'admin' ? 'admin' : 'dev_engineer'; },
    getUserDisplayName: function() { return 'Developer Engineer'; },
    hasRole: function(role) { return mockState.roles.indexOf(role) >= 0; },
    getProperty: function(key, dflt) {
        return (key in mockState.properties) ? mockState.properties[key] : dflt;
    },
    setProperty: function(k, v) { mockState.properties[k] = String(v); },
    warn: function(msg) {},
    error: function(msg) {},
    info: function(msg) {},
    beginningOfToday: () => '2026-10-21 00:00:00',
    getSession: () => ({
        clientData: {},
        getClientData: function(k) { return this.clientData[k]; },
        putClientData: function(k, v) { this.clientData[k] = v; }
    })
};

global.GlideDateTime = function(val) {
    this.val = val || '2026-10-21 12:00:00';
    this.getValue = function() { return this.val; };
    this.getDisplayValue = function() { return this.val; };
    this.setDisplayValueInternal = function(v) { this.val = v; };
    this.getNumericValue = () => 1761000000000;
    this.getLocalDate = () => ({ getValue: () => '2026-10-21' });
    this.after = function(other) {
        if (!other) return false;
        var oVal = typeof other.getValue === 'function' ? other.getValue() : String(other);
        return this.val > oVal;
    };
    this.before = function(other) {
        if (!other) return false;
        var oVal = typeof other.getValue === 'function' ? other.getValue() : String(other);
        return this.val < oVal;
    };
    this.addSeconds = function() {};
};

global.GlideDigest = function() {
    this.getSHA256Hex = (s) => crypto.createHash('sha256').update(s).digest('hex');
};

function MockGlideRecord(table) {
    this.table = table;
    this.rows = (mockState.tables[table] || []).slice();
    this.idx = -1;
    this.current = {};
    this.queries = [];
    this.limit = 100;

    this.initialize = function() {
        this.current = {};
    };
    this.addActiveQuery = function() {
        this.rows = this.rows.filter(r => r.active === true || r.active === '1' || r.active === undefined);
    };
    this.addQuery = function(f, op, val) {
        if (arguments.length === 2) { val = op; op = '='; }
        this.queries.push({ field: f, op: op, val: val });
    };
    this.addEncodedQuery = function() {};
    this.orderBy = function() {};
    this.orderByDesc = function() {};
    this.setLimit = function(n) { this.limit = n; };
    this.query = function() {
        var filtered = (mockState.tables[this.table] || []).slice();
        for (var i = 0; i < this.queries.length; i++) {
            var q = this.queries[i];
            if (q.op === '=') filtered = filtered.filter(r => String(r[q.field]) === String(q.val));
            else if (q.op === '!=') filtered = filtered.filter(r => String(r[q.field]) !== String(q.val));
        }
        this.rows = filtered.slice(0, this.limit);
        this.idx = -1;
    };
    this.next = function() {
        this.idx++;
        if (this.idx < this.rows.length) {
            this.current = this.rows[this.idx];
            return true;
        }
        return false;
    };
    this.get = function(id) {
        var found = (mockState.tables[this.table] || []).find(r => r.sys_id === id);
        if (found) {
            this.current = found;
            return true;
        }
        return false;
    };
    this.setValue = function(k, v) { this.current[k] = v; };
    this.getValue = function(k) { return this.current[k]; };
    this.getDisplayValue = function(k) { return this.current[k]; };
    this.isValidField = function(k) { return true; };
    this.getUniqueValue = function() { return this.current.sys_id || 'sys_' + Math.random().toString(36).substring(2, 10); };
    this.insert = function() {
        return MockGlideRecord.prototype.insert.apply(this, arguments);
    };
    this.update = function() {
        return MockGlideRecord.prototype.update.apply(this, arguments);
    };
}
MockGlideRecord.prototype.insert = function() {
    if (!this.current.sys_id) this.current.sys_id = 'sys_' + Math.random().toString(36).substring(2, 10);
    if (!mockState.tables[this.table]) mockState.tables[this.table] = [];
    mockState.tables[this.table].push(Object.assign({}, this.current));
    return this.current.sys_id;
};
MockGlideRecord.prototype.update = function() {
    var rows = mockState.tables[this.table] || [];
    var idx = rows.findIndex(r => r.sys_id === this.current.sys_id);
    if (idx >= 0) {
        rows[idx] = Object.assign({}, this.current);
        return true;
    }
    return false;
};
global.GlideAggregate = function(table) {
    this.table = table;
    this.addQuery = function() {};
    this.addEncodedQuery = function() {};
    this.addAggregate = function() {};
    this.groupBy = function() {};
    this.setGroup = function() {};
    this.query = function() {};
    this.next = function() { return false; };
    this.getAggregate = function() { return 0; };
    this.getValue = function() { return ''; };
};

global.sn_ws = {
    RESTMessageV2: function() {
        this.endpoint = '';
        this.method = 'post';
        this.headers = {};
        this.body = '';
        this.setEndpoint = (u) => { this.endpoint = u; };
        this.setHttpMethod = (m) => { this.method = m; };
        this.setRequestHeader = (k, v) => { this.headers[k] = v; };
        this.setRequestBody = (b) => { this.body = b; };
        this.setHttpTimeout = (ms) => {};
        this.execute = () => ({
            getStatusCode: () => 200,
            getBody: () => JSON.stringify({ choices: [{ message: { content: 'Acknowledged.' } }], usage: { total_tokens: 10 } }),
            haveError: () => false,
            getErrorMessage: () => ''
        });
    }
};

global.GlideRecord = MockGlideRecord;
global.GlideRecordSecure = MockGlideRecord;

// Load application Script Includes
loadScript('src/scoped/DiagnosticService.js');
loadScript('src/scoped/GMGSeal.js');
loadScript('src/scoped/Budget.js');
loadScript('src/scoped/DevValidator.js');
loadScript('src/scoped/DevAssistant.js');
loadScript('src/scoped/ITSMRetriever.js');
loadScript('src/scoped/ITSMContextBuilder.js');
loadScript('src/scoped/ITSMAssistant.js');
loadScript('src/scoped/RecordTools.js');
loadScript('src/scoped/AgentTools.js');
loadScript('src/scoped/LLMAdapter.js');
loadScript('src/scoped/WorkflowPlanner.js');
loadScript('src/scoped/WorkflowEngine.js');
loadScript('src/scoped/ActionService.js');
loadScript('src/scoped/AgentCore.js');
loadScript('src/global/GMGAIApplierCore.js');
global.GMGAIApplier = GMGAIApplierCore;
global.global = { GMGAIApplier: GMGAIApplierCore };

console.log('--- STARTING UPGRADE 5: PRODUCTION READINESS & OBSERVABILITY TESTS ---\n');

// 1. Secret redaction in errors
(function testSecretRedaction() {
    var rawErr = 'Failed connecting to https://api.openai.com/v1 with Bearer sk-ant-api03-abcdef123456789 and password="MySuperSecretPassword!"';
    var redacted = DiagnosticService.redact(rawErr);
    assert(redacted.indexOf('sk-ant-api03') === -1, '1. Secret redaction: sk- API key is redacted');
    assert(redacted.indexOf('MySuperSecretPassword') === -1, '1. Secret redaction: password is redacted');
    assert(redacted.indexOf('[redacted]') >= 0 || redacted.indexOf('[redacted key]') >= 0, '1. Secret redaction: contains redaction marker');
})();

// 2. Correlation ID propagation
(function testCorrelationIdPropagation() {
    var generated = DiagnosticService.generateCorrelationId();
    assert(/^corr_[a-z0-9_]{6,64}$/i.test(generated), '2. Correlation ID: Generated ID matches format corr_<ts>_<rand>');

    var validated = DiagnosticService.validateOrAssign('corr_valid123_abc');
    assert(validated === 'corr_valid123_abc', '2. Correlation ID: Valid client ID is accepted');

    var spoofed = DiagnosticService.validateOrAssign('malicious-payload<script>');
    assert(spoofed !== 'malicious-payload<script>' && spoofed.indexOf('corr_') === 0, '2. Correlation ID: Invalid/malicious client ID is safely replaced with server ID');

    var core = new AgentCore();
    var res = core.run({ message: 'Hello', correlation_id: 'corr_req_test123' });
    assert(res.correlation_id === 'corr_req_test123', '2. Correlation ID: Correlation ID propagated through AgentCore');
})();

// 3. Safe audit-event construction
(function testSafeAuditEventConstruction() {
    var audit = DiagnosticService.logAuditEvent({
        eventType: DiagnosticService.EVENT_TYPES.REQUEST_STARTED,
        correlationId: 'corr_audit_test',
        workflowId: 'wf_test_01',
        tool: 'get_record',
        targetTable: 'incident',
        targetSysId: 'inc123456',
        outcome: 'started',
        details: 'Authorization: Bearer secret_token_xyz'
    });
    assert(audit.ok === true, '3. Safe audit event: logAuditEvent returns success');
    assert(audit.audit.event_type === 'agent_request_started', '3. Safe audit event: Correct event_type recorded');
    assert(audit.audit.correlation_id === 'corr_audit_test', '3. Safe audit event: Correlation ID stored');
    assert(audit.audit.details.indexOf('secret_token') === -1, '3. Safe audit event: Secrets in details are redacted');
})();

// 4. Audit logging failure handling
(function testAuditLoggingFailureHandling() {
    var origInsert = GlideRecord.prototype.insert;
    GlideRecord.prototype.insert = function() { throw new Error('Database disk full / table lock'); };
    
    var res = DiagnosticService.logAuditEvent({ eventType: 'test_failure' });
    assert(res.ok === false, '4. Audit logging failure: Handled gracefully without uncaught exception');
    assert(res.error.indexOf('Database disk full') >= 0, '4. Audit logging failure: Safe error reported to logger');

    GlideRecord.prototype.insert = origInsert;
})();

// 5. Provider authentication failure
(function testProviderAuthFailure() {
    var diag = DiagnosticService.classify('Invalid API Key provided', 401);
    assert(diag.code === DiagnosticService.ERRORS.AUTH_ERROR, '5. Provider auth failure: Classified as AUTH_ERROR');
    assert(diag.retryable === false, '5. Provider auth failure: Marked non-retryable');
    assert(diag.safe_message.indexOf('Authentication or authorization failure') >= 0, '5. Provider auth failure: Returns safe user message');
})();

// 6. Provider rate-limit handling
(function testProviderRateLimitHandling() {
    var diag = DiagnosticService.classify('Rate limit reached: 3 requests per minute', 429);
    assert(diag.code === DiagnosticService.ERRORS.RATE_LIMIT, '6. Rate limit handling: Classified as RATE_LIMIT');
    assert(diag.retryable === true, '6. Rate limit handling: Marked retryable');
    assert(DiagnosticService.isRetryable(diag.code, false) === true, '6. Rate limit handling: Safe read retry is permitted');
})();

// 7. Retry classification
(function testRetryClassification() {
    // Write operations are NEVER retryable
    assert(DiagnosticService.isRetryable(DiagnosticService.ERRORS.RATE_LIMIT, true) === false, '7. Retry classification: Write op with RATE_LIMIT is NOT retryable');
    assert(DiagnosticService.isRetryable(DiagnosticService.ERRORS.TIMEOUT, true) === false, '7. Retry classification: Write op with TIMEOUT is NOT retryable');
    // Non-retryable error codes
    assert(DiagnosticService.isRetryable(DiagnosticService.ERRORS.AUTH_ERROR, false) === false, '7. Retry classification: AUTH_ERROR is not retryable');
    assert(DiagnosticService.isRetryable(DiagnosticService.ERRORS.STALE_CONFLICT, false) === false, '7. Retry classification: STALE_CONFLICT is not retryable');
    assert(DiagnosticService.isRetryable(DiagnosticService.ERRORS.PROPOSAL_ERROR, false) === false, '7. Retry classification: PROPOSAL_ERROR is not retryable');
    // Safe read errors
    assert(DiagnosticService.isRetryable(DiagnosticService.ERRORS.TIMEOUT, false) === true, '7. Retry classification: Read TIMEOUT is retryable');
})();

// 8. Deadline exhaustion
(function testDeadlineExhaustion() {
    var engine = new WorkflowEngine();
    var step = { id: 'step_1', name: 'Query Incidents', tool: 'query_records', params: { table: 'incident' }, status: 'pending' };
    var workflow = { workflow_id: 'wf_deadline', evidence: {} };
    // Pass deadlineMs that is already past minimum margin (now + 1000ms < 3000ms margin)
    var tightDeadline = new Date().getTime() + 1000;
    var res = engine.executeStep(step, workflow, {}, tightDeadline);
    assert(res.ok === false, '8. Deadline exhaustion: Step halts before execution');
    assert(res.timeout === true, '8. Deadline exhaustion: Marked as timeout');
    assert(res.error.indexOf('budget margin') >= 0, '8. Deadline exhaustion: Budget margin warning returned');
})();

// 9. Duplicate submission protection
(function testDuplicateSubmissionProtection() {
    var paId = 'pa_double_click_test';
    var paObj = {
        sys_id: paId,
        user: '6816f79cc0a8016401c5a33be04be441',
        status: 'applied',
        operation: 'update',
        target_table: 'incident',
        target_sys_id: 'inc_test_01',
        payload: JSON.stringify({ kind: 'record', table: 'incident', sys_id: 'inc_test_01', fields: { short_description: 'Test' } }),
        expires: '2026-10-21 13:00:00'
    };
    mockState.tables.x_gmg_ai_pending_action.push(paObj);

    var svc = new ActionService();
    var replayCall = svc.confirm(paId);
    assert(replayCall.code === 409, '9. Duplicate submission: Replay rejected with HTTP 409 conflict');
    assert(replayCall.error.indexOf('already applied') >= 0, '9. Duplicate submission: Explains action is already applied');
})();

// 10. Invalid workflow state transitions
(function testWorkflowStateTransitions() {
    assert(WorkflowEngine.isValidTransition('planned', 'running') === true, '10. State transitions: planned -> running is valid');
    assert(WorkflowEngine.isValidTransition('running', 'waiting_approval') === true, '10. State transitions: running -> waiting_approval is valid');
    assert(WorkflowEngine.isValidTransition('waiting_approval', 'completed') === true, '10. State transitions: waiting_approval -> completed is valid');
    assert(WorkflowEngine.isValidTransition('planned', 'completed') === false, '10. State transitions: planned -> completed is invalid');
    assert(WorkflowEngine.isValidTransition('completed', 'running') === false, '10. State transitions: completed -> running is invalid');
    assert(WorkflowEngine.isValidTransition('rejected', 'running') === false, '10. State transitions: rejected -> running is invalid');

    var engine = new WorkflowEngine();
    var invalidPlan = {
        workflow_id: 'wf_invalid_state',
        type: 'incident_investigation',
        status: 'completed',
        goal: 'Invalid run',
        steps: [{ id: 's1', name: 'Step 1', tool: 'get_record', params: { table: 'incident' }, status: 'completed', read_only: true, requires_approval: false }],
        user_id: '6816f79cc0a8016401c5a33be04be441'
    };
    var res = engine.run(invalidPlan, {}, '6816f79cc0a8016401c5a33be04be441');
    assert(res.ok === false, '10. State transitions: Cannot re-run completed workflow');
    assert(res.code === 400, '10. State transitions: Returns HTTP 400 bad request');
})();

// 11. Unauthorized workflow access
(function testUnauthorizedWorkflowAccess() {
    var engine = new WorkflowEngine();
    var otherUserPlan = {
        workflow_id: 'wf_other_user',
        type: 'incident_investigation',
        status: 'planned',
        goal: 'Private workflow',
        user_id: '9996f79cc0a8016401c5a33be04be999',
        steps: [{ id: 's1', name: 'Step 1', tool: 'get_record', params: { table: 'incident' }, status: 'pending', read_only: true, requires_approval: false }]
    };
    // Non-admin user attempting to access other user's workflow
    var origHasRole = gs.hasRole;
    gs.hasRole = function(role) { return role === 'x_gmg_ai.user'; }; // NOT admin
    
    var access = engine.canAccessWorkflow(otherUserPlan, '6816f79cc0a8016401c5a33be04be441');
    assert(access === false, '11. Cross-user isolation: Access refused for non-owner');

    var runRes = engine.run(otherUserPlan, {}, '6816f79cc0a8016401c5a33be04be441');
    assert(runRes.ok === false && runRes.code === 403, '11. Cross-user isolation: run() blocked with HTTP 403');

    gs.hasRole = origHasRole;
})();

// 12. Approval replay rejection
(function testApprovalReplayRejection() {
    var paId = 'pa_replay_test';
    var paObj = {
        sys_id: paId,
        user: '6816f79cc0a8016401c5a33be04be441',
        status: 'rejected',
        operation: 'update',
        target_table: 'incident',
        target_sys_id: 'inc_test_02',
        payload: JSON.stringify({ kind: 'record', table: 'incident', sys_id: 'inc_test_02', fields: { state: '7' } }),
        expires: '2026-10-21 13:00:00'
    };
    mockState.tables.x_gmg_ai_pending_action.push(paObj);

    var svc = new ActionService();
    var res = svc.confirm(paId);
    assert(res.code === 409, '12. Approval replay rejection: Rejected proposal cannot be confirmed');
    assert(res.error.indexOf('already rejected') >= 0, '12. Approval replay rejection: Error reports action was already rejected');
})();

// 13. Stale-record rejection
(function testStaleRecordRejection() {
    var oldStamp = { updated_on: '2026-10-21 10:00:00', mod_count: '1' };
    var currentRecord = { updated_on: '2026-10-21 11:30:00', mod_count: '2' };
    var staleCheck = GMGAIApplier.recordEditStale(oldStamp, currentRecord);
    assert(staleCheck !== '', '13. Stale-record rejection: Detects changed mod_count');
    assert(staleCheck.indexOf('changed since') >= 0, '13. Stale-record rejection: Reason states record changed');
})();

// 14. Ambiguous write timeout handling
(function testAmbiguousWriteTimeoutHandling() {
    var engine = new WorkflowEngine();
    var origHandle = engine._handleApprovalGatedStep;
    engine._handleApprovalGatedStep = function() { throw new Error('Socket hang up / ambiguous timeout'); };

    var writeStep = {
        id: 's_write',
        name: 'Update Incident',
        tool: 'propose_current_record_update',
        params: { fields: { close_notes: 'Done' } },
        status: 'pending'
    };
    var workflow = { workflow_id: 'wf_ambiguous', evidence: {} };
    var res = engine.executeStep(writeStep, workflow, {});
    assert(res.ok === false, '14. Ambiguous write timeout: Step marked failed');
    assert(res.ambiguous_write === true, '14. Ambiguous write timeout: Flagged as ambiguous_write');
    assert(res.retryable === false, '14. Ambiguous write timeout: Auto-retry strictly prohibited');

    engine._handleApprovalGatedStep = origHandle;
})();

// 15. Safe interrupted-workflow recovery
(function testInterruptedWorkflowRecovery() {
    var paId = 'pa_recovery_step';
    var paObj = {
        sys_id: paId,
        user: '6816f79cc0a8016401c5a33be04be441',
        status: 'applied',
        operation: 'update',
        target_table: 'incident',
        target_sys_id: 'inc_rec_01',
        payload: '{}'
    };
    mockState.tables.x_gmg_ai_pending_action.push(paObj);

    var engine = new WorkflowEngine();
    var interruptedPlan = {
        workflow_id: 'wf_interrupted_01',
        type: 'incident_investigation',
        status: 'waiting_approval',
        goal: 'Recover workflow',
        user_id: '6816f79cc0a8016401c5a33be04be441',
        steps: [
            { id: 's1', name: 'Read record', tool: 'get_record', params: { table: 'incident' }, status: 'completed', read_only: true, requires_approval: false },
            { id: 's2', name: 'Write change', tool: 'propose_current_record_update', params: {}, status: 'waiting_approval', result: { pending_action_id: paId }, read_only: false, requires_approval: true },
            { id: 's3', name: 'Final summarize', tool: 'summarize_incident', params: { incident_id: 'INC0000060', query: 'test' }, status: 'pending', read_only: true, requires_approval: false }
        ],
        evidence: {}
    };

    var res = engine.resume(interruptedPlan, {}, '6816f79cc0a8016401c5a33be04be441');
    assert(res.ok === true, '15. Interrupted recovery: Resume succeeds');
    assert(interruptedPlan.steps[1].status === 'completed', '15. Interrupted recovery: Step 2 marked completed because proposal was applied');
    assert(interruptedPlan.steps[2].status === 'completed', '15. Interrupted recovery: Subsequent steps executed cleanly');
    assert(interruptedPlan.status === 'completed', '15. Interrupted recovery: Workflow reaches completed status');
})();

// 16. UI error-state rendering
(function testUIErrorStateRendering() {
    var uiScriptCode = fs.readFileSync('src/global/gmg_ai_agent_panel.js', 'utf8');
    assert(uiScriptCode.indexOf('gmgai-err-diag') >= 0, '16. UI error-state: Renders diagnostic container');
    assert(uiScriptCode.indexOf('m.correlation_id') >= 0, '16. UI error-state: Displays correlation ID');
    assert(uiScriptCode.indexOf('m.error_code') >= 0, '16. UI error-state: Displays standardized error code');
    assert(uiScriptCode.indexOf('disabledAttr') >= 0 || uiScriptCode.indexOf('s.pending ? \' disabled') >= 0, '16. UI error-state: Input and buttons disabled while pending');
})();

// 17. Provider configuration validation
(function testProviderConfigValidation() {
    var validRes = LLMAdapter.validateEndpoint('https://api.openai.com/v1');
    assert(validRes.ok === true, '17. Provider config: Valid HTTPS endpoint allowed');

    var metadataRes = LLMAdapter.validateEndpoint('http://169.254.169.254/latest/meta-data');
    assert(metadataRes.ok === false, '17. Provider config: Cloud metadata IP forbidden');

    var privateRes = LLMAdapter.validateEndpoint('https://10.0.0.1/v1');
    assert(privateRes.ok === false, '17. Provider config: Private IP forbidden');

    var loopbackNoFlag = LLMAdapter.validateEndpoint('http://127.0.0.1:20128/v1', false);
    assert(loopbackNoFlag.ok === false, '17. Provider config: Loopback forbidden without explicit property');

    var loopbackWithFlag = LLMAdapter.validateEndpoint('http://127.0.0.1:20128/v1', true);
    assert(loopbackWithFlag.ok === true, '17. Provider config: Loopback permitted with allow_http_localhost flag');
})();

// 18. Update-set packaging integrity
(function testUpdateSetPackagingIntegrity() {
    var globalXml = fs.readFileSync('update_sets/gmg_ai_agent_global.xml', 'utf8');
    var scopedXml = fs.readFileSync('update_sets/gmg_ai_agent_scoped.xml', 'utf8');

    assert(globalXml.indexOf('<sys_update_xml action=') >= 0, '18. Update-set integrity: Global update set has valid XML records');
    assert(scopedXml.indexOf('DiagnosticService') >= 0, '18. Update-set integrity: DiagnosticService is packaged in scoped XML');
    assert(scopedXml.indexOf('WorkflowEngine') >= 0, '18. Update-set integrity: WorkflowEngine is packaged in scoped XML');
    assert(scopedXml.indexOf('ActionService') >= 0, '18. Update-set integrity: ActionService is packaged in scoped XML');

    var gCount = (globalXml.match(/<sys_update_xml action=/g) || []).length;
    var sCount = (scopedXml.match(/<sys_update_xml action=/g) || []).length;
    assert(gCount === 3, `18. Update-set integrity: Global record count is 3 (actual: ${gCount})`);
    assert(sCount === 330, `18. Update-set integrity: Scoped record count is 330 (actual: ${sCount})`);
})();

// 19. Documentation and manifest consistency
(function testDocumentationAndManifestConsistency() {
    var sumsContent = fs.readFileSync('SHA256SUMS', 'utf8').trim().split('\n');
    assert(sumsContent.length === 2, '19. Manifest consistency: SHA256SUMS contains 2 entries');

    sumsContent.forEach(function(line) {
        var parts = line.split(/\s+/);
        var expectedHash = parts[0];
        var filePath = parts[1];
        var fileBytes = fs.readFileSync(filePath);
        var actualHash = crypto.createHash('sha256').update(fileBytes).digest('hex');
        assert(expectedHash === actualHash, `19. Manifest consistency: Checksum matches for ${filePath}`);
    });
})();

// 20. Regression coverage for all existing capabilities
(function testRegressionCoverage() {
    // A. OmniRoute compatibility
    var pgrMock = {
        getUniqueValue: function() { return 'prov_omni_01'; },
        getValue: function(k) {
            if (k === 'name') return 'OmniRoute Gateway';
            if (k === 'type') return 'omniroute';
            if (k === 'model') return 'omniroute/gpt-4o-mini';
            if (k === 'api_url') return 'http://127.0.0.1:20128/v1';
            return '';
        },
        api_key: { getDecryptedValue: function() { return 'sk-omni-test'; } }
    };
    var adapter = new LLMAdapter(pgrMock);
    assert(adapter.p.type === 'omniroute', '20. Regression: OmniRoute provider recognized');

    // B. DevAssistant validation
    var devVal = new DevValidator();
    var brBad = devVal.validate('current.update();', 'business_rule');
    assert(brBad.ok === false, '20. Regression: DevValidator catches current.update()');

    // C. ITSM Evidence context
    var cb = new ITSMContextBuilder();
    var ctxRes = cb.buildContext({
        incidents: [{ number: 'INC001', short_description: 'Network outage' }],
        articles: [{ number: 'KB001', title: 'VPN Fix', text: 'Restart client' }]
    });
    assert(ctxRes.contextText.indexOf('INC001') >= 0, '20. Regression: ITSM context builder includes citations');

    // D. Workflow Planner
    var planner = new WorkflowPlanner();
    var planRes = planner.plan('Investigate INC0000060', { incident_id: 'INC0000060' }, {}, '6816f79cc0a8016401c5a33be04be441');
    assert(planRes.ok === true && planRes.plan.steps.length > 0, '20. Regression: WorkflowPlanner generates valid plan');
})();

console.log('\n========================================');
console.log(`PRODUCTION READINESS TEST SUMMARY: ${passCount} / ${totalCount} tests passed.`);
console.log('========================================\n');
