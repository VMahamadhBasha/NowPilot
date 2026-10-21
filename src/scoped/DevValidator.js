// Copyright 2026 GMG Technology LLC
// SPDX-License-Identifier: Apache-2.0
var DevValidator = Class.create();

/**
 * Deterministic static analysis and security validator for ServiceNow development artifacts.
 * Performs rigorous client/server context verification, recursion detection,
 * N+1 performance warnings, injection checks, and credential leakage scans.
 */
DevValidator.SEVERITY = {
    CRITICAL: 'Critical',
    HIGH: 'High',
    MEDIUM: 'Medium',
    LOW: 'Low',
    INFO: 'Info'
};

DevValidator.SERVER_ARTIFACTS = [
    'business_rule',
    'script_include',
    'scripted_rest',
    'background_script',
    'sys_script',
    'sys_script_include',
    'sys_ws_operation'
];

DevValidator.CLIENT_ARTIFACTS = [
    'client_script',
    'ui_policy',
    'sys_script_client',
    'sys_ui_policy'
];

/**
 * Quick balance checker for quotes, brackets, and braces
 */
DevValidator.checkBalance = function(code) {
    var stack = [];
    var inSingle = false, inDouble = false, inTemplate = false, inLineComment = false, inBlockComment = false;
    var line = 1, col = 1;

    for (var i = 0; i < code.length; i++) {
        var ch = code.charAt(i);
        var next = i + 1 < code.length ? code.charAt(i + 1) : '';

        if (ch === '\n') {
            line++;
            col = 1;
            inLineComment = false;
            continue;
        }
        col++;

        if (inLineComment) continue;
        if (inBlockComment) {
            if (ch === '*' && next === '/') {
                inBlockComment = false;
                i++;
            }
            continue;
        }

        if (!inSingle && !inDouble && !inTemplate) {
            if (ch === '/' && next === '/') {
                inLineComment = true;
                i++;
                continue;
            }
            if (ch === '/' && next === '*') {
                inBlockComment = true;
                i++;
                continue;
            }
        }

        // Handle string literals and escapes
        if (ch === '\\' && (inSingle || inDouble || inTemplate)) {
            i++; // skip escaped char
            continue;
        }

        if (ch === "'" && !inDouble && !inTemplate) {
            inSingle = !inSingle;
            continue;
        }
        if (ch === '"' && !inSingle && !inTemplate) {
            inDouble = !inDouble;
            continue;
        }
        if (ch === '`' && !inSingle && !inDouble) {
            inTemplate = !inTemplate;
            continue;
        }

        if (inSingle || inDouble || inTemplate) continue;

        // Parentheses, braces, brackets
        if (ch === '(' || ch === '{' || ch === '[') {
            stack.push({char: ch, line: line, col: col});
        } else if (ch === ')' || ch === '}' || ch === ']') {
            if (stack.length === 0) {
                return {ok: false, error: 'Unmatched closing bracket "' + ch + '" at line ' + line + ', col ' + col};
            }
            var top = stack.pop();
            var matches = (top.char === '(' && ch === ')') ||
                          (top.char === '{' && ch === '}') ||
                          (top.char === '[' && ch === ']');
            if (!matches) {
                return {
                    ok: false,
                    error: 'Mismatched brackets: expected closing for "' + top.char + '" (from line ' + top.line + ') but found "' + ch + '" at line ' + line
                };
            }
        }
    }

    if (inSingle) return {ok: false, error: 'Unclosed single quote literal'};
    if (inDouble) return {ok: false, error: 'Unclosed double quote literal'};
    if (inTemplate) return {ok: false, error: 'Unclosed template literal'};
    if (inBlockComment) return {ok: false, error: 'Unclosed block comment'};
    if (stack.length > 0) {
        var unclosed = stack.pop();
        return {ok: false, error: 'Unclosed bracket "' + unclosed.char + '" from line ' + unclosed.line};
    }

    return {ok: true};
};

/**
 * Remove comments and string literals to accurately scan bare code patterns
 */
DevValidator.stripCommentsAndStrings = function(code) {
    var out = '';
    var inSingle = false, inDouble = false, inTemplate = false, inLineComment = false, inBlockComment = false;

    for (var i = 0; i < code.length; i++) {
        var ch = code.charAt(i);
        var next = i + 1 < code.length ? code.charAt(i + 1) : '';

        if (ch === '\n') {
            inLineComment = false;
            out += '\n';
            continue;
        }

        if (inLineComment) continue;
        if (inBlockComment) {
            if (ch === '*' && next === '/') {
                inBlockComment = false;
                i++;
            }
            continue;
        }

        if (!inSingle && !inDouble && !inTemplate) {
            if (ch === '/' && next === '/') {
                inLineComment = true;
                i++;
                continue;
            }
            if (ch === '/' && next === '*') {
                inBlockComment = true;
                i++;
                continue;
            }
        }

        if (ch === '\\' && (inSingle || inDouble || inTemplate)) {
            i++;
            continue;
        }

        if (ch === "'" && !inDouble && !inTemplate) {
            inSingle = !inSingle;
            continue;
        }
        if (ch === '"' && !inSingle && !inTemplate) {
            inDouble = !inDouble;
            continue;
        }
        if (ch === '`' && !inSingle && !inDouble) {
            inTemplate = !inTemplate;
            continue;
        }

        if (inSingle || inDouble || inTemplate) continue;

        out += ch;
    }
    return out;
};

DevValidator.prototype = {
    initialize: function() {},

    /**
     * Run all deterministic static checks on the given code for an artifact type.
     */
    validate: function(code, artifactType, options) {
        options = options || {};
        code = String(code || '').trim();
        artifactType = String(artifactType || '').toLowerCase();

        var findings = [];
        if (!code) {
            findings.push({
                id: 'EMPTY_CODE',
                rule: 'Non-Empty Code',
                severity: DevValidator.SEVERITY.CRITICAL,
                message: 'Code block is empty or contains only whitespace.',
                explanation: 'An artifact requires executable script content.',
                recommendation: 'Provide or generate complete script body.'
            });
            return this._buildResult(findings, code);
        }

        // 1. Syntax & Balance Checks
        var balance = DevValidator.checkBalance(code);
        if (!balance.ok) {
            findings.push({
                id: 'SYNTAX_BRACKET_BALANCE',
                rule: 'Bracket & Literal Balance',
                severity: DevValidator.SEVERITY.CRITICAL,
                message: balance.error,
                explanation: 'Mismatched brackets or unclosed quotes will cause a syntax error at load/execution time.',
                recommendation: 'Ensure all opening braces, brackets, parentheses, and quotes are properly closed.'
            });
        }

        // Check for suspicious control characters
        if (/[\x00-\x08\x0B\x0C\x0E-\x1F]/.test(code)) {
            findings.push({
                id: 'SUSPICIOUS_CONTROL_CHARS',
                rule: 'No Control Characters',
                severity: DevValidator.SEVERITY.CRITICAL,
                message: 'Script contains illegal invisible ASCII control characters.',
                explanation: 'Non-printable control characters can break script parsers and obfuscate malicious payloads.',
                recommendation: 'Remove hidden ASCII control characters.'
            });
        }

        var bareCode = DevValidator.stripCommentsAndStrings(code);

        // 2. Security: Injection & Dangerous Execution
        if (/\b(eval|Function)\s*\(/.test(bareCode) || /setTimeout\s*\(\s*["']/.test(code) || /setInterval\s*\(\s*["']/.test(code)) {
            findings.push({
                id: 'DANGEROUS_EVAL',
                rule: 'No Dynamic Code Evaluation',
                severity: DevValidator.SEVERITY.CRITICAL,
                message: 'Suspicious dynamic code execution detected (eval, Function constructor, or string-based timer).',
                explanation: 'Dynamic code execution bypasses ServiceNow sandbox controls and exposes the instance to arbitrary code execution vulnerabilities.',
                recommendation: 'Refactor to static function calls or JSON.parse for serialization.'
            });
        }

        // Unsafe query concatenation (SQL-like injection in addEncodedQuery)
        if (/\.addEncodedQuery\s*\([^)]*\+[^)]*\)/.test(code)) {
            findings.push({
                id: 'UNSAFE_ENCODED_QUERY',
                rule: 'Safe Query Construction',
                severity: DevValidator.SEVERITY.HIGH,
                message: 'Potential query injection: addEncodedQuery used with string concatenation.',
                explanation: 'Concatenating unvalidated user inputs into an encoded query string can alter query semantics and expose unauthorized records.',
                recommendation: 'Use parameterized addQuery() calls or sanitize inputs before constructing encoded queries.'
            });
        }

        // Hardcoded credentials & sensitive tokens
        if (/\b(?:sk-[a-zA-Z0-9_-]{20,}|bearer\s+[a-zA-Z0-9_.-]{16,}|xai-[a-zA-Z0-9_-]{20,})\b/i.test(code) ||
            /(?:password|passwd|api[_-]?key|secret)\s*[:=]\s*["'][^"']{6,}["']/i.test(code)) {
            findings.push({
                id: 'HARDCODED_CREDENTIALS',
                rule: 'No Hardcoded Secrets',
                severity: DevValidator.SEVERITY.CRITICAL,
                message: 'Potential hardcoded API token, secret, or password detected in script.',
                explanation: 'Hardcoding secrets in script records risks credential leakage into logs, update sets, and version control.',
                recommendation: 'Store secrets in System Properties, 2-way encrypted fields, or ServiceNow Credentials / Connection records.'
            });
        }

        // Session impersonation without restoration
        if (/\.impersonate\s*\(/.test(bareCode)) {
            findings.push({
                id: 'SESSION_IMPERSONATION',
                rule: 'Privilege Escalation Review',
                severity: DevValidator.SEVERITY.HIGH,
                message: 'Script invokes gs.getSession().impersonate().',
                explanation: 'Impersonating users changes execution security context. Failure to restore original session identity causes lingering privilege escalation.',
                recommendation: 'Verify impersonation is strictly necessary and always wrapped in a try/finally block that restores the original user.'
            });
        }

        // 3. Client vs Server Boundary Violations
        var isServer = DevValidator.SERVER_ARTIFACTS.indexOf(artifactType) >= 0;
        var isClient = DevValidator.CLIENT_ARTIFACTS.indexOf(artifactType) >= 0;
        var isUiAction = (artifactType === 'ui_action' || artifactType === 'sys_ui_action');

        if (isServer) {
            // Server script calling client-only APIs
            if (/\b(g_form|g_user)\b/.test(bareCode)) {
                findings.push({
                    id: 'SERVER_CALLING_CLIENT_API',
                    rule: 'Client/Server Boundary',
                    severity: DevValidator.SEVERITY.CRITICAL,
                    message: 'Server-side artifact references client-side global object (g_form or g_user).',
                    explanation: 'g_form and g_user exist only in the browser DOM environment. Calling them on the server causes runtime ReferenceErrors.',
                    recommendation: 'Use the "current" GlideRecord, "gs.getUser()", or "gs.addInfoMessage()" on the server.'
                });
            }
            if (/\b(window|document|alert|confirm|prompt)\b/.test(bareCode)) {
                findings.push({
                    id: 'SERVER_CALLING_BROWSER_DOM',
                    rule: 'Client/Server Boundary',
                    severity: DevValidator.SEVERITY.CRITICAL,
                    message: 'Server-side script references browser DOM APIs (window, document, alert).',
                    explanation: 'The ServiceNow server JavaScript engine (Rhino/Node) runs headlessly and has no window or document objects.',
                    recommendation: 'Remove DOM calls from server script.'
                });
            }
        }

        if (isClient) {
            // Client script calling server-only APIs
            if (/\bgs\.(getUser|addInfoMessage|addErrorMessage|getProperty|log|info|warn|error|nil|tableExists)\b/.test(bareCode)) {
                findings.push({
                    id: 'CLIENT_CALLING_SERVER_API',
                    rule: 'Client/Server Boundary',
                    severity: DevValidator.SEVERITY.CRITICAL,
                    message: 'Client script references server-side GlideSystem API (gs.*).',
                    explanation: 'The "gs" object is not available in client scripts. Calling it causes a client-side JavaScript error.',
                    recommendation: 'Use "g_user" for user details, "g_scratchpad" for pre-loaded server values, or "GlideAjax" to query the server.'
                });
            }
            if (/\bcurrent\.(update|insert|setValue|getValue|addQuery)\b/.test(bareCode)) {
                findings.push({
                    id: 'CLIENT_CALLING_CURRENT_RECORD',
                    rule: 'Client/Server Boundary',
                    severity: DevValidator.SEVERITY.CRITICAL,
                    message: 'Client script attempts to manipulate "current" GlideRecord object.',
                    explanation: '"current" is a server-side Business Rule variable. In client scripts, use the "g_form" API.',
                    recommendation: 'Replace "current.setValue(...)" with "g_form.setValue(...)".'
                });
            }
            // Synchronous GlideRecord on client
            if (/\bnew\s+GlideRecord\b/.test(bareCode)) {
                findings.push({
                    id: 'CLIENT_SYNCHRONOUS_GLIDERECORD',
                    rule: 'No Client-Side GlideRecord',
                    severity: DevValidator.SEVERITY.HIGH,
                    message: 'Client script uses client-side GlideRecord.',
                    explanation: 'Client-side GlideRecord queries execute synchronously over HTTP, freezing the user browser interface and degrading UX.',
                    recommendation: 'Refactor to asynchronous GlideAjax calling a client-callable Script Include.'
                });
            }
        }

        // 4. Business Rule Recursion Hazards
        if (artifactType === 'business_rule' || artifactType === 'sys_script') {
            if (/\bcurrent\.update\s*\(/.test(bareCode)) {
                findings.push({
                    id: 'BR_RECURSION_CURRENT_UPDATE',
                    rule: 'Business Rule Recursion Protection',
                    severity: DevValidator.SEVERITY.CRITICAL,
                    message: 'Dangerous "current.update()" call detected in Business Rule.',
                    explanation: 'Calling current.update() in a before business rule triggers infinite recursion, thread exhaustion, and instance transaction hangs.',
                    recommendation: 'In a "before" business rule, values assigned to "current" are automatically saved without calling current.update(). If in an "after" rule, use current.setWorkflow(false) or refactor to an async rule.'
                });
            }
            if (/\bcurrent\.insert\s*\(/.test(bareCode)) {
                findings.push({
                    id: 'BR_RECURSION_CURRENT_INSERT',
                    rule: 'Business Rule Recursion Protection',
                    severity: DevValidator.SEVERITY.CRITICAL,
                    message: 'Dangerous "current.insert()" detected in Business Rule on insert.',
                    explanation: 'Calling current.insert() inside an insert rule results in duplicate record creation and recursive loops.',
                    recommendation: 'Assign field values directly to "current" instead of calling insert().'
                });
            }
        }

        // 5. Database Performance: GlideRecord inside Loops (N+1 Anti-Pattern)
        if (isServer) {
            if (/while\s*\([^)]*\.next\s*\(\s*\)\s*\)\s*\{[\s\S]*?\bnew\s+(?:GlideRecord|GlideRecordSecure)\b[\s\S]*?\}/.test(bareCode)) {
                findings.push({
                    id: 'PERF_GLIDERECORD_IN_LOOP',
                    rule: 'Avoid N+1 Database Queries',
                    severity: DevValidator.SEVERITY.HIGH,
                    message: 'GlideRecord instantiated or queried inside a while(.next()) loop.',
                    explanation: 'Instantiating and querying database records inside a loop creates an N+1 query pattern that severely degrades database performance under volume.',
                    recommendation: 'Collect record sys_ids into an array and perform a single batch query outside the loop using "addQuery(\'sys_id\', \'IN\', idList)".'
                });
            }

            // Unbounded queries on large tables
            if (/(?:syslog|sys_audit|sys_watermark|sys_email|task_sla)\b/i.test(code) &&
                /\.query\s*\(/.test(bareCode) && !/\.setLimit\s*\(/.test(bareCode)) {
                findings.push({
                    id: 'PERF_UNBOUNDED_LARGE_TABLE_QUERY',
                    rule: 'Query Row Limits on Large Tables',
                    severity: DevValidator.SEVERITY.HIGH,
                    message: 'Query executed against large table without setLimit().',
                    explanation: 'Querying high-volume tables (syslog, sys_audit, task_sla, sys_email) without a limit risks OutOfMemoryError and transaction cancellation.',
                    recommendation: 'Add gr.setLimit(500) or an appropriate bounded threshold before calling gr.query().'
                });
            }
        }

        // 6. Background Script Destructive Action Safety
        if (artifactType === 'background_script') {
            if (/\bdeleteMultiple\s*\(/.test(bareCode) && !/\bdryRun\b/i.test(code)) {
                findings.push({
                    id: 'BG_SCRIPT_UNGUARDED_DELETEMULTIPLE',
                    rule: 'Background Script Safety Guard',
                    severity: DevValidator.SEVERITY.CRITICAL,
                    message: 'Unbounded deleteMultiple() in Background Script without dry-run guard.',
                    explanation: 'deleteMultiple() bypasses business rules and deletes matched rows immediately. An incorrect query could purge production data.',
                    recommendation: 'Wrap destructive operations in a "var dryRun = true;" conditional block with log counting.'
                });
            }
            if (!/dryRun\b/i.test(code) && !/preview\b/i.test(code)) {
                findings.push({
                    id: 'BG_SCRIPT_NO_DRYRUN_FLAG',
                    rule: 'Background Script Dry-Run Standard',
                    severity: DevValidator.SEVERITY.MEDIUM,
                    message: 'Background script does not include a dryRun / simulation toggle.',
                    explanation: 'Best practice for one-off admin scripts is to provide a dry-run flag to verify record counts before applying updates.',
                    recommendation: 'Add "var dryRun = true;" and only execute updates/inserts when dryRun is false.'
                });
            }
        }

        // 7. Script Include Conventions
        if (artifactType === 'script_include' || artifactType === 'sys_script_include') {
            if (code.indexOf('Class.create()') < 0 && code.indexOf('prototype') < 0) {
                findings.push({
                    id: 'SI_MISSING_PROTOTYPE',
                    rule: 'Script Include Structure',
                    severity: DevValidator.SEVERITY.LOW,
                    message: 'Script Include does not follow standard Class.create() pattern.',
                    explanation: 'Standard ServiceNow Script Includes use Class.create() and prototype definition for object-oriented instantiation.',
                    recommendation: 'Wrap logic in "var MyClass = Class.create(); MyClass.prototype = { initialize: function() {}, type: \'MyClass\' };".'
                });
            }
            if (/AbstractAjaxProcessor/.test(code) && !/\bnewItem\s*\(/.test(code) && !/\bgetParameter\s*\(/.test(code)) {
                findings.push({
                    id: 'SI_AJAX_PROCESSOR_CONVENTIONS',
                    rule: 'Client-Callable Script Include Conventions',
                    severity: DevValidator.SEVERITY.INFO,
                    message: 'Script Include extends AbstractAjaxProcessor but does not call getParameter() or newItem().',
                    explanation: 'Client-callable Script Includes usually receive parameters via this.getParameter() and return data via this.newItem().',
                    recommendation: 'Verify Ajax parameters are read using this.getParameter(\'sysparm_name\').'
                });
            }
        }

        // 8. Client Script Conventions
        if (artifactType === 'client_script' || artifactType === 'sys_script_client') {
            if (options.client_script_type === 'onChange' || /function\s+onChange\b/.test(code)) {
                if (!/if\s*\(\s*isLoading\b/.test(bareCode)) {
                    findings.push({
                        id: 'CS_ONCHANGE_MISSING_ISLOADING',
                        rule: 'onChange Client Script Template',
                        severity: DevValidator.SEVERITY.MEDIUM,
                        message: 'onChange Client Script missing "if (isLoading) return;" guard.',
                        explanation: 'Without checking isLoading, an onChange script runs during initial form load, causing unnecessary overhead or unintended resets.',
                        recommendation: 'Include "if (isLoading || newValue === \'\') return;" at the beginning of the function.'
                    });
                }
            }
        }

        // 9. Null Handling Hazards
        if (isServer && /\.next\s*\(\s*\)/.test(bareCode)) {
            // Check if gr.getValue or gr.<field> is accessed without checking gr.next()
            if (/\b(?:gr|rec|record|target|source)\.getValue\s*\(/.test(bareCode) &&
                !/\bif\s*\([^)]*\.next\s*\(\s*\)\s*\)/.test(bareCode) &&
                !/\bwhile\s*\([^)]*\.next\s*\(\s*\)\s*\)/.test(bareCode)) {
                findings.push({
                    id: 'POTENTIAL_NULL_RECORD_ACCESS',
                    rule: 'Defensive Record Access',
                    severity: DevValidator.SEVERITY.LOW,
                    message: 'Potential record field access without verified next() check.',
                    explanation: 'Querying records without wrapping field retrieval in if (gr.next()) or while (gr.next()) will throw exceptions if no rows match.',
                    recommendation: 'Ensure all record field access occurs inside an "if (gr.next())" or "while (gr.next())" block.'
                });
            }
        }

        return this._buildResult(findings, code);
    },

    _buildResult: function(findings, code) {
        var counts = {Critical: 0, High: 0, Medium: 0, Low: 0, Info: 0};
        var hasCritical = false;

        for (var i = 0; i < findings.length; i++) {
            var s = findings[i].severity;
            if (counts[s] !== undefined) counts[s]++;
            if (s === DevValidator.SEVERITY.CRITICAL) hasCritical = true;
        }

        var lines = code ? code.split('\n').length : 0;
        var summary = counts.Critical + ' Critical, ' + counts.High + ' High, ' + counts.Medium + ' Medium, ' + counts.Low + ' Low issues found.';

        return {
            ok: !hasCritical,
            findings: findings,
            counts: counts,
            summary: summary,
            metrics: {
                lines: lines,
                chars: code.length
            }
        };
    },

    type: 'DevValidator'
};
