// Copyright 2026 GMG Technology LLC
// SPDX-License-Identifier: Apache-2.0
var ContextStore = Class.create();
/* Server-side chat context (docs/interviewer-design-overview.md, "Context management: what we chose and why").
 * x_gmg_ai_conversation: one row per chat (user, page context, running summary, billed_tokens = billed input+output tokens of all model calls).
 * x_gmg_ai_message: one row per turn (role user|agent|tool, text, tool name, args, result, est_tokens = estimate used for trimming only). Rows are never deleted
 * by trimming (audit); trimming only sets compacted / folded. The retention job is the only thing that deletes.
 * The prompt = system prompt + page context + running summary + newest messages that fit in ~70% of the context window.
 * Trim order: (1) tool results of earlier turns -> compact form (always), (2) oldest whole turns fold into the summary
 * while history is over the cap (x_gmg_ai.context.history_tokens, default 12000, never above window x 0.7). */
ContextStore.BUDGET_SHARE = 0.7;
/* Open-core step 10 ruling 3 + follow-up 2 (approvers): on the OPEN SOURCE edition every
 * /api/x_gmg_ai/agent operation refuses (503) until a REAL check finds all 8 conversation/message ACLs: matched by
 * name + operation + type (never sys_id), each active, with the expected role and exactly the shipped script. Only an OK
 * result is cached (per transaction). The property x_gmg_ai.install.conversation_acls is a status record only; it never
 * opens the gate. EDITION is baked in by build.py (open source build writes 'opensource', full build writes 'full'); the source
 * default is 'opensource' so a copy that was not built fails closed. */
ContextStore.EDITION = 'opensource';   // baked by build.py
ContextStore.INSTALL_PROP = 'x_gmg_ai.install.conversation_acls';
ContextStore.INSTALL_INCOMPLETE = 'install incomplete: conversation ACLs missing';
ContextStore.CONV_ACLS = [   // [table, operation, script ('' = none), role, advanced]; must equal build.py ctx_security (test_install_gate.js)
    ['x_gmg_ai_conversation', 'read', "answer = gs.hasRole('admin') || current.getValue('user') == gs.getUserID();", 'x_gmg_ai.user', true],
    ['x_gmg_ai_conversation', 'write', '', 'admin', false], ['x_gmg_ai_conversation', 'create', '', 'admin', false], ['x_gmg_ai_conversation', 'delete', '', 'admin', false],
    ['x_gmg_ai_message', 'read', "answer = gs.hasRole('admin') || current.conversation.user == gs.getUserID();", 'x_gmg_ai.user', true],
    ['x_gmg_ai_message', 'write', '', 'admin', false], ['x_gmg_ai_message', 'create', '', 'admin', false], ['x_gmg_ai_message', 'delete', '', 'admin', false]];
/* Other access-deciding sys_security_acl fields (confirmed in the instance dictionary 2026-10-18, opencore/acl_fields_dict.json) and the value every
 * shipped ACL sets explicitly; build.py CONV_ACL_FIELDS must be equal. A row whose value differs is 'unexpected'. Boolean fields: '1'/'true'. */
ContextStore.CONV_ACL_FIELDS = {'admin_overrides': 'true', 'condition': '', 'decision_type': 'allow', 'applies_to': '', 'local_or_existing': 'Existing',
    'security_attribute': '', 'controlled_by_refs': ''};
ContextStore.CONV_ACL_BOOL = {'admin_overrides': true, 'advanced': true};
/* Live readback finding: the platform fills applies_to with
 * 'table:<the ACL's own table>' on an ACL created by the install, where the package ships ''. applies_to accepts exactly '' or
 * 'table:' + that ACL's own table; anything else (a filter such as 'active=true', another table) still counts as unexpected.
 * Every other field must equal CONV_ACL_FIELDS exactly. Shared rule with build.py acl_field_ok. */
ContextStore._aclFieldOk = function(f, v, table) {
    var x = ContextStore._aclVal(f, v);
    if (x === ContextStore.CONV_ACL_FIELDS[f]) return true;
    return f == 'applies_to' && !!table && x === 'table:' + table;
};
ContextStore._aclVal = function(f, v) {
    v = (v === null || v === undefined) ? '' : String(v);
    if (ContextStore.CONV_ACL_BOOL[f]) return (v == '1' || v == 'true') ? 'true' : 'false';
    return v;
};
ContextStore._aclOkAt = 0;   // time of the last PASSING check (0 = none); a refusal is never cached
ContextStore.ACL_OK_TTL_MS = 300000;   // approver: a cached OK lasts at most 5 minutes; an ACL removed or added later closes the gate on the next request after that
ContextStore._now = function() { return new Date().getTime(); };
ContextStore.installIncomplete = function() {
    if (ContextStore.EDITION != 'opensource') return '';   // full (dev) build: no gate
    var t = ContextStore._now(), m;
    if (ContextStore._aclOkAt && t >= ContextStore._aclOkAt && t - ContextStore._aclOkAt < ContextStore.ACL_OK_TTL_MS) return '';
    ContextStore._aclOkAt = 0;
    try { m = ContextStore.aclsMissing(); } catch (e) { return ContextStore.INSTALL_INCOMPLETE; }
    if (m.length) return ContextStore.INSTALL_INCOMPLETE;
    ContextStore._aclOkAt = t;
    return '';
};
/* Every ACL that can grant access to chat history: names 'table', 'table.*' and 'table.<field>' on the two tables (architecture review). */
ContextStore.CONV_ACL_QUERY = 'nameINx_gmg_ai_conversation,x_gmg_ai_message^ORnameSTARTSWITHx_gmg_ai_conversation.^ORnameSTARTSWITHx_gmg_ai_message.';
/* Read-only. Returns the problems as strings; empty = install complete. Shared rule with build.py acl_audit / conv_acls_missing:
 * - ALL active record ACLs on the two tables (any operation, table / table.* / table.<field>) are read; inactive ones are ignored;
 * - each must be exactly one of the 8 shipped ACLs (name + operation + type, exact script, Advanced as shipped: true for the two
 *   script ACLs, false for the rest, and every CONV_ACL_FIELDS value), else 'unexpected ACL' (an extra permissive,
 *   looser-script or field ACL could widen access, so the gate stays closed);
 * - a matched ACL needs a link to its role and no link to any other role;
 * - each of the 8 must be matched at least once.
 * UNVERIFIED live: scoped read of sys_security_acl / sys_security_acl_role and the dot-walked role query. */
ContextStore.aclsMissing = function() {
    var miss = [], hit = [], i, a, gr, rr, nm, op, sc, sid, adv, k, rows = 0, n = 0, L = ContextStore.CONV_ACLS;
    /* count pre-check (kept as is; redundant with the audit below, listed for step 11) */
    gr = new GlideRecord('sys_security_acl');
    gr.addQuery('name', 'IN', 'x_gmg_ai_conversation,x_gmg_ai_message'); gr.addQuery('operation', 'IN', 'read,write,create,delete');
    gr.addQuery('type', 'record'); gr.addQuery('active', true); gr.query();
    while (gr.next() && n < 100) n++;
    if (n < L.length) miss.push('only ' + n + ' of ' + L.length + ' active conversation/message ACLs');
    gr = new GlideRecord('sys_security_acl');
    gr.addEncodedQuery(ContextStore.CONV_ACL_QUERY); gr.addQuery('type', 'record'); gr.addQuery('active', true); gr.query();
    while (gr.next()) {
        if (++rows > 500) { miss.push('more than 500 conversation/message ACLs'); break; }
        nm = String(gr.getValue('name') || ''); op = String(gr.getValue('operation') || ''); sc = String(gr.getValue('script') || ''); sid = String(gr.getValue('sys_id') || '');
        adv = ContextStore._aclVal('advanced', gr.getValue('advanced')) == 'true';   // boolean field: '1'/'0' (GlideRecord) or 'true'/'false'
        k = -1;
        for (i = 0; i < L.length; i++) if (L[i][0] === nm && L[i][1] === op && L[i][2] === sc && L[i][4] === adv) { k = i; break; }
        if (k >= 0) for (var fx in ContextStore.CONV_ACL_FIELDS) {
            if (ContextStore.CONV_ACL_FIELDS.hasOwnProperty(fx) && !ContextStore._aclFieldOk(fx, gr.getValue(fx), nm)) { k = -1; break; }
        }
        if (k < 0) { miss.push('unexpected ACL ' + nm + ' ' + op); continue; }
        a = L[k];
        rr = new GlideRecord('sys_security_acl_role'); rr.addQuery('sys_security_acl', sid); rr.addQuery('sys_user_role.name', a[3]); rr.setLimit(1); rr.query();
        if (!sid || !rr.next()) { miss.push('ACL role ' + nm + ' ' + op + ' (' + a[3] + ')'); continue; }
        rr = new GlideRecord('sys_security_acl_role'); rr.addQuery('sys_security_acl', sid); rr.addQuery('sys_user_role.name', '!=', a[3]); rr.setLimit(1); rr.query();
        if (rr.next()) { miss.push('ACL role ' + nm + ' ' + op + ': other role linked (only ' + a[3] + ')'); continue; }
        hit[k] = true;
    }
    for (i = 0; i < L.length; i++) if (!hit[i]) miss.push(L[i][0] + ' ' + L[i][1]);
    return miss;
};
ContextStore.KEEP_RAW_TOOL_RESULTS = 2;   // newest N tool results are always sent in full
ContextStore.MIN_RECENT_TURNS = 1;        // the newest turn (current question + its tool work) is never folded
ContextStore.COMPACT_CHARS = 400;
ContextStore.COMPACT_MAX_IDS = 200;   // review fix: identifiers kept per compacted result
ContextStore.DEFAULT_WINDOW = 32000;
ContextStore.HISTORY_TOKENS = 12000;     // fixed history cap (property x_gmg_ai.context.history_tokens, 4000-32000)
ContextStore.HISTORY_MIN = 4000; ContextStore.HISTORY_MAX = 32000;    // conservative when the model is unknown
/* Per-model context windows (tokens). UPDATE THIS TABLE WHEN NEW MODELS ARE ADDED; unmatched models get DEFAULT_WINDOW. */
ContextStore.WINDOWS = [[/claude/i, 200000], [/grok-4/i, 256000], [/grok/i, 131072], [/gpt-4o|gpt-4\.1|o\d/i, 128000]];

/* ---------- pure helpers (unit-tested in test/test_context.js, no Glide) ---------- */
ContextStore.estimateTokens = function(s) { s = s ? String(s) : ''; return s.length ? Math.ceil(s.length / 4) : 0; };
/* Window order: property x_gmg_ai.context.window_tokens if set and > 0, then the per-model table (ContextStore.WINDOWS), then DEFAULT_WINDOW.
 * UPDATE ContextStore.WINDOWS WHEN NEW MODELS ARE ADDED (a model not matched falls back to the conservative 32k default). Returns {tokens, source}. */
ContextStore.windowInfo = function(model, override) {
    var o = parseInt(override, 10); if (o > 0) return {tokens: o, source: 'property'};
    for (var i = 0; i < ContextStore.WINDOWS.length; i++) if (ContextStore.WINDOWS[i][0].test(String(model || ''))) return {tokens: ContextStore.WINDOWS[i][1], source: 'model_table'};
    return {tokens: ContextStore.DEFAULT_WINDOW, source: 'default'};
};
/* history cap = min(property, window x 0.7). Missing / unparseable / out of range -> 12000. */
ContextStore.historyCap = function(prop, win) {
    var s = String(prop == null ? '' : prop).trim(), p = /^\d+$/.test(s) ? parseInt(s, 10) : NaN;
    if (!(p >= ContextStore.HISTORY_MIN && p <= ContextStore.HISTORY_MAX)) p = ContextStore.HISTORY_TOKENS;
    return Math.min(p, Math.floor((win || ContextStore.DEFAULT_WINDOW) * ContextStore.BUDGET_SHARE));
};
ContextStore.windowFor = function(model, override) { return ContextStore.windowInfo(model, override).tokens; };
/* sys_ids, numbers and short keys survive compaction so later tool calls still have exact identifiers */
ContextStore.compact = function(toolName, result) {
    var s = String(result || ''), ids = s.match(/\b[0-9a-f]{32}\b/g) || [], nums = s.match(/\b[A-Z]{2,6}\d{5,}\b/g) || [], seen = {}, keep = [];
    /* review fix: keep EVERY distinct sys_id and number (was capped at 20, so lists over 20 rows lost ids on the next turn).
     * Safety cap COMPACT_MAX_IDS (200); anything beyond it is counted, never silently dropped. Order is stable, so output stays deterministic. */
    var more = 0;
    ids.concat(nums).forEach(function(x) { if (seen[x]) return; seen[x] = 1; if (keep.length < ContextStore.COMPACT_MAX_IDS) keep.push(x); else more++; });
    return '[compacted ' + (toolName || 'tool') + ' result, ' + s.length + ' chars] ' + s.substring(0, ContextStore.COMPACT_CHARS) +
        (keep.length ? ' ... ids: ' + keep.join(', ') : '') + (more ? ' (+' + more + ' more ids; re-run the tool to see them)' : '');
};
ContextStore.msgTokens = function(m) {
    if (m.role == 'tool') return ContextStore.estimateTokens(m.compacted ? ContextStore.compact(m.tool_name, m.result) : m.result) + 8;
    return ContextStore.estimateTokens(m.text) + ContextStore.estimateTokens(m.args) + 4;
};
/* Group seq-ordered messages into turns: a turn starts at each user message. */
ContextStore.turns = function(msgs) {
    var out = [], cur = null;
    msgs.forEach(function(m) { if (m.role == 'user' || !cur) { cur = []; out.push(cur); } cur.push(m); });
    return out;
};
/* msgs: active (not folded) rows oldest first [{seq, role, text, tool_name, args, result, compacted}]; budget: tokens left for history.
 * Returns {compact:[seq], fold:[seq], tokens}. Step 1 compacts tool results oldest first (never the newest KEEP_RAW);
 * step 2 folds oldest whole turns (never the last MIN_RECENT_TURNS). If still over, the caller sends what fits newest-first. */
ContextStore.plan = function(msgs, budget, extraSummaryTokensPerTurn) {
    var work = msgs.map(function(m) { var c = {}; for (var k in m) c[k] = m[k]; return c; });
    var total = function() { var t = 0; work.forEach(function(m) { if (!m._fold) t += ContextStore.msgTokens(m); }); return t; };
    var plan = {compact: [], fold: []}, per = extraSummaryTokensPerTurn || 60;
    var turns = ContextStore.turns(work);
    /* step 1: tool results from EARLIER user turns are always compacted, regardless of budget (deterministic).
     * The current (last) turn's tool results stay raw. */
    for (var t = 0; t < turns.length - 1; t++) turns[t].forEach(function(m) { if (m.role == 'tool' && !m.compacted) { m.compacted = true; plan.compact.push(m.seq); } });
    for (var j = 0; j < turns.length - ContextStore.MIN_RECENT_TURNS && total() > budget; j++) {
        turns[j].forEach(function(m) { m._fold = true; plan.fold.push(m.seq); });
        budget -= per;   // the summary grows by roughly this much per folded turn
    }
    plan.tokens = total();
    return plan;
};
/* Deterministic (no model call) summary line for a folded turn. Keeps the question, tools + ids, and the answer head. */
/* tool names + sys_ids of folded rows: always attached to the summary, even when the model writes it */
ContextStore.idsOf = function(rows) {
    var tools = {}, ids = {}, tl = [], il = [];
    rows.forEach(function(m) {
        if (m.role == 'tool' && m.tool_name && !tools[m.tool_name]) { tools[m.tool_name] = 1; tl.push(m.tool_name); }
        (String(m.result || '') + ' ' + String(m.args || '')).replace(/\b[0-9a-f]{32}\b/g, function(x) { if (!ids[x] && il.length < 30) { ids[x] = 1; il.push(x); } return x; });
    });
    return (tl.length ? 'tools: ' + tl.join(', ') : '') + (il.length ? (tl.length ? ' | ' : '') + 'sys_ids: ' + il.join(', ') : '');
};
/* summary text for folded rows: model text (if given) + row-built ids, else the row-built lines */
ContextStore.foldText = function(foldedRows, modelText) {
    var rowLines = ContextStore.turns(foldedRows).map(ContextStore.summarizeTurn).join('\n');
    if (!modelText) return {text: rowLines, source: 'rows'};
    var ids = ContextStore.idsOf(foldedRows);
    return {text: String(modelText).substring(0, 3000) + (ids ? '\n  [' + ids + ']' : ''), source: 'model'};
};
ContextStore.summarizeTurn = function(turn) {
    var q = '', a = '', tools = [];
    turn.forEach(function(m) {
        if (m.role == 'user') q = String(m.text || '').substring(0, 200);
        else if (m.role == 'tool') tools.push(m.tool_name + (/\b[0-9a-f]{32}\b/.test(m.result || '') ? ' (' + ((m.result.match(/\b[0-9a-f]{32}\b/g) || []).slice(0, 3).join(', ')) + ')' : ''));
        else if (m.text) a = String(m.text).substring(0, 240);
    });
    return '- User: ' + q + (tools.length ? ' | tools: ' + tools.join('; ') : '') + (a ? ' | Agent: ' + a : '');
};
/* Normalized adapter messages from rows (agent rows with args = tool_calls JSON; tool rows answer them). */
ContextStore.toAdapter = function(rows) {
    var out = [];
    rows.forEach(function(m) {
        if (m.role == 'user') out.push({role: 'user', content: String(m.text || '')});
        else if (m.role == 'agent') {
            var o = {role: 'assistant', content: String(m.text || '')}, tc = null;
            try { tc = m.args ? JSON.parse(m.args) : null; } catch (e) {}
            if (tc && tc.length) o.tool_calls = tc;
            if (o.content || o.tool_calls) out.push(o);
        } else if (m.role == 'tool') out.push({role: 'tool', tool_call_id: m.tool_call_id, name: m.tool_name, content: m.compacted ? ContextStore.compact(m.tool_name, m.result) : String(m.result || '')});
    });
    // a tool result whose tool_calls message was dropped would be rejected by the providers: drop orphans
    var calls = {};
    out.forEach(function(m) { (m.tool_calls || []).forEach(function(c) { calls[c.id] = 1; }); });
    return out.filter(function(m) { return m.role != 'tool' || calls[m.tool_call_id]; });
};
/* Newest-first fill of whatever still fits (whole turns only, so tool pairs stay intact). */
ContextStore.fit = function(rows, budget) {
    var turns = ContextStore.turns(rows), keep = [], used = 0;
    for (var i = turns.length - 1; i >= 0; i--) {
        var t = 0; turns[i].forEach(function(m) { t += ContextStore.msgTokens(m); });
        if (used + t > budget && keep.length) break;
        keep = turns[i].concat(keep); used += t;
    }
    return {rows: keep, tokens: used, dropped_turns: turns.length - ContextStore.turns(keep).length};
};

/* Chat retention: a setting, never more than 5 days. Above 5 = 5; missing, not a whole number, 0 or negative = 5. */
ContextStore.RETENTION_PROP = 'x_gmg_ai.context.retention_days';
ContextStore.RETENTION_MAX = 5;
ContextStore.retentionDays = function(raw) {
    var t = String(raw === null || raw === undefined ? '' : raw).replace(/^\s+|\s+$/g, '');
    if (!/^-?\d+$/.test(t)) return ContextStore.RETENTION_MAX;
    var d = parseInt(t, 10);
    if (!(d > 0)) return ContextStore.RETENTION_MAX;
    return d > ContextStore.RETENTION_MAX ? ContextStore.RETENTION_MAX : d;
};

/* ---------- Glide side ---------- */
ContextStore.prototype = {
    initialize: function() { this.T_CONV = 'x_gmg_ai_conversation'; this.T_MSG = 'x_gmg_ai_message'; },

    /* get-or-create the caller's conversation by the panel's conversation id. Another user's key never matches (user is part of the query). */
    open: function(key, ctx) {
        key = String(key || '');
        if (!/^[A-Za-z0-9-]{8,64}$/.test(key)) return null;
        var c = new GlideRecord(this.T_CONV);
        c.addQuery('user', gs.getUserID()); c.addQuery('conversation_key', key); c.setLimit(1); c.query();
        if (!c.next()) {
            c = new GlideRecord(this.T_CONV); c.initialize();
            c.setValue('user', gs.getUserID()); c.setValue('conversation_key', key); c.setValue('billed_tokens', 0); c.setValue('message_count', 0);
            c.setValue('summary', ''); c.setValue('summarized_through', 0);
        }
        c.setValue('page_url', String((ctx || {}).url || '').substring(0, 1000));
        c.setValue('page_context', JSON.stringify(this._pageCtx(ctx)).substring(0, 4000));
        c.setValue('last_activity', new GlideDateTime().getValue());
        if (c.isNewRecord()) c.insert(); else c.update();
        return c;
    },
    _pageCtx: function(ctx) {
        ctx = ctx || {}; var o = {};
        ['url', 'ui', 'kind', 'table', 'sys_id', 'view', 'query'].forEach(function(k) { if (ctx[k]) o[k] = String(ctx[k]).substring(0, 500); });
        if (ctx.fields) o.field_names = Object.keys(ctx.fields).slice(0, 40);
        return o;
    },
    /* write one row as it happens; returns {sys_id, seq, tokens} */
    append: function(conv, role, f) {
        f = f || {};
        var seq = (parseInt(conv.getValue('message_count'), 10) || 0) + 1, m = new GlideRecord(this.T_MSG);
        m.initialize();
        m.setValue('conversation', conv.getUniqueValue()); m.setValue('seq', seq); m.setValue('role', role);
        if (f.text) m.setValue('text', String(f.text));
        if (f.tool_name) m.setValue('tool_name', f.tool_name);
        if (f.tool_call_id) m.setValue('tool_call_id', f.tool_call_id);
        if (f.args) m.setValue('args', typeof f.args == 'string' ? f.args : JSON.stringify(f.args));
        if (f.result !== undefined) m.setValue('result', typeof f.result == 'string' ? f.result : JSON.stringify(f.result));
        var tok = f.tokens || ContextStore.msgTokens({role: role, text: f.text, args: m.getValue('args'), result: m.getValue('result'), tool_name: f.tool_name});
        m.setValue('est_tokens', tok); if (f.estimated) m.setValue('estimated', true);
        var id = m.insert();
        conv.setValue('message_count', seq);
        conv.setValue('last_activity', new GlideDateTime().getValue());
        conv.update();
        return {sys_id: id, seq: seq, tokens: tok};
    },
    /* billed_tokens = billed input + output of every model call (estimated only when the provider returned no usage; that agent row is flagged estimated) */
    addTokens: function(conv, n) { if (!n) return; conv.setValue('billed_tokens', (parseInt(conv.getValue('billed_tokens'), 10) || 0) + n); conv.update(); },
    rows: function(conv) {
        var out = [], m = new GlideRecord(this.T_MSG);
        m.addQuery('conversation', conv.getUniqueValue()); m.addQuery('folded', false); m.orderBy('seq'); m.query();
        while (m.next()) out.push({sys_id: m.getUniqueValue(), seq: parseInt(m.getValue('seq'), 10), role: m.getValue('role'), text: m.getValue('text') || '',
            tool_name: m.getValue('tool_name') || '', tool_call_id: m.getValue('tool_call_id') || '', args: m.getValue('args') || '', result: m.getValue('result') || '',
            compacted: m.getValue('compacted') == '1'});
        return out;
    },
    /* Trim (persisting compacted / folded flags + summary) and return adapter messages that fit. */
    /* opts.summarize(foldedRows, rowLines) -> model summary text or null (only called when folding; see AgentCore) */
    build: function(conv, systemPrompt, model, maxOut, winOverride, opts) {
        opts = opts || {};
        var wi = ContextStore.windowInfo(model, winOverride || gs.getProperty('x_gmg_ai.context.window_tokens', '')), win = wi.tokens;
        var cap = ContextStore.historyCap(gs.getProperty('x_gmg_ai.context.history_tokens', ''), win);   // history cap
        var summary = conv.getValue('summary') || '', fixed = ContextStore.estimateTokens(systemPrompt) + ContextStore.estimateTokens(summary) + 2000;   // +2000: tool schemas headroom
        var budget = Math.max(1000, Math.min(cap, Math.floor(win * ContextStore.BUDGET_SHARE) - fixed)), rows = this.rows(conv), p = ContextStore.plan(rows, budget), self = this, info = {window: win, window_source: wi.source, budget_tokens: cap, compacted: p.compact.length, folded: p.fold.length};
        if (p.compact.length) this._flag(p.compact, conv, 'compacted');
        if (p.fold.length) {
            var foldSet = {}; p.fold.forEach(function(s) { foldSet[s] = 1; });
            var folded = rows.filter(function(r) { return foldSet[r.seq]; }), mt = null;
            if (opts.summarize) { try { mt = opts.summarize(folded, ContextStore.foldText(folded).text); } catch (e) { mt = null; } }
            var ft = ContextStore.foldText(folded, mt); info.summary_source = ft.source;
            summary = (summary ? summary + '\n' : '') + ft.text;
            if (summary.length > 8000) summary = '[older summary trimmed]\n' + summary.substring(summary.length - 7900);
            conv.setValue('summary', summary); conv.setValue('summarized_through', Math.max.apply(null, p.fold)); conv.update();
            this._flag(p.fold, conv, 'folded');
        }
        rows = rows.filter(function(r) { return p.fold.indexOf(r.seq) < 0; }).map(function(r) { if (p.compact.indexOf(r.seq) >= 0) r.compacted = true; return r; });
        var f = ContextStore.fit(rows, Math.max(1000, Math.min(cap, Math.floor(win * ContextStore.BUDGET_SHARE) - ContextStore.estimateTokens(systemPrompt) - ContextStore.estimateTokens(summary) - 2000)));
        info.history_tokens = f.tokens; info.dropped_turns = f.dropped_turns;
        return {messages: ContextStore.toAdapter(f.rows), summary: summary, info: info};
    },
    _flag: function(seqs, conv, field) {
        var m = new GlideRecord(this.T_MSG);
        m.addQuery('conversation', conv.getUniqueValue()); m.addQuery('seq', 'IN', seqs.join(',')); m.query();
        while (m.next()) { m.setValue(field, true); m.update(); }
    },
    /* retention job: delete conversations (and their messages) idle longer than x_gmg_ai.context.retention_days (max 5, default 5) */
    purge: function() {
        var days = ContextStore.retentionDays(gs.getProperty(ContextStore.RETENTION_PROP, String(ContextStore.RETENTION_MAX)));
        var cut = new GlideDateTime(); cut.addDaysUTC(-days);
        var c = new GlideRecord(this.T_CONV), n = 0, k = 0;
        c.addQuery('last_activity', '<', cut.getValue()); c.setLimit(2000); c.query();
        while (c.next()) {
            var m = new GlideRecord(this.T_MSG); m.addQuery('conversation', c.getUniqueValue()); m.query();
            while (m.next()) { m.deleteRecord(); k++; }
            c.deleteRecord(); n++;
        }
        gs.info('GMG AI context retention: deleted ' + n + ' conversations / ' + k + ' messages older than ' + days + ' days');
        return {conversations: n, messages: k, days: days};
    },
    type: 'ContextStore'
};
