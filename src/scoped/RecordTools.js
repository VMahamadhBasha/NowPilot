// Copyright 2026 GMG Technology LLC
// SPDX-License-Identifier: Apache-2.0
var RecordTools = Class.create();
/* Open-core split step 6 (spec section 4, approvers 2026-10-18): the core write tools, bound to the record open in the panel.
 * propose_current_record_update has NO table or sys_id parameter; the model cannot name a target. propose_journal_entry / propose_resolution
 * are thin presets of it (same pending kind 'record', same card, bound record only). Nothing is written here: the user must Confirm, the
 * insert-time seal (GMGSeal) and the server-only field guard (ReviewWriteGuard) apply, and Confirm re-checks the binding (step 7).
 * Routing by table structure: a table extending sys_metadata -> artifact edit in a GMG AI update set; any other table -> record path.
 * Validation (floor denylist, system fields, field ACLs, script syntax, active=true refused) is ONE definition in global Core
 * (GMGAIApplier.validateFieldWrite / deniedTable), re-run at Confirm. */
RecordTools.NAMES = ['get_current_record', 'propose_current_record_update', 'propose_journal_entry', 'propose_resolution'];
/* get_current_record (2026-10-19): read the bound (open) record in full, as the user. Password fields are never shown. */
RecordTools.isSecret = function(el) { try { return /^password/.test(String(el.getED().getInternalType())); } catch (e) { return false; } };
RecordTools.CUT = 300; RecordTools.CHUNK = 3000;
/* Card scope (2026-10-19): the artifact card showed "scope undefined" because the card had no scope. Shown scope = the record's own
 * application scope (sys_scope.scope; 'global' for global records), read as the user. Display only: the payload and the seal are unchanged. */
RecordTools.scopeOf = function(table, id) {
    try {
        var g = new GlideRecordSecure(table);
        if (!g.get(id) || !g.isValidField('sys_scope')) return '';
        var raw = String(g.getValue('sys_scope') || '');
        if (raw == 'global') return 'global';
        var s = g.sys_scope && g.sys_scope.scope ? String(g.sys_scope.scope) : '';
        return s || String(g.getDisplayValue('sys_scope') || '');
    } catch (e) { return ''; }
};
/* Per turn: bind the target from the page context (unverified browser input) or refuse. Returns {table, sys_id, display} or {error}. */
RecordTools.bind = function(ctx, G) {
    ctx = ctx || {}; G = G || global.GMGAIApplier;
    var t = String(ctx.table || '').trim(), id = String(ctx.sys_id || '').trim();
    if (!t || !id || id == '-1') return {error: 'No saved record is open, so nothing can be changed. Open the record first.'};
    if (!/^[a-z][a-z0-9_]{0,79}$/.test(t) || !/^[0-9a-f]{32}$/.test(id)) return {error: 'The open page is not a record.'};
    var dn = G.deniedTable(t); if (dn) return {error: dn, denied: true};
    var g = new GlideRecordSecure(t);
    if (!(g.isValid() && g.get(id))) return {error: 'The open record was not found or you cannot read it.'};
    return {table: t, sys_id: id, display: String(g.getDisplayValue() || g.getValue('number') || id)};
};
/* Store the binding on the conversation (bound_table / bound_sys_id / bound_at); a navigation re-binds on the next turn. */
RecordTools.store = function(conv, b) {
    if (!conv || typeof conv.isValidField != 'function' || !conv.isValidField('bound_table')) return;
    var t = b && !b.error ? b.table : '', id = b && !b.error ? b.sys_id : '';
    if (String(conv.getValue('bound_table') || '') == t && String(conv.getValue('bound_sys_id') || '') == id) return;
    conv.setValue('bound_table', t); conv.setValue('bound_sys_id', id); conv.setValue('bound_at', t ? new GlideDateTime().getValue() : '');
    conv.update();
};
RecordTools.promptLine = function(b) {
    return b && !b.error ? 'Bound record (the ONLY record the write tools can change): ' + b.table + ' ' + b.sys_id + ' (' + b.display + '). Related records are not editable. Read it with get_current_record (any table, full script bodies via its field parameter) before explaining or proposing a change.'
        : 'No record is bound for writes: ' + (b && b.error || 'no record open') + ' The write tools refuse until a saved record is open.';
};
RecordTools.prototype = {
    initialize: function(ctx, G) { this.ctx = ctx || {}; this.G = G || null; this.proposed = []; },
    _G: function() { return this.G || global.GMGAIApplier; },
    definitions: function() {
        if (this.ctx.acting_user) return [];   // design (C): record writes never run on the bot runner path
        var F = {type: 'object', description: 'field name -> new value (reference fields: sys_id or display value)'};
        return [
            {name: 'get_current_record',
             description: 'READ the record open in the user\'s browser (the bound record), any table, with the user\'s own permissions. No table or sys_id parameter. ' +
                 'Without field: every readable field (long values cut, listed in long_fields). With field: that field in full (e.g. script), in chunks; pass offset=next_offset for more. Read-only.',
             parameters: {type: 'object', properties: {field: {type: 'string', description: 'One field name to read in full, e.g. script'}, offset: {type: 'integer', description: 'Start position for the next chunk'}}}},
            {name: 'propose_current_record_update',
             description: 'PROPOSE changing fields on the record open in the user\'s browser (the bound record). There is no table or sys_id parameter: only the open record can be changed. ' +
                 'Optional journal entry (work_notes by default; comments are CUSTOMER-VISIBLE, only when asked). Nothing is written until the user Accepts the card. System fields, number and active=true on code are refused.',
             parameters: {type: 'object', properties: {fields: F, journal: {type: 'object', properties: {field: {type: 'string', 'enum': ['work_notes', 'comments']}, text: {type: 'string'}}}, summary: {type: 'string'}}, required: ['summary']}},
            {name: 'propose_journal_entry',
             description: 'PROPOSE a journal entry on the open (bound) record. field: work_notes (DEFAULT) or comments (CUSTOMER-VISIBLE, only when asked). Data write, permanent, applied only after Accept.',
             parameters: {type: 'object', properties: {field: {type: 'string', 'enum': ['work_notes', 'comments']}, text: {type: 'string'}}, required: ['text']}},
            {name: 'propose_resolution',
             description: 'PROPOSE close_code and close_notes on the open (bound) record; resolve: true also sets state Resolved (incident). Applied only after Accept.',
             parameters: {type: 'object', properties: {close_code: {type: 'string'}, close_notes: {type: 'string'}, resolve: {type: 'boolean'}}, required: ['close_code', 'close_notes']}}
        ];
    },
    handles: function(name) { return RecordTools.NAMES.indexOf(name) >= 0; },
    execute: function(name, a) {
        a = a || {};
        if (this.ctx.acting_user) return {error: 'Record writes are not available here.', refused: true};
        var b = this.ctx.bound;
        if (!b || b.error) return {error: (b && b.error) || 'No record is bound.', no_card: true};
        if (name == 'get_current_record') return this.read(a);
        if (name == 'propose_journal_entry') return this.propose({journal: {field: a.field || 'work_notes', text: a.text}, summary: (a.field == 'comments' ? 'Comment' : 'Work note') + ' on ' + b.display});
        if (name == 'propose_resolution') {
            var f = {close_code: a.close_code, close_notes: a.close_notes};
            if (a.resolve === true || a.resolve === 'true') { if (b.table != 'incident') return {error: 'resolve:true is only supported on incident', no_card: true}; f.state = '6'; }
            return this.propose({fields: f, summary: 'Resolution on ' + b.display});
        }
        if (name == 'propose_current_record_update') return this.propose(a);
        return {error: 'Unknown tool.'};
    },
    read: function(a) {
        var b = this.ctx.bound, g = new GlideRecordSecure(b.table);
        if (!g.get(b.sys_id)) return {error: 'The open record was not found or you cannot read it.'};
        var el, n, f;
        if (a.field) {
            f = String(a.field).trim();
            if (!g.isValidField(f)) return {error: 'No field ' + f + ' on ' + b.table};
            el = g.getElement(f);
            if (!el.canRead()) return {error: 'You cannot read ' + f + ' on this record.'};
            if (RecordTools.isSecret(el)) return {error: f + ' is a password field and is never shown.'};
            var full = el.getValue() == null ? '' : String(el.getValue()), off = Math.max(0, parseInt(a.offset, 10) || 0), end = off + RecordTools.CHUNK;
            return {table: b.table, sys_id: b.sys_id, field: f, length: full.length, offset: off, value: full.substring(off, end), next_offset: end < full.length ? end : null};
        }
        var o = {table: String(g.getRecordClassName()), sys_id: b.sys_id, display: b.display}, longs = [], els = g.getElements();
        for (var i = 0; i < els.length; i++) {
            el = els[i]; n = String(el.getName());
            if (/^sys_(mod_count|tags|domain_path)$/.test(n) || !el.canRead()) continue;
            if (RecordTools.isSecret(el)) { o[n] = '[password field: never shown]'; continue; }
            var raw = el.getValue(), dv = el.getDisplayValue();
            raw = raw == null ? '' : String(raw); dv = dv == null ? '' : String(dv);
            if (!raw && !dv) continue;
            var v = dv || raw;
            if (raw && raw != v && /^[0-9a-f]{32}$/.test(raw)) v += ' [' + raw + ']';
            if (v.length > RecordTools.CUT) { o[n] = v.substring(0, RecordTools.CUT) + '... [' + v.length + ' chars: call get_current_record with field "' + n + '"]'; longs.push(n); }
            else o[n] = v;
        }
        o.long_fields = longs;
        return o;
    },
    propose: function(a) {
        var wo = typeof ActionService == 'undefined' ? '' : ActionService.writesOff();   // refused before any validation or card
        if (wo) return {error: wo, no_card: true, refused: true, writes_off: true};
        var b = this.ctx.bound, G = this._G();
        var v = G.validateFieldWrite({table: b.table, sys_id: b.sys_id, fields: a.fields || {}, journal: a.journal});
        if (v.error) return {error: v.error, no_card: true, no_access: !!v.no_access};
        var staticWarnings = [];
        if (a.fields && a.fields.script && typeof DevValidator != 'undefined') {
            try {
                var sVal = new DevValidator().validate(a.fields.script, v.table);
                if (sVal && sVal.findings && sVal.findings.length) {
                    staticWarnings.push('Static Analysis: ' + sVal.summary);
                    sVal.findings.forEach(function(f) {
                        if (f.severity == 'Critical' || f.severity == 'High') {
                            staticWarnings.push('  [' + f.severity + '] ' + f.message);
                        }
                    });
                }
            } catch (eV) {}
        }
        var meta = !!v.metadata, summary = String(a.summary || ('Update ' + v.display)).substring(0, 70);
        var warn = meta ? 'Captured in a GMG AI update set.' : 'Data write: nothing changes until you Accept. On Accept it is written straight to the record, not captured in an update set, so it cannot be backed out.' + (v.journal ? ' A journal entry cannot be edited or removed afterwards.' : '');   // wording (no "applied directly": Confirm is required)
        var live = meta ? G.activeNote(v.active) : '';   // step 8: live-change warning on active code (inactive note otherwise)
        if (live) warn = live + ' ' + warn;
        if (staticWarnings.length) warn = staticWarnings.join('\n') + '\n' + warn;
        var payload = meta ? {op: 'update', table: v.table, sys_id: v.sys_id, fields: v.fields, scope: '', bound: true, active_at_propose: v.active}
                           : {kind: 'record', rec: 'fields', table: v.table, op: 'update', scope: 'global', spec: {table: v.table, sys_id: v.sys_id, fields: v.fields, journal: v.journal || null}, updated_on: v.updated_on, bound: true};
        payload.stamp = {updated_on: String(v.updated_on || ''), mod_count: String(v.mod_count == null ? '' : v.mod_count)};   // AC-F26 stale check at Confirm
        if (v.elevated_note) warn = v.elevated_note + ' Confirm is still required and your record and field ACLs still apply. ' + warn;   // step 9
        var lines = [summary].concat(v.diff).concat(['NOTE: ' + warn]);
        var pa = new GlideRecord('x_gmg_ai_pending_action');
        pa.initialize();
        pa.setValue('user', gs.getUserID()); pa.setValue('action_type', meta ? 'artifact_update' : 'record_fields'); pa.setValue('operation', 'update');
        pa.setValue('target_table', v.table); pa.setValue('target_sys_id', v.sys_id); pa.setValue('target_scope', 'global'); pa.setValue('summary', summary);
        if (pa.isValidField('bound_table')) { pa.setValue('bound_table', b.table); pa.setValue('bound_sys_id', b.sys_id); }
        if (pa.isValidField('target_updated_on')) pa.setValue('target_updated_on', v.updated_on);
        if (pa.isValidField('review_route')) pa.setValue('review_route', 'none');
        pa.setValue('payload', JSON.stringify(payload)); pa.setValue('diff', lines.join('\n')); pa.setValue('status', 'pending');
        var exp = new GlideDateTime(); exp.addSeconds(30 * 60); pa.setValue('expires', exp.getValue());
        pa.setValue('page_url', String(this.ctx.url || '').substring(0, 1000)); if (pa.isValidField('conversation_id')) pa.setValue('conversation_id', String(this.ctx.conversation_id || ''));
        if (typeof GMGSeal != 'undefined') GMGSeal.sealRouteNone(pa);   // core insert-time seal
        var id = typeof ReviewWriteGuard == 'undefined' ? pa.insert() : ReviewWriteGuard.run(function() { return pa.insert(); });
        if (!id) return {error: 'Could not save the proposal.', no_card: true};
        if (typeof GMGSeal != 'undefined' && !GMGSeal.storeSeal(pa)) return {error: 'Could not seal the proposal, so it was not offered. Nothing was written.', no_card: true};   // server-only seal
        var usName = '';   // the GMG AI update set Accept will create, named by the same builder as the Applier ('update <table>' = p.op + ' ' + p.table)
        if (meta && typeof G.updateSetNameFor == 'function') { try { usName = String(G.updateSetNameFor(pa, 'update ' + v.table, id).name || ''); } catch (eu) { usName = ''; } }
        this.proposed.push({id: id, type: meta ? 'artifact' : 'record', rec: 'fields', operation: 'update', table: v.table, target: v.display, record: v.number || v.display,
            record_link: '/' + v.table + '.do?sys_id=' + v.sys_id, scope: meta ? RecordTools.scopeOf(v.table, v.sys_id) : '', bound: true, summary: summary, fields: v.fields, before: v.before, diff_lines: v.diff,
            update_set: usName, update_set_new: !!usName, data_warning: meta ? (v.elevated_note ? v.elevated_note + ' ' : '') + live : warn, elevated_note: v.elevated_note || '', live_warning: v.active == 'true' ? live : '', active: v.active, expires: exp.getDisplayValue(), expires_ms: exp.getNumericValue(), status: 'pending'});
        return {pending_action_id: id, status: 'pending', not_applied: true, summary_shown_to_user: lines.join('\n') + (usName ? '\nUpdate set (created on Accept): ' + usName : ''),
            message: 'Proposal saved. NOTHING HAS BEEN WRITTEN YET. The user must click Accept on the card within 30 minutes.'};
    },
    type: 'RecordTools'
};
