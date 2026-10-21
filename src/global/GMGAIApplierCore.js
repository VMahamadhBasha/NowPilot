var GMGAIApplierCore = (function() {
// Copyright 2026 GMG Technology LLC
// SPDX-License-Identifier: Apache-2.0
/* GMGAIApplierCore: the Applier implementation (moved verbatim from GMGAIApplier.js; no logic change).
 * Deployed as global Script Include GMGAIApplierCore, access "This application scope only" (global only) and client_callable=false.
 * build.py wraps this file at deploy as  var GMGAIApplierCore = (function() { <this file> return GMGAIApplier; })();
 * so the internal name GMGAIApplier below is local to Core and every Core method still calls the others unchanged.
 * Only the public facade global.GMGAIApplier (src/GMGAIApplier.js) is reachable from x_gmg_ai. */
var GMGAIApplier = Class.create();
/* GLOBAL scope Script Include (accessible from all scopes) used by the x_gmg_ai app to apply CONFIRMED build actions.
 * Lives in global because scoped apps cannot reliably create metadata in global or switch the user's update set / application.
 * Defense in depth: re-reads the pending action and re-checks owner, status (approved), age, table + field allowlists.
 * Writes use GlideRecordSecure as the calling user. No deletes. No deactivation, with ONE narrow exception (AC10): an update whose
 * server-written payload carries deactivate=true (the user explicitly asked to remove it) sets active=false on that existing record.
 * New BRs / client scripts forced inactive; existing records keep their active state on edits (AC11, editSafeFields). */
GMGAIApplier.TABLES = {
    sys_script: ['name', 'collection', 'when', 'order', 'action_insert', 'action_update', 'action_delete', 'action_query',
                 'filter_condition', 'condition', 'script', 'description', 'abort_action', 'priority'],
    sys_script_include: ['name', 'script', 'description', 'client_callable', 'access'],
    sys_script_client: ['name', 'table', 'type', 'field_name', 'script', 'description', 'ui_type', 'isolate_script', 'applies_extended'],
    /* metadata tables: written ONLY via applyMeta (kind 'meta', create/append-only, fixed field sets in validateMeta) */
    sys_dictionary: [], sys_documentation: [], sys_choice: [], sys_ui_section: [], sys_ui_element: [], sys_ui_policy: [], sys_ui_policy_action: []
};
/* (live builder edits existing records). Inactive-by-default applies to NEW records only; an edit NEVER flips an existing
 * active record off. Removing something = an explicit deactivate (opts.remove), never a delete. Pure; node-tested (node test). */
/* AC-R1.10: the one update-set link shape, ^/sys_update_set\.do\?sys_id=[0-9a-f]{32}$ ('' for anything else). */
GMGAIApplier.usLink = function(id) { id = String(id || ''); return /^[0-9a-f]{32}$/.test(id) ? '/sys_update_set.do?sys_id=' + id : ''; };
GMGAIApplier.recordLink = function(table, id) {   // AC-R1.10 addendum: table from the stored proposal target only (never model text), checked against sys_db_object
    table = String(table || ''); id = String(id || '');
    if (!/^[a-z][a-z0-9_]{0,79}$/.test(table) || !/^[0-9a-f]{32}$/.test(id)) return '';
    try { if (!gs.tableExists(table)) return ''; } catch (e) { return ''; }   // scoped: the global-only table-descriptor API is not allowed in x_gmg_ai (threw -> '' live c9dbb47); gs.tableExists is the scoped sys_db_object check
    return '/' + table + '.do?sys_id=' + id;
};
GMGAIApplier.editSafeFields = function(fields, existingActive, opts) {
    var out = {}, dropped = [], off = function(v) { return v === false || v === 0 || /^(false|0)$/i.test(String(v)); };
    for (var k in (fields || {})) {
        if (!fields.hasOwnProperty(k)) continue;
        if (k == 'active' && existingActive && off(fields[k]) && !(opts && opts.remove)) { dropped.push(k); continue; }
        out[k] = fields[k];
    }
    return {fields: out, dropped: dropped};
};
/* build rule 6: one update set per build. Pure check of the build's recorded set (same rules as BuildItemService.setUsable). */
GMGAIApplier.buildSetUsable = function(us, scopeId, me) {
    if (!us) return 'no update set recorded';
    if (us.state != 'in progress') return 'the build\'s update set is ' + us.state;
    if (String(us.application) != String(scopeId)) return 'the build\'s update set is in another scope';
    if (String(us.created_by) != String(me)) return 'the build\'s update set belongs to another user';
    if (String(us.name || '').indexOf('GMG AI \u2013 ') != 0) return 'not a GMG AI update set';
    return '';
};


/* Pure (unit-tested): returns an error string when the session is not a real interactive user (system, empty or non-sys_id user id), else ''. */
GMGAIApplier.sessionGuard = function(userName, userId) {
    var n = String(userName == null ? '' : userName).trim().toLowerCase(), id = String(userId == null ? '' : userId).trim();
    if (!n || n == 'system' || !id || id.toLowerCase() == 'system' || !/^[0-9a-f]{32}$/.test(id))
        return 'Refused: changes are applied only when you click Accept in your own session. A background or system process cannot apply proposals (design C).';
    return '';
};
/* PREFRESTORE 2026-10-18 (approver rulings): apply snapshots the 4 update-set prefs (sys_update_set,
 * apps.current_app, updateSetForScopeglobal, updateSetForScope<app>) plus any other updateSetForScope* row, before any write, and
 * restores them in its finally block. Each scope's target is that scope's OWN snapshot; a pref missing before the Accept is set to that
 * scope's Default update set (never deleted, never emptied). Restore goes through GlideUpdateSet per scope (it caches and re-saves the
 * prefs itself), ending on the original app, then a direct-row pass, then a read-back. */
GMGAIApplier._PREF_Q = 'name=sys_update_set^ORname=apps.current_app^ORnameSTARTSWITHupdateSetForScope';
GMGAIApplier._readPrefs = function() {
    var out = {}, p = new GlideRecord('sys_user_preference');
    p.addQuery('user', gs.getUserID()); p.addEncodedQuery(GMGAIApplier._PREF_Q); p.query();
    while (p.next()) out[p.getValue('name')] = p.getValue('value');
    return out;
};
GMGAIApplier._prefKeys = function(app) {
    app = String(app || 'global');
    var k = ['sys_update_set', 'apps.current_app', 'updateSetForScopeglobal'];
    if (app != 'global') k.push('updateSetForScope' + app);
    return k;
};
GMGAIApplier._snapPrefs = function(app, scopes) {
    var out = {values: GMGAIApplier._readPrefs(), missing: [], app: String(app || 'global')}, k = GMGAIApplier._prefKeys(out.app), i;
    /* review (AC2): each scope the Accept may write to is added too, so a updateSetForScope<x> pref the Accept itself creates
     * (missing before) is restored to that scope's Default instead of being left on the AI set. */
    for (i = 0; scopes && i < scopes.length; i++) if (scopes[i] && k.indexOf('updateSetForScope' + scopes[i]) < 0) k.push('updateSetForScope' + scopes[i]);
    for (i = 0; i < k.length; i++) if (!out.values.hasOwnProperty(k[i])) out.missing.push(k[i]);
    return out;
};
/* Scopes an Accept can write to: 'global' (create paths and flows switch to global) and the target record's own sys_scope (update paths). Read-only. */
GMGAIApplier._targetScopes = function(actionId) {
    var out = ['global'];
    try {
        var pa = new GlideRecord('x_gmg_ai_pending_action');
        if (pa.get(actionId) && pa.getValue('target_table') && pa.getValue('target_sys_id')) {
            var tg = new GlideRecord(pa.getValue('target_table'));
            if (tg.isValid() && tg.get(pa.getValue('target_sys_id'))) { var sc = String(tg.getValue('sys_scope') || 'global'); if (out.indexOf(sc) < 0) out.push(sc); }
        }
        /* review D1: create paths (record :1188-1190, flow :1270-1273) switch to the payload's p.scope -> resolve it the same way. */
        var p = null; try { p = JSON.parse(pa.getValue('payload') || '{}'); } catch (ep) { p = null; }
        if (p && p.scope && p.scope != 'global') {
            var ps = new GlideRecord('sys_scope');
            if (ps.get('scope', p.scope)) { var pid = String(ps.getUniqueValue()); if (out.indexOf(pid) < 0) out.push(pid); }
        }
    } catch (e) { gs.warn('GMG AI: could not read the target scope for the prefs snapshot: ' + e); }
    return out;
};
GMGAIApplier._scopeDefault = function(scope) {   // the scope's Default update set (in effect when no set is pinned for it)
    var u = new GlideRecord('sys_update_set');
    u.addQuery('application', String(scope || 'global')); u.addQuery('is_default', true); u.setLimit(1); u.query();
    return u.next() ? String(u.getUniqueValue()) : '';
};
GMGAIApplier._scopeOfKey = function(n, app) {
    if (n.indexOf('updateSetForScope') == 0) return n.substring('updateSetForScope'.length);
    return n == 'sys_update_set' ? app : '';
};
/* Target value of every pref after the restore: the snapshot, or (missing before) the scope's Default. apps.current_app missing -> the app in effect. */
GMGAIApplier._restoreTargets = function(snap) {
    var t = {}, n, i;
    for (n in snap.values) if (snap.values.hasOwnProperty(n)) t[n] = snap.values[n];
    snap.nodefault = [];
    for (i = 0; i < snap.missing.length; i++) {
        n = snap.missing[i];
        var tv = n == 'apps.current_app' ? snap.app : GMGAIApplier._scopeDefault(GMGAIApplier._scopeOfKey(n, snap.app));
        if (tv === '') { snap.nodefault.push(n); continue; }   // review: scope has no Default -> no write (never empty), warned, log row error
        t[n] = tv;
    }
    return t;
};
/* The set to re-select for a scope: that scope's own snapshot pref (never the generic sys_update_set), else its Default. */
GMGAIApplier._prevSet = function(snap, scope) {
    scope = String(scope || snap.app || 'global');
    var v = snap.values['updateSetForScope' + scope], u = new GlideRecord('sys_update_set');
    if (v && u.get(v) && u.getValue('state') == 'in progress') return v;
    return GMGAIApplier._scopeDefault(scope);
};
GMGAIApplier._restorePrefs = function(snap, targets) {   // direct-row pass: updates only, no row is ever removed
    var t = targets || GMGAIApplier._restoreTargets(snap);
    try {
        var p = new GlideRecord('sys_user_preference');
        p.addQuery('user', gs.getUserID()); p.addEncodedQuery(GMGAIApplier._PREF_Q); p.query();
        while (p.next()) {
            var n = p.getValue('name');
            if (!t.hasOwnProperty(n)) continue;   // only a no-Default row (warned + error via _backstop); every other row has a target
            if (p.getValue('value') != t[n]) { p.setValue('value', t[n]); p.update(); }
        }
    } catch (e) { gs.warn('GMG AI: could not restore update set preferences: ' + e); }
};
/* review 2/B backstop: any updateSetForScope* row the Accept created that _targetScopes did not predict gets its scope's
 * Default as target (never deleted, never emptied); no Default -> left unchanged, WARN, error (it exists after the Accept). */
GMGAIApplier._backstop = function(snap, t) {
    snap.backstop = []; snap.nodefault = snap.nodefault || [];
    var cur = GMGAIApplier._readPrefs(), n, d;
    for (n in cur) {
        if (!cur.hasOwnProperty(n) || n.indexOf('updateSetForScope') != 0 || t.hasOwnProperty(n) || snap.nodefault.indexOf(n) >= 0) continue;
        d = GMGAIApplier._scopeDefault(n.substring('updateSetForScope'.length));
        if (d) { t[n] = d; snap.backstop.push(n); } else snap.nodefault.push(n);
    }
};
/* Full restore: GlideUpdateSet per scope (other scopes first, the original app last), direct-row pass, read-back. */
GMGAIApplier._restoreAll = function(snap) {
    var t = GMGAIApplier._restoreTargets(snap), app = snap.app, n, s, scopes = [];
    GMGAIApplier._backstop(snap, t);
    for (n in t) if (t.hasOwnProperty(n) && n.indexOf('updateSetForScope') == 0) { s = n.substring('updateSetForScope'.length); if (s != app) scopes.push(s); }
    scopes.push(app);
    for (var i = 0; i < scopes.length; i++) {
        var us = t['updateSetForScope' + scopes[i]];
        try { gs.setCurrentApplicationId(scopes[i]); if (us) new GlideUpdateSet().set(us); } catch (e1) { gs.warn('GMG AI: GlideUpdateSet restore ' + scopes[i] + ': ' + e1); }
    }
    try { gs.setCurrentApplicationId(app); } catch (e2) {}
    /* set() also re-pins the generic sys_update_set (and apps.current_app) in the session copy; savePreference updates that same session
     * copy, so the end-of-transaction re-save writes the snapshot values, not the last set() call. */
    try { var u = gs.getUser(); for (n in t) if (t.hasOwnProperty(n)) u.savePreference(n, t[n]); } catch (e3) { gs.warn('GMG AI: savePreference restore: ' + e3); }
    GMGAIApplier._restorePrefs(snap, t);
    var after = GMGAIApplier._readPrefs(), keys = GMGAIApplier._prefKeys(app), before = {}, aft = {}, mismatch = [], nd = snap.nodefault || [], unres = [];
    var extra = snap.missing.concat(snap.backstop || [], nd);
    for (var m = 0; m < extra.length; m++) if (keys.indexOf(extra[m]) < 0) keys.push(extra[m]);
    for (var j = 0; j < keys.length; j++) {
        n = keys[j];
        before[n] = snap.values.hasOwnProperty(n) ? snap.values[n] : null;
        aft[n] = after.hasOwnProperty(n) ? after[n] : null;
        var absentOk = aft[n] === null && before[n] === null;   // missing before and still missing: nothing pinned, nothing to fix
        /* review 2: no Default -> left unchanged, always a WARN; an error only if the pref EXISTS after the Accept (it could not be
         * set to a target). Missing before and still missing: nothing created, warning only, row stays ok. */
        if (nd.indexOf(n) >= 0) { if (aft[n] !== null) unres.push(n); continue; }
        if (!absentOk && aft[n] != t[n]) mismatch.push(n);
    }
    return {before: before, target: t, after: aft, missing: snap.missing.slice(0), backstop: (snap.backstop || []).slice(0), mismatch: mismatch, warnings: nd.slice(0), unrestorable: unres, ok: mismatch.length == 0 && unres.length == 0};
};
GMGAIApplier.prefLine = function(pr) {   // one log line for the Accept row (AC3)
    if (!pr) return '[prefs] not recorded';
    var k = Object.keys(pr.before), a = [];
    for (var i = 0; i < k.length; i++) a.push(k[i] + ' ' + (pr.before[k[i]] === null ? '(none)' : pr.before[k[i]]) + ' -> ' + (pr.after[k[i]] === null ? '(none)' : pr.after[k[i]]));
    var w = pr.warnings && pr.warnings.length ? ' WARN no Default update set for ' + pr.warnings.join(',') + ' (left unchanged)' : '';
    return '[prefs' + (pr.mismatch && pr.mismatch.length ? ' MISMATCH ' + pr.mismatch.join(',') : '') + w + '] ' + a.join('; ');
};
/* architecture review ownership ruling: only the card's owner or an admin may apply it; anyone else gets 409 before anything is read or written. */
GMGAIApplier.NOT_OWNER = 'This change belongs to another user, so it can\u2019t be applied.';
GMGAIApplier.ownerCheck = function(actionId) {
    var pa = new GlideRecord('x_gmg_ai_pending_action'); pa.setWorkflow(false);   // read-only, BRs off for this read: the owner field decides (a foreign card -> 409, not a filtered-out 404)
    if (!actionId || !pa.get(actionId)) return {ok: false, code: 404, error: 'Action not found'};
    if (String(pa.getValue('user')) === String(gs.getUserID()) || gs.hasRole('admin') === true) return null;
    return {ok: false, code: 409, error: GMGAIApplier.NOT_OWNER};
};
GMGAIApplier.metaTables = function(t) { return String(new TableUtils(t).getTables()).replace(/[\[\]\s]/g, '').split(','); };

/* ---- read tools ---- */
/* update set name + description. Pure builder (unit-tested offline): o = {ref, summary, user, tag, max, sep, cap, minTitle,
 * pending_action, action_type, conversation, what}. Name "GMG AI – [<tag>] – <ref> – <title> – <user>"; title trimmed first (>= minTitle), user cut
 * to cap with an ellipsis; prefix, ref and tag never trimmed; o.tag is a label string ('' = untagged, the open source default, see qaTag); ticket-like tokens (ABC-123) stripped from the title. Description: one "key: value" per line. */
GMGAIApplier.buildUpdateSetName = function(o) {
    var sep = o.sep || ' \u2013 ', cap = o.cap || 20, minT = o.minTitle || 12, max = o.max || 80, E = '\u2026';
    var user = String(o.user || ''); if (user.length > cap) user = user.substring(0, cap - 1) + E;
    var title = String(o.summary || o.what || '').replace(/\b[A-Z][A-Z0-9]{1,9}-\d+\b/g, '').replace(/^gmg ai\s*[\u2013-]\s*/i, '').replace(/\s+/g, ' ').replace(/^[\s\u2013:,-]+|[\s\u2013:,-]+$/g, '');
    if (!title) title = String(o.what || 'change');
    var head = 'GMG AI' + sep + (GMGAIApplier.tagOk(o.tag) ? '[' + o.tag + ']' + sep : '') + String(o.ref || '') + sep, tail = sep + user;
    var room = max - head.length - tail.length;
    if (room < minT) { var keepU = Math.max(1, max - head.length - minT - sep.length - 1); if (user.length > keepU) user = user.substring(0, keepU) + E; tail = sep + user; room = max - head.length - tail.length; }
    if (title.length > room) title = title.substring(0, Math.max(room - 1, 1)).replace(/\s+$/, '') + E;
    var name = (head + title + tail).substring(0, max);
    var d = ['pending_action: ' + (o.pending_action || ''), 'owner: ' + String(o.user || ''), 'action_type: ' + (o.action_type || ''), 'conversation: ' + (o.conversation || '')];
    if (GMGAIApplier.tagOk(o.tag)) d.push(o.tag + ': true');
    d.push('created_by: GMG AI Agent'); d.push('Created by GMG AI Agent for pending action ' + (o.pending_action || '') + ' (' + (o.what || '') + ').');
    return {name: name, description: d.join('\n')};
};
/* tag rule: ONLY the requester user_name prefix from x_gmg_ai.qa.update_set_markers (default empty = nobody is a QA user; step 10 ruling 4). Never the summary, prompt or payload. */
GMGAIApplier.isQaUser = function(user, markers) {
    var m = String(markers === undefined ? gs.getProperty('x_gmg_ai.qa.update_set_markers', '') : markers).split(',').map(function(x) { return x.trim().toLowerCase(); }).filter(String);
    user = String(user || '').toLowerCase(); return m.some(function(x) { return user.indexOf(x) == 0; });
};
/* os-cleanup 2026-10-20 (Legal audit MEDIUM): no built-in test tag. The update-set tag label comes only from x_gmg_ai.qa.update_set_tag
 * (not shipped in open source; missing or empty = no tag), and applies only to requesters matched by isQaUser. Label: 1-20 of [a-z0-9-]. */
GMGAIApplier.tagOk = function(t) { return typeof t == 'string' && /^[a-z0-9-]{1,20}$/.test(t); };
GMGAIApplier.qaTag = function(user) { var t = String(gs.getProperty('x_gmg_ai.qa.update_set_tag', '') || '').trim().toLowerCase(); return GMGAIApplier.tagOk(t) && GMGAIApplier.isQaUser(user) ? t : ''; };
/* exact line-anchored token match in a description (never a substring CONTAINS on arbitrary text) */
GMGAIApplier.hasLine = function(desc, line) { return String(desc || '').split(/\r?\n/).some(function(l) { return l.replace(/\s+$/, '') === line; }); };
/* The ONE update-set name/description builder (static so a card can show it before Accept). Requester = the confirming user
 * (Confirm is requester-only), so the name previewed at propose time for the requester is the name Accept creates. */
GMGAIApplier.updateSetNameFor = function(pa, what, actionId) {
    var me = gs.getUserName(), P = function(n, d) { return gs.getProperty(n, d); };
    return GMGAIApplier.buildUpdateSetName({ref: String(actionId || '').substring(0, 8), summary: pa ? pa.getValue('summary') : '', what: what, user: me,
        tag: GMGAIApplier.qaTag(me), max: GMGAIApplier.updateSetNameMax(), sep: P('x_gmg_ai.update_set.separator', ' \u2013 '),
        cap: parseInt(P('x_gmg_ai.update_set.requester_cap', '20'), 10) || 20, minTitle: parseInt(P('x_gmg_ai.update_set.min_title', '12'), 10) || 12,
        pending_action: actionId, action_type: pa ? pa.getValue('action_type') : '', conversation: pa ? pa.getValue('conversation_id') : ''});
};
GMGAIApplier.updateSetNameMax = function() {
    var d = new GlideRecord('sys_dictionary'); d.addQuery('name', 'sys_update_set'); d.addQuery('element', 'name'); d.setLimit(1); d.query();
    var n = d.next() ? parseInt(d.getValue('max_length'), 10) : NaN; return n > 0 ? n : 80;
};

/* ===== Record (data) tools: journal + resolution. Data writes: NO update set, cannot be backed out; journal entries are permanent. ===== */
GMGAIApplier.REC = {JOURNAL_MAX: 2000, TEXT_MAX: 4000, NOTES_MAX: 4000, RESOLVED: {incident: '6'}};
GMGAIApplier.recTarget = function(table, id, sec) {
    table = String(table || '').trim(); id = String(id || '').trim();
    if (!/^[a-z][a-z0-9_]{1,79}$/.test(table) || /^(sys_|v_|ts_|syslog|x_gmg_ai)/.test(table)) return {error: 'table not allowed: ' + table};
    var g = new GlideRecord(table); if (!g.isValid()) return {error: 'table ' + table + ' does not exist'};
    if (!g.isValidField('work_notes') || !g.isValidField('comments')) return {error: table + ' has no work_notes / comments journal (task tables only)'};
    var r = sec === false ? new GlideRecord(table) : new GlideRecordSecure(table);
    if (!/^[0-9a-f]{32}$/.test(id) || !r.get(id)) {   // allow a number too
        r = sec === false ? new GlideRecord(table) : new GlideRecordSecure(table); r.addQuery('number', id); r.query();
        if (!r.next()) return {error: 'Record not found or not readable: ' + table + ' ' + id};
    }
    return {gr: r, table: table, sys_id: r.getUniqueValue(), number: r.getValue('number') || '', display: r.getDisplayValue() || r.getValue('number')};
};
GMGAIApplier.journalCount = function(table, id, field) {
    var c = new GlideAggregate('sys_journal_field'); c.addQuery('name', table); c.addQuery('element_id', id); c.addQuery('element', field); c.addAggregate('COUNT'); c.query();
    return c.next() ? parseInt(c.getAggregate('COUNT'), 10) : 0;
};
GMGAIApplier.closeCodes = function(table) {
    var tabs = GMGAIApplier.metaTables(table), out = [], seen = {};
    var c = new GlideRecord('sys_choice'); c.addQuery('name', 'IN', tabs.join(',')); c.addQuery('element', 'close_code'); c.addQuery('inactive', false); c.addQuery('language', 'en'); c.orderBy('sequence'); c.query();
    while (c.next()) if (!seen[c.getValue('value')]) { seen[c.getValue('value')] = 1; out.push({value: c.getValue('value'), label: c.getValue('label')}); }
    return out;
};
/* tell a missing field from one the user can't see. Existence is a metadata-only check on a PLAIN GlideRecord (isValidField; no
 * query, no record data). Access comes only from the user's GlideRecordSecure g: a null element or canRead()/canWrite() false = no access. */
GMGAIApplier.fieldAccess = function(g, table, field) {
    var meta = new GlideRecord(table);
    if (!meta.isValid() || !meta.isValidField(field)) return {missing: true, canRead: false, canWrite: false};
    var fe = g.getElement(field);
    if (fe == null) return {missing: false, canRead: false, canWrite: false};   // null test, not truthiness (an empty journal element is falsy but present)
    var r = typeof fe.canRead == 'function' ? !!fe.canRead() : true;
    return {missing: false, canRead: r, canWrite: r && !!fe.canWrite()};
};
/* ACL fix: the Confirm-time user ACL check, run HERE in global scope as the session user. From x_gmg_ai, GlideRecordSecure.canWrite
 * on a global table also applies that table's Application Access for other scopes (sc_cat_item: update_access=false, create_access=false), so it
 * is false even for admin. This check is the user's own ACLs only, the same ones the global Applier write honours. ops: [{table, sys_id?, op}] */
GMGAIApplier.CALLER_SCOPE = 'x_gmg_ai';
/* Scope lock. Accepts x_gmg_ai, and with allowGlobal also 'global' / 'rhino.global'. Global is accepted because the Applier calls its own
 * helpers at Confirm (apply -> applyCatalogItemEdit -> _userAccess), and those nested calls report 'rhino.global'. Accepting global grants
 * nothing new: global code is already unrestricted, and only admins can write it. Every other scoped app is refused.
 * Known limit (CLEANUP.md): an admin-written global SI that forwards calls could relay another scope through; accepted for v1. */
GMGAIApplier._callerOk = function(allowGlobal, caller) {   // scope lock: other scoped apps can't call the ACL helpers directly (global code is already unrestricted)
    /* caller MUST be gs.getCallerScopeName() read in the entry point's own body: read in here it is always this script's own scope
     * ('rhino.global'; verified live 2026-10-16 with a since-removed diagnostic route), which would make the lock a no-op. */
    var c = String(caller || ''); return c == GMGAIApplier.CALLER_SCOPE || (!!allowGlobal && (c == 'global' || c == 'rhino.global'));
};
GMGAIApplier.userAccess = function(ops) {   // server-side only (this SI is not client_callable); reachable only from the x_gmg_ai scope
    var caller = String(gs.getCallerScopeName() || '');
    if (!GMGAIApplier._callerOk(false, gs.getCallerScopeName())) return {ok: false, reason: 'userAccess may only be called from ' + GMGAIApplier.CALLER_SCOPE + ' (caller: ' + (caller || 'unknown') + ')'};
    return GMGAIApplier._userAccess(ops);
};
GMGAIApplier._userAccess = function(ops) {   // GlideRecordSecure only, as the session user; no plain GlideRecord, no impersonation; never throws
    if (!GMGAIApplier._callerOk(true, gs.getCallerScopeName())) return {ok: false, reason: 'the permission check may only be called by the GMG AI Agent'};   // x_gmg_ai, or the Applier itself (global)
    var label = function(g, o) { var n = ''; try { n = g.getDisplayValue() || g.getValue('name') || ''; } catch (e) {} return n ? '"' + n + '"' : (o.name ? '"' + o.name + '"' : 'this record'); };
    var what = {sc_cat_item: 'catalog item', item_option_new: 'variable'};
    try {
        for (var i = 0; i < (ops || []).length; i++) {
            var o = ops[i] || {}, kind = what[o.table] || String(o.table || ''), g = new GlideRecordSecure(String(o.table || ''));
            if (!g.isValid()) return {ok: false, reason: 'invalid table ' + o.table};
            if (o.item && o.name) { g.addQuery('cat_item', o.item); g.addQuery('name', o.name); g.query(); while (g.next()) if (!g.canWrite()) return {ok: false, reason: 'you cannot edit the ' + kind + ' "' + o.name + '"'}; continue; }
            if (o.sys_id) {
                if (!g.get(o.sys_id)) return {ok: false, reason: 'the ' + kind + ' was not found or you cannot read it'};
                if (o.op == 'write' && !g.canWrite()) return {ok: false, reason: 'you cannot edit the ' + kind + ' ' + label(g, o)};
                if (o.op == 'write' && o.write_fields) for (var wi = 0; wi < o.write_fields.length; wi++) { var wf = GMGAIApplier.fieldAccess(g, String(o.table), String(o.write_fields[wi])); if (wf.missing) return {ok: false, reason: 'unknown field ' + o.write_fields[wi] + ' on ' + o.table, unknown_fields: [o.write_fields[wi]]}; if (!wf.canWrite) return {ok: false, reason: 'you cannot write ' + o.write_fields[wi] + ' on ' + label(g, o), not_allowed_fields: [o.write_fields[wi]]}; }   // step 6: field ACLs on artifact edits
                continue;
            }
            g.initialize(); var pf = o.fields || {}; for (var fk in pf) g.setValue(fk, pf[fk]);   // parent fields (item_option_new.cat_item) set before canCreate
            if (!g.canCreate()) { var par = ''; if (pf.cat_item) { var ci = new GlideRecordSecure('sc_cat_item'); if (ci.get(pf.cat_item)) par = ' on ' + label(ci, {}); } return {ok: false, reason: 'you cannot add a ' + kind + par}; }
        }
        return {ok: true};
    } catch (e) { return {ok: false, reason: 'the permission check failed (' + String(e).substring(0, 160) + ')'}; }
};
/* ---------- Open-core split step 6: current-record write (open source) ----------
 * approvers 2026-10-18: no artifact allowlist. Any open record the user can write, except the hard floor below; system fields
 * blocked server-side; every other field goes through validation and field ACLs. Routing by table structure: a table extending sys_metadata
 * takes artifact edit (GMG AI update set), everything else the record path. Step 9 adds the property x_gmg_ai.opensource.denied_tables (admins add,
 * never shrink) and the security_admin exception for the ACL/role tables; until then those are denied for everyone, admin included. */
GMGAIApplier.DENY_EXACT = ['sys_alias', 'oauth_credential', 'token_auth_credential', 'inbound_auth_profile', 'sys_ca_certificate', 'sys_user_certificate', 'sys_certificate'];
GMGAIApplier.DENY_PATTERNS = ['x_gmg_ai_*', 'jwt_*', '*_credentials', '*credential*', 'sys_auth_profile*', 'oauth_entity*'];
GMGAIApplier.ACL_ROLE_TABLES = ['sys_security_acl', 'sys_security_acl_role', 'sys_user_role', 'sys_user_has_role', 'sys_user_role_contains', 'sys_group_has_role'];   // sys_group_has_role VERIFIED live 2026-10-18 4:15 PM CT (sys_db_object 13103a73, label Group Role)
GMGAIApplier.globMatch = function(pat, t) { return new RegExp('^' + String(pat).replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$').test(t); };
/* Step 9: x_gmg_ai.opensource.denied_tables (comma list, exact names or * wildcards) ADDS to the floor; it can never remove a floor entry. */
GMGAIApplier.DENY_PROP = 'x_gmg_ai.opensource.denied_tables';
GMGAIApplier.ELEVATION_PROP = 'x_gmg_ai.opensource.acl_elevation_exception';   // default false: the security_admin exception stays OFF until both live checks pass
GMGAIApplier.ELEVATE_MSG = 'Elevate to security_admin to edit ACL or role records.';
GMGAIApplier.ELEVATED_NOTE = 'You are elevated to security_admin.';
/* step 9 fix (architecture review): property MISSING (null) or empty = no extra entries (the floor still applies); present but unparseable = null
 * (caller refuses everything). Valid entry: [a-z0-9_*], 1-80 chars, after trim + lower-case; empty items between commas are ignored. */
GMGAIApplier.parseDenied = function(raw) {
    if (raw === null || raw === undefined) return [];
    var items = String(raw).split(','), out = [], i, x;
    for (i = 0; i < items.length; i++) { x = items[i].replace(/^\s+|\s+$/g, '').toLowerCase(); if (!x) continue; if (!/^[a-z0-9_*]{1,80}$/.test(x)) return null; out.push(x); }
    return out;
};
GMGAIApplier.DENY_MALFORMED = 'The denylist setting x_gmg_ai.opensource.denied_tables cannot be read, so the agent changes nothing until an admin fixes it.';
/* Pure decision. o: {extra: [patterns], exception: bool (property on), elevated: bool (session check)}. '' = allowed; else the refusal. */
GMGAIApplier.deniedTableWith = function(table, o) {
    o = o || {}; var t = String(table || '').toLowerCase(), i, ex = o.extra || [];
    if (!/^[a-z][a-z0-9_]{0,79}$/.test(t)) return 'That page is not a record table.';
    if (GMGAIApplier.DENY_EXACT.indexOf(t) >= 0) return 'Credential and key records (' + t + ') can never be changed by the agent.';
    for (i = 0; i < GMGAIApplier.DENY_PATTERNS.length; i++) if (GMGAIApplier.globMatch(GMGAIApplier.DENY_PATTERNS[i], t))
        return t.indexOf('x_gmg_ai') == 0 ? 'GMG AI configuration records (' + t + ') can never be changed by the agent.' : 'Credential and key records (' + t + ') can never be changed by the agent.';
    for (i = 0; i < ex.length; i++) if (GMGAIApplier.globMatch(ex[i], t)) return 'Your administrator has blocked agent changes to ' + t + ' (' + GMGAIApplier.DENY_PROP + ').';
    if (GMGAIApplier.ACL_ROLE_TABLES.indexOf(t) >= 0) {
        if (!o.exception) return 'ACL and role records (' + t + ') cannot be changed by the agent.';
        return o.elevated === true ? '' : GMGAIApplier.ELEVATE_MSG;
    }
    return '';
};
GMGAIApplier.isAclRoleTable = function(t) { return GMGAIApplier.ACL_ROLE_TABLES.indexOf(String(t || '').toLowerCase()) >= 0; };
/* Step 9, UNVERIFIED: is security_admin ACTIVE in this session through elevation? gs.hasRole alone must not count
 * (it is true for any admin through the admin override). Elevation-specific source: the session's active role list from
 * GlideSecurityManager.get().getRoles() (global; lists an elevated role only while elevated, community-reported, ServiceNow docs
 * c_ElevatedPrivilege: elevated roles exist only for the session after manual elevation), AND gs.hasRoleExactly('security_admin')
 * (no admin override). Both must be true; any error = false (fail closed). Read only: the app never elevates for the user. */
GMGAIApplier.sessionRoles = function() { try { return String(GlideSecurityManager.get().getRoles() || '').replace(/[\[\]\s]/g, '').split(','); } catch (e) { return []; } };
GMGAIApplier.securityAdminElevated = function() {
    try { return GMGAIApplier.sessionRoles().indexOf('security_admin') >= 0 && gs.hasRoleExactly('security_admin') === true; } catch (e) { return false; }
};
GMGAIApplier.deniedTable = function(table) {   // live inputs; '' = allowed. One definition (RecordTools via the facade, Confirm re-runs it).
    var t = String(table || '').toLowerCase(), acl = GMGAIApplier.isAclRoleTable(t), exc = false, elev = false, extra = [];
    try { extra = GMGAIApplier.parseDenied(gs.getProperty(GMGAIApplier.DENY_PROP, null)); exc = String(gs.getProperty(GMGAIApplier.ELEVATION_PROP, 'false')) == 'true'; } catch (e) { extra = null; exc = false; }
    if (extra === null) return GMGAIApplier.DENY_MALFORMED;   // fail closed: present but unparseable (or unreadable) -> refuse every table
    if (acl && exc) elev = GMGAIApplier.securityAdminElevated();
    return GMGAIApplier.deniedTableWith(t, {extra: extra, exception: exc, elevated: elev});
};
/* Open-core split step 8 (spec 5, product decision): active code is editable by default, with a live-change warning; Confirm re-reads 'active'
 * (changed either way -> 409 state_changed, card shown again); never sets active=true; opt-in x_gmg_ai.opensource.refuse_active_script_edits (default false). */
GMGAIApplier.LIVE_WARNING = 'This script is active. Your change goes live when you confirm.';
GMGAIApplier.INACTIVE_NOTE = 'This record is inactive. Your change is saved but does not run until it is activated.';
GMGAIApplier.STATE_CHANGED = 'This record was activated or deactivated since the card was made. Check the warning and confirm again.';
GMGAIApplier.REFUSE_ACTIVE_PROP = 'x_gmg_ai.opensource.refuse_active_script_edits';
GMGAIApplier.REFUSE_ACTIVE_MSG = 'This instance does not allow the agent to edit active code (x_gmg_ai.opensource.refuse_active_script_edits). Deactivate it first or edit it yourself.';
GMGAIApplier.activeOf = function(g) { if (!g.isValidField('active')) return ''; var a = String(g.getValue('active')); return a == '1' || a == 'true' ? 'true' : 'false'; };   // '' = no active field
GMGAIApplier.refuseActive = function(getProp) { return String(getProp(GMGAIApplier.REFUSE_ACTIVE_PROP, 'false')) == 'true'; };
GMGAIApplier.activeNote = function(state) { return state == 'true' ? GMGAIApplier.LIVE_WARNING : state == 'false' ? GMGAIApplier.INACTIVE_NOTE : ''; };
GMGAIApplier.systemField = function(f) { f = String(f || ''); return /^sys_/.test(f) || f == 'number'; };   // sys_id, sys_class_name, sys_domain, sys_created_*, sys_updated_*, sys_mod_count...
GMGAIApplier.isMetadataTable = function(table) { try { return GMGAIApplier.metaTables(table).indexOf('sys_metadata') >= 0; } catch (e) { return false; } };
/* Propose + Confirm validation of a field write on ONE existing record (GlideRecordSecure, as the user). a: {table, sys_id, fields:{}, journal?:{field, text}}. */
/* a multi-line field (script, condition, html...) shows a line diff on the card instead of one huge
 * 'field: whole before -> whole after' line. Common prefix/suffix lines are trimmed, the middle is matched line by line (LCS, up to
 * LINE_DIFF_LCS lines a side; beyond that the middle is shown as removed/added). Each hunk: a note row 'field, line N:' then
 * interleaved '-old' / '+new' lines (the card's changeRows pairs them as before -> after rows). Unchanged lines are not shown.
 * Display text only: the payload, Confirm and the seal are unchanged (the seal hashes whatever diff is stored). */
GMGAIApplier.LINE_DIFF_LCS = 400; GMGAIApplier.LINE_DIFF_MAX = 300; GMGAIApplier.LINE_DIFF_CHARS = 40000;   // diff column is 65000
GMGAIApplier.lineDiff = function(field, before, after) {
    var A = String(before == null ? '' : before).split('\n'), B = String(after == null ? '' : after).split('\n');
    var p = 0, sa, sb, i, j;
    while (p < A.length && p < B.length && A[p] === B[p]) p++;
    sa = A.length; sb = B.length;
    while (sa > p && sb > p && A[sa - 1] === B[sb - 1]) { sa--; sb--; }
    var a = A.slice(p, sa), b = B.slice(p, sb), ops = [];   // ops: ['=', text] | ['-', text] | ['+', text]
    if (a.length && b.length && a.length <= GMGAIApplier.LINE_DIFF_LCS && b.length <= GMGAIApplier.LINE_DIFF_LCS) {
        var n = a.length, m = b.length, L = [];
        for (i = 0; i <= n; i++) { L.push([]); for (j = 0; j <= m; j++) L[i].push(0); }
        for (i = n - 1; i >= 0; i--) for (j = m - 1; j >= 0; j--) L[i][j] = a[i] === b[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
        i = 0; j = 0;
        while (i < n && j < m) {
            if (a[i] === b[j]) { ops.push(['=', a[i]]); i++; j++; }
            else if (L[i + 1][j] >= L[i][j + 1]) ops.push(['-', a[i++]]);
            else ops.push(['+', b[j++]]);
        }
        while (i < n) ops.push(['-', a[i++]]);
        while (j < m) ops.push(['+', b[j++]]);
    } else {
        for (i = 0; i < a.length; i++) ops.push(['-', a[i]]);
        for (j = 0; j < b.length; j++) ops.push(['+', b[j]]);
    }
    var show = function(t) { return t === '' ? '(blank line)' : t; };
    var out = [], changed = 0, emitted = 0, chars = 0, lineNo = p + 1, k = 0;
    var full = function() { return emitted >= GMGAIApplier.LINE_DIFF_MAX || chars >= GMGAIApplier.LINE_DIFF_CHARS; };
    while (k < ops.length) {
        if (ops[k][0] == '=') { lineNo++; k++; continue; }
        var rem = [], add = [], at = lineNo;
        while (k < ops.length && ops[k][0] != '=') { if (ops[k][0] == '-') rem.push(ops[k][1]); else { add.push(ops[k][1]); lineNo++; } k++; }
        changed += Math.max(rem.length, add.length);
        if (full()) continue;
        out.push(field + ', line ' + at + ':');
        for (i = 0; i < Math.max(rem.length, add.length) && !full(); i++) {
            if (i < rem.length) { out.push('-' + show(rem[i])); emitted++; chars += rem[i].length + 2; }
            if (i < add.length) { out.push('+' + show(add[i])); emitted++; chars += add[i].length + 2; }
        }
    }
    if (full()) out.push('(diff cut at ' + emitted + ' lines)');
    out.unshift(field + ': ' + changed + ' changed line' + (changed == 1 ? '' : 's') + ' (' + A.length + ' lines before, ' + B.length + ' after)');
    return out;
};
GMGAIApplier.validateFieldWrite = function(a) {
    a = a || {};
    var table = String(a.table || ''), id = String(a.sys_id || ''), dn = GMGAIApplier.deniedTable(table);
    if (dn) return GMGAIApplier.isAclRoleTable(table) ? {error: dn, denied: true, acl: true, code: 409} : {error: dn, denied: true};   // step 9: an ACL/role table refused at Confirm = elevation dropped -> 409
    if (!/^[0-9a-f]{32}$/.test(id)) return {error: 'No saved record is open (new or unsaved form).'};
    var g = new GlideRecordSecure(table);
    if (!g.isValid() || !g.get(id)) return {error: 'Record not found or you cannot read it.'};
    if (!g.canWrite()) return {error: 'You cannot update this record (no write access).', no_access: true};
    var meta = GMGAIApplier.isMetadataTable(table), fields = a.fields || {}, out = {table: table, sys_id: id, display: g.getDisplayValue() || g.getValue('number') || id,
        number: g.getValue('number') || '', updated_on: g.getValue('sys_updated_on'), mod_count: g.getValue('sys_mod_count'), metadata: meta, fields: {}, before: {}, diff: [], active: meta ? GMGAIApplier.activeOf(g) : ''};
    if (out.active == 'true' && GMGAIApplier.refuseActive(function(n, d) { return gs.getProperty(n, d); })) return {error: GMGAIApplier.REFUSE_ACTIVE_MSG, refused_active: true};   // step 8 opt-in
    var n = 0, k, sysf = [];
    for (k in fields) if (fields.hasOwnProperty(k) && GMGAIApplier.systemField(k)) sysf.push(k);
    if (sysf.length) return {error: 'System fields are never changed by the agent: ' + sysf.join(', ')};
    for (k in fields) {
        if (!fields.hasOwnProperty(k)) continue;
        var fa = GMGAIApplier.fieldAccess(g, table, k);
        if (fa.missing) return {error: 'Field ' + k + ' not found on ' + table};
        if (!fa.canWrite) return {error: 'You cannot write ' + k + ' on this record (field ACL).', no_access: true};
        var v = fields[k] == null ? '' : String(fields[k]);
        if (k == 'active' && meta && /^(true|1)$/i.test(v)) return {error: 'The agent never sets active=true on a code or configuration record. Activate it yourself.'};
        if (k == 'script' || /(^|_)script$/.test(k)) { try { new Function(v); } catch (e) { return {error: 'Syntax error in ' + k + ': ' + String(e && e.message || e)}; } }
        out.fields[k] = v; out.before[k] = g.getValue(k) == null ? '' : String(g.getValue(k));
        if (out.before[k] != v) {
            if (/\n/.test(out.before[k] + v)) out.diff = out.diff.concat(GMGAIApplier.lineDiff(k, out.before[k], v));   // line diff for multi-line fields
            else out.diff.push(k + ': ' + (g.getDisplayValue(k) || out.before[k] || '(empty)') + ' -> ' + v);
        }
        n++;
    }
    if (a.journal && a.journal.text) {
        var jf = String(a.journal.field || 'work_notes'); if (jf != 'work_notes' && jf != 'comments') return {error: 'journal field must be work_notes or comments'};
        var ja = GMGAIApplier.fieldAccess(g, table, jf);
        if (ja.missing) return {error: 'This record has no ' + jf + ' journal.'};
        if (!ja.canWrite) return {error: 'You cannot write ' + jf + ' on this record (field ACL).', no_access: true};
        var jt = String(a.journal.text).trim(); if (jt.length > GMGAIApplier.REC.TEXT_MAX) return {error: 'journal text too long'};
        out.journal = {field: jf, text: jt}; out.diff.push('+ ' + (jf == 'comments' ? 'Additional comments (customer visible)' : 'Work notes (internal)') + ': ' + jt);
        if (meta) return {error: 'Journal entries go on data records, not code or configuration records.'};
        n++;
    }
    if (!n) return {error: 'Nothing to change.'};
    if (GMGAIApplier.isAclRoleTable(table)) out.elevated_note = GMGAIApplier.ELEVATED_NOTE;   // step 9: allowed only while elevated (deniedTable above)
    return out;
};
/* validation for both record writes (propose + Confirm). sec=true at propose (user ACL read), Confirm re-reads as the user too. */
GMGAIApplier.validateRecordWrite = function(kind, a) {
    a = a || {};
    var T = GMGAIApplier.recTarget(a.table, a.sys_id, true); if (T.error) return T;
    var g = T.gr, out = {kind: kind, table: T.table, sys_id: T.sys_id, number: T.number, display: T.display, updated_on: g.getValue('sys_updated_on'), diff: [], spec: {table: T.table, sys_id: T.sys_id}};
    if (!g.canWrite()) return {error: 'You cannot update ' + T.table + ' ' + (T.number || T.sys_id) + ' (no write access)', no_access: true};
    if (kind == 'journal') {
        var f = String(a.field || 'work_notes'); if (f != 'work_notes' && f != 'comments') return {error: 'field must be work_notes or comments'};
        var fa = GMGAIApplier.fieldAccess(g, T.table, f);   // a secure getElement is null when the user can't read the field
        if (fa.missing) return {error: 'Field ' + f + ' not found on ' + T.table};
        if (!fa.canRead || !fa.canWrite) return {error: 'You cannot ' + (!fa.canRead ? 'read or write' : 'write') + ' ' + f + ' on ' + (T.number || T.sys_id) + ' (field exists; no access by ACL). Ask your ServiceNow admin for access, or add the note yourself on the form.', no_access: true, field_exists: true};
        var t = String(a.text || '').trim(); if (!t) return {error: 'text is required'}; if (t.length > GMGAIApplier.REC.TEXT_MAX) return {error: 'text is longer than ' + GMGAIApplier.REC.TEXT_MAX + ' characters'};
        out.spec.field = f; out.spec.text = t; out.customer_visible = f == 'comments';
        out.title = (f == 'comments' ? 'Customer-visible comment on ' : 'Work note on ') + (T.number || T.display);
        out.diff.push('+ ' + (f == 'comments' ? 'Additional comments (customer visible)' : 'Work notes (internal)') + ' on ' + T.table + ' ' + (T.number || T.sys_id) + ':');
        t.split('\n').forEach(function(l) { out.diff.push('  ' + l); });
        return out;
    }
    if (kind == 'resolution') {
        if (!g.isValidField('close_code') || !g.isValidField('close_notes')) return {error: T.table + ' has no close_code / close_notes'};
        var codes = GMGAIApplier.closeCodes(T.table), cc = String(a.close_code || '').trim(), hit = null;
        codes.forEach(function(c) { if (c.value == cc || c.label.toLowerCase() == cc.toLowerCase()) hit = c; });
        if (!hit) return {error: 'close_code "' + cc + '" is not a valid choice. Valid: ' + codes.map(function(c) { return c.value; }).join(', ')};
        var cn = String(a.close_notes || '').trim(); if (!cn) return {error: 'close_notes is required'}; if (cn.length > GMGAIApplier.REC.NOTES_MAX) return {error: 'close_notes too long'};
        if (!g.getElement('close_code').canWrite() || !g.getElement('close_notes').canWrite()) return {error: 'You cannot write close_code / close_notes', no_access: true};
        var resolve = a.resolve === true || a.resolve === 'true', rs = GMGAIApplier.REC.RESOLVED[T.table];
        if (resolve && !rs) return {error: 'resolve:true is only supported on incident'};
        if (resolve && !g.getElement('state').canWrite()) return {error: 'You cannot change state', no_access: true};
        out.spec.close_code = hit.value; out.spec.close_notes = cn; out.spec.resolve = resolve;
        out.title = 'Resolution on ' + (T.number || T.display) + (resolve ? ' + RESOLVE' : '');
        out.diff.push('~ close_code: "' + (g.getDisplayValue('close_code') || '') + '" -> "' + hit.label + '" (' + hit.value + ')');
        out.diff.push('~ close_notes: "' + String(g.getValue('close_notes') || '').substring(0, 120) + '" -> "' + cn.substring(0, 300) + '"');
        out.state_change = resolve ? 'State changes from "' + g.getDisplayValue('state') + '" to Resolved (business rules run as normal).' : '';
        if (resolve) out.diff.push('~ state: ' + g.getDisplayValue('state') + ' -> Resolved');
        return out;
    }
    return {error: 'unknown record write ' + kind};
};

/* pure age / staleness rule for Confirm (unit-tested offline in branches/scriptdev-bot-builder). ageOf(dateTimeValue) -> seconds since then.
 * o: {team, created, passed, capturedUpdated, currentUpdated}. */
/* AC-F26 (architecture review): propose_flow_edit stamps the flow's sys_updated_on AND sys_mod_count; Confirm refuses on any mismatch (or a
 * missing stamp) with nothing written, whether or not the proposal belongs to a team build. Pure. */
GMGAIApplier.FLOW_STALE_MSG = 'This flow changed since I drafted the edit. Ask me to redo it.';
GMGAIApplier.flowEditStale = function(stamp, cur) {
    if (!stamp || !stamp.updated_on || stamp.mod_count === undefined || stamp.mod_count === null || stamp.mod_count === '') return GMGAIApplier.FLOW_STALE_MSG;
    if (!cur || String(cur.updated_on) != String(stamp.updated_on) || String(cur.mod_count) != String(stamp.mod_count)) return GMGAIApplier.FLOW_STALE_MSG;
    return '';
};
/* AC-F26 for every non-flow update (business rules and other artifacts, catalog item edits, record writes): same rule, record wording. */
GMGAIApplier.RECORD_STALE_MSG = 'This record changed since I drafted the edit. Ask me to redo it.';
GMGAIApplier.recordEditStale = function(stamp, cur) { return GMGAIApplier.flowEditStale(stamp, cur) ? GMGAIApplier.RECORD_STALE_MSG : ''; };
/* architecture review ruling: the Reviewer's verdict is stored ON each proposal (review_verdict, review_notes, review_turn,
 * review_hash = SHA-256 of the payload the Reviewer actually read). A Reviewer-routed proposal applies only when that stored verdict is 'pass'
 * and the hash still matches the current payload; any later edit voids the pass. Card options the user may set at Confirm (new update set,
 * ATF activate) are excluded from the hash, so choosing them is not an edit. Ruling (b): run_as is NOT a card option for reviewed cards; it is hashed. Pure. */
GMGAIApplier.CARD_OPTION_KEYS = [['spec', 'update_set'], ['spec', 'update_set_auto'], ['spec', 'activate']];
/* architecture review ruling (c): the canonical hash covers EVERY field the Applier reads to decide what it writes: run_as, target_table,
 * target_sys_id, operation, action_type, target_updated_on, summary, diff, current_script and the payload (card options above excluded). Keys are sorted recursively, so key order alone is
 * not an edit. r: a reviewInput object ({payload, action_type, operation, target_table, target_sys_id}) or a bare payload string. */
GMGAIApplier.REVIEW_HASH_FIELDS = ['action_type', 'operation', 'target_table', 'target_sys_id', 'target_updated_on', 'summary', 'diff', 'current_script'];   // approver (4): what the card SHOWS (summary, diff, current_script) is hashed too; older stored hashes mismatch -> fail closed   // target_updated_on: the Applier's stale-target check reads it
GMGAIApplier.BOUND_FIELDS = ['bound_table', 'bound_sys_id'];   // open-core split step 7: sealed when present (a current-record proposal)
GMGAIApplier.sortDeep = function(v) {
    if (Object.prototype.toString.call(v) == '[object Array]') return v.map(GMGAIApplier.sortDeep);
    if (v && typeof v == 'object') { var o = {}; Object.keys(v).sort().forEach(function(k) { o[k] = GMGAIApplier.sortDeep(v[k]); }); return o; }
    return v;
};
GMGAIApplier.reviewInput = function(pa) {
    var o = {payload: String(pa.getValue('payload') || '')};
    GMGAIApplier.REVIEW_HASH_FIELDS.forEach(function(f) { o[f] = pa.isValidField(f) ? String(pa.getValue(f) || '') : ''; });
    GMGAIApplier.BOUND_FIELDS.forEach(function(f) { if (pa.isValidField(f) && pa.getValue(f)) o[f] = String(pa.getValue(f)); });   // step 7
    return o;
};
GMGAIApplier.reviewCanon = function(r, fields) {
    if (r === null || typeof r != 'object') r = {payload: r};
    var raw = String(r.payload == null ? '' : r.payload), p = null; try { p = JSON.parse(raw); } catch (e) { p = null; }
    var obj = !!(p && typeof p == 'object');
    if (obj) GMGAIApplier.CARD_OPTION_KEYS.forEach(function(k) { var o = p; for (var i = 0; i < k.length - 1; i++) o = o && typeof o == 'object' ? o[k[i]] : null; if (o && typeof o == 'object') delete o[k[k.length - 1]]; });
    var out = {payload: obj ? p : raw, run_as: obj && p.run_as != null ? String(p.run_as) : ''};
    (fields || GMGAIApplier.REVIEW_HASH_FIELDS).forEach(function(f) { out[f] = String(r[f] == null ? '' : r[f]); });
    GMGAIApplier.BOUND_FIELDS.forEach(function(f) { if (r[f]) out[f] = String(r[f]); });   // step 7: the binding is sealed too (only when set, so unbound rows keep their hash)
    return JSON.stringify(GMGAIApplier.sortDeep(out));
};
GMGAIApplier.reviewHash = function(r, fields) { return String(new GlideDigest().getSHA256Hex(GMGAIApplier.reviewCanon(r, fields))).toLowerCase(); };
/* Design review: a stored hash in the OLD canon (before summary, diff, current_script were hashed) that still matches the card = out of date,
 * not edited. Still refused (409); only the message differs. Any other mismatch stays 'edited'. */
GMGAIApplier.REVIEW_GATE = {not_passed: 'The review didn\u2019t pass this change, so it can\u2019t be applied.', edited: 'This change was edited after the Reviewer passed it, so the pass no longer counts. Ask for a new review.', stale: 'This card is out of date and can\u2019t be accepted. Ask for the change again to get a fresh card.'};
/* r: {review_route, review_state, review_verdict, review_hash, payload} -> '' (may apply) or the refusal. Ruling (3), fail closed:
 * only review_route 'none' (set at creation for a proposal never routed to the Reviewer) skips the review; 'reviewer' needs a stored
 * pass on the same payload; an empty or unknown route is refused. Never inferred from build being empty. */
GMGAIApplier.gateInput = function(pa) {   // the gate's input read off a pending-action GlideRecord: review fields + everything the hash covers
    var o = GMGAIApplier.reviewInput(pa);
    ['review_route', 'review_state', 'review_verdict', 'review_hash'].forEach(function(f) { o[f] = pa.isValidField(f) ? String(pa.getValue(f) || '') : ''; });
    return o;
};
GMGAIApplier.reviewGate = function(r) {
    var miss = function() { return String(r.review_hash || '') == GMGAIApplier.reviewHash(r, GMGAIApplier.REVIEW_HASH_FIELDS.filter(function(f) { return ['summary', 'diff', 'current_script'].indexOf(f) < 0; })) ? GMGAIApplier.REVIEW_GATE.stale : GMGAIApplier.REVIEW_GATE.edited; };   // Design review: old-canon hash that still matches = out of date, not edited (still refused)
    if (!r) return GMGAIApplier.REVIEW_GATE.not_passed;
    var route = String(r.review_route || '');
    if (route == 'none') return !r.review_hash ? GMGAIApplier.REVIEW_GATE.edited : String(r.review_hash) != GMGAIApplier.reviewHash(r) ? miss() : '';   // architecture review (B): route-none cards carry the server's insert-time hash; any content change -> refused (fails closed when missing)
    if (route != 'reviewer') return GMGAIApplier.REVIEW_GATE.not_passed;
    if (String(r.review_verdict || '') != 'pass' || String(r.review_state || '') != 'passed') return GMGAIApplier.REVIEW_GATE.not_passed;
    if (!r.review_hash) return GMGAIApplier.REVIEW_GATE.edited;
    if (String(r.review_hash) != GMGAIApplier.reviewHash(r)) return miss();
    return '';
};
GMGAIApplier.reviewGateOf = function(pa) { return GMGAIApplier.reviewGate(GMGAIApplier.gateInput(pa)); };   // the same gate read off a pending-action GlideRecord (full hash input)

GMGAIApplier.NOT_BOUND = 'This change is not for the record it was proposed on.';
/* Open-core split step 7 (spec 4.4.1): a core kind applies only to the record it was bound to at propose time. r: {target_table, target_sys_id,
 * bound_table, bound_sys_id}; p: the parsed payload. '' = same record everywhere (pending target, binding, and the record the payload writes). Pure.
 * MUST stay identical in ActionService and GMGAIApplierCore (test_bound_confirm checks the bodies match). */
GMGAIApplier.boundCheck = function(r, p) {
    var bt = String(r.bound_table || ''), bs = String(r.bound_sys_id || '');
    if (!bt || !/^[0-9a-f]{32}$/.test(bs)) return GMGAIApplier.NOT_BOUND;
    if (String(r.target_table || '') != bt || String(r.target_sys_id || '') != bs) return GMGAIApplier.NOT_BOUND;
    var sp = p && p.kind == 'record' ? (p.spec || {}) : (p || {});
    if (String(sp.table || '') != bt || String(sp.sys_id || '') != bs) return GMGAIApplier.NOT_BOUND;
    if (p && p.kind == 'record' && p.table && String(p.table) != bt) return GMGAIApplier.NOT_BOUND;
    return '';
};
GMGAIApplier.NEEDS_PAID = 'This change needs GMG Plan & Create. Nothing was applied.';   // open-core: paid kinds with no paid applier
GMGAIApplier.ageCheck = function(o, ageOf) {
    if (!o.team) return parseInt(ageOf(o.created), 10) > 35 * 60 ? {ok: false, error: 'Action too old'} : {ok: true};
    if (!o.passed) return {ok: false, error: 'This build proposal has not passed review yet.'};
    if (parseInt(ageOf(o.passed), 10) > 35 * 60) return {ok: false, error: 'Action too old (more than 35 minutes since the Reviewer passed it). Ask the bot to re-run.'};
    if (o.capturedUpdated && o.currentUpdated !== null && o.currentUpdated !== undefined && String(o.currentUpdated) != String(o.capturedUpdated))
        return {ok: false, error: 'The target record changed after this proposal was made. Nothing was applied; ask the bot to re-run.'};
    return {ok: true};
};
GMGAIApplier.prototype = {
    initialize: function() {},

    validateScript: function(script) {
        try {
            new Function(String(script));   // compiles only; never invoked
            return {ok: true};
        } catch (e) {
            return {ok: false, error: String(e && e.message || e)};
        }
    },

    /* Every Confirm path: snapshot the user's current update set (session + sys_user_preference rows) and restore it exactly afterwards.
     * GlideUpdateSet().set() persists per-scope preferences, so restoring only the session left other scopes pointing at the GMG AI set. */
    apply: function(actionId) {
        if (!GMGAIApplier._callerOk(true, gs.getCallerScopeName())) return {ok: false, error: 'GMGAIApplier.apply may only be called by the GMG AI Agent'};   // scope guard
        var own = GMGAIApplier.ownerCheck(actionId); if (own) return own;   // architecture review: owner or admin, before anything else (no prefs snapshot, no read of the payload)
        var prevApp = String(gs.getCurrentApplicationId() || 'global'), snap = GMGAIApplier._snapPrefs(prevApp, GMGAIApplier._targetScopes(actionId)), prevUS = GMGAIApplier._prevSet(snap, prevApp), res, pr = null;
        /* GlideUpdateSet().set() keeps the session's own copy of the prefs and saves it back at end of transaction, so the restore goes
         * through set() per scope (from each scope's own snapshot) before the direct-row pass; see _restoreAll. */
        try { res = this._applyInner(actionId); }
        finally { pr = GMGAIApplier._restoreAll(snap); }
        if (res) { res.restored_update_set = prevUS; res.restored_preferences = Object.keys(pr.target).length; res.pref_restore = pr; res.pref_line = GMGAIApplier.prefLine(pr); }
        return res;
    },

    _applyInner: function(actionId) {
        /* Design (C) guard (approvers, 2026-10-15): proposals are applied ONLY by the user's own Confirm in their own session.
         * A background / runner / system-context call is refused before anything is read or written. */
        var sg = GMGAIApplier.sessionGuard(gs.getUserName(), gs.getUserID());
        if (sg) return {ok: false, error: sg};
        var pa = new GlideRecord('x_gmg_ai_pending_action');
        if (!pa.get(actionId)) return {ok: false, error: 'Action not found'};
        if (pa.getValue('user') != gs.getUserID() && gs.hasRole('admin') !== true) return {ok: false, code: 409, error: GMGAIApplier.NOT_OWNER};   // re-checked on the row actually applied
        if (pa.getValue('status') != 'approved') return {ok: false, error: 'Action not approved'};
        if (!gs.hasRole('x_gmg_ai.user')) return {ok: false, error: 'Missing role x_gmg_ai.user'};
        /* architecture review: team/build proposals start the 35-minute clock when the Reviewer passed them (review_passed_on),
         * not when drafted, and are refused if the target record changed since propose time (target_updated_on). Single-agent proposals: unchanged. */
        var team = pa.isValidField('build') && !!pa.getValue('build');
        var tgt = null;
        if (team && pa.getValue('target_sys_id') && pa.isValidField('target_updated_on') && pa.getValue('target_updated_on')) {
            var tg = new GlideRecord(pa.getValue('target_table'));
            tgt = tg.isValid() && tg.get(pa.getValue('target_sys_id')) ? tg.getValue('sys_updated_on') : 'missing';
        }
        var chk = GMGAIApplier.ageCheck({team: team, created: pa.getValue('sys_created_on'), passed: pa.isValidField('review_passed_on') ? pa.getValue('review_passed_on') : '',
            capturedUpdated: pa.isValidField('target_updated_on') ? pa.getValue('target_updated_on') : '', currentUpdated: tgt},
            function(from) { return parseInt(gs.dateDiff(from, new GlideDateTime().getValue(), true), 10); });
        if (!chk.ok) return {ok: false, error: chk.error};
        var rg = GMGAIApplier.reviewGateOf(pa);   // architecture review: the gate lives in the Applier itself, so no caller can skip it
        if (rg) return {ok: false, code: 409, error: rg, review_gate: true, out_of_date: rg == GMGAIApplier.REVIEW_GATE.stale};   // architecture review (B): every route, 409

        var p;
        try { p = JSON.parse(pa.getValue('payload')); } catch (e) { return {ok: false, error: 'Bad payload'}; }
        if (p.kind != 'flow' && String(pa.getValue('operation')) == 'update' && pa.getValue('target_sys_id')) {   // AC-F26: before any update set or write (flows: applyFlowEdit)
            var sg2 = new GlideRecord(pa.getValue('target_table')), ok2 = sg2.isValid() && sg2.get(pa.getValue('target_sys_id'));
            var stale = GMGAIApplier.recordEditStale(p.stamp, ok2 ? {updated_on: sg2.getValue('sys_updated_on'), mod_count: sg2.getValue('sys_mod_count')} : null);
            if (stale) return {ok: false, stale: true, error: stale};
        }
        /* Open-core split step 5 part 2: the open source Core applies only the core kinds, 'record' (one existing record) and an artifact UPDATE.
         * Every other kind (flow, catalog, meta, ATF, artifact create) is applied by GMG Plan & Create's own global applier, which mixes its handlers into
         * a Core instance as applyPaid. Core never names the paid applier and the core facade never forwards to it: paid absent -> 409, nothing written. */
        if (p.kind == 'record' || (!p.kind && p.op == 'update')) {   // step 7: the Applier repeats the binding check (core kinds)
            var bc = GMGAIApplier.boundCheck({target_table: pa.getValue('target_table'), target_sys_id: pa.getValue('target_sys_id'), bound_table: pa.isValidField('bound_table') ? pa.getValue('bound_table') : '', bound_sys_id: pa.isValidField('bound_sys_id') ? pa.getValue('bound_sys_id') : ''}, p);
            if (bc) return {ok: false, code: 409, not_bound: true, error: bc};
        }
        if (p.kind == 'record') return this.applyRecordWrite(pa, p, actionId);
        if (!p.kind && p.op == 'update') return this._applyArtifactUpdate(pa, p, actionId);
        if (typeof this.applyPaid == 'function') return this.applyPaid(pa, p, actionId);
        return {ok: false, code: 409, needs_paid: true, error: GMGAIApplier.NEEDS_PAID};
    },

    /* step 6 record path: field update (+ optional journal) on ONE existing NON-metadata record, as the user; no update set, no insert. */
    _applyFieldWrite: function(pa, p, actionId) {
        var v = GMGAIApplier.validateFieldWrite(p.spec);
        if (v.error) return v.code == 409 ? {ok: false, code: 409, not_elevated: true, error: v.error} : {ok: false, error: 'Proposal no longer valid: ' + v.error};   // step 9: elevation dropped -> 409, nothing written
        if (v.metadata) return {ok: false, error: 'Code and configuration records are changed through an update set; ask the agent to propose again.'};
        if (String(p.updated_on || '') != String(v.updated_on || '')) return {ok: false, stale: true, error: GMGAIApplier.RECORD_STALE_MSG};
        var g = new GlideRecordSecure(v.table); if (!g.get(v.sys_id) || !g.canWrite()) return {ok: false, error: 'No write access'};
        for (var k in v.fields) g.setValue(k, v.fields[k]);
        if (v.journal) g[v.journal.field].setJournalEntry(v.journal.text);
        if (!g.update()) return {ok: false, error: 'Update was rejected (business rule, data policy or ACL)'};
        return {ok: true, kind: 'fields', data_write: true, table: v.table, sys_id: v.sys_id, number: v.number, link: GMGAIApplier.recordLink(v.table, v.sys_id)};
    },

    /* Artifact fields the proposal may write. Update (open source): validateFieldWrite. Create (paid): the table allowlist (GMGAIApplier.TABLES) + syntax check. */
    _artifactFields: function(p) {
        if (p.op == 'update') {   // step 6 (approvers): no field allowlist on edits; floor + system fields blocked, the rest re-validated as the user
            var vf = GMGAIApplier.validateFieldWrite({table: p.table, sys_id: p.sys_id, fields: p.fields});
            if (vf.error) return {error: vf.error, code: vf.code};
            if (!vf.metadata) return {error: p.table + ' is a data table; data records take the record path.'};
            return {fields: vf.fields};
        }
        var allowed = GMGAIApplier.TABLES[p.table];   // paid artifact CREATE keeps the allowlist (paid applier's artifact create)
        if (!allowed) return {error: 'Table not allowed: ' + p.table};
        if (!allowed.length) return {error: p.table + ' can only be changed through the metadata tools'};
        var fields = {};
        for (var k in p.fields) if (allowed.indexOf(k) >= 0) fields[k] = p.fields[k];
        if (fields.script !== undefined) {
            var v = this.validateScript(fields.script);
            if (!v.ok) return {error: 'Syntax error: ' + v.error};
        }
        return {fields: fields};
    },

    /* Open source write path: update ONE existing artifact as the calling user (GlideRecordSecure), captured in a GMG AI update set. No insert of the
     * target, ever; the only insert in Core is the update-set row in _openUpdateSet. */
    _applyArtifactUpdate: function(pa, p, actionId) {
        var af = this._artifactFields(p); if (af.error) return af.code == 409 ? {ok: false, code: 409, not_elevated: true, error: af.error} : {ok: false, error: af.error};
        var fields = af.fields, target = new GlideRecordSecure(p.table);
        if (!target.get(p.sys_id)) return {ok: false, error: 'Target not found or not readable'};
        if (!target.canWrite()) return {ok: false, error: 'No write access to target'};
        if (p.bound) {   // step 8: Confirm re-reads 'active' (the card's warning must match); backstop of ActionService's re-show
            var actNow = GMGAIApplier.activeOf(target);
            if (String(p.active_at_propose || '') != actNow) return {ok: false, code: 409, state_changed: true, active: actNow, live_warning: GMGAIApplier.activeNote(actNow), error: GMGAIApplier.STATE_CHANGED};
        }
        if (fields.active !== undefined && /^(true|1)$/i.test(String(fields.active))) return {ok: false, error: 'The agent never sets active=true.'};   // step 8: never activates
        var scopeId = target.getValue('sys_scope') || 'global';
        var prevApp = gs.getCurrentApplicationId();
        var gus = new GlideUpdateSet();
        var prevUS = gus.get();
        var res = {ok: false};
        try {
            gs.setCurrentApplicationId(scopeId);
            var usId = this._openUpdateSet(pa, scopeId, p.op + ' ' + p.table, actionId, res);   // the build's set when usable, else a new GMG AI set (standard name)
            if (!usId) return {ok: false, error: 'Could not create update set'};
            var wasActive = target.isValidField('active') && (target.getValue('active') == '1' || target.getValue('active') == 'true');
            var safe = GMGAIApplier.editSafeFields(fields, wasActive, {remove: p.deactivate === true});   // AC11: an edit never flips an existing active record off
            if (safe.dropped.length) res.kept_active = true;
            for (var g in safe.fields) target.setValue(g, safe.fields[g]);   // 'active' is not in the allowlist; the guard holds if it is ever added
            if (p.deactivate === true && wasActive) { target.setValue('active', false); res.deactivated = true; }   // AC10: the ONE deactivation path (explicit ask, server-written payload flag)
            if (!target.update()) { res.error = 'Update failed: ' + (target.getLastErrorMessage() || 'denied'); return res; }
            res.sys_id = target.getUniqueValue();
            res.captured_updates = this._countUpdates(usId);
            res.ok = true;
            res.link = GMGAIApplier.recordLink(p.table, res.sys_id);   // p = stored proposal payload
            res.update_set_link = GMGAIApplier.usLink(usId);
            res.scope = scopeId;
            return res;
        } catch (e) {
            res.ok = false; res.error = 'Apply error: ' + e;
            return res;
        } finally {
            try { new GlideUpdateSet().set(prevUS); } catch (e1) {}
            try { gs.setCurrentApplicationId(prevApp); } catch (e2) {}
            res.restored_update_set = prevUS;
        }
    },

    /* Record (data) write Confirm: no update set; GlideRecord update as the calling user, ACL re-check, stale-record guard, business rules on. */
    applyRecordWrite: function(pa, p, actionId) {
        if (!GMGAIApplier._callerOk(true, gs.getCallerScopeName())) return {ok: false, error: 'GMGAIApplier.applyRecordWrite may only be called by the GMG AI Agent'};   // scope guard
        if (p.rec == 'fields') return this._applyFieldWrite(pa, p, actionId);   // step 6: current-record field update (data record path)
        var v = GMGAIApplier.validateRecordWrite(p.rec, p.spec);
        if (v.error) return {ok: false, error: 'Proposal no longer valid: ' + v.error};
        if (String(p.updated_on || '') != String(v.updated_on || '')) return {ok: false, stale: true, error: 'The record changed after this card was created (updated ' + v.updated_on + ' UTC). Ask the agent to regenerate the proposal.'};
        var g = new GlideRecord(v.table); if (!g.get(v.sys_id)) return {ok: false, error: 'Record not found'};
        if (!g.canWrite()) return {ok: false, error: 'No write access'};
        var s = v.spec, res = {ok: false, kind: p.rec, table: v.table, sys_id: v.sys_id, number: v.number, data_write: true};
        var jBefore = 0;
        if (p.rec == 'journal') {   // journal fields append; existing entries are never edited
            jBefore = GMGAIApplier.journalCount(v.table, v.sys_id, s.field);
            g[s.field].setJournalEntry(s.text);
        }
        else { g.setValue('close_code', s.close_code); g.setValue('close_notes', s.close_notes); if (s.resolve) g.setValue('state', GMGAIApplier.REC.RESOLVED[v.table]); }
        var ok = g.update();
        if (!ok) return {ok: false, error: 'Update was rejected (business rule, data policy or ACL)'};
        var chk = new GlideRecord(v.table); chk.get(v.sys_id);
        res.ok = true;
        if (p.rec == 'journal' && GMGAIApplier.journalCount(v.table, v.sys_id, s.field) <= jBefore) { res.ok = false; res.error = 'Update ran but no journal entry was created'; } res.state = chk.getDisplayValue('state'); res.close_code = chk.getValue('close_code');
        if (s.resolve && chk.getValue('state') != GMGAIApplier.REC.RESOLVED[v.table]) { res.ok = false; res.error = 'Saved, but state is ' + res.state + ' (a business rule or data policy prevented Resolved)'; }
        res.link = GMGAIApplier.recordLink(p.table, v.sys_id);   // stored proposal target; v.table is re-validated from it
        return res;
    },

    /* the ONE place a GMG AI update set name/description is built. Requester = confirming user (Confirm is requester-only). */
    _updateSetName: function(pa, what, actionId) { return GMGAIApplier.updateSetNameFor(pa, what, actionId); },

    _openUpdateSet: function(pa, scopeId, what, actionId, res) {
        var reuse = this._buildSetFor(pa, scopeId, res); if (reuse) return reuse;   // build rule 6
        var us = new GlideRecord('sys_update_set');
        us.initialize();
        var nmd = this._updateSetName(pa, what, actionId);   // the one update-set name builder
        us.setValue('name', nmd.name);
        us.setValue('application', scopeId);
        us.setValue('state', 'in progress');
        us.setValue('description', nmd.description);
        var usId = us.insert();
        if (!usId) return null;
        new GlideUpdateSet().set(usId);
        res.update_set_id = usId;
        res.update_set_name = us.getValue('name');
        return usId;
    },

    /* build rule 6: the build's update set (x_gmg_ai_build.update_set, recorded by x_gmg_ai.BuildItemService.afterApply on the first apply)
     * when the proposal belongs to a per-item build, the property is on and the set is still usable (in progress, same scope, mine, GMG AI);
     * otherwise null and the caller opens a new set exactly as today. Reads only. */
    _buildSetFor: function(pa, scopeId, res) {
        if (!pa || !pa.isValidField('build') || !pa.getValue('build')) return null;
        if (String(gs.getProperty('x_gmg_ai.build.per_item_enabled', 'false')) != 'true') return null;
        var b = new GlideRecord('x_gmg_ai_build');
        if (!b.get(pa.getValue('build')) || String(b.getValue('origin')) != 'plan_page' || !b.getValue('update_set')) return null;
        var u = new GlideRecord('sys_update_set'); if (!u.get(b.getValue('update_set'))) return null;
        var why = GMGAIApplier.buildSetUsable({state: u.getValue('state'), application: u.getValue('application'), created_by: u.getValue('sys_created_by'), name: u.getValue('name')}, scopeId, gs.getUserName());
        if (why) { res.update_set_note = 'Build update set not reused (' + why + '); opened a new one'; return null; }
        new GlideUpdateSet().set(u.getUniqueValue());
        res.update_set_id = u.getUniqueValue(); res.update_set_name = u.getValue('name'); res.update_set_reused = true; res.update_set_build = true;
        return u.getUniqueValue();
    },

    _countUpdates: function(usId) {
        var cnt = new GlideAggregate('sys_update_xml');
        cnt.addQuery('update_set', usId); cnt.addAggregate('COUNT'); cnt.query();
        return cnt.next() ? parseInt(cnt.getAggregate('COUNT'), 10) : 0;
    },

    type: 'GMGAIApplier'
};

return GMGAIApplier;
})();
