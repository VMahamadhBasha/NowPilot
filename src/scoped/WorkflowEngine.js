// Copyright 2026 GMG Technology LLC
// SPDX-License-Identifier: Apache-2.0
var WorkflowEngine = Class.create();

/**
 * Deterministic orchestrator and multi-step tool execution engine.
 * Controls the step-by-step execution of authorized tools, enforces parameter limits,
 * execution deadlines, budget margins, loop prevention, evidence caching,
 * and strict human approval gating for proposed changes.
 */

WorkflowEngine.MAX_STEPS = 8;
WorkflowEngine.MIN_TIME_MARGIN_MS = 3000;
WorkflowEngine.MAX_PARAM_CHARS = 32000;

WorkflowEngine.ALLOWED_TOOLS = [
    'get_record',
    'query_records',
    'get_current_record',
    'search_similar_incidents',
    'search_knowledge_articles',
    'recommend_resolution',
    'summarize_incident',
    'prepare_knowledge_draft',
    'validate_dev_code',
    'review_dev_artifact',
    'propose_resolution',
    'propose_current_record_update',
    'propose_journal_entry'
];

WorkflowEngine.WRITE_TOOLS = [
    'propose_resolution',
    'propose_current_record_update',
    'propose_journal_entry'
];

WorkflowEngine.ALLOWED_TARGET_TABLES = [
    'incident',
    'change_request',
    'problem',
    'kb_knowledge',
    'sys_script',
    'sys_script_include',
    'sys_ui_action',
    'sys_ui_policy'
];

WorkflowEngine.isTableAllowed = function(table) {
    if (!table || typeof table !== 'string') return false;
    return WorkflowEngine.ALLOWED_TARGET_TABLES.indexOf(String(table).trim().toLowerCase()) >= 0;
};

WorkflowEngine.VALID_TRANSITIONS = {
    'planned': ['running', 'rejected'],
    'running': ['waiting_approval', 'completed', 'failed'],
    'waiting_approval': ['running', 'completed', 'rejected', 'failed'],
    'failed': ['planned'],
    'completed': [],
    'rejected': []
};

WorkflowEngine.isValidTransition = function(fromStatus, toStatus) {
    if (!fromStatus || fromStatus === toStatus) return true;
    var allowed = WorkflowEngine.VALID_TRANSITIONS[fromStatus];
    return allowed ? allowed.indexOf(toStatus) >= 0 : false;
};

/**
 * Redact sensitive data from evidence, results, and logs
 */
WorkflowEngine.redact = function(s) {
    if (typeof s !== 'string') return s;
    return s.replace(/\b(password|passwd|pwd|secret)\s*[:=]\s*(?:'[^']*'|"[^"]*"|[^\s,;]+)/gi, '$1: [REDACTED]')
            .replace(/\bBearer\s+[A-Za-z0-9_\-\.]{15,}\b/gi, 'Bearer [REDACTED]')
            .replace(/\b(?:ghp|glpat|xoxb|xoxp|sk)-[A-Za-z0-9_\-]{15,}\b/gi, '[REDACTED_TOKEN]')
            .replace(/\b(?:Basic\s+[A-Za-z0-9+/=]{16,})\b/gi, 'Basic [REDACTED]');
};

WorkflowEngine.prototype = {
    initialize: function(core) {
        this.core = core || null;
        this.tools = new AgentTools();
        this.planner = new WorkflowPlanner();
        this.budget = new Budget();
        this.dev = (typeof DevAssistant != 'undefined') ? new DevAssistant() : null;
        this.validator = (typeof DevValidator != 'undefined') ? new DevValidator() : null;
    },

    /**
     * Check if user is authorized to execute workflows
     */
    canExecute: function(userId) {
        if (typeof gs == 'undefined') return true;
        return gs.hasRole('x_gmg_ai.user') || gs.hasRole('admin');
    },

    /**
     * Check if user has access to a specific workflow
     */
    canAccessWorkflow: function(workflow, userId) {
        if (!workflow) return false;
        if (typeof gs == 'undefined') return true;
        userId = userId || gs.getUserID();
        if (gs.hasRole('admin')) return true;
        return workflow.user_id === userId;
    },

    /**
     * Validate tool parameters and size constraints
     */
    validateParams: function(toolName, params) {
        if (WorkflowEngine.ALLOWED_TOOLS.indexOf(toolName) < 0) {
            return { ok: false, error: 'Tool "' + toolName + '" is not in the allowlist.' };
        }
        if (!params || typeof params !== 'object') {
            return { ok: true, params: {} };
        }

        var keys = Object.keys(params);
        var sanitized = {};
        for (var i = 0; i < keys.length; i++) {
            var k = keys[i];
            var v = params[k];
            if (typeof v === 'string') {
                if (v.length > WorkflowEngine.MAX_PARAM_CHARS) {
                    return { ok: false, error: 'Parameter "' + k + '" exceeds maximum allowed size of ' + WorkflowEngine.MAX_PARAM_CHARS + ' characters.' };
                }
                // Check for dangerous dynamic script injection attempts
                if (/\b(?:eval|Function)\s*\(/.test(v) && toolName !== 'validate_dev_code') {
                    return { ok: false, error: 'Dangerous code evaluation directives rejected in parameter "' + k + '".' };
                }
                sanitized[k] = WorkflowEngine.redact(v);
            } else {
                sanitized[k] = v;
            }
        }
        return { ok: true, params: sanitized };
    },

    /**
     * Execute a single step within a workflow
     */
    executeStep: function(step, workflow, context, deadlineMs) {
        if (!step) return { ok: false, error: 'No step provided' };

        // 1. Tool allowlist check
        if (WorkflowEngine.ALLOWED_TOOLS.indexOf(step.tool) < 0) {
            return { ok: false, error: 'Tool "' + step.tool + '" is not authorized in workflow allowlist.' };
        }

        // 2. Deadline and budget check
        var now = new Date().getTime();
        if (deadlineMs && (deadlineMs - now < WorkflowEngine.MIN_TIME_MARGIN_MS)) {
            return { ok: false, error: 'Execution deadline approaching: less than 3000ms remaining in budget margin.', timeout: true };
        }

        // 3. Parameter validation
        var paramVal = this.validateParams(step.tool, step.params);
        if (!paramVal.ok) {
            return { ok: false, error: paramVal.error };
        }
        var p = paramVal.params;

        // 4. Evidence Caching & Loop Prevention Check
        var cacheKey = step.tool + ':' + JSON.stringify(p);
        if (workflow.evidence && workflow.evidence._cache && workflow.evidence._cache[cacheKey]) {
            return { ok: true, result: workflow.evidence._cache[cacheKey], cached: true };
        }

        // 5. Tool Execution Routing
        var result = null;
        try {
            if (step.tool === 'get_record') {
                if (!p.table || typeof p.table !== 'string') {
                    return { ok: false, error: 'Target table is required for tool "get_record" and cannot be omitted.', rejected: true };
                }
                if (!WorkflowEngine.isTableAllowed(p.table)) {
                    return { ok: false, error: 'Target table "' + p.table + '" is not authorized for workflow execution. Allowed tables: ' + WorkflowEngine.ALLOWED_TARGET_TABLES.join(', '), rejected: true };
                }
                result = this.tools.getRecord(p);
            } else if (step.tool === 'query_records') {
                if (!p.table || typeof p.table !== 'string') {
                    return { ok: false, error: 'Target table is required for tool "query_records" and cannot be omitted.', rejected: true };
                }
                if (!WorkflowEngine.isTableAllowed(p.table)) {
                    return { ok: false, error: 'Target table "' + p.table + '" is not authorized for workflow execution. Allowed tables: ' + WorkflowEngine.ALLOWED_TARGET_TABLES.join(', '), rejected: true };
                }
                result = this.tools.queryRecords(p);
            } else if (step.tool === 'get_current_record') {
                var rt = new RecordTools(context);
                result = rt.read(p);
            } else if (step.tool === 'search_similar_incidents') {
                result = this.tools.searchSimilarIncidents(p);
            } else if (step.tool === 'search_knowledge_articles') {
                result = this.tools.searchKnowledgeArticles(p);
            } else if (step.tool === 'recommend_resolution') {
                result = this.tools.recommendResolution(p);
            } else if (step.tool === 'summarize_incident') {
                result = this.tools.summarizeIncident(p);
            } else if (step.tool === 'prepare_knowledge_draft') {
                result = this.tools.prepareKnowledgeDraft(p);
            } else if (step.tool === 'validate_dev_code') {
                if (!this.validator) this.validator = new DevValidator();
                result = this.validator.validate(p.code || '', p.artifact_type || 'business_rule');
            } else if (step.tool === 'review_dev_artifact') {
                result = this._executeDevReview(p, context);
            } else if (WorkflowEngine.WRITE_TOOLS.indexOf(step.tool) >= 0) {
                // Write tool execution creates a sealed pending action proposal and halts for approval
                // Ambiguous write protection: if a write action fails or throws an ambiguous error/timeout,
                // automatic retry is strictly forbidden to prevent duplicate writes!
                try {
                    return this._handleApprovalGatedStep(step, workflow, context, p);
                } catch (exWrite) {
                    return {
                        ok: false,
                        ambiguous_write: true,
                        error: 'Ambiguous write error during step execution: ' + String(exWrite) + '. Automatic retry is prohibited to protect record integrity.',
                        retryable: false
                    };
                }
            } else {
                return { ok: false, error: 'Unhandled tool "' + step.tool + '".' };
            }
        } catch (ex) {
            return { ok: false, error: 'Step execution threw: ' + String(ex) };
        }

        if (result && result.error) {
            return { ok: false, error: result.error, result: result };
        }

        // Redact any sensitive output in result
        var cleanResult = this._sanitizeResult(result);

        // Cache the evidence
        if (!workflow.evidence._cache) workflow.evidence._cache = {};
        workflow.evidence._cache[cacheKey] = cleanResult;

        return { ok: true, result: cleanResult };
    },

    /**
     * Handle write steps that require human approval
     */
    _handleApprovalGatedStep: function(step, workflow, context, params) {
        var userId = workflow.user_id || (typeof gs != 'undefined' ? gs.getUserID() : '');

        // Verify writes are not globally disabled
        var wo = typeof ActionService != 'undefined' ? ActionService.writesOff() : '';
        if (wo) {
            return { ok: false, error: wo, refused: true };
        }

        // Determine target table and target sys_id
        var targetTable = params.table || (context && context.table) || (context && context.bound && context.bound.table);
        var targetSysId = params.sys_id || (context && context.sys_id) || (context && context.bound && context.bound.sys_id) || '';

        // If target is an incident number, resolve sys_id and default table to incident if appropriate
        if (params.incident_id) {
            if (!targetTable) targetTable = 'incident';
            if (!targetSysId) {
                var incGr = this.tools._find('incident', params.incident_id, params.incident_id);
                if (incGr) {
                    targetTable = 'incident';
                    targetSysId = incGr.getUniqueValue();
                }
            }
        }

        if (!targetTable && workflow && workflow.type === 'development_review') {
            targetTable = 'sys_script';
        }

        // Validate table existence and authorization - NEVER silently default to incident!
        if (!targetTable) {
            return {
                ok: false,
                error: 'Target table is required for workflow execution and cannot be omitted. Workflows will never silently default to incident.',
                rejected: true
            };
        }

        if (!WorkflowEngine.isTableAllowed(targetTable)) {
            return {
                ok: false,
                error: 'Target table "' + targetTable + '" is not authorized for workflow automation. Allowed tables: ' + WorkflowEngine.ALLOWED_TARGET_TABLES.join(', '),
                rejected: true
            };
        }

        // Enforce ACLs and record ownership before generating proposal
        if (targetSysId && typeof GlideRecordSecure !== 'undefined') {
            var checkGr = new GlideRecordSecure(targetTable);
            if (!checkGr.get(targetSysId)) {
                return {
                    ok: false,
                    error: 'Target record (' + targetSysId + ') not found in table "' + targetTable + '" or caller lacks ACL permissions to access it.',
                    rejected: true
                };
            }
            if (typeof checkGr.canWrite === 'function' && !checkGr.canWrite()) {
                return {
                    ok: false,
                    error: 'User lacks write ACL permissions on ' + targetTable + ':' + targetSysId + '.',
                    rejected: true
                };
            }
        }

        var summary = params.summary || ('Workflow proposed ' + step.tool + ' on ' + targetTable);
        var payloadObj = {
            kind: 'record',
            rec: 'fields',
            table: targetTable,
            op: 'update',
            scope: 'global',
            spec: {
                table: targetTable,
                sys_id: targetSysId,
                fields: params.fields || {}
            },
            workflow_id: workflow.workflow_id,
            step_id: step.id
        };

        if (step.tool === 'propose_resolution') {
            var defaultClose = (typeof gs !== 'undefined' && gs.getProperty) ? gs.getProperty('x_gmg_ai.default_close_code', 'Solved (Permanently)') : 'Solved (Permanently)';
            var closeCode = params.close_code || defaultClose;

            // Validate close code against instance choices if ITSMAssistant is available
            if (typeof ITSMAssistant !== 'undefined' && typeof ITSMAssistant.isValidCloseCode === 'function') {
                if (!ITSMAssistant.isValidCloseCode(targetTable, closeCode)) {
                    return {
                        ok: false,
                        error: 'Invalid close_code "' + closeCode + '" for table "' + targetTable + '".',
                        rejected: true
                    };
                }
            }

            // Validate target incident state
            if (targetSysId && typeof GlideRecordSecure !== 'undefined') {
                var incStateCheck = new GlideRecordSecure(targetTable);
                if (incStateCheck.get(targetSysId)) {
                    if (typeof ITSMAssistant !== 'undefined' && typeof ITSMAssistant.validateIncidentForResolution === 'function') {
                        var stateVal = ITSMAssistant.validateIncidentForResolution(incStateCheck);
                        if (!stateVal.ok) {
                            return { ok: false, error: stateVal.error, rejected: true };
                        }
                    }
                }
            }

            payloadObj.spec.fields.close_code = closeCode;
            payloadObj.spec.fields.close_notes = params.close_notes || '';
            summary = 'Resolution Proposal for ' + targetTable + ' (' + (params.incident_id || targetSysId) + ')';
        } else if (step.tool === 'propose_journal_entry') {
            payloadObj.spec.journal = {
                field: params.field || 'work_notes',
                text: params.text || ''
            };
            summary = (params.field === 'comments' ? 'Customer Comment' : 'Work Note') + ' Proposal';
        }

        // Insert pending action record
        var pa = new GlideRecord('x_gmg_ai_pending_action');
        pa.initialize();
        pa.setValue('user', userId);
        pa.setValue('status', 'pending');
        pa.setValue('operation', 'update');
        pa.setValue('target_table', targetTable);
        pa.setValue('target_sys_id', targetSysId);
        pa.setValue('payload', JSON.stringify(payloadObj));
        pa.setValue('review_route', 'none');
        pa.setValue('summary', summary);

        // Compute GMGSeal Route None
        if (typeof GMGSeal != 'undefined') {
            GMGSeal.sealRouteNone(pa);
        }

        var paId = '';
        if (typeof ReviewWriteGuard != 'undefined') {
            paId = ReviewWriteGuard.run(function() { return pa.insert(); });
        } else {
            paId = pa.insert();
        }

        if (!paId) {
            return { ok: false, error: 'Could not create pending action proposal record.' };
        }

        // Store server seal
        if (typeof GMGSeal != 'undefined') {
            GMGSeal.storeSeal(pa);
        }

        if (workflow.proposals.indexOf(paId) < 0) {
            workflow.proposals.push(paId);
        }

        if (typeof DiagnosticService != 'undefined') {
            DiagnosticService.logAuditEvent({
                eventType: DiagnosticService.EVENT_TYPES.PROPOSAL_CREATED,
                correlationId: workflow.correlation_id,
                workflowId: workflow.workflow_id,
                targetTable: targetTable,
                targetSysId: targetSysId,
                outcome: 'pending',
                details: summary
            });
        }

        return {
            ok: true,
            requires_approval: true,
            pending_action_id: paId,
            proposal: {
                id: paId,
                status: 'pending',
                target_table: targetTable,
                target_sys_id: targetSysId,
                summary: summary,
                requires_explicit_confirmation: true
            }
        };
    },

    /**
     * Execute 8-point development review
     */
    _executeDevReview: function(params, context) {
        var code = params.code || '';
        var artType = params.artifact_type || 'business_rule';
        if (!this.validator) this.validator = new DevValidator();

        var val = this.validator.validate(code, artType);
        var issues = val.findings || val.issues || [];

        // Build 8-point contract findings
        var findings = [];
        if (issues.length === 0) {
            findings.push({
                summary: 'No critical anti-patterns or syntax errors detected.',
                severity: 'Info',
                why_it_matters: 'Artifact complies with scoped ServiceNow coding standards and syntax rules.',
                relevant_code_section: code.substring(0, 100) + '...',
                recommended_fix: 'None required.',
                corrected_code: code,
                regression_test_cases: 'Test standard execution path in sub-production instance.',
                assumptions_and_caveats: 'Assumes standard GlideRecord table access and user roles.'
            });
        } else {
            for (var i = 0; i < issues.length; i++) {
                var issue = issues[i];
                findings.push({
                    summary: issue.message || 'Issue detected in ' + artType,
                    severity: issue.severity || 'Medium',
                    why_it_matters: issue.why || 'Violates ServiceNow platform reliability or scoping conventions.',
                    relevant_code_section: issue.snippet || '',
                    recommended_fix: issue.recommendation || 'Refactor to follow best practices.',
                    corrected_code: issue.suggested_fix || code,
                    regression_test_cases: 'Validate edge conditions and error handling in test environment.',
                    assumptions_and_caveats: 'Verify field names and table schema before deploying.'
                });
            }
        }

        return {
            ok: true,
            artifact_type: artType,
            findings: findings,
            fatal: val.fatal || false
        };
    },

    /**
     * Recursively sanitize and redact sensitive strings in result objects
     */
    _sanitizeResult: function(obj) {
        if (obj === null || obj === undefined) return obj;
        if (typeof obj === 'string') return WorkflowEngine.redact(obj);
        if (typeof obj === 'number' || typeof obj === 'boolean') return obj;
        if (obj instanceof Array) {
            var arr = [];
            for (var i = 0; i < obj.length; i++) arr.push(this._sanitizeResult(obj[i]));
            return arr;
        }
        if (typeof obj === 'object') {
            var out = {};
            var keys = Object.keys(obj);
            for (var k = 0; k < keys.length; k++) {
                if (keys[k] === '_cache') continue;
                out[keys[k]] = this._sanitizeResult(obj[keys[k]]);
            }
            return out;
        }
        return obj;
    },

    /**
     * Run or resume a workflow execution plan
     */
    run: function(plan, context, userId, budgetLimit) {
        var start = new Date().getTime();
        userId = userId || (typeof gs != 'undefined' ? gs.getUserID() : '');

        if (!this.canExecute(userId)) {
            return {
                ok: false,
                error: 'User not authorized to execute AI workflows (missing x_gmg_ai.user role).'
            };
        }

        // Validate plan schema
        var val = this.planner.validatePlan(plan);
        if (!val.ok) {
            return { ok: false, error: val.error, plan: plan };
        }

        if (!this.canAccessWorkflow(plan, userId)) {
            return {
                ok: false,
                error: 'Workflow belongs to another user. Access denied.',
                code: 403
            };
        }

        // Check state transitions
        if (!WorkflowEngine.isValidTransition(plan.status, 'running')) {
            return {
                ok: false,
                error: 'Invalid workflow state transition: cannot run workflow currently in "' + plan.status + '" state.',
                code: 400,
                workflow: plan
            };
        }

        // Check budget if budgetLimit is passed or check provider budget
        var provGr = null;
        if (this.core && typeof this.core.getProvider === 'function') {
            provGr = this.core.selectedProvider() || this.core.getProvider();
        }
        if (provGr && this.budget) {
            var bStatus = this.budget.status(provGr, 100, userId);
            if (bStatus && bStatus.blocked) {
                plan.status = 'failed';
                plan.error = 'Budget blocked: ' + (bStatus.reason || 'Token budget exhausted.');
                plan.updated_at = new GlideDateTime().getValue();
                return { ok: false, error: plan.error, workflow: plan };
            }
        }

        plan.status = 'running';
        plan.updated_at = new GlideDateTime().getValue();

        var deadlineMs = start + (budgetLimit ? budgetLimit : 30000); // 30s default workflow timeout

        for (var i = 0; i < plan.steps.length; i++) {
            var step = plan.steps[i];

            // Skip already completed steps
            if (step.status === 'completed' || step.status === 'skipped') {
                continue;
            }

            // If step was waiting approval, check its proposal status
            if (step.status === 'waiting_approval') {
                var pId = (step.result && step.result.pending_action_id) || (plan.proposals && plan.proposals[0]);
                if (pId) {
                    var paGr = new GlideRecord('x_gmg_ai_pending_action');
                    if (paGr.get(pId)) {
                        var pStatus = paGr.getValue('status');
                        if (pStatus === 'applied') {
                            step.status = 'completed';
                            continue;
                        } else if (pStatus === 'rejected') {
                            step.status = 'rejected';
                            plan.status = 'rejected';
                            plan.updated_at = new GlideDateTime().getValue();
                            return { ok: false, error: 'Step rejected by user.', workflow: plan };
                        } else {
                            // Still pending approval: keep waiting
                            plan.status = 'waiting_approval';
                            plan.updated_at = new GlideDateTime().getValue();
                            return { ok: true, waiting_approval: true, workflow: plan };
                        }
                    }
                }
            }

            step.status = 'running';

            var stepRes = this.executeStep(step, plan, context, deadlineMs);

            if (!stepRes.ok) {
                step.status = 'failed';
                step.error = stepRes.error;
                plan.status = 'failed';
                plan.error = 'Workflow failed at step "' + step.name + '": ' + stepRes.error;
                plan.updated_at = new GlideDateTime().getValue();
                if (typeof DiagnosticService != 'undefined') {
                    DiagnosticService.logAuditEvent({
                        eventType: DiagnosticService.EVENT_TYPES.WORKFLOW_FAILED,
                        correlationId: plan.correlation_id,
                        workflowId: plan.workflow_id,
                        tool: step.tool,
                        outcome: 'failure',
                        errorCode: stepRes.timeout ? 'TIMEOUT' : 'TOOL_ERROR',
                        details: stepRes.error
                    });
                }
                return { ok: false, error: plan.error, workflow: plan };
            }

            if (stepRes.requires_approval) {
                step.status = 'waiting_approval';
                step.result = stepRes;
                plan.status = 'waiting_approval';
                plan.updated_at = new GlideDateTime().getValue();
                return {
                    ok: true,
                    waiting_approval: true,
                    pending_action_id: stepRes.pending_action_id,
                    proposal: stepRes.proposal,
                    workflow: plan
                };
            }

            step.status = 'completed';
            step.result = stepRes.result;
            if (typeof DiagnosticService != 'undefined') {
                DiagnosticService.logAuditEvent({
                    eventType: DiagnosticService.EVENT_TYPES.TOOL_COMPLETED,
                    correlationId: plan.correlation_id,
                    workflowId: plan.workflow_id,
                    tool: step.tool,
                    outcome: 'success',
                    details: 'Step "' + step.name + '" completed'
                });
            }
            this._collectEvidence(plan, step);
        }

        plan.status = 'completed';
        plan.updated_at = new GlideDateTime().getValue();
        if (typeof DiagnosticService != 'undefined') {
            DiagnosticService.logAuditEvent({
                eventType: DiagnosticService.EVENT_TYPES.WORKFLOW_COMPLETED,
                correlationId: plan.correlation_id,
                workflowId: plan.workflow_id,
                outcome: 'success',
                details: 'All steps completed successfully'
            });
        }
        return { ok: true, workflow: plan };
    },

    /**
     * Synthesize evidence from completed steps into workflow.evidence
     */
    _collectEvidence: function(workflow, step) {
        if (!workflow.evidence) workflow.evidence = {};
        if (step.tool === 'search_similar_incidents' && step.result && step.result.incidents) {
            workflow.evidence.incidents = step.result.incidents;
        } else if (step.tool === 'search_knowledge_articles' && step.result && step.result.articles) {
            workflow.evidence.articles = step.result.articles;
        } else if (step.tool === 'summarize_incident' && step.result && step.result.summary) {
            workflow.evidence.summary = step.result.summary;
        } else if (step.tool === 'recommend_resolution' && step.result) {
            workflow.evidence.recommendation = step.result.recommendation || step.result;
        } else if (step.tool === 'prepare_knowledge_draft' && step.result) {
            workflow.evidence.draft_article = step.result.draft || step.result;
        } else if (step.tool === 'review_dev_artifact' && step.result) {
            workflow.evidence.dev_review = step.result.findings || step.result;
        }
    },

    /**
     * Resume an interrupted or waiting workflow
     */
    resume: function(workflow, context, userId) {
        return this.run(workflow, context, userId);
    },

    /**
     * Retry a specific failed step in a workflow
     */
    retry: function(workflow, stepId, context, userId) {
        userId = userId || (typeof gs != 'undefined' ? gs.getUserID() : '');
        if (!this.canAccessWorkflow(workflow, userId)) {
            return { ok: false, error: 'Unauthorized to retry this workflow.', code: 403 };
        }

        var found = false;
        for (var i = 0; i < workflow.steps.length; i++) {
            var st = workflow.steps[i];
            if (st.id === stepId) {
                // Only safe read steps can be retried automatically
                if (st.requires_approval || WorkflowEngine.WRITE_TOOLS.indexOf(st.tool) >= 0) {
                    return { ok: false, error: 'Write steps cannot be retried directly. Re-propose or confirm the pending action instead.' };
                }
                st.status = 'pending';
                st.error = null;
                found = true;
                break;
            }
        }

        if (!found) {
            return { ok: false, error: 'Step "' + stepId + '" not found in workflow.' };
        }

        workflow.status = 'planned';
        workflow.error = null;
        return this.run(workflow, context, userId);
    }
};
