<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- Copyright 2026 GMG Technology LLC -->
# Data notice: how your data moves
The GMG AI Agent runs inside your ServiceNow instance. When a user asks it something, it sends the request and the record data it reads (for example, ticket fields and work notes) directly from your instance to the AI model provider or AI gateway (such as OmniRoute) *you* configure. GMG Technology LLC does not receive, store or see this data. When an enterprise deploys an on-premises or private-network OmniRoute gateway, data flows directly from your ServiceNow instance to that gateway.

**Changes go live once the user confirms.** The agent writes only to the record you have open, and only after you click Accept. If that record is active code, the confirmed change goes live immediately. The update set tracks the change; it does not hold it back for review. Review the diff, and test in a sub-production instance first.

**Your responsibilities.** You are the controller of your data. You choose the provider and are responsible for having a lawful basis and appropriate contract (such as a data processing agreement) with that provider, and for meeting laws that apply to you, which may include the Texas Data Privacy and Security Act (Tex. Bus. & Com. Code ch. 541) and the California Consumer Privacy Act (Cal. Civ. Code §1798.100 et seq.).

**Current limits.** The agent never sends password-type fields to the provider. It also removes keys, tokens and passwords from the error text it shows. It does not yet redact other personal data (names, emails, phone numbers, open text fields). Don't point it at records with sensitive personal data unless your provider agreement allows it.
