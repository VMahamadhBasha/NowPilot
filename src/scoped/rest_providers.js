/* Copyright 2026 GMG Technology LLC */ /* SPDX-License-Identifier: Apache-2.0 */ (function process(/*RESTAPIRequest*/ request, /*RESTAPIResponse*/ response) {
    /* Model picker list: active providers the caller may use. Safe fields only (sys_id, name, model, is_default). */
    if (!gs.hasRole('x_gmg_ai.user')) { response.setStatus(403); return {error: 'x_gmg_ai.user role required'}; }
    var inc = ContextStore.installIncomplete(); if (inc) { response.setStatus(503); return {error: inc}; }   // step 10 ruling 3: before anything is read or stored
    return new AgentCore().listProviders();
})(request, response);
