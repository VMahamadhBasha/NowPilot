/* Copyright 2026 GMG Technology LLC */ /* SPDX-License-Identifier: Apache-2.0 */ (function process(request, response) {
    /* Health/context check: verifies role, provider config and tools without calling the LLM. */
    if (!gs.hasRole('x_gmg_ai.user')) { response.setStatus(403); return {error: 'x_gmg_ai.user role required'}; }
    var inc = ContextStore.installIncomplete(); if (inc) { response.setStatus(503); return {error: inc}; }
    var po = ActionService.panelOff();
    if (request.queryParams.access) return {panel_access: po ? false : true};
    if (po) { response.setStatus(403); return {error: po, panel_off: true}; }

    var q = request.queryParams;
    var core = new AgentCore();
    
    // Resolve target provider: accepts test_provider or provider parameter
    var provParam = q.test_provider || q.provider;
    var p = null;
    if (provParam && /^[0-9a-f]{32}$/.test(String(provParam))) {
        var pgr = new GlideRecord('x_gmg_ai_provider');
        if (pgr.get(String(provParam))) p = pgr;
    }
    if (!p) p = core.getProvider();

    var isAdmin = gs.hasRole('admin') === true;

    // Administrator diagnostics endpoint: explicit test only (?diagnostics=1, ?test=1, or ?test_provider=<sys_id>)
    if (q.diagnostics == '1' || q.test == '1' || q.test_provider) {
        if (!isAdmin) {
            response.setStatus(403);
            return {error: 'Administrator role required for provider diagnostics and connectivity testing.'};
        }
        if (!p) {
            return {error: 'No active AI provider configured.'};
        }

        var llm = new LLMAdapter(p);
        var testRes = llm.testConnection();

        var diag = {
            provider: p.getValue('name'),
            type: p.getValue('type') || 'openai_compatible',
            model: p.getValue('model'),
            key_configured: !!(p.api_key && p.api_key.getDecryptedValue()),
            connection_ok: testRes.ok,
            latency_ms: testRes.latency_ms,
            http_status: testRes.status,
            discovered_models: testRes.models || [],
            failure_category: testRes.category || null,
            error: testRes.error || null
        };

        // Query historical metrics from log (last success, last failure, fallback events)
        try {
            var lLast = new GlideRecord('x_gmg_ai_log');
            lLast.addQuery('provider', p.getUniqueValue());
            lLast.addQuery('status', 'ok');
            lLast.orderByDesc('sys_created_on');
            lLast.setLimit(1);
            lLast.query();
            diag.last_successful_request = lLast.next() ? String(lLast.getValue('sys_created_on')) : null;

            var lFail = new GlideRecord('x_gmg_ai_log');
            lFail.addQuery('provider', p.getUniqueValue());
            lFail.addQuery('status', '!=', 'ok');
            lFail.orderByDesc('sys_created_on');
            lFail.setLimit(1);
            lFail.query();
            diag.last_failure_at = lFail.next() ? String(lFail.getValue('sys_created_on')) : null;

            var gaFb = new GlideAggregate('x_gmg_ai_log');
            gaFb.addQuery('provider', p.getUniqueValue());
            gaFb.addEncodedQuery('responseLIKEFallbacks:');
            gaFb.addAggregate('COUNT');
            gaFb.query();
            diag.fallback_count = gaFb.next() ? parseInt(gaFb.getAggregate('COUNT'), 10) || 0 : 0;
        } catch (eLogs) {}

        return diag;
    }

    var t = new AgentTools();
    var r = {
        user: gs.getUserName(),
        provider: p ? p.getValue('name') : null,
        type: p ? p.getValue('type') : null,
        model: p ? p.getValue('model') : null,
        key_present: p ? !!(p.api_key && p.api_key.getDecryptedValue()) : false,
        tools: t.definitions().map(function(d) { return d.name; })
    };

    if (q.number) {
        r.sample_get_record = t.execute('get_record', {table: 'incident', number: String(q.number)});
        r.sample_similar = t.execute('find_similar_incidents', {number: String(q.number), limit: 3});
        r.sample_query = t.execute('query_records', {table: 'incident', query: 'active=true^priority=1', limit: 3});
        r.system_prompt = core.systemPrompt({url: '/incident.do', table: 'incident', kind: 'form', fields: {number: String(q.number)}});
    }

    var hs = GMGExtensions.call('healthSamples', [q]), i, k;
    for (i = 0; i < hs.length; i++) for (k in hs[i]) if (!(k in r)) r[k] = hs[i][k];
    var cc = GMGExtensions.call('clientConfig', []);
    r.client = cc.length ? cc[0] : {features: []};
    return r;
})(request, response);
