// Copyright 2026 GMG Technology LLC
// SPDX-License-Identifier: Apache-2.0
var ActionService = Class.create();
/* Open-core split step 5: paid kinds, the Reviewer verdict, run_as lock, build rules and takeovers come from GMGExtensions
 * (GMG Plan & Create). Open source alone confirms only core kinds ('record', artifact update); anything else is 409 "needs GMG Plan & Create". */
ActionService.ext = function(hook, args) { return typeof GMGExtensions == 'undefined' ? [] : GMGExtensions.call(hook, args); };
ActionService.paidInstalled = function() { return typeof GMGExtensions != 'undefined' && GMGExtensions.installed(); };
ActionService.takeoverOk = function(pa) { return ActionService.ext('canActOn', [pa]).some(function(r) { return r === true; }); };   // paid: R2b.10a/d takeover admin
/* Confirm / reject pending actions. Validates: same user, still pending, not expired. Applies core kinds via global.GMGAIApplier, paid kinds via their handler. */
ActionService.prototype = {
    initialize: function() {},

    _load: function(id) {
        var pa = new GlideRecord('x_gmg_ai_pending_action');
        if (!id || !(typeof ReviewWriteGuard == 'undefined' ? pa.get(id) : ReviewWriteGuard.serverGet(pa, id))) return {error: 'Pending action not found.', code: 404};
        if (pa.getValue('user') != gs.getUserID() && gs.hasRole('admin') !== true && !ActionService.takeoverOk(pa)) return   /* (C) an admin may Accept any card; user stays the card's owner */ {error: 'This action belongs to another user.', code: 403};
        if (pa.getValue('status') != 'pending') return {error: 'Action is already ' + pa.getValue('status') + '.', code: 409};
        var exp = new GlideDateTime(pa.getValue('expires'));
        if (new GlideDateTime().after(exp)) {
            pa.setValue('status', 'expired'); ActionService.srvUpdate(pa);
            return {error: 'Action expired (30 minute limit). Ask the agent to propose it again.', code: 410};
        }
        return {pa: pa};
    },

    reject: function(id) {
        var r = this._load(id);
        if (r.error) return r;
        r.pa.setValue('status', 'rejected');
        r.pa.setValue('decided_at', new GlideDateTime().getValue());
        ActionService.srvUpdate(r.pa);
        this._log(r.pa, 'rejected', 'Rejected by user');
        if (typeof DiagnosticService != 'undefined') {
            DiagnosticService.logAuditEvent({
                eventType: DiagnosticService.EVENT_TYPES.APPROVAL_REJECTED,
                targetTable: r.pa.getValue('target_table'),
                targetSysId: r.pa.getValue('target_sys_id'),
                outcome: 'rejected',
                details: 'Proposal rejected by user ' + gs.getUserName()
            });
        }
        return {ok: true, status: 'rejected'};
    },

    confirm: function(id, runAs, opts) {
        opts = opts || {};
        var r = this._load(id);   // 404 / 403 (requester-only) / 409 / 410 expired, before any role check
        if (r.error) return r;
        var pa = r.pa;
        var wo = ActionService.writesOff(); if (wo) return this._refuse(pa, {reason: wo});   // read-only for non-admins, also for cards made before the switch
        var nb = ActionService.notPassedBlock(pa); if (nb) return nb;   // core seal (route none) / review needs paid (route reviewer), before any write
        var kp = null; try { kp = JSON.parse(pa.getValue('payload')); } catch (e0) {}
        if (kp && !ActionService.isCoreKind(ActionService.kindOf(kp), kp) && !ActionService.handlerFor(ActionService.kindOf(kp), kp)) return ActionService.needsPaid(pa);   // license lapse / paid absent: 409, nothing written
        if (kp && ActionService.isCoreKind(ActionService.kindOf(kp), kp)) {   // step 7: core kinds only for the record they were bound to (stored binding; the live page is not re-checked)
            var bc = ActionService.boundCheck({target_table: pa.getValue('target_table'), target_sys_id: pa.getValue('target_sys_id'), bound_table: pa.isValidField('bound_table') ? pa.getValue('bound_table') : '', bound_sys_id: pa.isValidField('bound_sys_id') ? pa.getValue('bound_sys_id') : ''}, kp);
            if (bc) return {ok: false, code: 409, not_bound: true, error: bc};
            var dn = ActionService.deniedAtConfirm(pa.getValue('target_table'));   // step 9: floor / property / ACL-role elevation re-checked at Confirm (409 if dropped), before anything is written
            if (dn) return {ok: false, code: 409, not_elevated: ActionService.ACL_ROLE_TABLES.indexOf(String(pa.getValue('target_table'))) >= 0, denied: true, error: dn};
        }
        if (kp && kp.bound && !kp.kind && kp.op == 'update') { var sc = this._activeRecheck(pa, kp); if (sc) return sc; }   // step 8
        /* paid beforeConfirm: Reviewer verdict, run_as lock (flow cards), card options of paid kinds, build-item update set rule. A throw = block. */
        var blk = typeof GMGExtensions == 'undefined' ? null : GMGExtensions.blocked('beforeConfirm', [pa, {run_as: runAs, opts: opts}]);
        if (blk) return blk;
        /* role map, then ACL (GlideRecordSecure), for the CONFIRMER (session user). Runs after the card
         * options above so run_as cannot be swapped after the check. A refusal never reaches the Applier. */
        var payload = null;
        try { payload = JSON.parse(pa.getValue('payload')); } catch (e4) {}
        var auth = this._authorize(pa, payload);
        if (!auth.ok) return this._refuse(pa, auth);
        pa.setValue('status', 'approved');
        pa.setValue('decided_at', new GlideDateTime().getValue());
        if (pa.isValidField('confirmed_by')) pa.setValue('confirmed_by', gs.getUserID());
        ActionService.srvUpdate(pa);

        if (typeof DiagnosticService != 'undefined') {
            DiagnosticService.logAuditEvent({
                eventType: DiagnosticService.EVENT_TYPES.APPROVAL_ACCEPTED,
                targetTable: pa.getValue('target_table'),
                targetSysId: pa.getValue('target_sys_id'),
                outcome: 'accepted',
                details: 'Proposal confirmed by user ' + gs.getUserName()
            });
        }
        var res;
        /* step 5 part 2: core kinds apply through the core facade global.GMGAIApplier; a paid kind through its registered handler's apply. */
        var hk = kp && !ActionService.isCoreKind(ActionService.kindOf(kp), kp) ? ActionService.handlerFor(ActionService.kindOf(kp), kp) : null;
        try { res = hk && typeof hk.apply == 'function' ? hk.apply(id) : new global.GMGAIApplier().apply(id); } catch (e) { res = {ok: false, error: 'Apply threw: ' + e}; }
        pa = new GlideRecord('x_gmg_ai_pending_action'); (typeof ReviewWriteGuard == 'undefined' ? pa.get(id) : ReviewWriteGuard.serverGet(pa, id));
        if (!res.ok && res.not_public) return this._refuse(pa, {reason: res.not_public_reason || res.error || 'This flow uses actions that are not public.'});   // backstop: refused, not failed (reason from the paid applier)
        pa.setValue('status', res.ok ? 'applied' : 'failed');
        pa.setValue('result', JSON.stringify(res).substring(0, 4000));
        if (res.update_set_id) pa.setValue('update_set', res.update_set_id);
        if (res.sys_id) pa.setValue('target_sys_id', res.sys_id);
        ActionService.srvUpdate(pa);   // server path: status / update_set are server-only (ReviewWriteGuard)
        if (res.ok) { var aa = ActionService.ext('afterApply', [pa, res]); if (aa.length) res.build_item = aa[0]; }   // paid: build-item afterApply (a throw is logged and skipped)
        var prl = res.pref_line ? '\n' + res.pref_line : '';   // PREFRESTORE AC3: before/after of the 4 prefs
        this._log(pa, res.pref_restore && (!res.pref_restore.ok || (res.pref_restore.unrestorable && res.pref_restore.unrestorable.length)) ? 'error' : (res.ok ? 'applied' : 'failed'), (res.ok ? ('Applied ' + pa.getValue('operation') + ' ' + pa.getValue('target_table') + ' ' + res.sys_id +
            (res.update_set_name ? ' in update set "' + res.update_set_name + '"' : (res.data_write ? ' as a data write (no update set)' : ' (no update set)')) + ' ' + res.link) : res.error) + prl);   // a data write has no update set (was "undefined"); same rule as the panel's applied line
        if (typeof DiagnosticService != 'undefined') {
            DiagnosticService.logAuditEvent({
                eventType: res.ok ? DiagnosticService.EVENT_TYPES.CHANGE_APPLIED : DiagnosticService.EVENT_TYPES.CHANGE_REJECTED,
                targetTable: pa.getValue('target_table'),
                targetSysId: res.sys_id || pa.getValue('target_sys_id'),
                outcome: res.ok ? 'applied' : 'failed',
                errorCode: res.ok ? null : 'RECORD_ACCESS_ERROR',
                details: res.ok ? ('Applied ' + pa.getValue('operation') + ' to ' + pa.getValue('target_table')) : res.error
            });
        }
        res.status = res.ok ? 'applied' : 'failed';
        return res;
    },

    /* Refusal: status 'refused', HTTP 403, logged; the Applier is never called, so no update set and no record. */
    _refuse: function(pa, auth) {
        pa.setValue('status', 'refused');
        pa.setValue('decided_at', new GlideDateTime().getValue());
        if (pa.isValidField('confirmed_by')) pa.setValue('confirmed_by', gs.getUserID());
        var out = ActionService.refusalBody(auth);
        pa.setValue('result', JSON.stringify(out).substring(0, 4000));
        ActionService.srvUpdate(pa);
        this._log(pa, 'refused', 'Refused at Accept: ' + auth.reason);
        out.code = 403;
        return out;
    },

    /* Single decision point for Confirm-time authorization. Returns {ok:true} or {ok:false, reason, required_roles}. */
    _authorize: function(pa, p) {
        if (!p) return {ok: false, reason: 'Proposal payload is unreadable.'};
        var key = ActionService.kindOf(p);
        if (key == 'record' && !p.sys_id) p.sys_id = pa.getValue('target_sys_id');
        var roles = ActionService.rolesFor(key, p);
        if (!roles) return {ok: false, reason: 'Unknown change type "' + key + '"; refused.'};
        if (roles.length && !ActionService.hasAnyRole(roles, function(r) { return gs.hasRole(r); }))
            return {ok: false, required_roles: roles, reason: 'You do not have permission to accept this change (' + key + '). Requires one of the roles: ' + roles.join(', ') + '.'};
        var acl = this._aclCheck(key, p);
        if (!acl.ok) return {ok: false, required_roles: roles, reason: 'Access denied by ACL: ' + acl.reason, unknown_fields: acl.unknown_fields, not_allowed_fields: acl.not_allowed_fields};
        var h = ActionService.handlerFor(key, p);   // paid handler pre-check after role map + ACL (flow public check); before status=approved
        if (h && typeof h.precheck == 'function') { var pc = h.precheck(p, pa); if (pc && !pc.ok) { gs.info('GMG AI: handler pre-check refused ' + pa.getUniqueValue()); return {ok: false, required_roles: roles, reason: pc.error}; } }
        return {ok: true, key: key, required_roles: roles};
    },

    /* GlideRecordSecure gate on the target: canWrite() for an existing record, canCreate() for a new one. */
    _aclCheck: function(key, p) {
        var t = ActionService.aclTarget(key, p);
        if (!t) return {ok: true};
        var ops = ActionService.aclOps(key, p, t);
        if (ops && typeof global.GMGAIApplier.userAccess == 'function') return global.GMGAIApplier.userAccess(ops);   // ACL fix: user ACLs checked in global scope (see GMGAIApplier.userAccess)
        var g;
        try { g = new GlideRecordSecure(t.table); } catch (e) { return {ok: false, reason: 'cannot open table ' + t.table}; }
        if (!g.isValid()) return {ok: false, reason: 'invalid table ' + t.table};
        if (t.sys_id) {
            if (!g.get(t.sys_id)) return {ok: false, reason: 'target ' + t.table + ' ' + t.sys_id + ' not found or not readable'};
            if (!g.canWrite()) return {ok: false, reason: 'no write access to ' + t.table + ' ' + t.sys_id};
            return ActionService.fieldsCheck(g, ActionService.payloadFields(key, p), t, new GlideRecord(t.table));   // every payload field: valid + field ACL
        }
        g.initialize();
        return g.canCreate() ? {ok: true} : {ok: false, reason: 'no create access on ' + t.table};
    },

    /* step 8 (spec 5): re-read 'active' on a bound artifact edit. Changed since propose (either way) -> nothing applied; the card is updated
     * (payload.active_at_propose, warning line), re-sealed server-side, kept pending, and returned for the user to confirm again (409 state_changed). */
    _activeRecheck: function(pa, kp) {
        var g = new GlideRecord(String(kp.table || '')); if (!g.isValid() || !g.get(String(kp.sys_id || ''))) return null;   // missing: the Applier refuses
        var now = !g.isValidField('active') ? '' : (String(g.getValue('active')) == '1' || String(g.getValue('active')) == 'true' ? 'true' : 'false');
        if (String(kp.active_at_propose || '') == now) return null;
        var note = ActionService.ACTIVE_NOTE[now] || '';
        kp.active_at_propose = now; pa.setValue('payload', JSON.stringify(kp));
        var d = String(pa.getValue('diff') || '').split('\n').filter(function(l) { return l.indexOf(ActionService.ACTIVE_NOTE['true']) < 0 && l.indexOf(ActionService.ACTIVE_NOTE['false']) < 0; });
        if (note) d.push('NOTE: ' + note); pa.setValue('diff', d.join('\n'));
        if (typeof GMGSeal != 'undefined') GMGSeal.sealRouteNone(pa);   // server re-seal of the server's own change
        ActionService.srvUpdate(pa);
        if (typeof GMGSeal != 'undefined') GMGSeal.storeSeal(pa);   // new server seal for the re-sealed card (the newest seal counts)
        this._log(pa, 'pending', 'Confirm skipped: active changed to ' + now + ' since the proposal');
        return {ok: false, code: 409, state_changed: true, status: 'pending', active: now, live_warning: now == 'true' ? note : '', data_warning: note, error: ActionService.STATE_CHANGED, diff: d};
    },

    _log: function(pa, status, text) {
        try {
            var l = new GlideRecord('x_gmg_ai_log');
            l.initialize();
            l.setValue('user', gs.getUserID());
            if (l.isValidField('confirmed_by') && status != 'rejected') l.setValue('confirmed_by', gs.getUserID());
            l.setValue('page_url', pa.getValue('page_url'));
            if (l.isValidField('conversation_id') && pa.isValidField('conversation_id')) l.setValue('conversation_id', pa.getValue('conversation_id') || '');
            l.setValue('table_name', pa.getValue('target_table'));
            l.setValue('record_sys_id', pa.getValue('target_sys_id'));
            l.setValue('tools', 'action:' + pa.getValue('action_type') + ':' + pa.getValue('operation'));
            
            var cleanSummary = (typeof DiagnosticService != 'undefined') ? DiagnosticService.redact(pa.getValue('summary')) : pa.getValue('summary');
            l.setValue('prompt', ('Pending action ' + pa.getUniqueValue() + ': ' + cleanSummary).substring(0, 4000));
            
            var cleanText = (typeof DiagnosticService != 'undefined') ? DiagnosticService.redact(String(text)) : String(text);
            l.setValue('response', cleanText.substring(0, 4000));
            l.setValue('status', status);
            l.setValue('pending_action', pa.getUniqueValue());
            l.insert();
        } catch (e) {
            if (typeof gs != 'undefined' && gs.error) gs.error('GMG AI action log failed: ' + e);
        }
    },

    type: 'ActionService'
};

/* ---- role map (pure; unit-tested in test/test_action_roles.js). admin always passes gs.hasRole. ---- */
/* Rulings (1)-(3): a Reviewer-routed proposal is applied only after a stored pass on the payload the Reviewer read; a proposal marked
 * review_route 'none' at creation is not reviewed; anything else (empty / unknown route) is refused. 409 before any write. */
/* route-none seal mismatch at Accept: 409 before any write. An old-canon seal that still matches = out of date (design review wording), else edited. */
ActionService.notPassedBlock = function(pa) {   // core seal gate (GMGSeal.routeGate), checked BEFORE any write; the global Applier repeats GMGAIApplier.reviewGateOf
    var why = typeof GMGSeal == 'undefined' ? 'Review gate unavailable.' : GMGSeal.routeGate(GMGSeal.gateInput(pa), ActionService.paidInstalled());
    if (!why) why = GMGSeal.serverSealGate(pa);   // the row's hash must also equal the server-only seal (x_gmg_ai_log), so a rewritten payload + hash is refused
    return why ? {ok: false, code: 409, not_passed: true, out_of_date: typeof GMGSeal != 'undefined' && why == GMGSeal.REVIEW_GATE.stale, error: why} : null;
};
/* x_gmg_ai.allow_non_admin_writes = false makes the agent read-only for non-admins (admin = the admin role; the free
 * tier has no x_gmg_ai.admin role). Missing or anything but the text 'false' = true (unchanged). Shared by AgentCore (tools + prompt),
 * RecordTools.propose (proposal) and ActionService.confirm (Accept). Returns '' (writes allowed) or the refusal text. */
ActionService.WRITE_PROP = 'x_gmg_ai.allow_non_admin_writes';
ActionService.WRITES_OFF = 'Updating records is turned off for your role. I can still read and explain this record for you.';
ActionService.writesOffFor = function(prop, isAdmin) {
    if (isAdmin === true) return '';
    return String(prop === null || prop === undefined ? '' : prop).replace(/^\s+|\s+$/g, '').toLowerCase() == 'false' ? ActionService.WRITES_OFF : '';
};
ActionService.writesOff = function() { return ActionService.writesOffFor(gs.getProperty(ActionService.WRITE_PROP, 'true'), gs.hasRole('admin') === true); };
/* Panel access (admin setting x_gmg_ai.panel_access): everyone (default) | admins | off. admins = the admin role, decided like
 * allow_non_admin_writes (gs.hasRole('admin')). Missing, empty or any other value = everyone. Enforced server-side by the chat, action
 * (Confirm/Reject) and health REST operations; the panel only hides its launcher from the same answer (GET /health?access=1).
 * Returns '' (allowed) or the refusal text. */
ActionService.PANEL_PROP = 'x_gmg_ai.panel_access';
ActionService.PANEL_OFF = 'The GMG AI Agent is turned off for your role.';
ActionService.panelModeOf = function(prop) {
    var v = String(prop === null || prop === undefined ? '' : prop).replace(/^\s+|\s+$/g, '').toLowerCase();
    return v == 'admins' || v == 'off' ? v : 'everyone';
};
ActionService.panelOffFor = function(prop, isAdmin) {
    var m = ActionService.panelModeOf(prop);
    if (m == 'off') return ActionService.PANEL_OFF;
    if (m == 'admins' && isAdmin !== true) return ActionService.PANEL_OFF;
    return '';
};
ActionService.panelOff = function() { return ActionService.panelOffFor(gs.getProperty(ActionService.PANEL_PROP, 'everyone'), gs.hasRole('admin') === true); };
ActionService.NOT_BOUND = 'This change is not for the record it was proposed on.';
/* Open-core split step 7 (spec 4.4.1): a core kind applies only to the record it was bound to at propose time. r: {target_table, target_sys_id,
 * bound_table, bound_sys_id}; p: the parsed payload. '' = same record everywhere (pending target, binding, and the record the payload writes). Pure.
 * MUST stay identical in ActionService and GMGAIApplierCore (test_bound_confirm checks the bodies match). */
ActionService.boundCheck = function(r, p) {
    var bt = String(r.bound_table || ''), bs = String(r.bound_sys_id || '');
    if (!bt || !/^[0-9a-f]{32}$/.test(bs)) return ActionService.NOT_BOUND;
    if (String(r.target_table || '') != bt || String(r.target_sys_id || '') != bs) return ActionService.NOT_BOUND;
    var sp = p && p.kind == 'record' ? (p.spec || {}) : (p || {});
    if (String(sp.table || '') != bt || String(sp.sys_id || '') != bs) return ActionService.NOT_BOUND;
    if (p && p.kind == 'record' && p.table && String(p.table) != bt) return ActionService.NOT_BOUND;
    return '';
};
ActionService.STATE_CHANGED = 'This record was activated or deactivated since the card was made. Check the warning and confirm again.';   // same text as GMGAIApplier.STATE_CHANGED
ActionService.ACTIVE_NOTE = {'true': 'This script is active. Your change goes live when you confirm.', 'false': 'This record is inactive. Your change is saved but does not run until it is activated.'};   // = GMGAIApplier.LIVE_WARNING / INACTIVE_NOTE
ActionService.ACL_ROLE_TABLES = ['sys_security_acl', 'sys_security_acl_role', 'sys_user_role', 'sys_user_has_role', 'sys_user_role_contains', 'sys_group_has_role'];   // = GMGAIApplier.ACL_ROLE_TABLES (labels only; the decision is Core's)
ActionService.deniedAtConfirm = function(t) {   // one definition in global Core (deniedTable); a missing facade method fails closed
    try { return typeof global.GMGAIApplier.deniedTable == 'function' ? String(global.GMGAIApplier.deniedTable(String(t || '')) || '') : 'The denylist check is unavailable; nothing was applied.'; }
    catch (e) { return 'The denylist check failed; nothing was applied.'; }
};
ActionService.NEEDS_PAID = 'This change needs GMG Plan & Create. Nothing was applied.';
ActionService.needsPaid = function(pa) { return {ok: false, code: 409, needs_paid: true, error: ActionService.NEEDS_PAID}; };
/* status, update_set etc. are server-only (ReviewWriteGuard): ActionService's own writes run inside the marker */
/* owner-initiated server writes (Accept, Reject, expiry) never move review_passed_on; only the Reviewer's verdict write sets it. */
ActionService.srvUpdate = function(gr) { if (gr.isValidField && gr.isValidField('review_passed_on') && gr.review_passed_on && typeof gr.review_passed_on.changes == 'function' && gr.review_passed_on.changes()) { gs.addErrorMessage(ReviewWriteGuard.SERVER_ONLY_DENIED); return false; }
    return typeof ReviewWriteGuard == 'undefined' ? gr.update() : ReviewWriteGuard.run(function() { return gr.update(); }); };
/* Core kinds only (spec 3.1): record writes and updates of existing artifacts. Paid kinds come from proposalKinds() handlers. */
ActionService.ROLE_MAP = {
    'artifact:sys_script': ['admin'],
    'artifact:sys_script_include': ['admin'],
    'artifact:sys_script_client': ['admin'],
    'record': []   // journal / resolution data writes: no extra role, ACL canWrite only
};
ActionService.isCoreKind = function(key, p) { return key == 'record' || (key.indexOf('artifact:') == 0 && !!p && p.op == 'update'); };
/* handler for a paid kind: {kind, roles(p), aclTarget(p), aclOps(p, t), precheck(p, pa)}; null when no extension registers it */
ActionService.handlerFor = function(key, p) {
    if (ActionService.isCoreKind(key, p)) return null;
    var k = key.indexOf('artifact:') == 0 ? 'artifact_create' : key.indexOf('meta:') == 0 ? 'meta' : key;
    var lists = ActionService.ext('proposalKinds', []), i, j;
    for (i = 0; i < lists.length; i++) for (j = 0; j < (lists[i] || []).length; j++) if (lists[i][j] && lists[i][j].kind == k) return lists[i][j];
    return null;
};
ActionService.kindOf = function(p) {
    if (!p) return 'unknown';
    if (p.kind == 'meta') return 'meta:' + p.meta;
    if (p.kind) return String(p.kind);
    return 'artifact:' + p.table;
};
/* Returns the role list (empty = no extra role), or null for an unknown kind (refuse). */
ActionService.rolesFor = function(key, p) {
    if (ActionService.isCoreKind(key, p)) return ActionService.ROLE_MAP.hasOwnProperty(key) ? ActionService.ROLE_MAP[key] : (key.indexOf('artifact:') == 0 ? [] : null);   // step 6: no artifact allowlist; edits of other tables fall to ACLs
    var h = ActionService.handlerFor(key, p);
    return h && typeof h.roles == 'function' ? h.roles(key, p) : null;   // no handler: unknown kind, refused
};
ActionService.hasAnyRole = function(roles, has) {
    for (var i = 0; i < roles.length; i++) if (has(roles[i])) return true;
    return false;
};
/* {table, sys_id?} the ACL gate runs against; sys_id set = canWrite, else canCreate. */
/* Record writes: every field the payload writes must be a valid field the user can write (field ACL). */
/* 403 body and stored pending-action result: field lists returned as separate arrays. */
ActionService.refusalBody = function(auth) {
    return {ok: false, status: 'refused', error: auth.reason, required_roles: auth.required_roles || [],
        unknown_fields: auth.unknown_fields || [], not_allowed_fields: auth.not_allowed_fields || []};
};
ActionService.payloadFields = function(key, p) {
    if (key != 'record') return [];
    var sp = p.spec || {};
    if (p.rec == 'journal') return [String(sp.field || 'work_notes')];
    if (p.rec == 'resolution') { var f = ['close_code', 'close_notes']; if (sp.resolve === true || sp.resolve === 'true') f.push('state'); return f; }
    var skip = {table: 1, sys_id: 1, text: 1, field: 1, resolve: 1}, out = [];   // generic: any other spec keys are fields
    for (var k in (sp.fields || sp)) if (!skip[k]) out.push(k);
    if (p.rec == 'fields' && sp.journal && sp.journal.field) out.push(String(sp.journal.field));   // step 6: journal of a current-record update
    return out;
};
/* Existence is checked on a plain GlideRecord (schema), so an unreadable field is "not allowed", not "unknown"; write access on the GlideRecordSecure. */
ActionService.fieldsCheck = function(g, fields, t, plain) {
    var unknown = [], denied = [], schema = plain || g;
    (fields || []).forEach(function(f) {
        if (!schema.isValidField(f)) { unknown.push(f); return; }
        var el = g.getElement(f);
        if (el == null || !el.canWrite()) denied.push(f);   // never !el
    });
    if (!unknown.length && !denied.length) return {ok: true};
    var msg = [];
    if (unknown.length) msg.push('unknown fields on ' + t.table + ': ' + unknown.join(', '));
    if (denied.length) msg.push('not allowed to write on ' + t.table + ' ' + (t.sys_id || '') + ': ' + denied.join(', '));
    return {ok: false, unknown_fields: unknown, not_allowed_fields: denied, reason: msg.join('; ')};
};
/* ACL fix: the exact rows Confirm will write, for the global user-ACL check. null = keep the scoped check (record kind: per-field ACLs).
 * catalog_item_edit: write sc_cat_item only when item fields change; create item_option_new for added variables; write the item_option_new rows it updates. */
ActionService.aclOps = function(key, p, t) {
    if (key == 'record') return null;
    if (ActionService.isCoreKind(key, p)) { var wf = []; for (var fk in (p.fields || {})) wf.push(fk); return [wf.length ? {table: t.table, sys_id: t.sys_id, op: 'write', write_fields: wf} : {table: t.table, sys_id: t.sys_id, op: 'write'}]; }   // step 6: field ACLs on artifact edits
    var h = ActionService.handlerFor(key, p);
    return h && typeof h.aclOps == 'function' ? h.aclOps(key, p, t) : [t.sys_id ? {table: t.table, sys_id: t.sys_id, op: 'write'} : {table: t.table, op: 'create'}];
};
ActionService.aclTarget = function(key, p) {
    if (key.indexOf('artifact:') == 0 && p.op == 'update') return {table: p.table, sys_id: p.sys_id};
    if (key == 'record') return {table: p.table, sys_id: (p.spec && p.spec.sys_id) || p.sys_id || ''};
    var h = ActionService.handlerFor(key, p);
    return h && typeof h.aclTarget == 'function' ? h.aclTarget(key, p) : null;
};
