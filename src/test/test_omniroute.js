// Comprehensive test harness for GMG AI Agent with OmniRoute Upgrade (Production-Ready)
const assert = require('assert');
const fs = require('fs');
const path = require('path');

// Mock ServiceNow environment
const mockState = {
    properties: {
        'instance_name': 'dev12345',
        'x_gmg_ai.max_rounds': '4',
        'x_gmg_ai.time_budget_ms': '45000',
        'x_gmg_ai.max_attempts': '2',
        'x_gmg_ai.web_search.enabled': 'false',
        'x_gmg_ai.llm.prompt_cache': 'true',
        'x_gmg_ai.tools.selection': 'true',
        'x_gmg_ai.tool_result_chars': '4000',
        'x_gmg_ai.context.server_store': 'false',
        'x_gmg_ai.model_allowlist': 'gpt-4o,claude-3-5-sonnet,llama-3-70b,mistral-large',
        'x_gmg_ai.fallback_providers': 'Secondary Provider,Backup Provider',
        'x_gmg_ai.allow_http_localhost': 'true'
    },
    tables: {
        x_gmg_ai_provider: [],
        x_gmg_ai_log: []
    },
    roles: ['x_gmg_ai.user', 'admin'],
    restResponses: []
};

global.Class = {
    create: function() {
        return function() {
            if (this.initialize) this.initialize.apply(this, arguments);
        };
    }
};

global.gs = {
    getProperty: (name, def) => (name in mockState.properties ? mockState.properties[name] : def),
    setProperty: (name, val) => { mockState.properties[name] = String(val); },
    hasRole: (r) => mockState.roles.includes(r),
    getUserID: () => '6816f79cc0a8016401c5a33be04be441',
    getUserName: () => 'admin',
    getUserDisplayName: () => 'System Administrator',
    info: (msg) => {},
    warn: (msg) => {},
    error: (msg) => {},
    getSession: () => ({
        clientData: {},
        getClientData: function(k) { return this.clientData[k]; },
        putClientData: function(k, v) { this.clientData[k] = v; }
    })
};

global.GlideDateTime = function(val) {
    this.val = val || '2026-10-21 00:00:00';
    this.getValue = () => this.val;
    this.getDisplayValue = () => this.val;
    this.getLocalDate = () => ({ getValue: () => '2026-10-21' });
    this.setDisplayValueInternal = (v) => { this.val = v; };
    this.after = () => false;
};

global.GlideDigest = function() {
    this.getSHA256Hex = (s) => require('crypto').createHash('sha256').update(s).digest('hex');
};

global.GlideRecord = function(table) {
    this.table = table;
    this.rows = (mockState.tables[table] || []).slice();
    this.idx = -1;
    this.current = {};
    this.addActiveQuery = function() { this.rows = this.rows.filter(r => r.active === true || r.active === '1'); };
    this.addQuery = function(f, op, val) {
        if (arguments.length === 2) { val = op; op = '='; }
        if (op === '=') this.rows = this.rows.filter(r => r[f] === val);
        else if (op === '!=') this.rows = this.rows.filter(r => r[f] !== val);
    };
    this.addEncodedQuery = function(q) {};
    this.orderBy = function() {};
    this.orderByDesc = function() {};
    this.setLimit = function(n) { this.rows = this.rows.slice(0, n); };
    this.query = function() { this.idx = -1; };
    this.next = function() {
        this.idx++;
        if (this.idx < this.rows.length) {
            this.current = this.rows[this.idx];
            return true;
        }
        return false;
    };
    this.get = function(id) {
        const found = (mockState.tables[table] || []).find(r => r.sys_id === id);
        if (found) { this.current = found; return true; }
        return false;
    };
    this.getValue = function(f) { return this.current[f] !== undefined ? this.current[f] : null; };
    this.setValue = function(f, v) { this.current[f] = v; };
    this.getUniqueValue = function() { return this.current.sys_id || 'mock_sys_id'; };
    this.isValidField = function(f) { return true; };
    this.initialize = function() { this.current = {}; };
    this.insert = function() {
        if (!this.current.sys_id) this.current.sys_id = 'log_' + Math.random().toString(16).slice(2, 10);
        mockState.tables[table].push(Object.assign({}, this.current));
        return this.current.sys_id;
    };
    this.update = function() { return true; };
    Object.defineProperty(this, 'api_key', {
        get: () => ({ getDecryptedValue: () => this.current.api_key || '' })
    });
};

global.GlideRecordSecure = global.GlideRecord;

global.GlideAggregate = function(table) {
    this.table = table;
    this.addQuery = function() {};
    this.addEncodedQuery = function() {};
    this.addAggregate = function() {};
    this.groupBy = function() {};
    this.setGroup = function() {};
    this.query = function() {};
    this.next = function() { return false; };
    this.getAggregate = function() { return 0; };
    this.getValue = function() { return ''; };
};

// Mock sn_ws.RESTMessageV2
global.sn_ws = {
    RESTMessageV2: function() {
        this.endpoint = '';
        this.method = 'post';
        this.headers = {};
        this.body = '';
        this.followRedirects = true;
        this.setEndpoint = (u) => { this.endpoint = u; };
        this.setHttpMethod = (m) => { this.method = m; };
        this.setHttpTimeout = (t) => { this.timeout = t; };
        this.setFollowRedirects = (f) => { this.followRedirects = f; };
        this.setRequestHeader = (k, v) => { this.headers[k] = v; };
        this.setRequestBody = (b) => { this.body = b; };
        this.execute = () => {
            const planned = mockState.restResponses.shift();
            if (!planned) {
                return {
                    getStatusCode: () => 200,
                    getBody: () => JSON.stringify({ choices: [{ message: { content: 'Default mock answer' } }] }),
                    getHeader: () => null,
                    getErrorMessage: () => null
                };
            }
            if (planned.throws) throw new Error(planned.throws);
            return {
                getStatusCode: () => planned.status || 200,
                getBody: () => (typeof planned.body === 'string' ? planned.body : JSON.stringify(planned.body)),
                getHeader: (h) => (planned.headers && planned.headers[h]) || null,
                getErrorMessage: () => planned.errorMsg || null
            };
        };
    }
};

// Load scripts from src/scoped and src/global
const scopedDir = path.join(__dirname, '..', 'scoped');
const globalDir = path.join(__dirname, '..', 'global');
eval(fs.readFileSync(path.join(scopedDir, 'LLMAdapter.js'), 'utf8'));
eval(fs.readFileSync(path.join(scopedDir, 'AgentTools.js'), 'utf8'));
eval(fs.readFileSync(path.join(scopedDir, 'RecordTools.js'), 'utf8'));
eval(fs.readFileSync(path.join(scopedDir, 'Budget.js'), 'utf8'));
eval(fs.readFileSync(path.join(scopedDir, 'AgentCore.js'), 'utf8'));

console.log('--- STARTING OMNIROUTE INTEGRATION & SECURITY TESTS ---');

let passed = 0;
let total = 0;

function test(name, fn) {
    total++;
    mockState.restResponses = [];
    try {
        fn();
        console.log(`[PASS] ${name}`);
        passed++;
    } catch (err) {
        console.error(`[FAIL] ${name}:`, err.message);
    }
}

// 1. SSRF Protection: Multi-Vector Verification
test('SSRF Protection: Rejects private IPs, link-local, cloud metadata, userinfo, and hex/integer IPs', () => {
    // Dangerous schemes
    assert.strictEqual(LLMAdapter.validateEndpoint('file:///etc/passwd', false).ok, false);
    assert.strictEqual(LLMAdapter.validateEndpoint('gopher://internal.server', false).ok, false);
    
    // Userinfo confusion trick
    assert.strictEqual(LLMAdapter.validateEndpoint('https://evil.com@169.254.169.254/latest', false).ok, false);

    // Cloud metadata addresses
    assert.strictEqual(LLMAdapter.validateEndpoint('http://169.254.169.254/latest/meta-data', false).ok, false);
    assert.strictEqual(LLMAdapter.validateEndpoint('https://169.254.169.254/latest/meta-data', false).ok, false);
    assert.strictEqual(LLMAdapter.validateEndpoint('https://metadata.google.internal/computeMetadata/v1', false).ok, false);
    assert.strictEqual(LLMAdapter.validateEndpoint('https://instance-data', false).ok, false);

    // Private IPv4 ranges
    assert.strictEqual(LLMAdapter.validateEndpoint('https://10.0.0.1/v1', false).ok, false);
    assert.strictEqual(LLMAdapter.validateEndpoint('https://192.168.1.50/v1', false).ok, false);
    assert.strictEqual(LLMAdapter.validateEndpoint('https://172.16.0.5/v1', false).ok, false);
    assert.strictEqual(LLMAdapter.validateEndpoint('https://172.31.255.255/v1', false).ok, false);
    assert.strictEqual(LLMAdapter.validateEndpoint('https://0.0.0.0/v1', false).ok, false);

    // Integer / Hex IP tricks
    assert.strictEqual(LLMAdapter.validateEndpoint('https://2130706433/v1', false).ok, false);
    assert.strictEqual(LLMAdapter.validateEndpoint('https://0x7f000001/v1', false).ok, false);

    // IPv6 Private & Loopback
    assert.strictEqual(LLMAdapter.validateEndpoint('https://[::1]/v1', false).ok, false);
    assert.strictEqual(LLMAdapter.validateEndpoint('https://[fe80::1]/v1', false).ok, false);
    assert.strictEqual(LLMAdapter.validateEndpoint('https://[fc00::1]/v1', false).ok, false);

    // Insecure HTTP on remote host rejected
    assert.strictEqual(LLMAdapter.validateEndpoint('http://api.omniroute.com/v1', false).ok, false);

    // Valid public HTTPS allowed
    assert.strictEqual(LLMAdapter.validateEndpoint('https://api.omniroute.internal.corp/v1', false).ok, true);

    // Loopback testing strictly requires allow_http_localhost property
    assert.strictEqual(LLMAdapter.validateEndpoint('http://127.0.0.1:20128/v1', true).ok, true);
    assert.strictEqual(LLMAdapter.validateEndpoint('http://127.0.0.1:20128/v1', false).ok, false);
});

// 2. Error Classification
test('Error Classification: Categorizes retryable vs non-retryable errors', () => {
    const authErr = LLMAdapter.classifyError(401, 'Unauthorized: Invalid API key');
    assert.strictEqual(authErr.category, 'auth_error');
    assert.strictEqual(authErr.retryable, false);

    const badReq = LLMAdapter.classifyError(400, 'Invalid JSON body');
    assert.strictEqual(badReq.category, 'bad_request');
    assert.strictEqual(badReq.retryable, false);

    const rateLimit = LLMAdapter.classifyError(429, 'Rate limit exceeded');
    assert.strictEqual(rateLimit.category, 'rate_limit');
    assert.strictEqual(rateLimit.retryable, true);

    const serverErr = LLMAdapter.classifyError(503, 'Service Temporarily Unavailable');
    assert.strictEqual(serverErr.category, 'server_error');
    assert.strictEqual(serverErr.retryable, true);

    const timeoutErr = LLMAdapter.classifyError(0, 'Connection timed out');
    assert.strictEqual(timeoutErr.category, 'timeout');
    assert.strictEqual(timeoutErr.retryable, true);
});

// 3. Existing Anthropic Provider Compatibility
test('Existing Provider: Anthropic Claude messages and prompt caching work', () => {
    const provider = {
        sys_id: 'prov_anthropic_1',
        name: 'Anthropic Claude',
        type: 'anthropic',
        base_url: 'https://api.anthropic.com/v1',
        model: 'claude-3-5-sonnet',
        max_tokens: 2048,
        api_key: 'sk-ant-test-key'
    };

    mockState.restResponses.push({
        status: 200,
        body: {
            content: [{ type: 'text', text: 'Anthropic response' }],
            stop_reason: 'end_turn',
            usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 20, cache_creation_input_tokens: 10 }
        }
    });

    const adapter = new LLMAdapter(provider);
    const res = adapter.chat('System instructions', [{ role: 'user', content: 'Hello' }], []);
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.text, 'Anthropic response');
    assert.strictEqual(res.usage.cache_read, 20);
    assert.strictEqual(res.usage.input, 100);
});

// 4. Existing OpenAI-Compatible Provider Compatibility
test('Existing Provider: OpenAI-compatible wire protocol works', () => {
    const provider = {
        sys_id: 'prov_openai_1',
        name: 'OpenAI Direct',
        type: 'openai_compatible',
        base_url: 'https://api.openai.com/v1',
        model: 'gpt-4o',
        max_tokens: 2048,
        api_key: 'sk-openai-test-key'
    };

    mockState.restResponses.push({
        status: 200,
        body: {
            choices: [{ message: { content: 'OpenAI response', role: 'assistant' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 150, completion_tokens: 45, prompt_tokens_details: { cached_tokens: 50 } }
        }
    });

    const adapter = new LLMAdapter(provider);
    const res = adapter.chat('System text', [{ role: 'user', content: 'Explain CI' }], []);
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.text, 'OpenAI response');
    assert.strictEqual(res.usage.input, 100);
    assert.strictEqual(res.usage.cache_read, 50);
});

// 5. OmniRoute Provider Support & /models Discovery
test('OmniRoute Provider: Chat completions & connection test via /models', () => {
    const provider = {
        sys_id: 'prov_omni_1',
        name: 'OmniRoute Gateway',
        type: 'omniroute',
        base_url: 'https://omniroute.internal.corp/v1',
        model: 'llama-3-70b',
        max_tokens: 2048,
        api_key: 'or-test-key-12345'
    };

    mockState.restResponses.push({
        status: 200,
        body: {
            data: [{ id: 'llama-3-70b' }, { id: 'mistral-large' }, { id: 'gpt-4o' }]
        }
    });

    const adapter = new LLMAdapter(provider);
    const connTest = adapter.testConnection();
    assert.strictEqual(connTest.ok, true);
    assert.strictEqual(connTest.models.includes('llama-3-70b'), true);
    assert.strictEqual(connTest.models.includes('mistral-large'), true);

    mockState.restResponses.push({
        status: 200,
        body: {
            choices: [{ message: { content: 'OmniRoute answer' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 80, completion_tokens: 30 }
        }
    });

    const chatRes = adapter.chat('System', [{ role: 'user', content: 'Test OmniRoute' }], []);
    assert.strictEqual(chatRes.ok, true);
    assert.strictEqual(chatRes.text, 'OmniRoute answer');
});

// 6. Fail-Closed Model Allowlist Validation
test('Model Selection: Fail-closed allowlist enforcement', () => {
    // When allowlist is set
    mockState.properties['x_gmg_ai.model_allowlist'] = 'gpt-4o,llama-3-70b';
    assert.strictEqual(AgentCore.isModelAllowed('gpt-4o', 'llama-3-70b'), true);
    assert.strictEqual(AgentCore.isModelAllowed('claude-unlisted', 'llama-3-70b'), false);

    // Fail-closed when allowlist is empty/unset: only provider default model allowed
    mockState.properties['x_gmg_ai.model_allowlist'] = '';
    assert.strictEqual(AgentCore.isModelAllowed('llama-3-70b', 'llama-3-70b'), true);
    assert.strictEqual(AgentCore.isModelAllowed('random-model-name', 'llama-3-70b'), false);
    mockState.properties['x_gmg_ai.model_allowlist'] = 'gpt-4o,claude-3-5-sonnet,llama-3-70b,mistral-large'; // reset
});

// 7. Safe Fallback on Retryable 429 Rate Limit
test('Safe Fallback: HTTP 429 Rate Limit triggers fallback to secondary provider', () => {
    mockState.tables.x_gmg_ai_provider = [
        {
            sys_id: 'prov_primary',
            name: 'Primary OmniRoute',
            type: 'omniroute',
            base_url: 'https://omniroute.corp/v1',
            model: 'llama-3-70b',
            active: '1',
            is_default: '1',
            api_key: 'key-1'
        },
        {
            sys_id: 'prov_secondary',
            name: 'Secondary Provider',
            type: 'openai_compatible',
            base_url: 'https://backup.corp/v1',
            model: 'gpt-4o',
            active: '1',
            is_default: '0',
            api_key: 'key-2'
        }
    ];

    mockState.restResponses.push({
        status: 429,
        body: { error: { message: 'Rate limit exceeded' }, usage: { prompt_tokens: 40, completion_tokens: 0 } },
        headers: { 'Retry-After': '1' }
    });

    mockState.restResponses.push({
        status: 200,
        body: {
            choices: [{ message: { content: 'Answer from secondary backup provider' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 90, completion_tokens: 25 }
        }
    });

    const core = new AgentCore();
    const result = core.run({
        message: 'Summarize network alerts',
        context: { url: '/incident.do', table: 'incident', sys_id: 'd9b6b6812f8c1710fe5019aa6fa4e395' }
    });

    assert.strictEqual(result.response, 'Answer from secondary backup provider');
    assert.strictEqual(result.fallbacks.length, 1);
    assert.strictEqual(result.fallbacks[0].from_provider, 'Primary OmniRoute');
    assert.strictEqual(result.fallbacks[0].to_provider, 'Secondary Provider');
    assert.strictEqual(result.fallbacks[0].category, 'rate_limit');
    assert.strictEqual(result.attempts, 2);
    // Cumulative token accounting covers failed attempt + successful attempt
    assert.strictEqual(result.usage.input, 130); // 40 + 90
});

// 8. Non-Retryable Error Aborts Immediately Without Fallback
test('Non-Retryable Error: HTTP 401 Auth Failure does NOT trigger fallback', () => {
    mockState.tables.x_gmg_ai_provider = [
        {
            sys_id: 'prov_primary_auth',
            name: 'Primary Auth Fail',
            type: 'omniroute',
            base_url: 'https://omniroute.corp/v1',
            model: 'llama-3-70b',
            active: '1',
            is_default: '1',
            api_key: 'invalid-key'
        },
        {
            sys_id: 'prov_secondary',
            name: 'Secondary Provider',
            type: 'openai_compatible',
            base_url: 'https://backup.corp/v1',
            model: 'gpt-4o',
            active: '1',
            is_default: '0',
            api_key: 'key-2'
        }
    ];

    mockState.restResponses.push({
        status: 401,
        body: { error: { message: 'Incorrect API key provided' } }
    });

    const core = new AgentCore();
    const result = core.run({
        message: 'Hello',
        context: { url: '/incident.do' }
    });

    assert.strictEqual(result.fallbacks.length, 0);
    assert.strictEqual(result.attempts, 1);
    assert.strictEqual(result.error && result.error.includes('HTTP 401'), true);
});

// 9. Budget Accounting: Distinguishes Priced vs Unpriced
test('Budget Accounting: Correctly flags unpriced / estimated models', () => {
    const unpricedProvider = {
        sys_id: 'unpriced_prov',
        name: 'Unpriced OmniRoute',
        model: 'llama-3-70b',
        price_input_per_m: '0',
        price_output_per_m: '0',
        getValue: function(k) { return this[k]; },
        getUniqueValue: function() { return this.sys_id; }
    };
    assert.strictEqual(Budget.isPriced(unpricedProvider), false);

    const pricedProvider = {
        sys_id: 'priced_prov',
        name: 'Priced Provider',
        model: 'gpt-4o',
        price_input_per_m: '5.0',
        price_output_per_m: '15.0',
        getValue: function(k) { return this[k]; },
        getUniqueValue: function() { return this.sys_id; }
    };
    assert.strictEqual(Budget.isPriced(pricedProvider), true);
});

// 10. Secrets Never Exposed in listProviders
test('Security: Provider API keys are never exposed in listProviders', () => {
    mockState.tables.x_gmg_ai_provider = [
        {
            sys_id: 'prov_omni_sec',
            name: 'OmniRoute Gateway',
            type: 'omniroute',
            base_url: 'https://omniroute.corp/v1',
            model: 'llama-3-70b',
            active: '1',
            is_default: '1',
            api_key: 'SUPER_SECRET_KEY_NEVER_EXPOSE'
        }
    ];

    const core = new AgentCore();
    const provList = core.listProviders();
    assert.strictEqual(provList.providers.length, 1);
    const item = provList.providers[0];
    assert.strictEqual(item.name, 'OmniRoute Gateway');
    assert.strictEqual(item.type, 'omniroute');
    assert.strictEqual('api_key' in item, false);
    assert.strictEqual('key' in item, false);
    assert.strictEqual('base_url' in item, false);
    assert.strictEqual(JSON.stringify(provList).includes('SUPER_SECRET_KEY_NEVER_EXPOSE'), false);
});

// 11. Execution Deadline Exceeded (Timeout Handling)
test('Execution Deadline: Stops retrying when time budget is exceeded', () => {
    mockState.properties['x_gmg_ai.time_budget_ms'] = '100';
    mockState.tables.x_gmg_ai_provider = [
        {
            sys_id: 'prov_timeout',
            name: 'Timeout Provider',
            type: 'omniroute',
            base_url: 'https://omniroute.corp/v1',
            model: 'llama-3-70b',
            active: '1',
            is_default: '1',
            api_key: 'key-1'
        }
    ];

    mockState.restResponses.push({
        status: 0,
        body: '',
        errorMsg: 'SocketTimeoutException: Read timed out'
    });

    const core = new AgentCore();
    const result = core.run({
        message: 'Compute complex data',
        context: { url: '/incident.do' }
    });

    assert.strictEqual(result.error !== undefined, true);
    mockState.properties['x_gmg_ai.time_budget_ms'] = '45000';
});

// 12. OmniRoute Function / Tool Calling Contract
test('Tool Calling: OmniRoute tool_calls are parsed and handled correctly', () => {
    const provider = {
        sys_id: 'prov_omni_tools',
        name: 'OmniRoute Tool Caller',
        type: 'omniroute',
        base_url: 'https://omniroute.internal.corp/v1',
        model: 'llama-3-70b',
        max_tokens: 2048,
        api_key: 'key-tools'
    };

    mockState.restResponses.push({
        status: 200,
        body: {
            choices: [{
                message: {
                    content: null,
                    role: 'assistant',
                    tool_calls: [{
                        id: 'call_123',
                        type: 'function',
                        function: {
                            name: 'get_record',
                            arguments: '{"table":"incident","number":"INC0000060"}'
                        }
                    }]
                },
                finish_reason: 'tool_calls'
            }],
            usage: { prompt_tokens: 50, completion_tokens: 20 }
        }
    });

    const adapter = new LLMAdapter(provider);
    const res = adapter.chat('System', [{ role: 'user', content: 'Get incident INC0000060' }], [{
        name: 'get_record',
        description: 'Read record',
        parameters: { type: 'object' }
    }]);

    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.tool_calls.length, 1);
    assert.strictEqual(res.tool_calls[0].name, 'get_record');
    assert.strictEqual(res.tool_calls[0].arguments.number, 'INC0000060');
});

// 13. UI Script generates accessible model selector
test('UI Script: Generates accessible model selector dropdown with allowlisted models', () => {
    const uiScript = fs.readFileSync(path.join(globalDir, 'gmg_ai_agent_panel.js'), 'utf8');
    assert.strictEqual(uiScript.includes('id="gmgai-prov-select"'), true);
    assert.strictEqual(uiScript.includes('aria-label="Choose AI Model"'), true);
    assert.strictEqual(uiScript.includes('.gmgai-select'), true);
});

console.log(`\n========================================`);
console.log(`TEST SUMMARY: ${passed} / ${total} tests passed.`);
console.log(`========================================\n`);

if (passed !== total) {
    process.exit(1);
}
