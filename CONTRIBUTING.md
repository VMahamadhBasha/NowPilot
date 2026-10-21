# Contributing to Now Pilot for ServiceNow

Thank you for your interest in contributing to **Now Pilot for ServiceNow**! We welcome community contributions that help make this platform-native AI assistant more reliable, secure, transparent, and capable.

Like upstream open-source frameworks, our repository maintains a strict focus: **Now Pilot is a universal, platform-native, instance-agnostic, and secure-by-default framework.** Every line of code merged into upstream must maintain the integrity of enterprise ServiceNow instances.

---

## Table of Contents

- [Core Philosophy](#core-philosophy)
- [What Gets Merged vs. What Gets Declined](#what-gets-merged-vs-what-gets-declined)
- [Local Development & Setup](#local-development--setup)
- [Running Automated Tests](#running-automated-tests)
- [Packaging & Update Set Synchronization](#packaging--update-set-synchronization)
- [Code Style & Standards](#code-style--standards)
- [Submitting a Pull Request](#submitting-a-pull-request)
- [Code of Conduct](#code-of-conduct)

---

## Core Philosophy

1. **Human-in-the-Loop is Non-Negotiable**: Now Pilot will **never** perform unapproved automated writes to a ServiceNow database. Every proposed change must be presented to the user as a sealed proposal (`GMGSeal`) requiring an explicit human click on **Accept**.
2. **Platform-Native Security**: All database interactions must strictly adhere to ServiceNow Access Control Lists (ACLs) using `GlideRecordSecure`. We never bypass platform security or write raw SQL.
3. **SSRF & Network Isolation**: Outbound HTTP requests from ServiceNow Script Includes or test harnesses must strictly validate destination URLs. Cloud metadata endpoints (`169.254.169.254`), private IP subnets, and loopback addresses are forbidden by default.
4. **Zero Vendor Lock-In**: Now Pilot treats AI providers as interchangeable commodities. We support OmniRoute, Anthropic Claude, OpenAI, and standard OpenAI-compatible gateways with graceful fallback.
5. **Fail-Closed & Observable**: If a budget limit is reached, an execution deadline expires, or a target record changes in the background, Now Pilot halts gracefully, records an audit event, and notifies the user with an authoritative correlation ID.

---

## What Gets Merged vs. What Gets Declined

### What Gets Merged ✅
- **Security & Isolation Improvements**: Hardening against SSRF, prompt injection, prototype pollution, or cross-user cache leakage.
- **Provider & Gateway Adapters**: Adding or refining support for standard wire protocols (e.g. OpenAI-compatible endpoints, prompt caching, tool calling).
- **Static Code Analysis (`DevValidator`)**: New platform safety heuristics for Business Rules, Script Includes, Client Scripts, and Flow Actions (e.g., catching recursive calls or deprecated APIs).
- **RAG & Search Enhancements**: Better deterministic ranking algorithms (BM25, TF-IDF tuning) for incident retrieval and Knowledge Base matching.
- **Robustness & Bug Fixes**: Bug fixes accompanied by deterministic test cases in the test suite.
- **Documentation & Clarifications**: Fixing inaccuracies, improving setup instructions, or adding architecture explanations.

### What Gets Declined ❌
- **Autonomous Write Tools**: PRs attempting to bypass the proposal seal or allow the LLM to write directly to platform tables without human approval.
- **Instance-Specific Hardcoding**: Custom `sys_id` values, company-specific table names, hardcoded network addresses, or credentials.
- **Heavy External Dependencies**: The scoped runtime runs inside ServiceNow's JavaScript engine (Rhino / ECMAScript 2021). PRs adding npm runtime dependencies to the scoped application will be rejected.
- **Committing Customer Data or Secrets**: PRs containing test logs with real employee names, customer ticket details, or live API keys.
- **Unverified Update Sets**: PRs modifying source files under `src/` without synchronizing the update sets and updating `SHA256SUMS`.

---

## Local Development & Setup

You do not need access to a live ServiceNow instance to contribute! The repository includes a zero-dependency local simulation server that replicates the ServiceNow classic form, client scripts, and REST endpoints.

### Prerequisites
- **Node.js** (v18.0.0 or higher)
- **Git**

### 1. Clone the Repository
```bash
git clone https://github.com/your-username/servicenow-ai-agent.git
cd servicenow-ai-agent
```

### 2. Launch the Local Interactive Simulator
Run the standalone runner:
```bash
node local_runner.js
```

Open your browser to:
```
http://localhost:3000
```
This loads an interactive ServiceNow incident form (`INC0010001`) with the Now Pilot floating launcher button in the bottom-right corner. You can test Chat, ITSM Intelligence, Dev Assistant, and Workflows directly.

---

## Running Automated Tests

Before submitting any code, all 150 automated tests across our 5 test suites must pass. Run each test suite locally using Node:

```bash
# 1. OmniRoute & Gateway Integration Tests (13 tests)
node src/test/test_omniroute.js

# 2. Advanced ServiceNow Development Assistant Tests (20 tests)
node src/test/test_dev_assistant.js

# 3. ITSM Intelligence & RAG Retrieval Tests (22 tests)
node src/test/test_itsm_intelligence.js

# 4. Agentic Workflow Automation & Controlled Execution Tests (22 tests)
node src/test/test_workflow_automation.js

# 5. Production Readiness, Observability & Packaging Tests (73 tests)
node src/test/test_production_readiness.js
```

### Run All Test Suites in Sequence
```bash
node -e "
const { execSync } = require('child_process');
const suites = [
  'src/test/test_omniroute.js',
  'src/test/test_dev_assistant.js',
  'src/test/test_itsm_intelligence.js',
  'src/test/test_workflow_automation.js',
  'src/test/test_production_readiness.js'
];
suites.forEach(s => {
  console.log('\n=== RUNNING ' + s + ' ===');
  execSync('node ' + s, { stdio: 'inherit' });
});
console.log('\n[SUCCESS] All 150 tests passed cleanly.');
"
```

---

## Packaging & Update Set Synchronization

Now Pilot is distributed as both modular source files (`src/`) and ServiceNow XML Update Sets (`update_sets/`).

Whenever you modify a global UI Script or scoped Script Include:

1. **Update the Source Code**: Edit the relevant file under `src/global/` or `src/scoped/`.
2. **Synchronize Update Sets**: Package your changes into `update_sets/gmg_ai_agent_global.xml` or `update_sets/gmg_ai_agent_scoped.xml`.
   - *Note:* ServiceNow XML payloads escape characters twice (`&` &rarr; `&amp;amp;`, `<` &rarr; `&amp;lt;`, `>` &rarr; `&amp;gt;`, `"` &rarr; `&amp;quot;`).
3. **Recompute Checksums**: Update `SHA256SUMS` with the new hash:
   ```bash
   sha256sum update_sets/gmg_ai_agent_global.xml update_sets/gmg_ai_agent_scoped.xml > SHA256SUMS
   ```
4. **Verify Manifest Consistency**:
   Run `node src/test/test_production_readiness.js` to confirm test 19 passes.

---

## Code Style & Standards

- **ServiceNow Compatibility**: Code in `src/scoped/` must execute reliably in the ServiceNow server-side runtime. Avoid modern Node-only globals (like `Buffer` or `process`) in files meant for the instance.
- **UI Script Concurrency**: Code in `src/global/gmg_ai_agent_panel.js` must be self-contained within an IIFE, isolate its styles, and handle cross-frame top window access gracefully.
- **Brand Consistency**:
  - Primary Green: `#168B50` (hover: `#117342`)
  - Dark Panel: `#080808`
  - Elevated Surface: `#151515`
  - Border: `#303030`
  - Main Text: `#F5F5F5`
  - Secondary Text: `#A3A3A3`
  - Brand Logo: Refer to `src/assets/now_pilot_logo.png`
- **Error Handling**: Throw standardized errors or classify them with `DiagnosticService`. Always include a correlation ID (`corr_...`).

---

## Developer Certificate of Origin (DCO) & Sign-Off

To ensure legal clarity and open-source provenance for all contributions under the Apache License 2.0, **Now Pilot requires a Developer Certificate of Origin (DCO) sign-off** on every commit.

By adding a sign-off line, you certify the following statement (from [developercertificate.org](https://developercertificate.org/)):

```
Developer Certificate of Origin
Version 1.1

Copyright (C) 2004, 2006 The Linux Foundation and its contributors.

By making a contribution to this project, I certify that:

(a) The contribution was created in whole or in part by me and I
    have the right to submit it under the open source license
    indicated in the file; or

(b) The contribution is based upon previous work that, to the best
    of my knowledge, is covered under an appropriate open source
    license and I have the right under that license to submit that
    work with modifications, whether created in whole or in part
    by me, under the same open source license; or

(c) The contribution was provided directly to me by some other
    person who certified (a), (b) or (c) and I have not modified
    it; and

(d) I understand and agree that this project and the contribution
    are public and that a record of the contribution (including all
    personal information I submit with it, including my sign-off) is
    maintained indefinitely and may be redistributed consistent with
    this project or the open source license(s) involved.
```

### How to Sign Off Your Commits

Use the `-s` (or `--signoff`) flag when making Git commits:

```bash
git commit -s -m "feat(retry): connect retry_max_attempts to bounded backoff loop"
```

Git will automatically append your sign-off trailer:
```
Signed-off-by: Your Name <your.email@example.com>
```

> **Note:** If you forgot to sign off your most recent commit before opening a pull request, you can amend it using:
> ```bash
> git commit --amend --no-edit -s
> ```

---

## Submitting a Pull Request

1. **Fork the Repository**: Create your branch from `main`:
   ```bash
   git checkout -b feature/your-feature-name
   ```
2. **Commit Changes with DCO Sign-Off**:
   ```bash
   git commit -s -m "feat(scope): concise description of change"
   ```
3. **Add Tests**: Ensure new capabilities or bug fixes include assertions in the appropriate test suite under `src/test/`.
4. **Verify Checksums**: Ensure `SHA256SUMS` matches the update set XML files.
5. **Open a PR**: Describe what was changed, why, and include output proving all 184 automated tests pass.

---

## Code of Conduct

We are dedicated to providing a respectful, inclusive, and professional environment for everyone. Please be constructive, considerate, and collaborative in all issues, pull requests, and discussions.
