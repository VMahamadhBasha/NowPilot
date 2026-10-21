/* Copyright 2026 GMG Technology LLC */ /* SPDX-License-Identifier: Apache-2.0 */ (function process(/*RESTAPIRequest*/ request, /*RESTAPIResponse*/ response) {
    if (!gs.hasRole('x_gmg_ai.user')) { response.setStatus(403); return {error: 'x_gmg_ai.user role required'}; }
    var inc = ContextStore.installIncomplete(); if (inc) { response.setStatus(503); return {error: inc}; }   // step 10 ruling 3: before anything is read or stored
    var po = ActionService.panelOff(); if (po) { response.setStatus(403); return {error: po, panel_off: true}; }   // x_gmg_ai.panel_access
    var body = request.body.data || {};
    return new AgentCore().run(body);   // errors (incl. budget blocks) come back in .error / .blocked with HTTP 200
})(request, response);
