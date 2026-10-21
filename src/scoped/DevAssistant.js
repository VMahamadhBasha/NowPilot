// Copyright 2026 GMG Technology LLC
// SPDX-License-Identifier: Apache-2.0
var DevAssistant = Class.create();

/**
 * Advanced ServiceNow Development Assistant engine.
 * Handles generation, explanation, review, and debugging of ServiceNow artifacts:
 * 1. Business Rules (sys_script)
 * 2. Script Includes (sys_script_include)
 * 3. Client Scripts (sys_script_client)
 * 4. UI Policies & Actions (sys_ui_policy / sys_ui_policy_action)
 * 5. UI Actions (sys_ui_action)
 * 6. Background Scripts (scripts - background / ad-hoc safe runner)
 * 7. Scripted REST API resources (sys_ws_operation)
 * 8. Flow Designer implementation guidance
 * 9. Service Portal widgets (sp_widget)
 * 10. Automated Test Framework (ATF) test plans & scripts (sys_atf_test)
 */
DevAssistant.ARTIFACT_TYPES = {
    'business_rule': {
        label: 'Business Rule',
        table: 'sys_script',
        category: 'server',
        description: 'Server-side database trigger executing on insert, update, delete, or query.'
    },
    'script_include': {
        label: 'Script Include',
        table: 'sys_script_include',
        category: 'server',
        description: 'Reusable server-side JavaScript class or library, optionally client-callable.'
    },
    'client_script': {
        label: 'Client Script',
        table: 'sys_script_client',
        category: 'client',
        description: 'Browser-side script executing on form load, field change, or submit.'
    },
    'ui_policy': {
        label: 'UI Policy & Actions',
        table: 'sys_ui_policy',
        category: 'client',
        description: 'Client-side condition engine setting field mandatory, visible, or read-only states.'
    },
    'ui_action': {
        label: 'UI Action',
        table: 'sys_ui_action',
        category: 'hybrid',
        description: 'Form button, link, context menu item, or list button with client/server execution.'
    },
    'background_script': {
        label: 'Background Script',
        table: '',
        category: 'server_adhoc',
        description: 'One-off administrative script with dry-run and rollback protections. Never auto-executed.'
    },
    'scripted_rest': {
        label: 'Scripted REST API Resource',
        table: 'sys_ws_operation',
        category: 'server',
        description: 'Custom REST endpoint handling inbound HTTP requests and producing JSON responses.'
    },
    'flow_designer': {
        label: 'Flow Designer Guidance',
        table: 'sys_hub_flow',
        category: 'no_code_guidance',
        description: 'Step-by-step guidance for triggers, flow logic, actions, subflows, and error handlers.'
    },
    'service_portal_widget': {
        label: 'Service Portal Widget',
        table: 'sp_widget',
        category: 'sp',
        description: 'Service Portal widget composed of HTML template, Client Controller, Server Script, and CSS.'
    },
    'atf_test': {
        label: 'ATF Test Plan & Script',
        table: 'sys_atf_test',
        category: 'testing',
        description: 'Automated Test Framework test steps for form validation, server assertions, and regressions.'
    }
};

/**
 * Canonical starter templates ensuring adherence to ServiceNow runtime conventions
 */
DevAssistant.TEMPLATES = {
    'business_rule': function(name, table, when, actions) {
        when = when || 'before';
        table = table || 'incident';
        return '(function executeRule(current, previous /*null when async*/) {\n' +
               '    // Business Rule: ' + (name || 'Handle ' + table) + '\n' +
               '    // Timing: ' + when + ' (insert/update)\n' +
               '    // NOTE: In before rules, do NOT call current.update(). Changes to current are saved automatically.\n' +
               '    try {\n' +
               '        if (!current.isValidRecord()) return;\n\n' +
               '        // Business logic here\n\n' +
               '    } catch (ex) {\n' +
               '        gs.error("Error in Business Rule ' + name + ': " + ex.message);\n' +
               '    }\n' +
               '})(current, previous);';
    },

    'script_include': function(name, clientCallable, scope) {
        name = name || 'MyScriptInclude';
        if (clientCallable) {
            return 'var ' + name + ' = Class.create();\n' +
                   name + '.prototype = Object.extendsObject(global.AbstractAjaxProcessor, {\n' +
                   '    // Client-callable method: call via ga.addParam("sysparm_name", "myMethod");\n' +
                   '    myMethod: function() {\n' +
                   '        var paramValue = this.getParameter("sysparm_value");\n' +
                   '        var result = this.newItem("result");\n' +
                   '        result.setAttribute("status", "success");\n' +
                   '        return JSON.stringify({ ok: true, data: paramValue });\n' +
                   '    },\n\n' +
                   '    type: "' + name + '"\n' +
                   '});';
        }
        return 'var ' + name + ' = Class.create();\n' +
               name + '.prototype = {\n' +
               '    initialize: function() {\n' +
               '    },\n\n' +
               '    execute: function(input) {\n' +
               '        return { ok: true, input: input };\n' +
               '    },\n\n' +
               '    type: "' + name + '"\n' +
               '};';
    },

    'client_script': function(name, type, table) {
        type = type || 'onLoad';
        if (type === 'onChange') {
            return 'function onChange(control, oldValue, newValue, isLoading, isTemplate) {\n' +
                   '    if (isLoading || newValue === "") {\n' +
                   '        return;\n' +
                   '    }\n' +
                   '    // onChange client logic\n' +
                   '}';
        }
        if (type === 'onSubmit') {
            return 'function onSubmit() {\n' +
                   '    // Return false to prevent form submission\n' +
                   '    return true;\n' +
                   '}';
        }
        return 'function onLoad() {\n' +
               '    // onLoad client logic using g_form\n' +
               '}';
    },

    'ui_action': function(name, table, isClient) {
        if (isClient) {
            return '// Client-side onClick function\n' +
                   'function runClientCode() {\n' +
                   '    if (g_form.getValue("short_description") == "") {\n' +
                   '        g_form.addErrorMessage("Short description is required.");\n' +
                   '        return false;\n' +
                   '    }\n' +
                   '    gsftSubmit(null, g_form.getFormElement(), "' + (name || 'custom_action') + '");\n' +
                   '}\n\n' +
                   '// Server-side code execution\n' +
                   'if (typeof window == "undefined") {\n' +
                   '    runServerCode();\n' +
                   '}\n\n' +
                   'function runServerCode() {\n' +
                   '    current.update();\n' +
                   '    action.setRedirectURL(current);\n' +
                   '}';
        }
        return '// Server-side UI Action\n' +
               '(function executeUIAction(current) {\n' +
               '    current.update();\n' +
               '    action.setRedirectURL(current);\n' +
               '})(current);';
    },

    'background_script': function(description) {
        return '// =========================================================================\n' +
               '// Background Script: ' + (description || 'Safe Administrative Script') + '\n' +
               '// SAFETY: dryRun = true executes in simulation mode without committing updates.\n' +
               '// NEVER AUTO-EXECUTED: Run manually in System Definition > Scripts - Background\n' +
               '// =========================================================================\n' +
               '(function executeAdminScript() {\n' +
               '    var dryRun = true;\n' +
               '    var limit = 100;\n' +
               '    var processed = 0;\n' +
               '    var updated = 0;\n\n' +
               '    gs.info("[BG SCRIPT] Starting script. DryRun = " + dryRun);\n' +
               '    try {\n' +
               '        var gr = new GlideRecord("incident");\n' +
               '        gr.addActiveQuery();\n' +
               '        gr.setLimit(limit);\n' +
               '        gr.query();\n\n' +
               '        while (gr.next()) {\n' +
               '            processed++;\n' +
               '            if (!dryRun) {\n' +
               '                // gr.setValue("field", value);\n' +
               '                // gr.update();\n' +
               '                updated++;\n' +
               '            }\n' +
               '        }\n' +
               '        gs.info("[BG SCRIPT] Completed. Processed: " + processed + ", Updated: " + updated);\n' +
               '    } catch (e) {\n' +
               '        gs.error("[BG SCRIPT] Exception encountered: " + e);\n' +
               '    }\n' +
               '})();';
    },

    'scripted_rest': function(name, method) {
        return '(function process(/*RESTAPIRequest*/ request, /*RESTAPIResponse*/ response) {\n' +
               '    // Scripted REST API: ' + (name || 'Custom Endpoint') + '\n' +
               '    var queryParams = request.queryParams;\n' +
               '    var pathParams = request.pathParams;\n' +
               '    var bodyData = request.body.data || {};\n\n' +
               '    try {\n' +
               '        response.setStatus(200);\n' +
               '        response.setContentType("application/json");\n' +
               '        return {\n' +
               '            ok: true,\n' +
               '            timestamp: new GlideDateTime().getValue(),\n' +
               '            result: bodyData\n' +
               '        };\n' +
               '    } catch (ex) {\n' +
               '        response.setStatus(500);\n' +
               '        return { ok: false, error: ex.message };\n' +
               '    }\n' +
               '})(request, response);';
    }
};

DevAssistant.prototype = {
    initialize: function() {
        this.validator = new DevValidator();
    },

    /**
     * Build the specialized prompt instructions for the Development Assistant
     */
    buildSystemPrompt: function(mode, artifactType, context) {
        context = context || {};
        var artInfo = DevAssistant.ARTIFACT_TYPES[artifactType] || { label: artifactType, category: 'generic' };

        var lines = [
            '### ServiceNow Development Assistant Engine (' + mode.toUpperCase() + ' MODE)',
            'You are an expert ServiceNow Platform Architect and Certified Technical Architect (CTA).',
            'Target Artifact: ' + artInfo.label + (artInfo.table ? ' (' + artInfo.table + ')' : ''),
            'Execution Category: ' + artInfo.category,
            '',
            'ServiceNow Platform Standards & Invariants:',
            '1. Scoped Application API Isolation: In scoped apps, use scoped GlideRecord, GlideSystem, and GlideRecordSecure APIs.',
            '2. Client vs Server Boundary: NEVER mix client objects (g_form, g_user, window, document) in server code (Business Rules, Script Includes). NEVER call gs.* or current.* in Client Scripts.',
            '3. Business Rule Recursion: In before business rules, NEVER call current.update(). Modifying current saves automatically.',
            '4. Performance (N+1 Avoidance): Never instantiate or query GlideRecord inside a while(gr.next()) loop.',
            '5. Defensive Null Handling: Always verify gr.next() before accessing fields.',
            '6. Background Scripts: Always include a "var dryRun = true;" simulation flag and setLimit(). Background scripts must NEVER be executed automatically.',
            '7. ATF & Flow Guidance: Provide structured step-by-step instructions adhering to Workflow Studio and ATF best practices.',
            '8. Security & ACLs: Rely on GlideRecordSecure where user-level access is required. Never hardcode credentials.'
        ];

        if (context.table) lines.push('Target Table: ' + context.table);
        if (context.sys_scope) lines.push('Application Scope: ' + context.sys_scope);
        if (context.bound_display) lines.push('Open Record: ' + context.bound_display);

        if (mode === 'review' || mode === 'debug') {
            lines.push('');
            lines.push('REVIEW OUTPUT CONTRACT: For each issue identified, format strictly as:');
            lines.push('1. Summary: [Concise issue title]');
            lines.push('2. Severity: [Critical | High | Medium | Low]');
            lines.push('3. Why It Matters: [Explanation of impact]');
            lines.push('4. Relevant Code Section: [Code snippet]');
            lines.push('5. Recommended Fix: [Explanation of solution]');
            lines.push('6. Corrected Code: [Production-ready corrected code]');
            lines.push('7. Regression Test Cases: [Concrete test scenarios]');
            lines.push('8. Assumptions & Caveats: [Platform-specific assumptions]');
        }

        return lines.join('\n');
    },

    /**
     * Inspect the open record to retrieve existing code if viewing a development artifact
     */
    getExistingCodeFromContext: function(bound) {
        if (!bound || !bound.table || !bound.sys_id || bound.error) return null;

        var supportedTables = ['sys_script', 'sys_script_include', 'sys_script_client', 'sys_ui_action', 'sys_ui_policy'];
        if (supportedTables.indexOf(bound.table) < 0) return null;

        try {
            var gr = new GlideRecordSecure(bound.table);
            if (gr.get(bound.sys_id)) {
                var scriptField = 'script';
                if (!gr.isValidField(scriptField)) return null;
                var el = gr.getElement(scriptField);
                if (el && el.canRead()) {
                    return {
                        table: bound.table,
                        sys_id: bound.sys_id,
                        name: gr.getValue('name') || gr.getValue('short_description') || '',
                        script: String(el.getValue() || '')
                    };
                }
            }
        } catch (e) {
            gs.warn('DevAssistant: Could not read open code record: ' + e);
        }
        return null;
    },

    /**
     * Run deterministic static analysis and prepare structured findings
     */
    validateCode: function(code, artifactType, options) {
        return this.validator.validate(code, artifactType, options);
    },

    /**
     * Create a structured proposal card for generated or reviewed code
     */
    createProposal: function(params) {
        params = params || {};
        var artifactType = params.artifact_type || 'business_rule';
        var artInfo = DevAssistant.ARTIFACT_TYPES[artifactType] || { label: artifactType };
        var name = params.name || 'Generated ' + artInfo.label;
        var table = params.table || '';
        var scope = params.scope || 'global';
        var code = params.code || '';
        var summary = params.summary || ('Create / Update ' + artInfo.label + ': ' + name);
        var validation = this.validateCode(code, artifactType);

        var isBackground = (artifactType === 'background_script');
        var isGuidance = (artifactType === 'flow_designer' || artifactType === 'atf_test');

        var actionCard = {
            id: 'dev_' + Math.random().toString(16).slice(2, 10),
            type: 'dev_artifact',
            artifact_type: artifactType,
            artifact_label: artInfo.label,
            name: name,
            table: table,
            scope: scope,
            summary: summary,
            code: code,
            validation: validation,
            status: 'pending',
            can_accept: !!params.bound_sys_id, // Can only Accept if bound to an open metadata record
            bound_table: params.bound_table || '',
            bound_sys_id: params.bound_sys_id || '',
            is_background: isBackground,
            is_guidance: isGuidance,
            instructions: isBackground
                ? 'BACKGROUND SCRIPT SAFETY: This script will NEVER execute automatically. Copy and execute manually in System Definition > Scripts - Background.'
                : isGuidance
                ? 'GUIDANCE ARTIFACT: Follow the step-by-step instructions in Workflow Studio or ATF Test Designer.'
                : params.bound_sys_id
                ? 'Accept will update the open ' + artInfo.label + ' record in your active update set.'
                : 'Copy the generated code and create the ' + artInfo.label + ' record in your application scope.'
        };

        return actionCard;
    },

    type: 'DevAssistant'
};
