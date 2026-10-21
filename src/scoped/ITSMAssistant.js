// Copyright 2026 GMG Technology LLC
// SPDX-License-Identifier: Apache-2.0
var ITSMAssistant = Class.create();

/**
 * ITSM Intelligence Agent for evidence-grounded resolution recommendations,
 * structured incident summaries, knowledge article drafting, and citation validation.
 */
ITSMAssistant.prototype = {
    initialize: function() {
        this.retriever = new ITSMRetriever();
        this.contextBuilder = new ITSMContextBuilder();
    },

    /**
     * Builds prompt for evidence-grounded resolution recommendation
     */
    buildResolutionPrompt: function(incidentData, evidenceContext) {
        incidentData = incidentData || {};
        var lines = [
            '### ITSM INTELLIGENCE: EVIDENCE-GROUNDED RESOLUTION RECOMMENDATION',
            'You are a Senior ServiceNow ITSM Specialist and Certified Incident Management Architect.',
            'Task: Analyze the current open incident and formulate a grounded resolution recommendation using the retrieved evidence.',
            '',
            'Target Incident Context:',
            '- Incident Number: ' + (incidentData.number || 'Current Incident'),
            '- Short Description: ' + (incidentData.short_description || '(none)'),
            (incidentData.description ? '- Detailed Description: ' + incidentData.description : ''),
            (incidentData.category ? '- Category: ' + incidentData.category + (incidentData.subcategory ? ' / ' + incidentData.subcategory : '') : ''),
            (incidentData.cmdb_ci ? '- Configuration Item: ' + incidentData.cmdb_ci : ''),
            (incidentData.priority ? '- Priority: ' + incidentData.priority : ''),
            (incidentData.state ? '- Current State: ' + incidentData.state : ''),
            '',
            evidenceContext.contextText,
            '',
            'MANDATORY OUTPUT FORMAT & INVARIANTS:',
            '1. Supported Facts: State facts directly supported by the retrieved evidence. Explicitly cite the source record (e.g. [Source 1: INC...] or [Source 2: KB...]).',
            '2. Inferences & Root Cause: State technical deductions. If the root cause cannot be proven from evidence, state explicitly that the root cause is UNKNOWN.',
            '3. Recommended Resolution Steps: Concrete, step-by-step remediation procedures grounded in verified knowledge or past resolutions.',
            '4. Uncertainties & Missing Information: Disclose any gaps, conflicting evidence, or diagnostic data needed from the user.',
            '5. Required Approvals: Note any steps requiring change tickets, administrative credentials, or technician confirmation.',
            '',
            'ANTI-HALLUCINATION RULES:',
            '- NEVER invent incident numbers (INC...) or knowledge article numbers (KB...). Only cite sources listed in the evidence sandbox above.',
            '- If no relevant evidence was found, explicitly state: "No matching historical resolution found in authorized records; proposing general diagnostic guidance."',
            '- If retrieved sources suggest conflicting fixes, explain the conflict rather than picking an unsupported one.'
        ];

        return lines.join('\n');
    },

    /**
     * Builds prompt for structured incident summary
     */
    buildSummaryPrompt: function(incidentData, workNotes, evidenceContext) {
        incidentData = incidentData || {};
        var lines = [
            '### ITSM INTELLIGENCE: INCIDENT RESOLUTION SUMMARY',
            'Task: Generate a clear, structured executive and technical summary of this incident.',
            '',
            'Incident Details:',
            '- Number: ' + (incidentData.number || 'Current Incident'),
            '- Title: ' + (incidentData.short_description || ''),
            '- Category: ' + (incidentData.category || ''),
            '- CI: ' + (incidentData.cmdb_ci || ''),
            '- State: ' + (incidentData.state || ''),
            (workNotes ? '- Recorded Work Notes:\n' + workNotes : ''),
            '',
            (evidenceContext && evidenceContext.contextText ? evidenceContext.contextText + '\n' : ''),
            'FORMAT REQUIREMENTS:',
            '1. Executive Overview (2-3 sentences)',
            '2. Observed Symptoms & Business Impact',
            '3. Troubleshooting & Actions Already Performed',
            '4. Evidence-Supported Findings & Relevant Historical Links',
            '5. Current Resolution or Status',
            '6. Remaining Unknowns & Follow-Up Actions'
        ];

        return lines.join('\n');
    },

    /**
     * Builds prompt for knowledge article drafting from a resolved incident
     */
    buildKnowledgeDraftPrompt: function(incidentData, resolutionNotes, evidenceContext) {
        incidentData = incidentData || {};
        var lines = [
            '### ITSM INTELLIGENCE: KNOWLEDGE ARTICLE DRAFT GENERATION',
            'Task: Draft a complete, high-quality Knowledge Article based on the verified incident resolution.',
            '',
            'Source Incident:',
            '- Number: ' + (incidentData.number || ''),
            '- Short Description: ' + (incidentData.short_description || ''),
            (incidentData.description ? '- Problem Description: ' + incidentData.description : ''),
            (incidentData.cmdb_ci ? '- Affected Service / CI: ' + incidentData.cmdb_ci : ''),
            (incidentData.close_code ? '- Close Code: ' + incidentData.close_code : ''),
            (resolutionNotes ? '- Documented Resolution Notes:\n' + resolutionNotes : ''),
            '',
            (evidenceContext && evidenceContext.contextText ? evidenceContext.contextText + '\n' : ''),
            'DRAFT STRUCTURE CONTRACT:',
            '- Title: Clear, search-friendly symptom or problem title',
            '- Problem Statement: What failure occurred',
            '- Symptoms: How to identify or reproduce the issue',
            '- Environment / Affected CI: Systems impacted',
            '- Root Cause: Cause established by resolution notes. If unconfirmed, state "Unknown - Under Investigation"',
            '- Prerequisites: Tools or access required before troubleshooting',
            '- Resolution Steps: Numbered, executable instructions to fix the issue',
            '- Validation Steps: How to verify the service is restored',
            '- Rollback Steps: Recovery procedure if resolution steps fail',
            '- Source References: Cite source incident ' + (incidentData.number || '') + ' and any relevant KB sources.',
            '',
            'SAFETY INVARIANT: The article must be created in "Draft" state. Never mark as published.'
        ];

        return lines.join('\n');
    },

    /**
     * Validates cited record numbers in model response against actual retrieved evidence.
     * Prevents hallucinated incident and KB references from being presented as real sources.
     */
    validateCitations: function(responseText, sourceRegistry) {
        sourceRegistry = sourceRegistry || {};
        var foundMatches = String(responseText || '').match(/\b(?:INC\d{7}|KB\d{7})\b/g) || [];
        var tagMatches = String(responseText || '').match(/\[Source\s+\d+:\s*(?:INC|KB)\d+\]/gi) || [];

        var validCitations = [];
        var hallucinatedCitations = [];

        foundMatches.forEach(function(ref) {
            if (sourceRegistry[ref]) {
                if (validCitations.indexOf(ref) < 0) validCitations.push(ref);
            } else {
                if (hallucinatedCitations.indexOf(ref) < 0) hallucinatedCitations.push(ref);
            }
        });

        tagMatches.forEach(function(tag) {
            if (sourceRegistry[tag]) {
                if (validCitations.indexOf(tag) < 0) validCitations.push(tag);
            } else {
                if (hallucinatedCitations.indexOf(tag) < 0) hallucinatedCitations.push(tag);
            }
        });

        return {
            valid: (hallucinatedCitations.length === 0),
            validCitations: validCitations,
            hallucinatedCitations: hallucinatedCitations
        };
    },

    /**
     * Creates a structured proposal card for a draft knowledge article
     */
    createKnowledgeProposal: function(params) {
        params = params || {};
        var title = params.title || 'Draft Knowledge Article';
        var content = params.content || '';
        var incidentNumber = params.incident_number || '';
        var sources = params.sources || [];

        return {
            id: 'kb_draft_' + Math.random().toString(16).slice(2, 10),
            type: 'knowledge_draft',
            target_table: 'kb_knowledge',
            summary: 'Knowledge Article Draft: ' + title,
            title: title,
            content: content,
            incident_number: incidentNumber,
            sources: sources,
            workflow_state: 'draft',
            status: 'pending',
            can_accept: false, // Knowledge drafts require user criteria review and standard publication workflow
            instructions: 'KNOWLEDGE GOVERNANCE: Draft created for review. By policy, knowledge articles are never automatically published. Copy or create in Knowledge > Articles > Create New.'
        };
    },

    /**
     * Creates a structured proposal to propose incident resolution
     */
    createResolutionProposal: function(params) {
        params = params || {};
        var closeCode = params.close_code || 'Solved (Permanently)';
        var closeNotes = params.close_notes || '';
        var incidentSysId = params.sys_id || '';
        var incidentNumber = params.number || '';

        return {
            id: 'res_prop_' + Math.random().toString(16).slice(2, 10),
            type: 'incident_resolution',
            target_table: 'incident',
            target_sys_id: incidentSysId,
            summary: 'Propose Resolution on ' + incidentNumber,
            close_code: closeCode,
            close_notes: closeNotes,
            status: 'pending',
            can_accept: !!incidentSysId,
            instructions: 'RESOLUTION PROPOSAL: Accept will populate close_code and close_notes on ' + incidentNumber + ' and mark as Resolved.'
        };
    },

    type: 'ITSMAssistant'
};
