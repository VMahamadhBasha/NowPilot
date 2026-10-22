// Copyright 2026 GMG Technology LLC
// SPDX-License-Identifier: Apache-2.0
/* Now Pilot for ServiceNow - global desktop UI Script (UI16 + classic pages inside the Next Experience/Polaris iframe).
 * Built by Kanam Ramu.
 * Runs in every classic page/frame. The panel is rendered into the TOP window (same origin), and each
 * content frame registers a context provider there, so the agent "follows" the user across navigations.
 * Chat state lives in top.sessionStorage (keys scoped to the session user) so it survives page loads.
 */
(function() {
    var ROLE = 'x_gmg_ai.user', API = '/api/x_gmg_ai/agent/chat', KEY_BASE = 'gmgai_state_v1', CONV_BASE = 'gmgai_conv_id';
    var LOGO_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="30" height="30" style="flex-shrink:0;vertical-align:middle;border-radius:8px;background:#051C24;box-shadow:0 1px 3px rgba(0,0,0,0.15)"><rect width="32" height="32" rx="8" fill="#051C24"/><path d="M5 23 C11 23 17 20 26 15 C21 21 14 24 5 24 Z" fill="#46CC58"/><path d="M6 23 C11 21 16 18 25 15 C20 19 14 22 6 23 Z" fill="#52DF65"/><path d="M7 21 C11 16 16 11 22 7 C25 6 27 7.5 26 10 C24 13 18 17 11 21 C9.5 21.5 8.5 21.5 7 21 Z" fill="#FFFFFF"/></svg>';
    var BTN_LOGO_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="36" height="36" style="vertical-align:middle;display:block"><circle cx="16" cy="16" r="14.5" fill="#FFFFFF" stroke="#002B3B" stroke-width="1.8"/><path d="M7 16 L25 8 L14 17 Z" fill="#63E052"/><path d="M7 16 L14 17 L18 24 Z" fill="#38A827"/><path d="M14 17 L25 8" stroke="#002B3B" stroke-width="1.5" stroke-linecap="round"/></svg>';
    var w = window, top;
    try { top = window.top; void top.document.body; } catch (e) { top = window; }
    var tdoc = top.document;
    /* QA 2026-10-20 (cross-user panel cache): sessionStorage is per browser tab, not per ServiceNow user, so after a user switch in the
     * same tab the next user saw the previous user's chat and cards. Both keys are scoped to the session user; on load any other
     * user's keys and the old unscoped keys are removed (browser storage only). No user id: nothing is read or kept in sessionStorage.
     * Panel did not open in testing (2026-10-20): g_user is not always set when a global UI Script runs, so the user is resolved
     * lazily (ensureUser) on every load/save/convId/Clear; until it is known, state lives only in memory for this page (MEM). */
    function curUser() {
        var c = [w, top], i, u;
        for (i = 0; i < c.length; i++) { try { u = c[i].g_user && c[i].g_user.userID; if (u) return String(u); } catch (e) {} }
        for (i = 0; i < c.length; i++) { try { u = c[i].NOW && c[i].NOW.user_id; if (u) return String(u); } catch (e2) {} }
        return '';
    }
    var UID = '', KEY = '', CONV_KEY = '', MEM = null, MEM_CONV = null;
    function ensureUser() {
        if (UID) return UID;
        var u = curUser();
        if (!u) return '';
        UID = u; KEY = KEY_BASE + ':' + UID; CONV_KEY = CONV_BASE + ':' + UID;
        purgeOtherUsers();
        if (MEM) { try { var m = JSON.parse(MEM); m.owner = UID; top.sessionStorage.setItem(KEY, JSON.stringify(m)); } catch (e) {} MEM = null; }
        if (MEM_CONV) { try { if (!top.sessionStorage.getItem(CONV_KEY)) top.sessionStorage.setItem(CONV_KEY, MEM_CONV); } catch (e2) {} MEM_CONV = null; }
        return UID;
    }
    function purgeOtherUsers() {
        try {
            var st = top.sessionStorage, drop = [], i, k;
            for (i = 0; i < st.length; i++) {
                k = st.key(i);
                if (k == KEY_BASE || k == CONV_BASE) { drop.push(k); continue; }
                if (!UID) { if (k == KEY_BASE + ':' || k == CONV_BASE + ':') drop.push(k); continue; }   // user not known yet: keep scoped keys until ensureUser
                if ((k.indexOf(KEY_BASE + ':') === 0 || k.indexOf(CONV_BASE + ':') === 0) && k != KEY && k != CONV_KEY) drop.push(k);
            }
            for (i = 0; i < drop.length; i++) st.removeItem(drop[i]);
        } catch (e) {}
    }
    purgeOtherUsers();
    ensureUser();

    function hasRole() {
        try { return !!(w.g_user && (w.g_user.hasRole(ROLE) || w.g_user.hasRoleExactly && w.g_user.hasRoleExactly(ROLE))); } catch (e) { return false; }
    }
    /* Skip shells that only host the content frame (UI16 navpage); the frame does the work. */
    /* AC-R1.5: also the Next Experience shell (/now/... top document): it never boots or polls; the classic frame inside it does. */
    function isShellOnly() {
        if (w !== top) return false;
        return !!document.getElementById('gsft_main') || /^\/now(\/|$)/.test(w.location.pathname || '') || !!document.querySelector && !!document.querySelector('macroponent-f51912f4c700201072b211d4d8c26010, sn-polaris-layout, [data-polaris-shell]');
    }

    function tableFromPath(p) {
        var m = /\/([a-z0-9_]+?)(_list)?\.do/.exec(p);
        return m ? {table: m[1], list: !!m[2]} : null;
    }
    function param(name, search) {
        var m = new RegExp('[?&]' + name + '=([^&#]*)').exec(search);
        return m ? decodeURIComponent(m[1].replace(/\+/g, ' ')) : '';
    }

    var KEY_FIELDS = ['number', 'short_description', 'description', 'state', 'priority', 'impact', 'urgency', 'category',
        'subcategory', 'assignment_group', 'assigned_to', 'caller_id', 'cmdb_ci', 'business_service', 'type', 'risk',
        'start_date', 'end_date', 'problem_id', 'name', 'sys_class_name', 'operational_status', 'support_group',
        'workflow_state', 'kb_knowledge_base', 'close_code'];

    function getContext() {
        var c = {url: top.location.pathname + top.location.search, frame_url: w.location.pathname + w.location.search,
                 ui: (top !== w && /\/now\//.test(top.location.pathname)) ? 'next_experience_iframe' : (top !== w ? 'ui16_frame' : 'ui16')};
        var t = tableFromPath(w.location.pathname);
        try {
            if (w.g_form && w.g_form.getTableName) {
                c.kind = 'form';
                c.table = w.g_form.getTableName();
                c.sys_id = w.g_form.getUniqueValue();
                c.fields = {};
                KEY_FIELDS.forEach(function(f) {
                    try {
                        if (!w.g_form.hasField || !w.g_form.hasField(f)) return;
                        var v = w.g_form.getDisplayValue ? w.g_form.getDisplayValue(f) : '';
                        if (!v) v = w.g_form.getValue(f);
                        if (v) c.fields[f] = String(v).substring(0, 300);
                    } catch (e) {}
                });
                return c;
            }
        } catch (e) {}
        if (t) {
            c.table = t.table;
            if (t.list) { c.kind = 'list'; c.query = param('sysparm_query', w.location.search); }
            else { c.kind = 'form'; c.sys_id = param('sys_id', w.location.search); }
        } else {
            c.kind = 'page';
        }
        return c;
    }

    function suggestions(c) {
        var t = c.table || '';
        if (t == 'incident' && c.kind == 'form') return ['Summarize this incident', 'Find similar incidents and how they were resolved', 'What should I check next?'];
        if (t == 'incident') return ['Summarize the incidents in this list', 'Which of these are P1/P2?', 'Any patterns by assignment group?'];
        if (t == 'change_request' && c.kind == 'form') return ['Summarize this change and its risk', 'Any open incidents on this CI?', 'Other changes on the same CI?'];
        if (t == 'change_request') return ['Summarize these changes', 'Which changes are high risk?', 'What is scheduled this week?'];
        if (t == 'problem') return ['Summarize this problem', 'Which incidents relate to it?', 'Similar past problems?'];
        if (t.indexOf('cmdb_ci') === 0) return ['What is this CI and who supports it?', 'Open incidents on this CI', 'Recent changes on this CI'];
        if (t == 'kb_knowledge') return ['Summarize this article', 'Related incidents?', 'Other articles on this topic'];
        return ['Show me open P1 incidents', 'How many active changes are there?', 'Find incidents about email'];
    }

    function load() {
        ensureUser();
        var d = {open: false, messages: [], owner: UID};
        if (!UID) { try { return MEM ? JSON.parse(MEM) : d; } catch (e0) { return d; } }   // a copy, same as a sessionStorage read
        try { var s = JSON.parse(top.sessionStorage.getItem(KEY)); if (!s || (s.owner && s.owner != UID)) return d; s.owner = UID; return s; } catch (e) { return d; }
    }
    function save(s) { if (!ensureUser()) { try { MEM = JSON.stringify(s); } catch (e0) {} return; } try { s.owner = UID; top.sessionStorage.setItem(KEY, JSON.stringify(s)); } catch (e) {} }
    function esc(s) { return String(s).replace(/[&<>"']/g, function(ch) { return {'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[ch]; }); }
    /* SCREEN-REVIEW #25: no emoji from model text (our own marks are added by the panel, not by content) */
    function noEmoji(t) { return String(t == null ? '' : t).replace(/[\uD83C-\uD83E][\uDC00-\uDFFF]|[\u2600-\u27BF]\uFE0F?|\uFE0F/g, ''); }
    /* SCREEN-REVIEW #24: minimal safe markdown (escape FIRST, then **bold**, `code`, "- " / "* " / "1. " lists, line breaks). No links, no raw HTML.
     * GitHub-style tables. A '|' header row followed by a '|---|' separator row, then '|' body rows, becomes an HTML
     * table (header th, alignment from ':---:' / '---:'). Cells are escaped text with the same inline **bold** / `code`; '\|' is a literal pipe.
     * Rows with fewer cells are padded and extra cells are dropped (header count wins). Anything else, e.g. a lone '|' line, stays text. */
    var MD_SEP = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;
    function mdCells(line) {
        var x = String(line).replace(/^\s*\|/, '').replace(/\|\s*$/, ''), cells = [], cur = '', i;
        for (i = 0; i < x.length; i++) {
            if (x.charAt(i) == '\\' && x.charAt(i + 1) == '|') { cur += '|'; i++; continue; }
            if (x.charAt(i) == '|') { cells.push(cur.replace(/^\s+|\s+$/g, '')); cur = ''; continue; }
            cur += x.charAt(i);
        }
        cells.push(cur.replace(/^\s+|\s+$/g, ''));
        return cells;
    }
    function mdIsRow(line) { return /^\s*\|.*\|\s*$/.test(line) || (/\|/.test(line) && /^\s*[^|\s].*\|.*[^|\s]\s*$/.test(line) && mdCells(line).length > 1); }
    function md(t) {
        var out = [], list = null, lines = esc(noEmoji(t)).split('\n'), i, j;
        var inl = function(x) { return x.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/`([^`]+)`/g, '<code>$1</code>'); };
        var endList = function() { if (list) { out.push('</' + list.tag + '>'); list = null; } };
        for (i = 0; i < lines.length; i++) {
            var line = lines[i];
            if (mdIsRow(line) && i + 1 < lines.length && MD_SEP.test(lines[i + 1]) && /\|/.test(lines[i + 1])) {
                var head = mdCells(line), n = head.length, al = mdCells(lines[i + 1]).map(function(c) { return /^:-+:$/.test(c) ? 'center' : /-:$/.test(c) ? 'right' : ''; });
                var cell = function(tag, v, k) { return '<' + tag + (al[k] ? ' style="text-align:' + al[k] + '"' : '') + '>' + inl(v) + '</' + tag + '>'; };
                var h = '<div class="gmgai-tw"><table class="gmgai-mt"><thead><tr>' + head.map(function(c, k) { return cell('th', c, k); }).join('') + '</tr></thead><tbody>';
                for (j = i + 2; j < lines.length && mdIsRow(lines[j]) && !MD_SEP.test(lines[j]); j++) {
                    var c = mdCells(lines[j]).slice(0, n); while (c.length < n) c.push('');
                    h += '<tr>' + c.map(function(v, k) { return cell('td', v, k); }).join('') + '</tr>';
                }
                endList(); out.push(h + '</tbody></table></div>'); i = j - 1; continue;
            }
            var m = /^\s*(?:[-*]|(\d+)\.)\s+(.*)$/.exec(line);
            if (m) { var tag = m[1] ? 'ol' : 'ul'; if (!list || list.tag != tag) { endList(); list = {tag: tag}; out.push('<' + tag + '>'); } out.push('<li>' + inl(m[2]) + '</li>'); continue; }
            endList();
            out.push(inl(line) + '\n');
        }
        endList();
        return out.join('').replace(/\n$/, '');
    }


    /* SCREEN-REVIEW #23/#27 (AC16): one cost chip in cents; no usage counts or provider names. */
    function cents(n) { n = parseFloat(n) || 0; var c = Math.round(n * 100); return (n > 0 && c < 1 ? '<1' : String(c).replace(/\B(?=(\d{3})+(?!\d))/g, ',')) + '\u00a2'; }
    function footer(m) {
        var p = [];
        if (m.cost != null) p.push(cents(m.cost));
        if (m.month != null) p.push(cents(m.month) + (m.monthly_budget > 0 ? ' of ' + cents(m.monthly_budget) : '') + ' this month');
        return p.length ? '<span class="gmgai-cost">' + esc(p.join(' \u00b7 ')) + '</span>' : '';
    }
    /* SCREEN-REVIEW #29 (shared with build_new_client.js, kept identical; test_panel_review checks): diff text -> before/after rows.
     * 'field: before -> after' lines, '-'/'+' line pairs (script diffs), anything else = a note row. */
    function CAT_NONE(v) { v = String(v || '').replace(/^\s+|\s+$/g, ''); return !v || /^\(none\)$/i.test(v) ? 'None' : v; }
    var INACTIVE_TAG = /\s*\[created\s+INACTIVE(?:,[^\]]*)?\]\s*$/i;
    function changeRows(lines) {
        var rows = [], unq = function(v) { v = String(v).replace(/^\s+|\s+$/g, ''); return /^".*"$/.test(v) ? v.slice(1, -1) : v; }, pend = null;
        (lines || []).forEach(function(l) { l = String(l == null ? '' : l);
            var m = /^\s*([A-Za-z0-9_ .\/()-]{1,60}):\s(.*?)\s(?:->|\u2192)\s(.*)$/.exec(l);
            if (m) { if (pend) { rows.push(pend); pend = null; } rows.push({field: m[1], before: unq(m[2]), after: unq(m[3])}); return; }
            if (/^-(?!--)/.test(l)) { if (pend) rows.push(pend); pend = {field: '', before: l.substring(1), after: ''}; return; }
            if (/^\+(?!\+\+)/.test(l)) { if (pend && pend.after === '') { pend.after = l.substring(1); rows.push(pend); pend = null; } else rows.push({field: '', before: '', after: l.substring(1)}); return; }
            if (pend) { rows.push(pend); pend = null; }
            var cc = /^\s*Catalog:\s(.*?)\s{2,}Category:\s(.*)$/.exec(l);   // design review (2): one row each (older stored diffs still carry them on one line)
            if (cc) { rows.push({note: 'Catalog: ' + cc[1]}); rows.push({note: 'Category: ' + CAT_NONE(cc[2])}); return; }
            if (/\S/.test(l) && !/^(@@|---|\+\+\+)/.test(l)) rows.push({note: l.replace(/^\s+/, '')});
        });
        if (pend) rows.push(pend);
        return rows;
    }
    function changeCard(lines) {   // escaped HTML: field | old (struck) -> new; max 40 rows
        var rows = changeRows(lines), more = rows.length > 40 ? rows.length - 40 : 0;
        return '<div class="gmgai-chg">' + rows.slice(0, 40).map(function(r) {
            if (r.note != null) { var inact = INACTIVE_TAG.test(r.note); return '<div class="gmgai-cn">' + esc(inact ? r.note.replace(INACTIVE_TAG, '') : r.note) + (inact ? ' <span class="gmgai-chip-inactive">Starts inactive</span>' : '') + '</div>'; }   // design review ruling: same 14px chip as the plan page, no scope
            return '<div class="gmgai-cr">' + (r.field ? '<span class="f">' + esc(r.field) + '</span>' : '') + (r.before !== '' ? '<s>' + esc(r.before) + '</s>' : '<i>new</i>') +
                ' <span class="ar" aria-label="becomes">\u2192</span> ' + (r.after !== '' ? '<b>' + esc(r.after) + '</b>' : '<i>removed</i>') + '</div>';
        }).join('') + (more ? '<div class="gmgai-cn">+' + more + ' more lines</div>' : '') + '</div>';
    }
    function workflowCard(wf) {
        if (!wf || typeof wf !== 'object') return '';
        var statusColors = {
            'planned': '#6B7280',
            'running': '#2563EB',
            'waiting_approval': '#D97706',
            'completed': '#16A34A',
            'failed': '#DC2626',
            'rejected': '#9CA3AF'
        };
        var stColor = statusColors[wf.status] || '#4B5563';
        var out = '<div class="gmgai-wf-card" style="margin-top:8px;border:1px solid #D1D5DB;border-radius:6px;padding:8px;background:#F9FAFB">';
        out += '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">' +
               '<b>Workflow: ' + esc(wf.type || 'Automation') + '</b>' +
               '<span style="font-size:10px;padding:2px 6px;border-radius:4px;color:#fff;background:' + stColor + ';text-transform:uppercase;font-weight:600">' + esc(wf.status || '') + '</span>' +
               '</div>';
        if (wf.goal) out += '<div style="font-size:11px;color:#4B5563;margin-bottom:6px"><i>Goal: ' + esc(wf.goal) + '</i></div>';
        if (wf.steps && wf.steps.length) {
            out += '<div style="display:flex;flex-direction:column;gap:4px">';
            wf.steps.forEach(function(step, idx) {
                var stepColor = statusColors[step.status] || '#9CA3AF';
                var icon = step.status === 'completed' ? '&#10003;' : (step.status === 'failed' ? '&#10007;' : (step.status === 'waiting_approval' ? '&#9888;' : String(idx + 1)));
                out += '<div style="display:flex;align-items:center;gap:6px;font-size:11px;padding:3px 6px;border-radius:4px;background:#FFFFFF;border:1px solid #E5E7EB">' +
                       '<span style="width:16px;height:16px;border-radius:50%;background:' + stepColor + ';color:#fff;display:inline-flex;align-items:center;justify-content:center;font-size:10px;font-weight:bold">' + icon + '</span>' +
                       '<span style="flex:1;font-weight:' + (step.status === 'running' ? '600' : '400') + '">' + esc(step.name || step.tool) + '</span>' +
                       '<span style="font-size:10px;color:' + stepColor + ';font-weight:600">' + esc(step.status) + '</span>' +
                       '</div>';
            });
            out += '</div>';
        }
        if (wf.error) {
            out += '<div style="margin-top:6px;font-size:11px;color:#DC2626"><b>Error:</b> ' + esc(wf.error) + '</div>';
        }
        out += '</div>';
        return out;
    }
    function actionCard(a) {
        var h = '<div class="gmgai-card" data-act="' + esc(a.id) + '"><h4>' + esc((a.operation == 'update' ? 'Update ' : 'Create ') + a.type.replace('_', ' ')) + ': ' + esc(a.target || '') + '</h4>';
        if (a.type == 'knowledge_draft') {
            h = '<div class="gmgai-card" data-act="' + esc(a.id) + '"><h4>' + esc(a.summary || a.title || 'Knowledge Article Draft') + '</h4>';
            h += '<div class="meta"><span class="gmgai-chip" style="background:#EFF6FF;color:#1D4ED8;border-color:#BFDBFE">Knowledge Draft</span> &middot; State: <b>Draft (Review Only)</b>' + (a.incident_number ? ' &middot; Source: <b>' + esc(a.incident_number) + '</b>' : '') + '</div>';

            if (a.sources && a.sources.length) {
                h += '<div style="margin:4px 0;font-size:12px;color:#4B5563"><b>Citations & Evidence Sources:</b> ';
                h += a.sources.map(function(s) {
                    var sNum = (typeof s == 'object' ? s.number || s.tag : s);
                    return '<span class="gmgai-chip" style="background:#F3F4F6;color:#374151;border-color:#D1D5DB">' + esc(sNum) + '</span>';
                }).join(' ');
                h += '</div>';
            }

            h += '<div style="background:#EFF6FF;border:1px solid #BFDBFE;color:#1E40AF;border-radius:6px;padding:6px 8px;margin:5px 0;font-size:12px"><b>KNOWLEDGE GOVERNANCE:</b> Draft created for review. By policy, knowledge articles are never automatically published. Copy or create in Knowledge &gt; Articles &gt; Create New.</div>';

            if (a.content) {
                h += '<div class="gmgai-code-wrap" style="position:relative;margin:6px 0">';
                h += '<div style="display:flex;justify-content:space-between;align-items:center;background:#E5E7EB;padding:3px 8px;border-radius:6px 6px 0 0;font-size:12px">';
                h += '<span>' + esc(a.title || 'Article Content') + '</span>';
                h += '<button class="gmgai-copy-btn" data-code="' + esc(encodeURIComponent(a.content)) + '" style="background:#FFFFFF;border:1px solid #D1D5DB;border-radius:4px;padding:2px 8px;font-size:11px;cursor:pointer">Copy Article</button>';
                h += '</div>';
                h += '<div class="gmgai-diff" style="margin:0;border-radius:0 0 6px 6px;max-height:220px;overflow:auto;white-space:pre-wrap">' + esc(a.content) + '</div>';
                h += '</div>';
            }
            return h + '</div>';
        }
        if (a.type == 'incident_resolution') {
            h = '<div class="gmgai-card" data-act="' + esc(a.id) + '"><h4>' + esc(a.summary || 'Propose Incident Resolution') + '</h4>';
            h += '<div class="meta"><span class="gmgai-chip" style="background:#ECFDF5;color:#065F46;border-color:#A7F3D0">Resolution Proposal</span>' + (a.target_sys_id ? ' &middot; Record: <b>' + esc(a.target_sys_id) + '</b>' : '') + '</div>';

            h += '<div style="margin:5px 0;font-size:13px">';
            h += '<div><b>Close Code:</b> <code>' + esc(a.close_code || 'Solved (Permanently)') + '</code></div>';
            h += '<div style="margin-top:4px"><b>Resolution Notes:</b></div>';
            h += '<div class="gmgai-diff" style="max-height:160px;overflow:auto;white-space:pre-wrap;margin-top:2px">' + esc(a.close_notes || '') + '</div>';
            h += '</div>';

            if (a.instructions) {
                h += '<div style="background:#F0FDF4;border:1px solid #BBF7D0;color:#166534;border-radius:6px;padding:5px 7px;margin:4px 0;font-size:12px">' + esc(a.instructions) + '</div>';
            }

            if (a.can_accept && a.status == 'pending') {
                var actId = a.pending_action_id || a.id;
                h += '<div class="gmgai-act" data-act="' + esc(actId) + '"><button class="gmgai-ok" data-v="confirm">Accept Resolution</button><button class="gmgai-no" data-v="reject">Reject</button></div>';
            } else if (a.close_notes) {
                h += '<div style="margin-top:6px;display:flex;gap:6px">';
                h += '<button class="gmgai-copy-btn" data-code="' + esc(encodeURIComponent(a.close_notes)) + '" style="background:#FFFFFF;border:1px solid #D1D5DB;border-radius:4px;padding:3px 10px;font-size:12px;cursor:pointer">Copy Resolution Notes</button>';
                h += '</div>';
            }
            return h + '</div>';
        }
        if (a.type == 'flow') {
            h += '<div class="meta">' + esc('Flow Designer \u00b7 scope ' + a.scope + ' \u00b7 created as Draft, inactive') + '</div>';
            h += '<div class="gmgai-diff">' + esc(a.flow_summary || '') + '</div>';
            var ra = a.run_as == 'user' ? 'user' : 'system';
            if (a.status == 'pending' && !canAccept(a)) h += '';   // design review ruling (4): no Run As unless Accept is available
            else if (a.status == 'pending' && a.review_route == 'reviewer') h += '<div class="meta">Run As: ' + (ra == 'user' ? 'User who initiates session' : 'System user') + '</div>';   // ruling (b): the reviewed run_as is binding (no picker)
            else if (a.status == 'pending') h += '<div class="meta">Run As: <select class="gmgai-runas" data-id="' + esc(a.id) + '">' +
                '<option value="system"' + (ra == 'system' ? ' selected' : '') + '>System user</option>' +
                '<option value="user"' + (ra == 'user' ? ' selected' : '') + '>User who initiates session</option></select></div>';
            else h += '<div class="meta">Run As: ' + (ra == 'user' ? 'User who initiates session' : 'System user') + '</div>';
            return h + actionFooter(a, 'Open in Workflow Studio') + '</div>';
        }
        if (a.type == 'dev_artifact') {
            h = '<div class="gmgai-card" data-act="' + esc(a.id) + '"><h4>' + esc(a.summary || (a.artifact_label + ': ' + a.name)) + '</h4>';
            h += '<div class="meta"><span class="gmgai-chip">' + esc(a.artifact_label || 'Artifact') + '</span>' + (a.table ? ' Table: <b>' + esc(a.table) + '</b> &middot; ' : '') + 'Scope: <b>' + esc(a.scope || 'global') + '</b></div>';

            if (a.validation) {
                var v = a.validation;
                h += '<div style="margin:6px 0;padding:6px 8px;border-radius:6px;background:var(--surface);border:1px solid var(--border);font-size:13px">';
                h += '<b>Static Analysis:</b> ' + (v.ok ? '<span style="color:#15803D;font-weight:600">\u2714 No Critical Issues</span>' : '<span style="color:#B91C1C;font-weight:600">\u26A0 Critical Issues Detected</span>') + ' &middot; ' + esc(v.summary || '');
                if (v.findings && v.findings.length) {
                    h += '<div style="margin-top:4px;max-height:140px;overflow-y:auto">';
                    v.findings.forEach(function(f) {
                        var col = f.severity == 'Critical' ? '#B91C1C' : f.severity == 'High' ? '#B45309' : f.severity == 'Medium' ? '#D97706' : '#4B5563';
                        var bg = f.severity == 'Critical' ? '#FEF2F2' : f.severity == 'High' ? '#FFFBEB' : '#F9FAFB';
                        h += '<div style="margin:3px 0;padding:3px 6px;border-radius:4px;background:' + bg + ';border-left:3px solid ' + col + '">';
                        h += '<span style="color:' + col + ';font-weight:600">[' + esc(f.severity) + ']</span> ' + esc(f.message) + '</div>';
                    });
                    h += '</div>';
                }
                h += '</div>';
            }

            if (a.code) {
                h += '<div class="gmgai-code-wrap" style="position:relative;margin:6px 0">';
                h += '<div style="display:flex;justify-content:space-between;align-items:center;background:#E5E7EB;padding:3px 8px;border-radius:6px 6px 0 0;font-size:12px;font-family:monospace">';
                h += '<span>' + esc(a.name || a.artifact_label) + '</span>';
                h += '<button class="gmgai-copy-btn" data-code="' + esc(encodeURIComponent(a.code)) + '" style="background:#FFFFFF;border:1px solid #D1D5DB;border-radius:4px;padding:2px 8px;font-size:11px;cursor:pointer">Copy Code</button>';
                h += '</div>';
                h += '<pre class="gmgai-diff" style="margin:0;border-radius:0 0 6px 6px;font-family:ui-monospace,Menlo,monospace;font-size:12px;max-height:220px;overflow:auto"><code>' + esc(a.code) + '</code></pre>';
                h += '</div>';
            }

            if (a.instructions) {
                var warnStyle = a.is_background ? 'background:#FEF2F2;border:1px solid #FCA5A5;color:#991B1B' : 'background:#FFFBEB;border:1px solid #FCD34D;color:#92400E';
                h += '<div style="' + warnStyle + ';border-radius:6px;padding:5px 7px;margin:4px 0;font-size:13px">' + esc(a.instructions) + '</div>';
            }

            if (a.can_accept && a.status == 'pending') {
                var actId = a.pending_action_id || a.id;
                h += '<div class="meta" style="margin-top:6px;color:#15803D">Bound to open record ' + esc(a.bound_table) + ' ' + esc(a.bound_sys_id) + '. Click Accept to apply.</div>';
                h += '<div class="gmgai-act" data-act="' + esc(actId) + '"><button class="gmgai-ok" data-v="confirm">Accept</button><button class="gmgai-no" data-v="reject">Reject</button></div>';
            }
            return h + '</div>';
        }
        if (a.type == 'record') {
            h = '<div class="gmgai-card" data-act="' + esc(a.id) + '"><h4>' + esc(a.target || '') + '</h4>';
            h += '<div class="meta">Record: <a href="' + esc(a.record_link) + '" target="_blank">' + esc(a.record || '') + '</a> (' + esc(a.table) + ')</div>';
            if (a.customer_visible) h += '<div style="background:#fef2f2;border:1px solid #fca5a5;color:#991b1b;border-radius:6px;padding:5px 7px;margin:4px 0;font-size:14px"><b>' + WARN_ICO + ' Customer-visible.</b> This goes into Additional comments and is shown to the caller / customer (and may notify them by email).</div>';
            if (a.state_change) h += '<div style="background:#fffbeb;border:1px solid #fcd34d;color:#92400e;border-radius:6px;padding:5px 7px;margin:4px 0;font-size:14px"><b>State change.</b> ' + esc(a.state_change) + '</div>';
            if (a.rec == 'journal') h += '<div class="meta">' + esc(a.field == 'comments' ? 'Additional comments' : 'Work notes (internal)') + ':</div><div class="gmgai-diff" style="white-space:pre-wrap">' + esc(a.text || '') + '</div>';
            else h += changeCard(a.diff_lines);
            h += '<div class="meta" style="color:#6b7280">' + esc(a.data_warning || '') + '</div>';
            return h + actionFooter(a, 'Open record') + '</div>';
        }
        if (a.type == 'atf') {
            h = '<div class="gmgai-card" data-act="' + esc(a.id) + '"><h4>' + esc(a.target || '') + '</h4><div class="meta">' + esc(a.atf == 'runner' ? 'global \u00b7 needs admin' : 'global \u00b7 needs admin or atf_test_designer') + '</div>';
            if (a.update_set) h += '<div class="meta">Update set: <b>' + esc(a.update_set) + '</b>' + (a.atf == 'test' ? ' \u00b7 created inactive' : '') + '</div>';
            if (a.atf == 'run' && a.inactive && a.status == 'pending') h += '<div class="meta"><label><input type="checkbox" class="gmgai-atfact" data-id="' + esc(a.id) + '"' + (a.activate ? ' checked' : '') + '> Activate the test before running</label></div>';
            if (a.needs_ui && a.atf == 'run' && !a.client_runner_open) h += '<div style="background:#fffbeb;border:1px solid #fcd34d;color:#92400e;border-radius:6px;padding:5px 7px;margin:4px 0;font-size:14px">UI steps need an open Client Test Runner. Without one the run is refused; nothing is faked.</div>';
            h += changeCard(a.diff_lines);
            return h + actionFooter(a, 'Open') + '</div>';
        }
        if (a.type == 'meta') {
            h = '<div class="gmgai-card" data-act="' + esc(a.id) + '"><h4>' + esc(a.target || '') + '</h4><div class="meta">' + esc('global \u00b7 needs ' + (a.roles || 'admin')) + '</div>';
            h += '<div class="meta">Update set: <b>' + esc(a.update_set || '') + '</b>' + (a.update_set_auto ? ' (continues your previous step)' : ' (new)') + '</div>';
            if (a.update_set_auto && a.status == 'pending') h += '<div class="meta"><label><input type="checkbox" class="gmgai-newus" data-id="' + esc(a.id) + '"> Use a new update set instead</label></div>';
            if (a.warning) h += '<div style="background:#fef2f2;border:1px solid #fca5a5;color:#991b1b;border-radius:6px;padding:5px 7px;margin:4px 0;font-size:14px"><b>' + WARN_ICO + ' Irreversible schema change.</b> ' + esc(a.warning) + ' Backing out the update set may not be fully clean: out-of-box form sections can need "Keep Current" in the backout problems, and form elements can be left behind and need manual cleanup. Back Out only appears once your application scope is switched to Global.</div>';
            h += changeCard(a.diff_lines);
            return h + actionFooter(a, 'Open') + '</div>';
        }
        if (a.type == 'catalog_item_edit') {
            h = '<div class="gmgai-card" data-act="' + esc(a.id) + '"><h4>' + esc('Edit catalog item: ' + (a.target || '')) + '</h4><div class="meta">needs catalog_admin \u00b7 applied in a new update set</div>';
            h += changeCard(a.diff_lines);
            if (a.picture && a.picture.url) h += '<div class="meta" style="margin-top:4px"><img src="' + esc(a.picture.url) + '" referrerpolicy="no-referrer" style="max-width:160px;max-height:110px;border:1px solid #e5e7eb;border-radius:6px;display:block;margin-bottom:2px" onerror="this.style.display=\'none\'">' +
                'Image: <a href="' + esc(a.picture.url) + '" target="_blank" rel="noopener">' + esc(a.picture.url.length > 70 ? a.picture.url.substring(0, 70) + '\u2026' : a.picture.url) + '</a><br>Source: ' + esc(a.picture.source || a.picture.host || '') + '</div>';
            return h + actionFooter(a, 'Open catalog item') + '</div>';
        }
        if (a.type == 'catalog_item') {
            var it = a.item || {};
            h += '<div class="meta">' + esc('Catalog ' + (it.catalog || '') + ' \u00b7 category ' + (it.category || '(none)') + ' \u00b7 created inactive \u00b7 needs catalog_admin') + '</div>';
            if (it.short_description) h += '<div class="meta">' + esc(it.short_description) + '</div>';
            h += '<table class="gmgai-vt"><tr><th>#</th><th>Label</th><th>Name</th><th>Type</th><th>Req</th></tr>' + (a.variables || []).map(function(x) {
                return '<tr><td>' + esc(x.order) + '</td><td>' + esc(x.label) + '</td><td><code>' + esc(x.name) + '</code></td><td>' + esc(x.type + (x.reference ? ' \u2192 ' + x.reference : '')) + '</td><td>' + (x.mandatory ? '\u2714' : '') + '</td></tr>' +
                    ((x.choices || []).length ? '<tr><td></td><td colspan="4" style="color:#6b7280">' + esc('Choices: ' + x.choices.map(function(c) { return c.text + ' (' + c.value + ')'; }).join(', ')) + '</td></tr>' : '');
            }).join('') + '</table>';
            return h + actionFooter(a, 'Open catalog item') + '</div>';
        }
        var f = a.fields || {}, meta = [];
        if (f.collection || f.table) meta.push('table ' + (f.collection || f.table));
        if (f.when) meta.push(f.when);
        if (f.type) meta.push(f.type);
        ['action_insert', 'action_update', 'action_delete', 'action_query'].forEach(function(k) { if (f[k] == 'true') meta.push(k.replace('action_', 'on ')); });
        if (f.condition) meta.push('condition: ' + f.condition);
        if (f.filter_condition) meta.push('filter: ' + f.filter_condition);
        if (a.scope) meta.push('scope ' + a.scope);   // 2026-10-19: no 'scope undefined' when a card carries no scope
        if (a.operation == 'create' && f.active == 'false') meta.push('created inactive');
        h += '<div class="meta">' + esc(meta.join(' \u00b7 ')) + '</div>';
        if (a.update_set) h += '<div class="meta gmgai-us">Update set: <b>' + esc(a.update_set) + '</b>' + (a.update_set_new ? ' (new; created when you Accept)' : '') + '</div>';   // shown before Accept
        var dl = a.diff_lines && a.diff_lines.length ? a.diff_lines : a.diff ? String(a.diff).split('\n') : null;   // core artifact cards carry diff_lines (they showed no diff)
        if (dl) h += changeCard(dl);
        else if (a.status == 'pending') h += '<div class="gmgai-cn">No change preview is available for this card.</div>';
        return h + actionFooter(a, 'Open record') + '</div>';
    }
    /* design review final (2): Reviewer notes are plain text everywhere. Markdown emphasis/links/code markers are dropped (not rendered, not shown
     * as raw stars); line breaks kept. The result is still escaped / set as textContent by the caller. */
    function plainNotes(s) { return String(s == null ? '' : s)
        .replace(/!?\[([^\]\n]*)\]\([^)\n]*\)/g, '$1')                       // [text](url) / ![alt](src) -> text
        .replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, '$1').replace(/(^|[^\w])__(?=\S)([\s\S]*?\S)__(?!\w)/g, '$1$2') // **bold** / __bold__ (window.__x kept)
        .replace(/(^|[^\w*])\*(?=\S)([^*\n]*?\S)\*(?!\w)/g, '$1$2')           // *italic*
        .replace(/(^|[^\w])_(?=\S)([^\n]*?[^\s_])_(?!\w)/g, '$1$2')              // _italic_ (snake_case kept)
        .replace(/~~(?=\S)([^~\n]*?\S)~~/g, '$1').replace(/`+([^`\n]+)`+/g, '$1') // ~~strike~~, `code`
        .replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, '').replace(/^[ \t]{0,3}>[ \t]?/gm, '') // # headings, > quotes
        .replace(/\*\*/g, ''); }                                              // leftover unpaired **
    /* Reviewer result on team proposals (fields come from the build's actions; absent on single-agent cards, so nothing changes there).
     * review_state: pending_review | passed | rejected; review_notes: Reviewer notes and findings (plain text, escaped). */
    function reviewBlock(a) {
        if (!a.review_state || a.review_state == 'none') return '';
        var st = {pending_review: ['Waiting for the Reviewer', '#6b7280', '#f3f4f6', false], passed: ['\u2714 Reviewer passed', '#15803d', '#f0fdf4', false],
                  rejected: ['Didn\u2019t pass after 2 tries', '#92400e', '#fef3c7', true]}[a.review_state] || [a.review_state, '#374151', '#f3f4f6', false];
        /* design review ruling (3): the not-passed reason uses the page's amber callout (3px bar var(--note-bar), var(--note-bg), 14px/600 head, 16px reason) */
        if (a.review_state == 'rejected') return '<div class="gmgai-review gmgai-rv-note" role="note"><p class="gmgai-rv-head">' + esc(st[0]) + '</p>' + (a.review_notes ? '<p class="gmgai-rv-body">' + esc(plainNotes(a.review_notes)) + '</p>' : '') + '</div>';
        return '<div class="gmgai-review" style="font-size:14px;color:' + st[1] + ';background:' + st[2] + ';padding:4px 6px;border-radius:4px;margin-top:4px">' +
            '<b>' + (st[3] ? WARN_ICO + ' ' : '') + esc(st[0]) + '</b>' + (a.review_notes ? '<div style="white-space:pre-wrap;margin-top:2px">' + esc(plainNotes(a.review_notes)) + '</div>' : '') + '</div>';
    }
    /* Applied-card links: a string path or nothing, never 'undefined'. A card without a server link may get one from a panel extension's
     * cardLink hook (same safeLink allowlist); otherwise it renders no link at all. */
    /* AC-R1.10 (+addendum 2: no dot segments / %2e; nav_to whole-string): only same-origin app links: no backslash, control char or encoded slash/backslash; ^/ not // or /\; allowlisted prefixes. */
    function safeLink(u) { u = typeof u == 'string' ? u : ''; if (!(/^\/(?![\/\\])/.test(u) && !/[\\\x00-\x1f\x7f\s"'<>]|%2f|%5c|undefined|null/i.test(u) && !/\.\.|\/\.\/|\/\.$|%2e/i.test(u) && (/^\/nav_to\.do\?/.test(u) ? /^\/nav_to\.do\?uri=x_gmg_ai_[a-z0-9_]+\.do(%3F[A-Za-z0-9_.%-]*)?$/.test(u) : /^\/sys_update_set\.do\?sys_id=[0-9a-f]{32}$/.test(u) || /^\/(?:now\/workflow-studio\/builder\?|x_gmg_ai_)/.test(u) || /^\/[a-z][a-z0-9_]{0,79}\.do\?sys_id=[0-9a-f]{32}$/.test(u)))) return ''; try { if (typeof location != 'undefined' && location.origin && new URL(u, location.origin).origin !== location.origin) return ''; } catch (e) { return ''; } return u; }   // the URL same-origin check is browser-only and runs after it
    function openLink(a) {
        var l = safeLink(a.link); if (l) return l;
        var id = String(a.target_sys_id || a.sys_id || '');
        if (!SYSID_RE.test(id)) return '';
        var hl = hook('cardLink', [copy(a)]);   // os-cleanup: extension-supplied link (e.g. paid flow cards); still only an allowlisted same-origin path
        for (var i = 0; i < hl.length; i++) { var x = safeLink(hl[i]); if (x) return x; }
        return '';
    }
    /* a card that didn't pass review has no Accept button at all (ActionService.confirm also returns 409).
     * review_gate (server, buildActions) non-empty = refused; a Reviewer-routed or reviewed card needs review_state passed. */
    function canAccept(a) {
        if (a.review_gate || a.out_of_date) return false;
        var rs = String(a.review_state || '');
        if (rs == 'rejected' || rs == 'pending_review') return false;
        if (a.review_route == 'reviewer' && rs != 'passed') return false;
        return true;
    }
    /* design review ruling (3): local time, e.g. 'Expires at 12:20 PM CT' (expires_ms from the server; generic zone name, CDT/CST -> CT) */
    function expiresText(a) {
        var ms = Number(a && a.expires_ms);
        if (!(ms > 0)) return 'Expires ' + String((a && a.expires) || 'in 30 min');
        var d = new Date(ms), t;
        try { t = d.toLocaleTimeString('en-US', {hour: 'numeric', minute: '2-digit', timeZoneName: 'shortGeneric'}); }
        catch (e) { t = d.toLocaleTimeString('en-US', {hour: 'numeric', minute: '2-digit', timeZoneName: 'short'}).replace(/\b([A-Z])[DS]T\b/, '$1T'); }
        return 'Expires at ' + t.replace(/\u202f/g, ' ');
    }
    function actionFooter(a, openLabel) {
        var h = reviewBlock(a);
        if (a.live_warning) h += '<div class="gmgai-live" style="background:#fef2f2;border:1px solid #fca5a5;color:#991b1b;border-radius:6px;padding:5px 7px;margin:4px 0;font-size:14px"><b>Live change.</b> ' + esc(a.live_warning) + '</div>';   // step 8
        if (a.status == 'pending_review') return h;   // no Confirm until the Reviewer has passed it (ActionService also refuses non-pending)
        if (a.status == 'superseded') return h + '<div class="gmgai-st" style="color:#6b7280">Superseded by a revised proposal (kept, not deleted).</div>';
        if (a.status == 'pending' && a.out_of_date) h += outOfDate(a);   // f25 design review: info, not red; Reject stays below
        if (a.status == 'pending') h += '<div class="gmgai-act">' + (canAccept(a) ? '<button class="gmgai-ok" data-v="confirm">Accept</button>' : '') + '<button class="gmgai-no" data-v="reject">Reject</button>' +
            '<span class="gmgai-exp" style="font-size:14px;align-self:center">' + esc(expiresText(a)) + '</span></div>';
        else if (a.status == 'working') h += '<div class="gmgai-st">Applying\u2026</div>';
        else if (a.status == 'applied') { var ol = openLink(a), ul = safeLink(a.update_set_link);
            h += '<div class="gmgai-st" style="color:#15803d">\u2714 Applied.' + (ol ? ' <a href="' + esc(ol) + '" target="_blank">' + esc(openLabel) + '</a>' : '') +
                (ul ? ' \u00b7 <a href="' + esc(ul) + '" target="_blank">' + esc(a.update_set_name || 'Update set') + '</a>' : /^record_/.test(String(a.type || '')) ? ' \u00b7 data write (no update set)' : '') + '</div>'; }
        else if (a.status == 'refused') h += '<div class="gmgai-st" style="color:#92400e;background:#fef3c7;padding:4px 6px;border-radius:4px">' + STOP_SVG + 'Not allowed: ' + esc(a.error || 'you do not have permission to accept this change.') + '</div>';
        else h += '<div class="gmgai-st" style="color:#991b1b">' + esc(a.status) + (a.error ? ': ' + a.error : '') + '</div>';
        return h;
    }
    /* f25 (design review wording): a card whose stored hash predates the current canon. Still 409 on Accept; 14px secondary text + info icon;
     * 'Ask again' resends the request that produced the card when we still have it. */
    function askText(id) { var s = load(), t = ''; (s.messages || []).forEach(function(m, i) { if ((m.actions || []).some(function(a) { return a.id == id; }))
        for (var k = i - 1; k >= 0 && !t; k--) if (s.messages[k].role == 'user') t = String(s.messages[k].content || ''); }); return t; }
    function outOfDate(a) { return '<div class="gmgai-st gmgai-ood" role="note" style="font-size:14px;color:var(--text-secondary)">' + INFO_SVG + esc(a.error || a.review_gate || '') +
        (askText(a.id) ? ' <button class="gmgai-ask" data-v="ask_again" style="font-size:14px;background:none;border:0;padding:0;color:var(--text-secondary);text-decoration:underline;cursor:pointer">Ask again</button>' : '') + '</div>'; }
    /* SCREEN-REVIEW #26: say a refusal once. A blocked answer whose card already shows the same refusal renders only the card. */
    function repeatsCard(m) { var t = String(m.content || '').replace(/^(Refused|Error): /, ''); return !!(m.error && t && (m.actions || []).some(function(a) { return a.status == 'refused' && String(a.error || '') == t; })); }
    function decide(id, verb) {
        var s = load(), act = null, msg = null;
        s.messages.forEach(function(m) { (m.actions || []).forEach(function(a) { if (a.id == id) { act = a; msg = m; } }); });
        (s.buildActions || []).forEach(function(a) { if (a.id == id) act = a; });   // team build cards (same Confirm path)
        if (!act || act.status != 'pending') return;
        if (verb == 'ask_again') { var q = askText(id); if (q) send(q); return; }
        var body = '{}';
        if (act.type == 'flow') {
            var sel = null; try { sel = top.document.querySelector('select.gmgai-runas[data-id="' + id + '"]') || document.querySelector('select.gmgai-runas[data-id="' + id + '"]'); } catch (e) {}
            act.run_as = sel && sel.value == 'user' ? 'user' : (sel ? 'system' : (act.run_as == 'user' ? 'user' : 'system'));
            body = JSON.stringify({run_as: act.run_as});
        }
        if (act.type == 'meta' && verb == 'confirm') {
            var cb = null; try { cb = top.document.querySelector('input.gmgai-newus[data-id="' + id + '"]') || document.querySelector('input.gmgai-newus[data-id="' + id + '"]'); } catch (e) {}
            if (cb && cb.checked) { body = JSON.stringify({new_update_set: true}); act.update_set = act.new_update_set_name || ''; act.update_set_auto = false; }
        }
        if (act.type == 'atf' && act.atf == 'run' && verb == 'confirm') {
            var ab = null; try { ab = top.document.querySelector('input.gmgai-atfact[data-id="' + id + '"]') || document.querySelector('input.gmgai-atfact[data-id="' + id + '"]'); } catch (e) {}
            if (ab) { act.activate = !!ab.checked; body = JSON.stringify({activate: act.activate}); }
        }
        act.status = 'working'; save(s); render();
        w.fetch('/api/x_gmg_ai/agent/action/' + encodeURIComponent(id) + '/' + verb, {method: 'POST', credentials: 'same-origin',
            headers: {'Accept': 'application/json', 'Content-Type': 'application/json', 'X-UserToken': top.__gmgaiToken || w.g_ck || ''}, body: body})
            .then(function(r) { return r.json(); }).then(function(j) {
                var r = j.result || j, st = load();
                if (verb == 'confirm' && r.state_changed) {   // step 8: active changed since the card was made; nothing applied, card shown again with the current warning
                    var re = function(a) { if (a.id == id) { a.status = 'pending'; a.error = r.error; a.live_warning = r.live_warning || ''; a.data_warning = r.data_warning || ''; if (r.diff) a.diff_lines = r.diff; } };
                    st.messages.forEach(function(m) { (m.actions || []).forEach(re); }); (st.buildActions || []).forEach(re);
                    save(st); top.__gmgaiRender && top.__gmgaiRender(); return; }
                if (verb == 'confirm' && r.out_of_date) {   // f25: still refused; keep the card open so Reject stays available
                    var mark = function(a) { if (a.id == id) { a.status = 'pending'; a.out_of_date = true; a.error = r.error; } };
                    st.messages.forEach(function(m) { (m.actions || []).forEach(mark); }); (st.buildActions || []).forEach(mark);
                    save(st); top.__gmgaiRender && top.__gmgaiRender(); return; }
                st.messages.forEach(function(m) { (m.actions || []).forEach(function(a) { if (a.id == id) {
                    a.status = r.status || (r.ok ? 'applied' : 'failed'); a.error = r.error; a.link = r.link; a.target_sys_id = r.sys_id || a.target_sys_id; a.update_set_link = r.update_set_link; a.update_set_name = r.update_set_name; } }); });
                (st.buildActions || []).forEach(function(a) { if (a.id == id) { a.status = r.status || (r.ok ? 'applied' : 'failed'); a.error = r.error; a.link = r.link; a.target_sys_id = r.sys_id || a.target_sys_id; a.update_set_link = r.update_set_link; a.update_set_name = r.update_set_name; } });
                if (!(verb == 'confirm' && r.status == 'refused')) st.messages.push({role: 'assistant', content: verb == 'confirm'
                    ? (r.ok ? 'Accepted and applied ' + (act.target || '') + ' (' + r.link + ')' + (r.update_set_name ? ' in update set "' + r.update_set_name + '"' : (r.data_write ? ' as a data write (no update set)' : ' (no update set)')) + '.' : (r.status == 'refused' ? 'Refused: ' : 'Apply failed: ') + (r.error || 'unknown error'))
                    : (r.ok ? 'Rejected proposal for ' + (act.target || '') + '. Nothing was changed.' : 'Reject failed: ' + r.error)});
                save(st); top.__gmgaiRender && top.__gmgaiRender();
                hook('onConfirmed', [id, r]);   // extension refresh (paid: build cards/strip from the server)
            })['catch'](function(e) { var st = load(); st.messages.push({role: 'assistant', error: true, content: 'Error: ' + e}); save(st); top.__gmgaiRender && top.__gmgaiRender(); });
    }

    /* design review: text-style warning + circle-slash stop (HTML paths). Escaped message content uses \u2715 fallback. */
    var WARN_ICO = '<span style="color:#B45309" aria-hidden="true">\u26a0\ufe0e</span>';
    var INFO_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 14 14" aria-hidden="true" style="display:inline-block;vertical-align:-2px;margin-right:3px"><circle cx="7" cy="7" r="5.5" fill="none" stroke="currentColor" stroke-width="1.5"/><line x1="7" y1="6.2" x2="7" y2="10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><circle cx="7" cy="4.2" r="0.9" fill="currentColor"/></svg>';
    var STOP_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 14 14" aria-hidden="true" style="display:inline-block;vertical-align:-2px;margin-right:3px"><circle cx="7" cy="7" r="5.5" fill="none" stroke="#B91C1C" stroke-width="1.5"/><line x1="3.2" y1="3.2" x2="10.8" y2="10.8" stroke="#B91C1C" stroke-width="1.5" stroke-linecap="round"/></svg>';
    var CSS = '#gmgai-root{' +
        'position:fixed;right:20px;bottom:20px;z-index:2147483000;' +
        'font:13px/1.45 Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;' +
        '--np-background:#EEECE8;--np-surface:#FFFFFF;--np-surface-muted:#F5F4F1;--np-navy:#002B3B;--np-green:#63E052;' +
        '--np-green-hover:#4CCB3B;--np-text:#111111;--np-text-secondary:#626262;--np-border:#DEDCD7;--np-danger:#D92D20;' +
        '--np-shadow:0 8px 28px rgba(0,0,0,0.12);' +
        '--card:var(--np-surface);--surface:var(--np-surface-muted);--border:var(--np-border);--border-strong:var(--np-green);' +
        '--text-primary:var(--np-text);--text-secondary:var(--np-text-secondary);--danger:var(--np-danger);' +
        '--note-bar:#F59E0B;--note-bg:rgba(245,158,11,.1);--primary-accent:var(--np-green);' +
        'color:var(--np-text);-webkit-font-smoothing:antialiased}' +
        '.gmgai-select{font-family:inherit;font-size:12px;font-weight:500;padding:5px 10px;border:1px solid #E5E5E5;' +
        'border-radius:8px;background:#FFFFFF;color:#111111;max-width:130px;cursor:pointer;outline:none;' +
        'text-overflow:ellipsis;white-space:nowrap;box-sizing:border-box;transition:all .15s ease}' +
        '.gmgai-select:focus{border-color:var(--np-green);box-shadow:0 0 0 2px rgba(82,223,101,0.2)}' +
        '#gmgai-btn{width:56px;height:56px;border-radius:50%;border:2px solid #002B3B;background:#FFFFFF !important;' +
        'box-shadow:0 6px 20px rgba(0,0,0,0.15),0 0 12px rgba(82,223,101,0.25);cursor:pointer;display:grid;place-items:center;' +
        'padding:0;overflow:hidden;transition:all .18s ease;z-index:2147483000;box-sizing:border-box}' +
        '#gmgai-btn:hover{transform:translateY(-2px);border-color:var(--np-green);box-shadow:0 10px 24px rgba(0,0,0,0.2),0 0 16px rgba(82,223,101,0.45)}' +
        '#gmgai-btn:active{transform:translateY(0);box-shadow:0 4px 12px rgba(0,0,0,0.15)}' +
        '#gmgai-btn svg{display:block}' +
        '#gmgai-btn:focus-visible,#gmgai-root :focus-visible{outline:2px solid var(--np-green);outline-offset:2px}' +
        '#gmgai-panel{position:fixed;right:16px;bottom:16px;width:460px;height:680px;max-height:88vh;max-width:calc(100vw - 32px);' +
        'background:#FFFFFF;border:1px solid var(--np-border);border-radius:18px;box-shadow:var(--np-shadow);' +
        'display:flex;flex-direction:column;overflow:hidden;color:var(--np-text);box-sizing:border-box}' +
        '#gmgai-head{padding:12px 16px;background:#FFFFFF;color:var(--np-text);display:flex;' +
        'justify-content:space-between;align-items:center;border-bottom:1px solid var(--np-border);gap:8px;box-sizing:border-box;flex-shrink:0}' +
        '#gmgai-head .gmgai-brand{display:flex;align-items:center;gap:12px;min-width:0;flex:1 1 auto;overflow:hidden}' +
        '#gmgai-head .gmgai-title-wrap{min-width:0;overflow:hidden;display:flex;flex-direction:column}' +
        '#gmgai-head .gmgai-title{font-size:16px;font-weight:700;color:#111111;line-height:1.2;white-space:nowrap;letter-spacing:-0.2px}' +
        '#gmgai-head small{display:block;color:var(--np-text-secondary);font-size:11.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:200px;line-height:1.3;font-weight:400;margin-top:2px}' +
        '#gmgai-head .gmgai-controls{display:flex;align-items:center;gap:8px;flex-shrink:0}' +
        '#gmgai-head button{background:transparent;border:0;color:var(--np-text-secondary);cursor:pointer;padding:4px 6px;border-radius:6px;font-size:12px;font-weight:500;transition:all .15s ease;flex-shrink:0;font-family:inherit}' +
        '#gmgai-head button:hover{color:#111111;background:rgba(0,0,0,0.04)}' +
        '#gmgai-head #gmgai-close{background:transparent;color:#626262;border:0;padding:4px;border-radius:6px;display:inline-flex;align-items:center;justify-content:center;cursor:pointer;flex-shrink:0;transition:all .15s ease}' +
        '#gmgai-head #gmgai-close:hover{background:#F3F4F6;color:#111111}' +
        '#gmgai-head #gmgai-close:focus-visible{outline:2px solid var(--np-green);outline-offset:1px}' +
        '#gmgai-mode-bar{display:flex;border-bottom:1px solid var(--np-border);background:#FFFFFF;box-sizing:border-box;flex-shrink:0;padding:0 12px;gap:6px}' +
        '#gmgai-mode-bar button{padding:10px 10px;border:0;background:transparent;font-size:12px;font-weight:500;color:var(--np-text-secondary);cursor:pointer;text-align:center;white-space:nowrap;transition:all .15s ease;font-family:inherit;border-bottom:3px solid transparent;position:relative}' +
        '#gmgai-mode-bar button:hover{color:#111111}' +
        '#gmgai-mode-bar button.gmgai-tab-active{color:#111111;font-weight:600;border-bottom-color:var(--np-green);border-radius:3px 3px 0 0}' +
        '#gmgai-msgs{flex:1;overflow-y:auto;padding:16px;background:var(--np-background);color:var(--np-text);box-sizing:border-box}' +
        '.gmgai-hero-card{background:#F6F4EE;border:1px solid rgba(0,0,0,0.04);border-radius:14px;padding:18px 20px;display:flex;gap:14px;align-items:flex-start;margin-bottom:16px;box-sizing:border-box}' +
        '.gmgai-hero-icon{flex-shrink:0;width:32px;height:32px;display:flex;align-items:center;justify-content:center}' +
        '.gmgai-hero-text{flex:1;min-width:0}' +
        '.gmgai-hero-text h3{margin:0 0 6px 0;font-size:17.5px;font-weight:700;color:#111111;line-height:1.25}' +
        '.gmgai-hero-text p{margin:0;font-size:13px;line-height:1.48;color:#525252}' +
        '.gmgai-examples-head{font-size:13.5px;font-weight:700;color:#111111;margin:16px 0 10px 0}' +
        '.gmgai-bento-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px}' +
        '.gmgai-bento-card{background:#FFFFFF;border:1px solid #ECEAE5;border-radius:12px;padding:12px;display:flex;align-items:center;gap:10px;cursor:pointer;text-align:left;transition:all .15s ease;box-shadow:0 1px 3px rgba(0,0,0,0.02);width:100%;box-sizing:border-box;font-family:inherit}' +
        '.gmgai-bento-card:hover{border-color:var(--np-green);transform:translateY(-1px);box-shadow:0 4px 12px rgba(0,0,0,0.05)}' +
        '.gmgai-bento-icon{width:34px;height:34px;border-radius:50%;display:flex;align-items:center;justify-content:center;flex-shrink:0}' +
        '.gmgai-bento-content{flex:1;min-width:0}' +
        '.gmgai-bento-title{font-size:12.5px;font-weight:600;color:#111111;line-height:1.3;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
        '.gmgai-bento-sub{font-size:11px;color:#6B7280;line-height:1.3;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
        '.gmgai-bento-arrow{color:#9CA3AF;flex-shrink:0;display:flex;align-items:center}' +
        '.gmgai-m{margin:6px 0;padding:10px 14px;border-radius:12px;font-size:13px;line-height:1.5;white-space:pre-wrap;word-wrap:break-word;max-width:88%;box-sizing:border-box}' +
        '.gmgai-u{background:#002B3B;color:#FFFFFF;margin-left:auto;border-bottom-right-radius:2px;box-shadow:0 1px 4px rgba(0,43,59,0.15)}' +
        '.gmgai-a{background:#FFFFFF;border:1px solid #ECEAE5;color:var(--np-text);border-bottom-left-radius:2px;box-shadow:0 1px 4px rgba(0,0,0,0.03);max-width:92%}' +
        '.gmgai-e{background:#FEF2F2;border:1px solid #FCA5A5;color:var(--np-danger)}' +
        '.gmgai-chip{display:inline-block;font:11px ui-monospace,Menlo,monospace;background:#F5F4F0;color:#002B3B;border:1px solid #ECEAE5;border-radius:4px;padding:1px 6px;margin:0 3px 3px 0;font-weight:500}' +
        '.gmgai-sug{display:block;width:100%;text-align:left;margin:4px 0;padding:8px 12px;border:1px solid #ECEAE5;border-radius:8px;background:#FFFFFF;cursor:pointer;color:var(--np-text);font-size:12px;font-weight:500;transition:all .15s ease;box-shadow:0 1px 3px rgba(0,0,0,0.02);box-sizing:border-box;font-family:inherit}' +
        '.gmgai-sug:hover{border-color:var(--np-green);background:#F5FDF4;color:#002B3B;transform:translateX(2px)}' +
        '#gmgai-in{display:flex;gap:8px;padding:12px 14px;border-top:1px solid var(--np-border);background:#FFFFFF;box-sizing:border-box;flex-shrink:0;align-items:center}' +
        '#gmgai-clip{width:38px;height:38px;border-radius:50%;background:#FFFFFF;border:1px solid #E5E5E5;display:flex;align-items:center;justify-content:center;cursor:pointer;color:#525252;flex-shrink:0;box-shadow:0 1px 2px rgba(0,0,0,0.03);transition:all .15s ease;padding:0}' +
        '#gmgai-clip:hover{border-color:var(--np-green);color:#111111}' +
        '#gmgai-in textarea{flex:1;resize:none;height:38px;border:1px solid #E5E5E5;border-radius:10px;padding:9px 12px;font:inherit;font-size:13px;line-height:1.4;background:#FFFFFF;color:var(--np-text);box-sizing:border-box;transition:border-color .15s ease}' +
        '#gmgai-in textarea:focus{border-color:var(--np-green);outline:none;box-shadow:0 0 0 2px rgba(82,223,101,0.2)}' +
        '#gmgai-in button#gmgai-send{border:0;border-radius:10px;background:var(--np-green);color:#061D24;font-weight:600;font-size:13px;padding:0 18px;height:38px;cursor:pointer;transition:all .15s ease;flex-shrink:0;box-shadow:0 2px 6px rgba(82,223,101,0.25);font-family:inherit;display:inline-flex;align-items:center;gap:6px}' +
        '#gmgai-in button#gmgai-send:hover:not(:disabled){background:var(--np-green-hover)}' +
        '#gmgai-in button#gmgai-send:active:not(:disabled){transform:scale(0.98)}' +
        '#gmgai-in button#gmgai-send:disabled{opacity:0.55;cursor:not-allowed;box-shadow:none}' +
        '.gmgai-foot{font-size:11px;color:var(--np-text-secondary);margin-top:6px;border-top:1px solid var(--np-border);padding-top:4px}' +
        '.gmgai-warn{background:#FFFBEB;border:1px solid #FCD34D;color:#92400E;border-radius:6px;padding:5px 8px;margin-top:5px;font-size:12px}' +
        '.gmgai-card{border:1px solid var(--np-border);background:var(--np-surface);border-radius:10px;padding:10px 12px;margin:6px 0;max-width:100%;color:var(--np-text);font-size:12.5px;box-shadow:0 1px 4px rgba(0,0,0,0.03);box-sizing:border-box}' +
        '.gmgai-card h4{margin:0 0 4px;font-size:13px;font-weight:600;color:var(--np-navy)}' +
        '.gmgai-card .meta{font-size:11px;color:var(--np-text-secondary);margin-bottom:4px}' +
        '.gmgai-diff{background:var(--np-surface-muted);color:var(--np-text);border:1px solid var(--np-border);font:11.5px/1.45 ui-monospace,Menlo,monospace;border-radius:6px;padding:6px 8px;max-height:200px;overflow:auto;white-space:pre-wrap}' +
        '.gmgai-chip-inactive{display:inline-block;font-size:11px;line-height:18px;padding:0 6px;border-radius:999px;border:1px solid var(--np-border);color:var(--np-text-secondary);font-weight:500;vertical-align:middle}' +
        '.gmgai-cr s,.gmgai-cr b{white-space:pre-wrap}' +
        '.gmgai-chg{border:1px solid var(--np-border);border-radius:6px;background:var(--np-surface-muted);margin:5px 0;max-height:240px;overflow:auto}' +
        '.gmgai-cr,.gmgai-cn{padding:5px 8px;border-top:1px solid var(--np-border);font-size:12px;line-height:1.4;word-break:break-word;color:var(--np-text)}.gmgai-chg>div:first-child{border-top:0}' +
        '.gmgai-cr .f{display:block;font:11px ui-monospace,Menlo,monospace;color:var(--np-text-secondary);margin-bottom:2px}' +
        '.gmgai-cr s{color:#B91C1C;background:rgba(217,45,32,0.1);border-radius:3px;padding:0 3px}' +
        '.gmgai-cr b{color:#15803D;background:rgba(99,224,82,0.18);border-radius:3px;padding:0 3px;font-weight:600}' +
        '.gmgai-cr .ar{color:var(--np-text-secondary)}' +
        '.gmgai-cr i{color:var(--np-text-secondary)}' +
        '.gmgai-cn{color:var(--np-text)}' +
        '.gmgai-act{display:flex;gap:6px;margin-top:6px}' +
        '.gmgai-act button{border:0;border-radius:6px;padding:5px 12px;cursor:pointer;font-size:11.5px;font-weight:600;transition:background .15s ease;font-family:inherit}' +
        '.gmgai-ok{background:var(--np-green);color:var(--np-navy)}.gmgai-ok:hover{background:var(--np-green-hover)}' +
        '.gmgai-no{background:var(--np-surface);color:var(--np-danger);border:1px solid var(--np-border) !important}.gmgai-act button.gmgai-no:hover{border-color:var(--np-danger) !important;background:#FEE2E2}' +
        '.gmgai-rv-note{border-left:3px solid var(--note-bar);background:var(--note-bg);border-radius:6px;padding:8px 12px;margin:8px 0 4px}' +
        '.gmgai-rv-head{font-size:12px;font-weight:600;line-height:16px;color:var(--np-text);margin:0 0 3px}.gmgai-rv-body{font-size:13px;line-height:18px;color:var(--np-text);white-space:pre-wrap;overflow-wrap:anywhere;margin:0}' +
        '.gmgai-st{font-size:12px;margin-top:4px;font-weight:600}.gmgai-st a{color:var(--np-navy);text-decoration:underline}' +
        '.gmgai-tw{overflow-x:auto;max-width:100%;margin:4px 0}.gmgai-mt{border-collapse:collapse;font-size:12px;line-height:1.4;white-space:normal;width:100%}' +
        '.gmgai-mt th,.gmgai-mt td{border:1px solid var(--np-border);padding:4px 6px;text-align:left;vertical-align:top}' +
        '.gmgai-mt th{background:var(--np-surface-muted);font-weight:600;color:var(--np-navy)}' +
        '.gmgai-vt{border-collapse:collapse;width:100%;font-size:12px;margin-top:4px}.gmgai-vt th,.gmgai-vt td{border-bottom:1px solid var(--np-border);padding:4px 6px;text-align:left;vertical-align:top}' +
        '.gmgai-m ul,.gmgai-m ol{margin:4px 0;padding-left:20px;white-space:normal}.gmgai-m code{font:11.5px ui-monospace,Menlo,monospace;background:var(--np-surface-muted);border:1px solid var(--np-border);border-radius:3px;padding:1px 4px;color:var(--np-navy)}' +
        '.gmgai-no-chip{display:inline-flex;align-items:center;gap:4px;height:22px;padding:0 8px;border:1px solid var(--np-danger);border-radius:99px;color:var(--np-danger);font-size:11px;font-weight:600}.gmgai-no-chip:before{content:"";width:6px;height:6px;border-radius:50%;background:var(--np-danger)}' +
        '.gmgai-cost{display:inline-flex;align-items:center;height:22px;padding:0 8px;border:1px solid var(--np-border);border-radius:99px;background:var(--np-surface);color:var(--np-text-secondary);font-size:11px}';
    var PAPI = '/api/x_gmg_ai/agent/providers';
    /* Model picker: list comes from the server (safe fields only); the server validates whatever id we send. */
    function loadProviders() {
        if (top.__gmgaiProvLoading) return; top.__gmgaiProvLoading = true;
        w.fetch(PAPI, {credentials: 'same-origin', headers: {'Accept': 'application/json', 'X-UserToken': top.__gmgaiToken || w.g_ck || ''}})
            .then(function(r) { return r.json(); })
            .then(function(j) {
                var r = (j && j.result) || j || {}, s = load();
                top.__gmgaiProviders = r.providers || [];
                var ok = top.__gmgaiProviders.some(function(p) { return p.sys_id == s.provider; });
                if (!ok) s.provider = r.selected || '';
                save(s); top.__gmgaiRender && top.__gmgaiRender();
            })['catch'](function() {})
            .then(function() { top.__gmgaiProvLoading = false; });
    }

    /* Open-core split step 4: panel extensions. GMG Plan & Create ships its own UI Script that does
     *   (window.__gmgaiExtQ = window.__gmgaiExtQ || []).push(ext)   // ext = {id, feature, renderStrip, headerControls, bind, onSend, onConfirmed, onBoot, onOpen, onClear}
     * which works in either load order (register() drains the queue). Hooks run only when GET /health client.features lists ext.feature;
     * with no extension registered the panel makes no /health call and no build request. Every hook gets a read-only COPY of the panel
     * state plus the small action API below (the only way an extension changes state) and runs in try/catch (a throw is logged, skipped). */
    var EXTS = [], FEATURES = null, booted = false, HAPI = '/api/x_gmg_ai/agent/health';
    function copy(x) { return JSON.parse(JSON.stringify(x)); }
    function extLog(m) { try { w.console && w.console.warn && w.console.warn('GMG AI: ' + m); } catch (e) {} }
    var EXT_API = {
        state: function() { return copy(load()); },
        setBuild: function(b, cards) { var s = load(); s.build = b ? copy(b) : null; s.buildActions = cards ? copy(cards) : []; save(s); },
        setTeam: function(v) { var s = load(); s.team = !!v; save(s); },
        addMessage: function(m) { m = m || {}; var s = load(); s.messages.push({role: m.role == 'user' ? 'user' : 'assistant', content: String(m.content || ''), error: !!m.error}); save(s); },
        done: function() { var s = load(); s.pending = false; save(s); top.__gmgaiRender && top.__gmgaiRender(); },   // onSend === true: the extension calls this when its reply is in
        open: function() { var s = load(); openedHere = true; s.open = true; save(s); },
        render: function() { top.__gmgaiRender && top.__gmgaiRender(); },
        headers: function() { return {'Content-Type': 'application/json', 'Accept': 'application/json', 'X-UserToken': top.__gmgaiToken || w.g_ck || ''}; },
        esc: function(x) { return esc(x); }, cents: function(n) { return cents(n); }, param: function(n, q) { return param(n, q); },
        actionCard: function(a) { return actionCard(a); }
    };
    function extOn(x) { return !!FEATURES && FEATURES.indexOf(x.feature) >= 0; }
    function hook(name, args) {
        var out = [], i, x, r;
        for (i = 0; i < EXTS.length; i++) {
            x = EXTS[i];
            if (!extOn(x) || typeof x[name] != 'function') continue;
            try { r = x[name].apply(x, [copy(load()), EXT_API].concat(args || [])); if (r !== undefined && r !== null) out.push(r); }
            catch (e) { extLog('panel extension ' + x.id + '.' + name + ' threw: ' + e); }
        }
        return out;
    }
    function extBoot() {
        var i, x;
        for (i = 0; i < EXTS.length; i++) {
            x = EXTS[i];
            if (x.__booted || !extOn(x)) continue;
            x.__booted = true;
            if (typeof x.onBoot == 'function') { try { x.onBoot(copy(load()), EXT_API); } catch (e) { extLog('panel extension ' + x.id + '.onBoot threw: ' + e); } }
        }
    }
    function extStart() {
        if (!booted || !EXTS.length) return;
        if (FEATURES !== null) { render(); extBoot(); return; }
        if (w.__gmgaiFeatLoading) return;
        w.__gmgaiFeatLoading = true;
        w.fetch(HAPI, {credentials: 'same-origin', headers: {'Accept': 'application/json', 'X-UserToken': top.__gmgaiToken || w.g_ck || ''}})
            .then(function(r) { return r.json(); })
            .then(function(j) { var r = (j && j.result) || j || {}; FEATURES = r.client && r.client.features instanceof Array ? r.client.features : []; })
            ['catch'](function() { FEATURES = []; })
            .then(function() { w.__gmgaiFeatLoading = false; if (FEATURES.length) { render(); extBoot(); } });
    }
    function register(x) {
        if (!x || typeof x.id != 'string' || typeof x.feature != 'string') return false;
        for (var i = 0; i < EXTS.length; i++) if (EXTS[i].id == x.id) return false;
        EXTS.push(x); extStart(); return true;
    }

    /* design review: on our pages an open panel must not cover Accept/Reject or 'Create it': narrow the content frame's main column. */
    var PANEL_ROOM = 512;   // #gmgai-panel width 480 + right 16 + gap 16
    function shiftContent(open) { try { if (!/^\/x_gmg_ai_/.test(w.location.pathname)) return; var b = w.document.body; b.style.paddingRight = open ? PANEL_ROOM + 'px' : ''; b.style.boxSizing = 'border-box'; b.setAttribute('data-gmgai-panel', open ? 'open' : 'closed'); } catch (e) {} }
    function provSelectHtml(s) {
        var cur = s.provider || 'default';
        var out = '<select id="gmgai-prov-select" class="gmgai-select" title="Choose AI Model" aria-label="Choose AI Model">';
        out += '<option value="default"' + (cur == 'default' || !cur ? ' selected' : '') + '>Default Model</option>';
        (top.__gmgaiProviders || []).forEach(function(p) {
            var pModels = (p.models && p.models.length) ? p.models : [p.model];
            if (pModels.length <= 1) {
                var val = p.sys_id;
                out += '<option value="' + esc(val) + '"' + (cur == val ? ' selected' : '') + '>' + esc(p.name + ' (' + p.model + ')') + '</option>';
            } else {
                pModels.forEach(function(m) {
                    var val = p.sys_id + ':' + m;
                    out += '<option value="' + esc(val) + '"' + (cur == val ? ' selected' : '') + '>' + esc(p.name + ': ' + m) + '</option>';
                });
            }
        });
        out += '</select>';
        return out;
    }

    function render() {
        var s = load(), c = top.__gmgaiCtx ? top.__gmgaiCtx() : getContext();
        var old = tdoc.getElementById('gmgai-root');
        if (old) old.parentNode.removeChild(old);
        if (!tdoc.getElementById('gmgai-css')) {
            var st = tdoc.createElement('style'); st.id = 'gmgai-css'; st.textContent = CSS; tdoc.head.appendChild(st);
        }
        var root = tdoc.createElement('div'); root.id = 'gmgai-root';
        var open = s.open && (!ownAppPage() || openedHere);
        shiftContent(open);
        if (!open) {
            if (top.__gmgaiDocClick) {
                tdoc.removeEventListener('click', top.__gmgaiDocClick, true);
                top.__gmgaiDocClick = null;
            }
            if (top.__gmgaiDocKeydown) {
                tdoc.removeEventListener('keydown', top.__gmgaiDocKeydown);
                top.__gmgaiDocKeydown = null;
            }
            if (ownAppPage()) return;
            root.innerHTML = '<button id="gmgai-btn" title="Now Pilot for ServiceNow" aria-label="Open Now Pilot for ServiceNow">' + BTN_LOGO_SVG + '</button>';
            tdoc.body.appendChild(root);
            var btnEl = tdoc.getElementById('gmgai-btn');
            if (btnEl) {
                btnEl.onclick = function(e) {
                    e.preventDefault();
                    e.stopPropagation();
                    s.open = true;
                    save(s);
                    render();
                    hook('onOpen');
                };
            }
            return;
        }
        var isDevMode = (s.mode === 'dev');
        var isITSMMode = (s.mode === 'itsm');
        var isWorkflowMode = (s.mode === 'workflow');
        var isChatMode = (!isDevMode && !isITSMMode && !isWorkflowMode);

        var closeSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';

        var h = '<div id="gmgai-panel"><div id="gmgai-head">' +
            '<div class="gmgai-brand">' + LOGO_SVG + '<div class="gmgai-title-wrap"><div class="gmgai-title">Now Pilot</div><small title="AI-powered ServiceNow assistant">AI-powered ServiceNow assistant</small></div></div>' +
            '<div class="gmgai-controls">' + (top.__gmgaiProviders && top.__gmgaiProviders.length ? provSelectHtml(s) : '') + '<button id="gmgai-clear" title="Clear chat history">Clear</button><button id="gmgai-close" title="Close Now Pilot" aria-label="Close Now Pilot" tabindex="0">' + closeSvg + '</button></div></div>' +
            '<div id="gmgai-mode-bar">' +
            '<button id="gmgai-tab-chat" class="' + (isChatMode ? 'gmgai-tab-active' : '') + '">Chat</button>' +
            '<button id="gmgai-tab-itsm" class="' + (isITSMMode ? 'gmgai-tab-active' : '') + '">ITSM Intelligence</button>' +
            '<button id="gmgai-tab-dev" class="' + (isDevMode ? 'gmgai-tab-active' : '') + '">Dev Assistant</button>' +
            '<button id="gmgai-tab-workflow" class="' + (isWorkflowMode ? 'gmgai-tab-active' : '') + '">Workflows</button>' +
            '</div><div id="gmgai-msgs">';
        h += hook('renderStrip').join('');
        if (!s.messages.length) {
            // Hero Welcome Card exactly matching screenshot
            h += '<div class="gmgai-hero-card">' +
                 '<div class="gmgai-hero-icon">' +
                 '<svg width="28" height="28" viewBox="0 0 24 24" fill="none"><path d="M12 2L14.4 9.6L22 12L14.4 14.4L12 22L9.6 14.4L2 12L9.6 9.6L12 2Z" fill="#16A34A"/><circle cx="19" cy="6" r="1.5" fill="#16A34A"/></svg>' +
                 '</div>' +
                 '<div class="gmgai-hero-text">' +
                 '<h3>Hi! I\'m Now Pilot</h3>' +
                 '<p>Ask me anything about ServiceNow — incidents, knowledge articles, configurations, scripts, or platform development.</p>' +
                 '</div>' +
                 '</div>';

            // "Try these examples" 2x2 Bento Grid
            h += '<div class="gmgai-examples-head">Try these examples</div>' +
                 '<div class="gmgai-bento-grid">' +
                 '<button class="gmgai-bento-card gmgai-sug" data-prompt="Show me open P1 incidents">' +
                 '<div class="gmgai-bento-icon" style="background:#E8F8F0;color:#16A34A"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg></div>' +
                 '<div class="gmgai-bento-content"><div class="gmgai-bento-title">Show me open P1 incidents</div><div class="gmgai-bento-sub">List high-priority incidents with key details</div></div>' +
                 '<div class="gmgai-bento-arrow"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg></div>' +
                 '</button>' +
                 '<button class="gmgai-bento-card gmgai-sug" data-prompt="Find incidents about email">' +
                 '<div class="gmgai-bento-icon" style="background:#F3E8FF;color:#9333EA"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg></div>' +
                 '<div class="gmgai-bento-content"><div class="gmgai-bento-title">Find incidents about email</div><div class="gmgai-bento-sub">Search similar resolved incidents and KB articles</div></div>' +
                 '<div class="gmgai-bento-arrow"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg></div>' +
                 '</button>' +
                 '<button class="gmgai-bento-card gmgai-sug" data-prompt="Create a Business Rule" data-tab="dev">' +
                 '<div class="gmgai-bento-icon" style="background:#E0F2FE;color:#0284C7"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg></div>' +
                 '<div class="gmgai-bento-content"><div class="gmgai-bento-title">Create a Business Rule</div><div class="gmgai-bento-sub">Generate a business rule with best practices</div></div>' +
                 '<div class="gmgai-bento-arrow"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg></div>' +
                 '</button>' +
                 '<button class="gmgai-bento-card gmgai-sug" data-prompt="Help me automate a workflow" data-tab="workflow">' +
                 '<div class="gmgai-bento-icon" style="background:#FFEDD5;color:#EA580C"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M13 6h3a2 2 0 0 1 2 2v7"/><line x1="6" y1="9" x2="6" y2="21"/></svg></div>' +
                 '<div class="gmgai-bento-content"><div class="gmgai-bento-title">Help me automate a workflow</div><div class="gmgai-bento-sub">Plan and create a multi-step workflow</div></div>' +
                 '<div class="gmgai-bento-arrow"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg></div>' +
                 '</button>' +
                 '</div>';

            var dynSug = suggestions(c);
            if (dynSug && dynSug.length) {
                h += '<div style="margin-top:6px;display:flex;flex-wrap:wrap;gap:4px">';
                dynSug.forEach(function(x) {
                    h += '<button class="gmgai-sug" style="display:inline-block;width:auto;padding:4px 8px;font-size:11px;border-radius:6px;margin:2px 0">' + esc(x) + '</button>';
                });
                h += '</div>';
            }
        }
        s.messages.forEach(function(m) {
            var cls = m.role == 'user' ? 'gmgai-u' : (m.error ? 'gmgai-e' : 'gmgai-a');
            var chips = (m.tools || []).map(function(t) { return '<span class="gmgai-chip">' + esc(t) + '</span>'; }).join('');
            h += '<div class="gmgai-m ' + cls + '"' + (m.actions && m.actions.length ? ' style="max-width:100%"' : '') + '>' + (chips ? chips + '<br>' : '') +
                (m.error && m.blocked ? '<span class="gmgai-no-chip">Not allowed</span> ' : '') + (repeatsCard(m) ? '' : (m.role == 'user' ? esc(m.content) : md(m.content)));
            if (m.workflow) h += workflowCard(m.workflow);
            (m.actions || []).forEach(function(a) { h += actionCard(a); });
            if (m.citation_warning) h += '<div class="gmgai-warn" style="background:#FEF2F2;border-color:#FCA5A5;color:#991B1B"><b>' + WARN_ICO + ' Citation Notice:</b> ' + esc(m.citation_warning) + '</div>';
            if (m.warning) h += '<div class="gmgai-warn">' + esc(m.warning) + '</div>';
            if (m.error && (m.correlation_id || m.error_code)) {
                h += '<div class="gmgai-err-diag" style="font-size:11px;color:#991B1B;margin-top:4px;padding:3px 6px;background:#FEE2E2;border-radius:4px;border:1px solid #FCA5A5">' +
                     (m.correlation_id ? '<b>ID:</b> <code>' + esc(m.correlation_id) + '</code>' : '') +
                     (m.correlation_id && m.error_code ? ' &middot; ' : '') +
                     (m.error_code ? '<b>Code:</b> <code>' + esc(m.error_code) + '</code>' : '') +
                     '</div>';
            }
            if (m.role == 'assistant' && (m.cost != null || m.month != null)) h += '<div class="gmgai-foot">' + footer(m) + '</div>';
            h += '</div>';
        });
        if (s.pending) h += '<div class="gmgai-m gmgai-a" style="color:var(--np-text-secondary)">Working…</div>';
        var devPane = '';
        if (isDevMode) {
            devPane = '<div id="gmgai-dev-bar" style="padding:8px 12px;background:var(--np-surface-muted);border-top:1px solid var(--np-border);display:flex;flex-direction:column;gap:6px;font-size:12px">' +
                '<div style="display:flex;gap:4px;align-items:center">' +
                '<label style="font-weight:600;min-width:45px">Artifact:</label>' +
                '<select id="gmgai-dev-artifact" class="gmgai-select" style="flex:1" aria-label="Artifact Type">' +
                '<option value="business_rule"' + (s.dev_artifact == 'business_rule' ? ' selected' : '') + '>Business Rule</option>' +
                '<option value="script_include"' + (s.dev_artifact == 'script_include' ? ' selected' : '') + '>Script Include</option>' +
                '<option value="client_script"' + (s.dev_artifact == 'client_script' ? ' selected' : '') + '>Client Script</option>' +
                '<option value="ui_policy"' + (s.dev_artifact == 'ui_policy' ? ' selected' : '') + '>UI Policy & Actions</option>' +
                '<option value="ui_action"' + (s.dev_artifact == 'ui_action' ? ' selected' : '') + '>UI Action</option>' +
                '<option value="background_script"' + (s.dev_artifact == 'background_script' ? ' selected' : '') + '>Background Script</option>' +
                '<option value="scripted_rest"' + (s.dev_artifact == 'scripted_rest' ? ' selected' : '') + '>Scripted REST API</option>' +
                '<option value="flow_designer"' + (s.dev_artifact == 'flow_designer' ? ' selected' : '') + '>Flow Designer Guidance</option>' +
                '<option value="service_portal_widget"' + (s.dev_artifact == 'service_portal_widget' ? ' selected' : '') + '>Service Portal Widget</option>' +
                '<option value="atf_test"' + (s.dev_artifact == 'atf_test' ? ' selected' : '') + '>ATF Test Plan & Script</option>' +
                '</select>' +
                '<label style="font-weight:600;margin-left:4px">Action:</label>' +
                '<select id="gmgai-dev-action" class="gmgai-select" style="width:90px" aria-label="Dev Action">' +
                '<option value="generate"' + (s.dev_action == 'generate' ? ' selected' : '') + '>Generate</option>' +
                '<option value="review"' + (s.dev_action == 'review' ? ' selected' : '') + '>Review</option>' +
                '<option value="explain"' + (s.dev_action == 'explain' ? ' selected' : '') + '>Explain</option>' +
                '<option value="debug"' + (s.dev_action == 'debug' ? ' selected' : '') + '>Debug</option>' +
                '</select></div>' +
                '<div style="display:flex;gap:4px;align-items:center">' +
                '<label style="font-weight:600;min-width:45px">Table:</label>' +
                '<input id="gmgai-dev-table" type="text" placeholder="e.g. incident" value="' + esc(s.dev_table !== undefined ? s.dev_table : (c.table || '')) + '" style="flex:1;padding:4px 8px;border:1px solid var(--np-border);border-radius:6px;font:inherit;font-size:12px;background:var(--np-surface);color:var(--np-text)" aria-label="Table Name">' +
                '<button id="gmgai-dev-code-toggle" style="background:var(--np-surface);border:1px solid var(--np-border);border-radius:6px;padding:3px 8px;cursor:pointer;font-size:11.5px;font-weight:500" aria-label="Toggle Code Input">' + (s.dev_show_code ? '- Code' : '+ Code') + '</button>' +
                '</div>' +
                '<textarea id="gmgai-dev-code" placeholder="Paste existing script here for Review / Debug / Explain..." style="display:' + (s.dev_show_code ? 'block' : 'none') + ';width:100%;height:75px;box-sizing:border-box;font-family:ui-monospace,Menlo,monospace;font-size:11.5px;border:1px solid var(--np-border);border-radius:6px;padding:6px;resize:vertical;background:var(--np-surface);color:var(--np-text)" aria-label="Existing Script Code">' + esc(s.dev_code || '') + '</textarea>' +
                '</div>';
        }
        var itsmPane = '';
        if (isITSMMode) {
            var boundInc = (c.table == 'incident' ? (c.fields && c.fields.number ? c.fields.number : (c.sys_id || '')) : '');
            itsmPane = '<div id="gmgai-itsm-bar" style="padding:8px 12px;background:var(--np-surface-muted);border-top:1px solid var(--np-border);display:flex;flex-direction:column;gap:6px;font-size:12px">' +
                '<div style="display:flex;gap:4px;align-items:center">' +
                '<label style="font-weight:600;min-width:45px">Action:</label>' +
                '<select id="gmgai-itsm-action" class="gmgai-select" style="flex:1" aria-label="ITSM Action">' +
                '<option value="recommend_resolution"' + (s.itsm_action == 'recommend_resolution' || !s.itsm_action ? ' selected' : '') + '>Recommend Resolution</option>' +
                '<option value="similar_incidents"' + (s.itsm_action == 'similar_incidents' ? ' selected' : '') + '>Find Similar Incidents</option>' +
                '<option value="search_knowledge"' + (s.itsm_action == 'search_knowledge' ? ' selected' : '') + '>Search Knowledge Articles</option>' +
                '<option value="summarize"' + (s.itsm_action == 'summarize' ? ' selected' : '') + '>Summarize Incident</option>' +
                '<option value="draft_knowledge"' + (s.itsm_action == 'draft_knowledge' ? ' selected' : '') + '>Draft Knowledge Article</option>' +
                '</select>' +
                '</div>' +
                '<div style="display:flex;gap:4px;align-items:center">' +
                '<label style="font-weight:600;min-width:45px">Incident:</label>' +
                '<input id="gmgai-itsm-incident" type="text" placeholder="e.g. INC0000060 or sys_id" value="' + esc(s.itsm_incident !== undefined ? s.itsm_incident : boundInc) + '" style="flex:1;padding:4px 8px;border:1px solid var(--np-border);border-radius:6px;font:inherit;font-size:12px;background:var(--np-surface);color:var(--np-text)" aria-label="Incident Identifier">' +
                '</div>' +
                '</div>';
        }
        var workflowPane = '';
        if (isWorkflowMode) {
            var boundTarget = (c.table == 'incident' ? (c.fields && c.fields.number ? c.fields.number : (c.sys_id || '')) : (c.bound && c.bound.sys_id ? c.bound.sys_id : ''));
            workflowPane = '<div id="gmgai-wf-bar" style="padding:8px 12px;background:var(--np-surface-muted);border-top:1px solid var(--np-border);display:flex;flex-direction:column;gap:6px;font-size:12px">' +
                '<div style="display:flex;gap:4px;align-items:center">' +
                '<label style="font-weight:600;min-width:55px">Workflow:</label>' +
                '<select id="gmgai-wf-type" class="gmgai-select" style="flex:1" aria-label="Workflow Template">' +
                '<option value="incident_investigation"' + (s.wf_type == 'incident_investigation' || !s.wf_type ? ' selected' : '') + '>A: Incident Investigation</option>' +
                '<option value="knowledge_preparation"' + (s.wf_type == 'knowledge_preparation' ? ' selected' : '') + '>B: Knowledge Preparation</option>' +
                '<option value="development_review"' + (s.wf_type == 'development_review' ? ' selected' : '') + '>C: Development Review</option>' +
                '</select>' +
                '</div>' +
                '<div style="display:flex;gap:4px;align-items:center">' +
                '<label style="font-weight:600;min-width:55px">Target/Ref:</label>' +
                '<input id="gmgai-wf-target" type="text" placeholder="e.g. INC0000060 or script" value="' + esc(s.wf_target !== undefined ? s.wf_target : boundTarget) + '" style="flex:1;padding:4px 8px;border:1px solid var(--np-border);border-radius:6px;font:inherit;font-size:12px;background:var(--np-surface);color:var(--np-text)" aria-label="Workflow Target">' +
                '</div>' +
                '</div>';
        }
        var inputPlaceholder = isDevMode ? 'Enter requirement, acceptance criteria, or questions…'
            : isITSMMode ? 'Enter symptoms, query, or prompt for ITSM analysis…'
            : isWorkflowMode ? 'Enter workflow goal, acceptance criteria, or instruction…'
            : 'Ask anything about this page or ServiceNow…';
        var actionBtnLabel = isDevMode ? 'Run' : (isITSMMode ? 'Analyze' : (isWorkflowMode ? 'Start' : 'Send'));
        var disabledAttr = s.pending ? ' disabled style="opacity:0.6;cursor:not-allowed"' : '';
        var clipIcon = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>';
        var sendIcon = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>';

        h += '</div>' + devPane + itsmPane + workflowPane + '<div id="gmgai-in">' +
            '<button id="gmgai-clip" title="Attach context" aria-label="Attach">' + clipIcon + '</button>' +
            '<textarea placeholder="' + inputPlaceholder + '" aria-label="Message Input"' + (s.pending ? ' disabled style="opacity:0.7"' : '') + '></textarea>' +
            hook('headerControls').join('') +
            '<button id="gmgai-send" aria-label="Send Message"' + disabledAttr + '>' + sendIcon + '<span>' + actionBtnLabel + '</span></button></div></div>';
        root.innerHTML = h;
        tdoc.body.appendChild(root);
        var box = tdoc.getElementById('gmgai-msgs'); box.scrollTop = box.scrollHeight;
        var ta = root.querySelector('textarea');

        var panelEl = tdoc.getElementById('gmgai-panel') || root.querySelector('#gmgai-panel');
        if (panelEl) {
            panelEl.onclick = function(e) {
                e.stopPropagation();
            };
        }

        var closeBtn = tdoc.getElementById('gmgai-close') || root.querySelector('#gmgai-close');
        if (closeBtn) {
            closeBtn.onclick = function(e) {
                e.preventDefault();
                e.stopPropagation();
                var curr = load();
                curr.open = false;
                save(curr);
                render();
            };
        }

        if (top.__gmgaiDocClick) {
            tdoc.removeEventListener('click', top.__gmgaiDocClick, true);
            top.__gmgaiDocClick = null;
        }
        top.__gmgaiDocClick = function(e) {
            var curr = load();
            if (!curr.open) return;
            var pEl = tdoc.getElementById('gmgai-panel');
            var bEl = tdoc.getElementById('gmgai-btn');
            if (!pEl) return;

            var path = e.composedPath ? e.composedPath() : [];
            var inside = false;
            if (path && path.length) {
                for (var i = 0; i < path.length; i++) {
                    if (path[i] === pEl || path[i] === bEl) {
                        inside = true;
                        break;
                    }
                }
            } else {
                inside = pEl.contains(e.target) || (bEl && bEl.contains(e.target));
            }

            if (!inside) {
                try {
                    var sel = (top.getSelection && top.getSelection()) || (w.getSelection && w.getSelection());
                    if (sel && String(sel).length > 0) return;
                } catch (eSel) {}
                curr.open = false;
                save(curr);
                render();
            }
        };
        tdoc.addEventListener('click', top.__gmgaiDocClick, true);

        if (top.__gmgaiDocKeydown) {
            tdoc.removeEventListener('keydown', top.__gmgaiDocKeydown);
            top.__gmgaiDocKeydown = null;
        }
        top.__gmgaiDocKeydown = function(e) {
            if (e.key === 'Escape' || e.keyCode === 27) {
                var curr = load();
                if (curr.open) {
                    curr.open = false;
                    save(curr);
                    render();
                }
            }
        };
        tdoc.addEventListener('keydown', top.__gmgaiDocKeydown);

        var selProv = root.querySelector('#gmgai-prov-select');
        if (selProv) {
            selProv.onchange = function() {
                var st = load();
                st.provider = this.value;
                st.explicit = (this.value !== 'default');
                save(st);
            };
        }
        var clearBtn = tdoc.getElementById('gmgai-clear') || root.querySelector('#gmgai-clear');
        if (clearBtn) {
            clearBtn.onclick = function(e) {
                e.preventDefault();
                e.stopPropagation();
                var st = load();
                st.messages = [];
                st.pending = false;
                st.explicit = false;
                st.provider = '';
                save(st);
                hook('onClear');
                MEM_CONV = null;
                if (ensureUser()) { try { top.sessionStorage.removeItem(CONV_KEY); } catch (err) {} }
                render();
            };
        }
        Array.prototype.forEach.call(root.querySelectorAll('.gmgai-sug'), function(b) {
            b.onclick = function(e) {
                e.stopPropagation();
                var pVal = b.getAttribute('data-prompt') || b.textContent;
                var pTab = b.getAttribute('data-tab');
                if (pTab) {
                    var st = load();
                    st.mode = pTab;
                    save(st);
                    render();
                    return;
                }
                ta.value = pVal;
                ta.focus();
            };
        });
        Array.prototype.forEach.call(root.querySelectorAll('.gmgai-card button'), function(b) {
            if (b.classList.contains('gmgai-copy-btn')) return;
            b.onclick = function(e) {
                e.stopPropagation();
                var actNode = b.parentNode.getAttribute('data-act') ? b.parentNode : b.parentNode.parentNode;
                decide(actNode.getAttribute('data-act'), b.getAttribute('data-v'));
            };
        });
        Array.prototype.forEach.call(root.querySelectorAll('.gmgai-copy-btn'), function(b) {
            b.onclick = function(e) {
                e.stopPropagation();
                var rawCode = decodeURIComponent(b.getAttribute('data-code') || '');
                if (top.navigator && top.navigator.clipboard && top.navigator.clipboard.writeText) {
                    top.navigator.clipboard.writeText(rawCode).then(function() {
                        var oldText = b.textContent;
                        b.textContent = 'Copied!';
                        setTimeout(function() { b.textContent = oldText; }, 2000);
                    });
                } else {
                    var taTemp = tdoc.createElement('textarea');
                    taTemp.value = rawCode;
                    tdoc.body.appendChild(taTemp);
                    taTemp.select();
                    tdoc.execCommand('copy');
                    tdoc.body.removeChild(taTemp);
                    var oldText2 = b.textContent;
                    b.textContent = 'Copied!';
                    setTimeout(function() { b.textContent = oldText2; }, 2000);
                }
            };
        });
        var tabChat = tdoc.getElementById('gmgai-tab-chat');
        if (tabChat) {
            tabChat.onclick = function(e) { e.stopPropagation(); var st = load(); st.mode = 'chat'; save(st); render(); };
        }
        var tabITSM = tdoc.getElementById('gmgai-tab-itsm');
        if (tabITSM) {
            tabITSM.onclick = function(e) { e.stopPropagation(); var st = load(); st.mode = 'itsm'; save(st); render(); };
        }
        var tabDev = tdoc.getElementById('gmgai-tab-dev');
        if (tabDev) {
            tabDev.onclick = function(e) { e.stopPropagation(); var st = load(); st.mode = 'dev'; save(st); render(); };
        }
        var tabWorkflow = tdoc.getElementById('gmgai-tab-workflow');
        if (tabWorkflow) {
            tabWorkflow.onclick = function(e) { e.stopPropagation(); var st = load(); st.mode = 'workflow'; save(st); render(); };
        }
        var selWfType = tdoc.getElementById('gmgai-wf-type');
        if (selWfType) {
            selWfType.onchange = function() { var st = load(); st.wf_type = this.value; save(st); };
        }
        var inpWfTarget = tdoc.getElementById('gmgai-wf-target');
        if (inpWfTarget) {
            inpWfTarget.onchange = function() { var st = load(); st.wf_target = this.value; save(st); };
        }
        var selITSMAction = tdoc.getElementById('gmgai-itsm-action');
        if (selITSMAction) {
            selITSMAction.onchange = function() { var st = load(); st.itsm_action = this.value; save(st); };
        }
        var inpITSMIncident = tdoc.getElementById('gmgai-itsm-incident');
        if (inpITSMIncident) {
            inpITSMIncident.onchange = function() { var st = load(); st.itsm_incident = this.value; save(st); };
        }
        var devCodeToggle = tdoc.getElementById('gmgai-dev-code-toggle');
        if (devCodeToggle) {
            devCodeToggle.onclick = function(e) {
                e.stopPropagation();
                var st = load();
                st.dev_show_code = !st.dev_show_code;
                var codeArea = tdoc.getElementById('gmgai-dev-code');
                if (codeArea) st.dev_code = codeArea.value;
                save(st);
                render();
            };
        }
        var selArtifact = tdoc.getElementById('gmgai-dev-artifact');
        if (selArtifact) {
            selArtifact.onchange = function() { var st = load(); st.dev_artifact = this.value; save(st); };
        }
        var selAction = tdoc.getElementById('gmgai-dev-action');
        if (selAction) {
            selAction.onchange = function() { var st = load(); st.dev_action = this.value; save(st); };
        }
        var inpTable = tdoc.getElementById('gmgai-dev-table');
        if (inpTable) {
            inpTable.onchange = function() { var st = load(); st.dev_table = this.value; save(st); };
        }
        var clipBtn = tdoc.getElementById('gmgai-clip');
        if (clipBtn) {
            clipBtn.onclick = function(e) {
                e.stopPropagation();
                ta.value = (ta.value ? ta.value + ' ' : '') + '[Context: ' + (c.fields && c.fields.number ? c.fields.number : (c.table || 'current page')) + '] ';
                ta.focus();
            };
        }
        if (!top.__gmgaiProviders) loadProviders();
        hook('bind', [root]);
        root.querySelector('#gmgai-in button#gmgai-send').onclick = function(e) { e.stopPropagation(); send(ta.value); };
        ta.onkeydown = function(e) { if (e.key == 'Enter' && !e.shiftKey) { e.preventDefault(); e.stopPropagation(); send(ta.value); } };
        if (!s.pending) ta.focus();
    }

    /* one conversation id per browser session (sessionStorage), sent with every chat call; scopes update-set auto-join */
    /* provider field sent to the server: the sys_id only for an explicit pick, else 'default' (routing may apply) */
    function isDefault(id) { return (top.__gmgaiProviders || []).some(function(p) { return p.sys_id == id && p.is_default; }); }
    function providerParam(s) {
        var ex = s.explicit === undefined ? !!(s.provider && top.__gmgaiProviders && !isDefault(s.provider)) : !!s.explicit;
        return ex && s.provider ? s.provider : 'default';
    }
    function convId() {
        ensureUser();
        var k = CONV_KEY, v = UID ? null : MEM_CONV;
        if (UID) { try { v = top.sessionStorage.getItem(k); } catch (e) {} }
        if (!v || !/^[A-Za-z0-9-]{8,64}$/.test(v)) {
            try { v = top.crypto && top.crypto.randomUUID ? top.crypto.randomUUID() : null; } catch (e2) {}
            if (!v) v = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) { var r = Math.random() * 16 | 0; return (c == 'x' ? r : (r & 3 | 8)).toString(16); });
            if (UID) { try { top.sessionStorage.setItem(k, v); } catch (e3) {} } else MEM_CONV = v;
        }
        return v;
    }
    function send(text) {
        text = String(text || '').trim();
        var s = load();
        if (!text || s.pending) return;
        var ctx = top.__gmgaiCtx ? top.__gmgaiCtx() : getContext();
        ctx = pinned(ctx, load());   // record pinned by the form UI action fills a missing table/sys_id only
        s.messages.push({role: 'user', content: text, page: ctx.url});
        s.pending = true; save(s); render();
        /* an extension that takes the message (e.g. team build) returns true; input stays locked until it calls api.done() (no double send) */
        if (hook('onSend', [text]).some(function(r) { return r === true; })) return;
        var token = top.__gmgaiToken || w.g_ck || '';
        var provVal = providerParam(s), pId = provVal, reqModel = null;
        if (provVal && provVal.indexOf(':') > 0) {
            var parts = provVal.split(':');
            pId = parts[0];
            reqModel = parts[1];
        }
        var devReq = null;
        if (s.mode === 'dev') {
            var devArtEl = tdoc.getElementById('gmgai-dev-artifact');
            var devActEl = tdoc.getElementById('gmgai-dev-action');
            var devTblEl = tdoc.getElementById('gmgai-dev-table');
            var devCodeEl = tdoc.getElementById('gmgai-dev-code');
            devReq = {
                artifact_type: devArtEl ? devArtEl.value : (s.dev_artifact || 'business_rule'),
                mode: devActEl ? devActEl.value : (s.dev_action || 'generate'),
                table: devTblEl ? devTblEl.value : (s.dev_table || ctx.table || ''),
                code: devCodeEl ? devCodeEl.value : (s.dev_code || ''),
                requirement: text
            };
        }
        var itsmReq = null;
        if (s.mode === 'itsm') {
            var itsmActEl = tdoc.getElementById('gmgai-itsm-action');
            var itsmIncEl = tdoc.getElementById('gmgai-itsm-incident');
            itsmReq = {
                action: itsmActEl ? itsmActEl.value : (s.itsm_action || 'recommend_resolution'),
                incident_id: itsmIncEl ? itsmIncEl.value : (s.itsm_incident || (ctx.table == 'incident' ? ctx.sys_id : '')),
                query: text
            };
        }
        var wfReq = null;
        if (s.mode === 'workflow') {
            var wfTypeEl = tdoc.getElementById('gmgai-wf-type');
            var wfTargetEl = tdoc.getElementById('gmgai-wf-target');
            var tVal = wfTargetEl ? wfTargetEl.value : (s.wf_target || '');
            wfReq = {
                action: 'run',
                goal: text || 'Execute workflow',
                type: wfTypeEl ? wfTypeEl.value : (s.wf_type || 'incident_investigation'),
                params: {
                    incident_id: tVal,
                    code: tVal,
                    query: text
                }
            };
        }
        var sendPayload = {context: ctx, conversation_id: convId(), provider: pId, message: text};
        if (reqModel) sendPayload.model = reqModel;
        if (devReq) sendPayload.dev_request = devReq;
        if (itsmReq) sendPayload.itsm_request = itsmReq;
        if (wfReq) sendPayload.workflow_request = wfReq;
        w.fetch(API, {method: 'POST', credentials: 'same-origin',
            headers: {'Content-Type': 'application/json', 'Accept': 'application/json', 'X-UserToken': token},
            body: JSON.stringify(sendPayload)
        }).then(function(r) { return r.json().then(function(j) { return {status: r.status, j: j}; }); })
          .then(function(x) {
              var r = (x.j && x.j.result) || x.j || {};
              var st = load(); st.pending = false;
              var u = r.usage || {}, meta = {cost: r.cost, month: r.spend && r.spend.month, monthly_budget: r.spend && r.spend.monthly_budget,
                  warning: r.warning, citation_warning: r.citation_warning, correlation_id: r.correlation_id, error_code: r.error_code};   // AC16: model and token counts are never kept or shown in the panel
              if (r.workflow) meta.workflow = r.workflow;
              if (r.rejected) { top.__gmgaiProviders = null; st.provider = ''; }
              if (r.response) st.messages.push(Object.assign({role: 'assistant', content: r.response, tools: r.tools_used, actions: r.pending_actions || []}, meta));
              else st.messages.push(Object.assign({role: 'assistant', error: true, blocked: !!r.blocked,
                  content: (r.blocked ? '' : 'Error: ') + (r.error || (x.j && x.j.error && x.j.error.message) || ('HTTP ' + x.status)),
                  actions: r.pending_actions || []}, meta));  /* blocked: content is esc()'d — stop mark is \u2715 in #B91C1C at render (not SVG) */
              save(st); top.__gmgaiRender && top.__gmgaiRender();
          })['catch'](function(e) {
              var st = load(); st.pending = false; st.messages.push({role: 'assistant', error: true, content: 'Error: ' + e}); save(st);
              top.__gmgaiRender && top.__gmgaiRender();
          });
    }

    /* form UI action "Ask GMG AI Agent" calls top.__gmgaiOpen(table, sys_id). Opens the panel and pins that record as context.
     * Client-only: nothing is written; any change still goes through the agent's proposal + Confirm. Role-gated like the panel. */
    var TABLE_RE = /^[a-z0-9_]{1,80}$/, SYSID_RE = /^[0-9a-f]{32}$/;
    function openWith(table, sysId) {
        if (!hasRole() || top.__gmgaiAccess !== true) return false;   // panel_access: same server answer as the launcher
        table = String(table || ''); sysId = String(sysId || '');
        if (!TABLE_RE.test(table) || !SYSID_RE.test(sysId)) return false;
        var s = load(); openedHere = true; s.open = true; s.pin = {table: table, sys_id: sysId}; save(s); render();
        return true;
    }
    function pinned(ctx, s) {
        ctx = ctx || {};
        if (s && s.pin && !ctx.sys_id) { ctx.table = s.pin.table; ctx.sys_id = s.pin.sys_id; ctx.kind = 'form'; ctx.pinned = true; }
        return ctx;
    }
    var openedHere = false;   // per page load (live dcb843c)
    function ownAppPage() { try { return /^\/x_gmg_ai_[a-z0-9_]+\.do$/.test(w.location.pathname || ''); } catch (e) { return false; } }
    function boot() {
        if (isShellOnly() || !hasRole() || !tdoc.body) return;
        /* Ignore tiny helper iframes (e.g. hidden frames, dialogs) */
        if (w !== top && (w.innerWidth < 300 || w.innerHeight < 200)) return;
        accessThen(bootAllowed);   // x_gmg_ai.panel_access: no launcher until the server says this user may use the agent
    }
    /* Panel access: ask the server once per top window (GET /health?access=1 -> {panel_access: true|false}). Anything but an explicit
     * true (403, error, bad JSON) = no launcher. The REST operations refuse on their own, so this only hides the UI. */
    function accessThen(fn) {
        if (top.__gmgaiAccess === true) { fn(); return; }
        if (top.__gmgaiAccess === false) return;
        (top.__gmgaiAccessQ = top.__gmgaiAccessQ || []).push(fn);
        if (top.__gmgaiAccessLoading) return;
        top.__gmgaiAccessLoading = true;
        w.fetch(HAPI + '?access=1', {credentials: 'same-origin', headers: {'Accept': 'application/json', 'X-UserToken': w.g_ck || ''}})
            .then(function(r) { return r.status == 200 ? r.json() : null; })
            .then(function(j) { var r = (j && j.result) || j || {}; top.__gmgaiAccess = r.panel_access === true; })
            ['catch'](function() { top.__gmgaiAccess = false; })
            .then(function() {
                var q = top.__gmgaiAccessQ || [], i; top.__gmgaiAccessQ = []; top.__gmgaiAccessLoading = false;
                if (top.__gmgaiAccess === true) for (i = 0; i < q.length; i++) { try { q[i](); } catch (e) { extLog('boot threw: ' + e); } }
            });
    }
    function bootAllowed() {
        top.__gmgaiCtx = getContext;          // latest content frame owns the context
        top.__gmgaiOwner = w;                 // ...and the build poll (AC-R1.5)
        top.__gmgaiToken = w.g_ck;
        top.__gmgaiRender = render;
        top.__gmgaiOpen = openWith;
        var s = load(); if (s.pending && !s.pendingSince) { s.pendingSince = Date.now(); save(s); }
        if (s.pending && s.pendingSince && Date.now() - s.pendingSince > 120000) { s.pending = false; delete s.pendingSince; save(s); }
        render();
        booted = true; extStart();   // extensions (if any registered) boot after /health says their feature is on
    }

    var q0 = w.__gmgaiExtQ; w.__gmgaiExtQ = {push: register};   // either load order: drain what an earlier extension script queued
    if (q0 && q0.length) for (var qi = 0; qi < q0.length; qi++) register(q0[qi]);
    if (document.readyState == 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
