/* Copyright 2026 GMG Technology LLC */ /* SPDX-License-Identifier: Apache-2.0 */ (function process(request, response) {
    if (!gs.hasRole('x_gmg_ai.user')) { response.setStatus(403); return {error: 'x_gmg_ai.user role required'}; }
    var inc = ContextStore.installIncomplete(); if (inc) { response.setStatus(503); return {error: inc}; }   // step 10 ruling 3: before anything is read or stored
    var po = ActionService.panelOff(); if (po) { response.setStatus(403); return {error: po, code: 403, panel_off: true}; }   // x_gmg_ai.panel_access: Confirm and Reject refused, cards made before the switch too
    var id = String(request.pathParams.id || ''), verb = String(request.pathParams.verb || '');
    var svc = new ActionService();   /* ruling (b): body run_as is only compared; a reviewed card applies with its stored run_as and a different one gets 409 */
    var r = verb == 'confirm' ? svc.confirm(id, (function() { try { var b = request.body && request.body.data; return b && b.run_as ? String(b.run_as) : ''; } catch (e) { return ''; } })(), (function() { try { var b = request.body && request.body.data; var o = {new_update_set: !!(b && (b.new_update_set === true || b.new_update_set == 'true'))}; if (b && b.activate !== undefined) o.activate = b.activate === true || b.activate == 'true'; return o; } catch (e) { return {}; } })()) : verb == 'reject' ? svc.reject(id) : {error: 'Unknown verb', code: 400};
    if (r.code) response.setStatus(r.code);
    return r;
})(request, response);
