// Copyright 2026 GMG Technology LLC
// SPDX-License-Identifier: Apache-2.0
var WorkflowPlanner = Class.create();

/**
 * Deterministic workflow planning layer for ServiceNow AI Agent.
 * Translates user requests into structured, schema-validated execution plans.
 * Enforces permission requirements, read-only vs write distinctions,
 * bounded step counts, and rejects ambiguous or destructive requests.
 */

WorkflowPlanner.MAX_STEPS = 8;

WorkflowPlanner.WORKFLOW_TYPES = [
    'incident_investigation',
    'knowledge_preparation',
    'development_review'
];

WorkflowPlanner.ALLOWED_TOOLS = [
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

WorkflowPlanner.WRITE_TOOLS = [
    'propose_resolution',
    'propose_current_record_update',
    'propose_journal_entry'
];

WorkflowPlanner.ALLOWED_TARGET_TABLES = [
    'incident',
    'change_request',
    'problem',
    'kb_knowledge',
    'sys_script',
    'sys_script_include',
    'sys_ui_action',
    'sys_ui_policy'
];

WorkflowPlanner.isTableAllowed = function(table) {
    if (!table || typeof table !== 'string') return false;
    return WorkflowPlanner.ALLOWED_TARGET_TABLES.indexOf(String(table).trim().toLowerCase()) >= 0;
};

WorkflowPlanner.STATUSES = [
    'planned',
    'running',
    'waiting_approval',
    'completed',
    'failed',
    'rejected'
];

WorkflowPlanner.DESTRUCTIVE_PATTERNS = [
    /\bdelete\s+all\b/i,
    /\bdrop\s+table\b/i,
    /\btruncate\b/i,
    /\bwipe\s+(out|all)\b/i,
    /\bdestroy\b/i,
    /\brm\s+-rf\b/i,
    /\beval\s*\(/i,
    /\bexecute\s+arbitrary\b/i,
    /\bformat\s+disk\b/i
];

WorkflowPlanner.prototype = {
    initialize: function() {},

    /**
     * Generate a unique workflow ID
     */
    generateId: function() {
        var d = new GlideDateTime().getNumericValue();
        var rand = Math.floor(Math.random() * 1000000);
        return 'wf_' + d + '_' + rand;
    },

    /**
     * Check if a text contains ambiguous or destructive directives
     */
    isDestructiveOrAmbiguous: function(text) {
        if (!text || typeof text !== 'string') return false;
        for (var i = 0; i < WorkflowPlanner.DESTRUCTIVE_PATTERNS.length; i++) {
            if (WorkflowPlanner.DESTRUCTIVE_PATTERNS[i].test(text)) {
                return true;
            }
        }
        return false;
    },

    /**
     * Classify user goal into a known workflow type
     */
    classifyGoal: function(goal, context) {
        goal = String(goal || '').trim();
        if (!goal) {
            return {
                ok: false,
                error: 'Goal description cannot be empty. Please specify a workflow request.',
                requires_clarification: true
            };
        }

        if (this.isDestructiveOrAmbiguous(goal)) {
            return {
                ok: false,
                error: 'Ambiguous or destructive request rejected. Automated execution of bulk deletion, dropping tables, or arbitrary script execution is prohibited.',
                requires_clarification: true,
                rejected: true
            };
        }

        var lower = goal.toLowerCase();

        // 1. Knowledge Article Preparation
        if (/\b(knowledge|kb|article|sop)\b.*\b(draft|prepare|create)\b/i.test(lower) ||
            /\b(draft|prepare|create)\b.*\b(knowledge|kb|article|sop)\b/i.test(lower)) {
            return { ok: true, type: 'knowledge_preparation' };
        }

        // 2. ServiceNow Development Review
        if (/\b(review|debug|analyze|inspect)\b.*\b(script|code|artifact|rule|include)\b/i.test(lower) ||
            /\b(dev\s+review|syntax\s+check)\b/i.test(lower)) {
            return { ok: true, type: 'development_review' };
        }

        // 3. Incident Investigation
        if (/\b(investigate|incident|troubleshoot|recommend\s+resolution|similar\s+incident|inc\d{5,})\b/i.test(lower)) {
            return { ok: true, type: 'incident_investigation' };
        }

        // Default or context-based fallback
        if (context && context.table === 'incident') {
            return { ok: true, type: 'incident_investigation' };
        }
        if (context && context.bound && /^sys_script/.test(context.bound.table || '')) {
            return { ok: true, type: 'development_review' };
        }

        return {
            ok: false,
            error: 'Could not determine workflow type from request. Please specify whether you want to investigate an incident, prepare a knowledge article, or review a development artifact.',
            requires_clarification: true
        };
    },

    /**
     * Build an Incident Investigation workflow plan
     */
    createIncidentInvestigationPlan: function(goal, params, userId) {
        params = params || {};
        var incId = params.incident_id || params.incident_number || params.number || params.sys_id || '';
        var query = params.query || (incId ? 'incident ' + incId : goal);
        var defaultClose = (typeof gs !== 'undefined' && gs.getProperty) ? gs.getProperty('x_gmg_ai.default_close_code', 'Solved (Permanently)') : 'Solved (Permanently)';
        var closeCode = params.close_code || defaultClose;

        var steps = [
            {
                id: 'step_1',
                name: 'Retrieve Incident Details',
                tool: 'get_record',
                params: { table: 'incident', number: incId, sys_id: params.sys_id || '' },
                read_only: true,
                requires_approval: false,
                status: 'pending'
            },
            {
                id: 'step_2',
                name: 'Search Similar Historical Incidents',
                tool: 'search_similar_incidents',
                params: { incident_id: incId, query: query, limit: params.limit || 5 },
                read_only: true,
                requires_approval: false,
                status: 'pending'
            },
            {
                id: 'step_3',
                name: 'Search Relevant Knowledge Articles',
                tool: 'search_knowledge_articles',
                params: { query: query, limit: params.limit || 5 },
                read_only: true,
                requires_approval: false,
                status: 'pending'
            },
            {
                id: 'step_4',
                name: 'Summarize Incident Evidence & History',
                tool: 'summarize_incident',
                params: { incident_id: incId },
                read_only: true,
                requires_approval: false,
                status: 'pending'
            },
            {
                id: 'step_5',
                name: 'Synthesize Grounded Resolution Recommendation',
                tool: 'recommend_resolution',
                params: { incident_id: incId, query: query },
                read_only: true,
                requires_approval: false,
                status: 'pending'
            },
            {
                id: 'step_6',
                name: 'Prepare Resolution Proposal Card',
                tool: 'propose_resolution',
                params: {
                    incident_id: incId,
                    table: 'incident',
                    close_code: closeCode,
                    close_notes: params.close_notes || 'Resolved via Now Pilot Incident Investigation workflow.'
                },
                read_only: false,
                requires_approval: true,
                status: 'pending'
            }
        ];

        return {
            workflow_id: this.generateId(),
            type: 'incident_investigation',
            goal: goal,
            user_id: userId || (typeof gs != 'undefined' ? gs.getUserID() : ''),
            status: 'planned',
            steps: steps,
            evidence: { incidents: [], articles: [], summary: '', recommendation: '' },
            proposals: [],
            created_at: new GlideDateTime().getValue(),
            updated_at: new GlideDateTime().getValue()
        };
    },

    /**
     * Build a Knowledge Article Preparation workflow plan
     */
    createKnowledgePreparationPlan: function(goal, params, userId) {
        params = params || {};
        var incId = params.incident_id || params.incident_number || params.number || params.sys_id || '';
        var query = params.query || (incId ? 'incident ' + incId : goal);

        var steps = [
            {
                id: 'step_1',
                name: 'Retrieve Incident and Resolution Evidence',
                tool: 'get_record',
                params: { table: 'incident', number: incId, sys_id: params.sys_id || '' },
                read_only: true,
                requires_approval: false,
                status: 'pending'
            },
            {
                id: 'step_2',
                name: 'Search Existing Knowledge Articles to Avoid Duplication',
                tool: 'search_knowledge_articles',
                params: { query: query, limit: 5 },
                read_only: true,
                requires_approval: false,
                status: 'pending'
            },
            {
                id: 'step_3',
                name: 'Synthesize Structured Knowledge Draft',
                tool: 'prepare_knowledge_draft',
                params: { incident_id: incId, resolution_notes: params.resolution_notes || '' },
                read_only: true,
                requires_approval: false,
                status: 'pending'
            },
            {
                id: 'step_4',
                name: 'Propose Knowledge Draft Review Card',
                tool: 'propose_journal_entry',
                params: {
                    field: 'work_notes',
                    text: 'Draft Knowledge Article generated for review. Manual verification required before publishing.'
                },
                read_only: false,
                requires_approval: true,
                status: 'pending'
            }
        ];

        return {
            workflow_id: this.generateId(),
            type: 'knowledge_preparation',
            goal: goal,
            user_id: userId || (typeof gs != 'undefined' ? gs.getUserID() : ''),
            status: 'planned',
            steps: steps,
            evidence: { draft_article: null, existing_kbs: [] },
            proposals: [],
            created_at: new GlideDateTime().getValue(),
            updated_at: new GlideDateTime().getValue()
        };
    },

    /**
     * Build a Development Review workflow plan
     */
    createDevelopmentReviewPlan: function(goal, params, userId) {
        params = params || {};
        var artifactType = params.artifact_type || 'business_rule';
        var code = params.code || '';

        var steps = [
            {
                id: 'step_1',
                name: 'Static Syntax and Security Validation',
                tool: 'validate_dev_code',
                params: { code: code, artifact_type: artifactType },
                read_only: true,
                requires_approval: false,
                status: 'pending'
            },
            {
                id: 'step_2',
                name: 'ServiceNow Architectural Review (8-Point Contract)',
                tool: 'review_dev_artifact',
                params: { code: code, artifact_type: artifactType, table: params.table || '' },
                read_only: true,
                requires_approval: false,
                status: 'pending'
            },
            {
                id: 'step_3',
                name: 'Propose Reviewed Code Correction',
                tool: 'propose_current_record_update',
                params: {
                    table: params.table || (artifactType === 'script_include' ? 'sys_script_include' : 'sys_script'),
                    summary: 'ServiceNow Development Assistant code correction for ' + artifactType,
                    fields: { script: params.corrected_code || code }
                },
                read_only: false,
                requires_approval: true,
                status: 'pending'
            }
        ];

        return {
            workflow_id: this.generateId(),
            type: 'development_review',
            goal: goal,
            user_id: userId || (typeof gs != 'undefined' ? gs.getUserID() : ''),
            status: 'planned',
            steps: steps,
            evidence: { validation_findings: [], review_verdict: null },
            proposals: [],
            created_at: new GlideDateTime().getValue(),
            updated_at: new GlideDateTime().getValue()
        };
    },

    /**
     * Create a concrete plan based on goal text or structured request
     */
    plan: function(goal, params, context, userId) {
        if (params && params.table && !WorkflowPlanner.isTableAllowed(params.table)) {
            return {
                ok: false,
                error: 'Target table "' + params.table + '" is not authorized for workflow automation. Supported tables: ' + WorkflowPlanner.ALLOWED_TARGET_TABLES.join(', '),
                rejected: true
            };
        }

        var classification = this.classifyGoal(goal, context);
        if (!classification.ok) {
            return classification;
        }

        var p = null;
        if (classification.type === 'incident_investigation') {
            p = this.createIncidentInvestigationPlan(goal, params, userId);
        } else if (classification.type === 'knowledge_preparation') {
            p = this.createKnowledgePreparationPlan(goal, params, userId);
        } else if (classification.type === 'development_review') {
            p = this.createDevelopmentReviewPlan(goal, params, userId);
        }

        var validation = this.validatePlan(p);
        if (!validation.ok) {
            return validation;
        }

        return { ok: true, plan: p };
    },

    /**
     * Validate plan schema, bounds, tool allowlist, and permission consistency
     */
    validatePlan: function(plan) {
        if (!plan || typeof plan !== 'object') {
            return { ok: false, error: 'Invalid plan: expected object.' };
        }

        if (!plan.workflow_id || typeof plan.workflow_id !== 'string') {
            return { ok: false, error: 'Invalid plan: missing or invalid workflow_id.' };
        }

        if (!plan.type || WorkflowPlanner.WORKFLOW_TYPES.indexOf(plan.type) < 0) {
            return { ok: false, error: 'Invalid plan: unsupported workflow type "' + plan.type + '".' };
        }

        if (!plan.status || WorkflowPlanner.STATUSES.indexOf(plan.status) < 0) {
            return { ok: false, error: 'Invalid plan: invalid status "' + plan.status + '".' };
        }

        if (!plan.steps || !(plan.steps instanceof Array) || plan.steps.length === 0) {
            return { ok: false, error: 'Invalid plan: steps array must not be empty.' };
        }

        if (plan.steps.length > WorkflowPlanner.MAX_STEPS) {
            return { ok: false, error: 'Invalid plan: step count ' + plan.steps.length + ' exceeds maximum of ' + WorkflowPlanner.MAX_STEPS + ' steps.' };
        }

        // Validate each step
        var seenStepIds = {};
        for (var i = 0; i < plan.steps.length; i++) {
            var step = plan.steps[i];
            if (!step || typeof step !== 'object') {
                return { ok: false, error: 'Invalid step at index ' + i + ': expected object.' };
            }

            if (!step.id || typeof step.id !== 'string') {
                return { ok: false, error: 'Invalid step at index ' + i + ': missing or invalid step id.' };
            }
            if (seenStepIds[step.id]) {
                return { ok: false, error: 'Invalid step at index ' + i + ': duplicate step id "' + step.id + '".' };
            }
            seenStepIds[step.id] = true;

            if (!step.name || typeof step.name !== 'string') {
                return { ok: false, error: 'Invalid step "' + step.id + '": missing name.' };
            }

            if (!step.tool || WorkflowPlanner.ALLOWED_TOOLS.indexOf(step.tool) < 0) {
                return { ok: false, error: 'Invalid step "' + step.id + '": tool "' + step.tool + '" is not in the allowlist.' };
            }

            // Enforce Write / Approval Invariant
            var isWriteTool = WorkflowPlanner.WRITE_TOOLS.indexOf(step.tool) >= 0;
            if (isWriteTool) {
                if (step.read_only === true) {
                    return { ok: false, error: 'Step "' + step.id + '" uses write tool "' + step.tool + '" but declares read_only: true.' };
                }
                if (step.requires_approval !== true) {
                    return { ok: false, error: 'Step "' + step.id + '" uses write tool "' + step.tool + '" but does not require approval.' };
                }
            } else {
                if (step.read_only !== true) {
                    return { ok: false, error: 'Step "' + step.id + '" uses read-only tool "' + step.tool + '" but declares read_only: false.' };
                }
            }

            // Validate table if specified in params
            if (step.params && step.params.table) {
                if (!WorkflowPlanner.isTableAllowed(step.params.table)) {
                    return { ok: false, error: 'Step "' + step.id + '" targets unauthorized table "' + step.params.table + '". Allowed tables: ' + WorkflowPlanner.ALLOWED_TARGET_TABLES.join(', ') };
                }
            }

            // Validate parameter size bounds
            if (step.params && typeof step.params === 'object') {
                var pKeys = Object.keys(step.params);
                for (var k = 0; k < pKeys.length; k++) {
                    var val = step.params[pKeys[k]];
                    if (typeof val === 'string' && val.length > 32000) {
                        return { ok: false, error: 'Step "' + step.id + '" parameter "' + pKeys[k] + '" exceeds maximum allowed size (32000 characters).' };
                    }
                }
            }
        }

        return { ok: true };
    }
};
