// Copyright 2026 GMG Technology LLC
// SPDX-License-Identifier: Apache-2.0
var Budget = Class.create();
/* Spend tracking from x_gmg_ai_log.est_cost. "Today"/"month" are in the calling user's time zone.
 * Cost = (input + W*cache_write + R*cache_read) * price_in/1M + output * price_out/1M
 * (cache multipliers follow Anthropic's published prompt-caching rates; xAI cached input is approximated the same way). */
Budget.tokens = function(ga, o) {
    var n = function(f) { return ga ? parseInt(ga.getAggregate('SUM', f), 10) || 0 : 0; };
    o.uncached = n('input_tokens'); o.cache_read = n('cache_read_tokens'); o.cache_write = n('cache_write_tokens'); o.output = n('output_tokens');
    o.input = o.uncached + o.cache_read + o.cache_write;
    return o;
};

Budget.NOT_SEALED = 'status!=sealed^ORstatusISEMPTY';
Budget.isUserId = function(u) { return /^[0-9a-f]{32}$/.test(String(u || '')); };

Budget.isPriced = function(pgr) {
    if (!pgr) return false;
    var pin = parseFloat(pgr.getValue('price_input_per_m')) || 0, pout = parseFloat(pgr.getValue('price_output_per_m')) || 0;
    return (pin > 0 || pout > 0);
};

Budget.prototype = {
    initialize: function() {},

    _starts: function() {
        var d = new GlideDateTime().getLocalDate().getValue(); // yyyy-MM-dd, user TZ
        var t = new GlideDateTime(); t.setDisplayValueInternal(d + ' 00:00:00');
        var m = new GlideDateTime(); m.setDisplayValueInternal(d.substring(0, 8) + '01 00:00:00');
        return {today: t.getValue(), month: m.getValue()};
    },

    _sum: function(q) {
        var ga = new GlideAggregate('x_gmg_ai_log');
        ga.addEncodedQuery(q + '^' + Budget.NOT_SEALED);
        ga.addAggregate('SUM', 'est_cost');
        ga.addAggregate('SUM', 'input_tokens');
        ga.addAggregate('SUM', 'output_tokens');
        ga.addAggregate('SUM', 'cache_read_tokens'); ga.addAggregate('SUM', 'cache_write_tokens');
        ga.setGroup(false);
        ga.query();
        if (ga.next()) return Budget.tokens(ga, {cost: parseFloat(ga.getAggregate('SUM', 'est_cost')) || 0});
        return Budget.tokens(null, {cost: 0});
    },

    cost: function(pgr, u) {
        if (!pgr) return 0;
        var pin = parseFloat(pgr.getValue('price_input_per_m')) || 0, pout = parseFloat(pgr.getValue('price_output_per_m')) || 0;
        var wsFee = parseFloat(gs.getProperty('x_gmg_ai.web_search.price_per_1k', '10')) || 0;
        var m = Budget.multipliers(pgr.getValue('model'), function(n) { return gs.getProperty(n, ''); });
        return ((u.input || 0) + m.write * (u.cache_write || 0) + m.read * (u.cache_read || 0)) * pin / 1e6 + (u.output || 0) * pout / 1e6 + (u.web_search || 0) * wsFee / 1000;
    },

    status: function(pgr, running, userId, opts) {
        var given = !(userId === undefined || userId === null || userId === '');
        if (given && !Budget.isUserId(userId)) throw 'Budget.status: invalid userId';
        if (opts && opts.background && !given) throw 'Budget.status: background call needs an explicit userId (design C)';
        running = running || 0;
        var s = this._starts(), id = pgr.getUniqueValue();
        var today = this._sum('provider=' + id + '^sys_created_on>=' + s.today).cost + running;
        var month = this._sum('provider=' + id + '^sys_created_on>=' + s.month).cost + running;
        var uid = given ? String(userId) : gs.getUserID();
        var userToday = this._sum('user=' + uid + '^sys_created_on>=' + s.today).cost + running;
        var db = parseFloat(pgr.getValue('daily_budget')) || 0, mb = parseFloat(pgr.getValue('monthly_budget')) || 0;
        var uc = parseFloat(gs.getProperty('x_gmg_ai.user_daily_cap_usd', '0')) || 0;
        var priced = Budget.isPriced(pgr);
        var r = {today: today, month: month, user_today: userToday, daily_budget: db, monthly_budget: mb, user_daily_cap: uc,
                 priced: priced, cost_label: priced ? null : 'unknown/unpriced', blocked: false, warning: ''};
        var name = pgr.getValue('name');
        if (db > 0 && today >= db) r.blocked = 'Daily budget reached for ' + name + ': $' + today.toFixed(4) + ' of $' + db.toFixed(2) + ' today. Raise daily_budget on the provider or try tomorrow.';
        else if (mb > 0 && month >= mb) r.blocked = 'Monthly budget reached for ' + name + ': $' + month.toFixed(4) + ' of $' + mb.toFixed(2) + ' this month.';
        else if (uc > 0 && userToday >= uc) r.blocked = 'Your personal daily cap is reached: $' + userToday.toFixed(4) + ' of $' + uc.toFixed(2) + ' (property x_gmg_ai.user_daily_cap_usd).';
        else {
            var w = [];
            if (db > 0 && today >= 0.8 * db) w.push(Math.round(100 * today / db) + '% of daily budget ($' + db.toFixed(2) + ')');
            if (mb > 0 && month >= 0.8 * mb) w.push(Math.round(100 * month / mb) + '% of monthly budget ($' + mb.toFixed(2) + ')');
            if (uc > 0 && userToday >= 0.8 * uc) w.push(Math.round(100 * userToday / uc) + '% of your daily cap');
            if (w.length) r.warning = 'Budget warning (' + name + '): ' + w.join('; ') + ' used.';
        }
        return r;
    },

    summary: function() {
        var s = this._starts(), admin = gs.hasRole('admin') === true;
        var own = admin ? '' : '^user=' + gs.getUserID();
        var out = {today_start_utc: s.today, month_start_utc: s.month, providers: [], totals: {}, is_admin: admin, scope: admin ? 'all' : 'mine'};
        var p = new GlideRecord('x_gmg_ai_provider');
        p.orderBy('name'); p.query();
        while (p.next()) {
            var id = p.getUniqueValue();
            var isPriced = Budget.isPriced(p);
            var row = {name: p.getValue('name'), type: p.getValue('type'), model: p.getValue('model'), active: p.getValue('active') == '1',
                priced: isPriced,
                cost_status: isPriced ? 'exact' : 'unpriced',
                today: this._sum('provider=' + id + '^sys_created_on>=' + s.today + own),
                month: this._sum('provider=' + id + '^sys_created_on>=' + s.month + own),
                all_time: this._sum('provider=' + id + own)};
            if (admin) { row.price_in = p.getValue('price_input_per_m'); row.price_out = p.getValue('price_output_per_m'); row.daily_budget = p.getValue('daily_budget'); row.monthly_budget = p.getValue('monthly_budget'); }
            out.providers.push(row);
        }
        var byModel = [];
        var ga = new GlideAggregate('x_gmg_ai_log');
        ga.addEncodedQuery('sys_created_on>=' + s.month + '^modelISNOTEMPTY^' + Budget.NOT_SEALED + own);
        ga.addAggregate('COUNT'); ga.addAggregate('SUM', 'est_cost'); ga.addAggregate('SUM', 'input_tokens'); ga.addAggregate('SUM', 'output_tokens');
        ga.addAggregate('SUM', 'cache_read_tokens'); ga.addAggregate('SUM', 'cache_write_tokens');
        ga.groupBy('model'); ga.query();
        while (ga.next()) byModel.push(Budget.tokens(ga, {model: ga.getValue('model'), chats: parseInt(ga.getAggregate('COUNT'), 10), cost: parseFloat(ga.getAggregate('SUM', 'est_cost')) || 0}));
        out.month_by_model = byModel;
        out.totals.today = this._sum('sys_created_on>=' + s.today + own);
        out.totals.month = this._sum('sys_created_on>=' + s.month + own);
        out.user_daily_cap = gs.getProperty('x_gmg_ai.user_daily_cap_usd', '0');
        return out;
    },

    type: 'Budget'
};

Budget.DEFAULTS = {read: 0.1, write: 1.25};
Budget.multipliers = function(model, getProp) {
    function num(v) { var s = String(v == null ? '' : v).trim(); if (!/^\d*\.?\d+$/.test(s)) return null; var f = parseFloat(s); return isFinite(f) && f >= 0 ? f : null; }
    function pick(kind) {
        var m = model ? num(getProp('x_gmg_ai.cache.' + kind + '_multiplier.' + model)) : null;
        if (m !== null) return m;
        var g = num(getProp('x_gmg_ai.cache.' + kind + '_multiplier'));
        return g !== null ? g : Budget.DEFAULTS[kind];
    }
    return {read: pick('read'), write: pick('write')};
};
