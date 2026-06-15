# VousFin → Autonomous Finance: Intelligence & Autonomy Roadmap

> A staged plan to evolve VousFin from an AI-assisted accounting app into a
> **policy-governed, multi-agent autonomous finance team** — one that keeps the
> books continuously closed, manages cash and collections, stays compliant and
> files taxes, and acts on the owner's behalf within guardrails they control —
> **earning more autonomy as it learns**, with every action explained, audited
> and reversible.

---

## 1. How I arrived at the target (scenarios → scoring → convergence)

I visualised four end-states, scored each, then stress-tested the winner for what
would make it better, until it stopped improving.

| # | Scenario | What it is | Autonomy ceiling | Verdict |
|---|----------|-----------|------------------|---------|
| A | **Smarter assistant** | More/better AI suggestions; human does all entry + decisions | Low | Rejected — advises, never acts. The data-entry burden (the real cost) stays. |
| B | **Self-driving books** | Docs/bank feeds → AI extracts, classifies, posts double-entry; only exceptions reviewed; books continuously closed | Medium-High | Better than A (removes entry burden) but still passive on cash, compliance, decisions. |
| C | **Autonomous CFO** | B + forecasts cash, flags risk, drafts & (with approval) executes actions: collections, payment timing, tax filing, close, monthly CFO report | High | Better than B (records → decides + acts) but decisions are static rules/forecasts; no learning, weak governance. |
| D | **Policy-governed agentic finance ops + continuous learning** | C, re-architected as cooperating agents under an explicit **policy + guardrail engine**, **confidence-calibrated** automation, a **learning loop** from every correction, full **explainability + reversibility**, and a per-capability **autonomy dial** | **Maximal** | **Chosen.** |

**Why D wins the stress test.** Putting an AI in charge of money fails on *trust*
and *safety* unless four things are true; D is the only scenario that has them:

1. **Earned autonomy, not assumed.** A per-capability dial — **Observe → Suggest
   → Co-pilot (auto with approval) → Autopilot (auto within limits)** — lets the
   owner grant control gradually as each capability *proves* its accuracy. You
   cannot ship "auto-pay vendors" on day one; you earn it.
2. **Confidence-calibrated action.** Every proposed action carries a confidence
   score; high-confidence auto-executes within policy, low-confidence escalates.
   Thresholds are owner-set and tighten/loosen as the system learns.
3. **A closed learning loop.** Every approve / edit / reject becomes signal —
   per-vendor/customer/account memory, rule tuning, model calibration — so the
   **exception rate visibly falls month over month**. The system measurably gets
   more autonomous; the owner sees their workload shrink.
4. **Total auditability + one-click reversal.** Every autonomous action is logged,
   explained ("why I did this"), and reversible. Non-negotiable for finance —
   and VousFin already has immutable audit + journal reversal to build on.

**Could it be better than D?** I pushed on it: peer/benchmark intelligence
(privacy-sensitive, secondary), regulatory auto-updates (folds into the tax
agent), email-inbox ingestion (folds into the bookkeeper agent). None change the
shape. The shape is right. **The one unforgettable thing** is the *trust curve*:
a finance system that hands you back hours by earning your trust, transparently,
and proves it with a falling exception count.

**North-star UX:** the owner's entire interface collapses to **one inbox**
(approvals + exceptions), **a set of autonomy dials**, and **a plain-language
control line** ("don't pay ACME until the dispute clears", "be aggressive on
collections this month"). Everything else runs itself and reports back.

---

## 2. Architecture — three foundation pillars + a fleet of agents

VousFin already has unusually strong foundations to build on: double-entry GL with
atomic balances, immutable audit trail, journal reversal, an AI review/approval
queue, anomaly detection, an LSTM forecast platform, business-health scoring,
bank reconciliation, a needs-attention feed, `node-cron` job infra, the AI
assistant, and now the **Tax Autopilot (FR-04)**. The roadmap *wraps and
orchestrates* these rather than replacing them.

### Foundation (the spine — build first, everything plugs in)

- **F1 · Autonomy Engine** — the control plane. Per-capability autonomy level,
  confidence thresholds, a **policy store** (limits, allow/deny lists, blackout
  rules), approval routing, and the guardrail checks every action must pass.
- **F2 · Action Framework** — one uniform `ProposedAction` abstraction every
  agent emits: `{ capability, type, payload, confidence, rationale, citations,
  reversal }`. The Autonomy Engine routes each: **auto-execute** (within policy),
  **queue for approval**, or **surface as a suggestion**. One inbox; every action
  carries its undo and its audit row.
- **F3 · Learning Loop** — capture every approve/edit/reject as feedback; build
  per-entity memory (this vendor's GL account, this customer's pay behaviour);
  recalibrate confidence + tighten rules on a schedule; publish an **Autonomy
  Report** ("87% auto-handled this month, up from 64%; you reviewed 12 items").

### Agents (the autonomous workers — each a capability on the dial)

- **A1 · Bookkeeper** — ingest documents (uploads, email, bank feeds) → extract →
  classify → propose journal entries. *Builds on:* AI review queue, NL/Excel
  engines.
- **A2 · Reconciler** — auto-match bank lines, propose adjusting entries. *Builds
  on:* bank reconciliation, exceptions queue.
- **A3 · Collector** — predict late payers, draft/auto-send dunning, offer payment
  plans. *Builds on:* dunning service, AR.
- **A4 · Cash & Payments** — optimise payment timing for cash position + early-pay
  discounts; propose payment runs (execution always approval-gated). *Builds on:*
  AP, forecast, bill scheduler.
- **A5 · Tax & Compliance** — **done (FR-04)**: live position, advisor, prepare +
  file. *Elevate:* plug into the dial; "Autopilot" = auto-file when configured.
- **A6 · Controller / Close** — autonomous month-end: accruals, depreciation, FX,
  provisions, period reconciliation → reports + a CFO narrative. *Builds on:*
  reports, recognition schedules, fiscal-year service, cfoReport.
- **A7 · CFO Advisor** — proactive cash forecast, risk alerts, scenario planning,
  financing suggestions. *Builds on:* forecast platform, health, scenarios.

### Orchestration & Experience

- **O1 · Orchestrator/Planner** — sequences cross-domain workflows with
  dependencies (the monthly close; the weekly cash cycle), schedules agent runs,
  surfaces a unified plan.
- **X1 · Command Center** — the single inbox + autonomy dials + NL control line +
  Autonomy Report. The owner's whole surface.

---

## 3. Phased build (trust-first, value-incremental)

Each phase ships working software and is independently valuable. Autonomy is
introduced **at "Suggest" first**, then unlocked toward "Autopilot" per capability
only after its accuracy is demonstrated in the Autonomy Report. TDD throughout;
every autonomous action audited + reversible from day one.

### Phase 0 — The spine (Autonomy Engine + Action Framework + unified inbox)
*No behavior change — just unification and the control plane. Lowest risk.*
- **0.1** `AutonomyPolicy` model + store: per-business, per-capability level
  (`observe|suggest|copilot|autopilot`), confidence threshold, hard limits
  (e.g. max auto-payment), allow/deny lists. Default everything to `suggest`.
- **0.2** `ProposedAction` model + `actionRouter.service`: validate against
  policy + guardrails → route (execute/queue/suggest); always write an audit row
  and store a `reversal` descriptor.
- **0.3** Wrap the existing **AI review queue** and **needs-attention** items as
  `ProposedAction`s flowing through the router — one inbox, no logic change yet.
- **0.4** `Command Center` page (frontend): the unified inbox (approve / edit /
  reject), grouped by capability, each item showing rationale + citations.
- **0.5** Per-action **reversal** path proven (reuse journal reversal) + an audit
  view of "what the system did."
- **Acceptance:** every existing AI suggestion appears in one inbox with a why and
  an undo; nothing auto-executes yet; policy defaults to suggest.

### Phase 1 — The Learning Loop (make it get smarter)
- **1.1** `feedbackEvent` capture on every approve/edit/reject (what was proposed,
  what the human changed, why).
- **1.2** Per-entity **memory**: vendor→GL-account, customer→terms/behaviour,
  recurring-description→category. Used to raise suggestion accuracy + confidence.
- **1.3** Confidence **recalibration** job: per-capability accuracy from feedback;
  auto-suggest threshold adjustments to the owner.
- **1.4** **Autonomy Report**: accuracy, auto-handled %, exceptions, trend — the
  trust instrument that justifies turning dials up.
- **Acceptance:** repeated corrections measurably change future suggestions;
  the report shows accuracy per capability.

### Phase 2 — Bookkeeper Agent (the biggest workload win)
- **2.1** Ingestion: document upload + email-forward inbox + bank-feed import →
  normalize to a `SourceDocument`.
- **2.2** Extraction + classification → `ProposedAction(post_journal)` with
  confidence (reuse + extend the NL/AI engines; apply per-entity memory).
- **2.3** Dial integration: `observe` (log only) → `suggest` (review queue) →
  `copilot` (auto-post, owner notified) → `autopilot` (auto-post within limits).
- **2.4** Confidence-gated auto-posting with full audit + one-click reverse.
- **Acceptance:** a forwarded bill becomes a correct, reviewable (or auto-posted)
  journal entry; low-confidence escalates; everything reversible.

### Phase 3 — Reconciler + Collector to autopilot
- **3.1** Reconciler emits match + adjustment `ProposedAction`s; auto-clears
  high-confidence matches within policy.
- **3.2** Collector predicts late payers (feature off AR + history), drafts dunning
  / payment-plan offers; `copilot`/`autopilot` sends within policy + blackout
  rules; respects per-customer overrides from the NL control line.
- **Acceptance:** bank statement auto-reconciles the obvious lines; overdue
  customers are chased automatically within the owner's tone/limits.

### Phase 4 — Cash & Payments Agent (execution, approval-gated)
- **4.1** Cash-aware payment scheduling: optimise timing for runway + early-pay
  discounts; build a proposed **payment run**.
- **4.2** Execution is **always** approval-gated unless `autopilot` + within hard
  limits; full audit; reversible before settlement.
- **4.3** Guardrails: per-vendor/dispute holds, max auto-amount, dual-approval
  above a threshold (reuse the approval workflow).
- **Acceptance:** a weekly payment run is proposed with cash rationale; the owner
  approves once; disputed/held vendors are excluded.

### Phase 5 — Controller / Close Agent (autonomous month-end)
- **5.1** Close checklist as an orchestrated sequence: accruals, depreciation, FX
  revaluation, recognition postings, tax provision (FR-04), period reconciliation.
- **5.2** Auto-run each step as a `ProposedAction`; generate statements + a
  plain-language **CFO narrative** of the month.
- **5.3** Dial: `suggest` (draft close for review) → `autopilot` (close + report,
  exceptions surfaced).
- **Acceptance:** at month-end the books are closed (or a draft close is ready)
  with a narrative, with every posting audited + reversible.

### Phase 6 — Orchestrator / Planner (cross-domain autonomy)
- **6.1** Workflow engine sequencing multi-agent flows with dependencies
  (the **monthly close**, the **weekly cash cycle**, the **tax filing cycle**).
- **6.2** A unified **plan view**: what the system will do, when, and why; pause /
  override any step.
- **Acceptance:** the monthly close runs as one orchestrated, observable plan
  spanning bookkeeping → reconciliation → accruals → tax → reports.

### Phase 7 — Command Center polish + NL control plane
- **7.1** Natural-language policy control ("don't pay ACME until the dispute
  clears", "raise GST auto-file to autopilot") → structured policy updates.
- **7.2** Autonomy dials UI per capability with the accuracy that justifies each
  level; the Autonomy Report as the home of trust.
- **7.3** Responsive, themed, accessible; one inbox to rule them all.
- **Acceptance:** the owner runs the business from one inbox + dials + a chat line;
  turning a dial up is backed by a visible accuracy track record.

---

## 4. Cross-cutting principles (apply in every phase)

- **Safety rails before autonomy.** A capability cannot leave `suggest` until its
  guardrails (limits, holds, reversibility, dual-approval where money moves) exist.
- **Explain everything.** Every action shows its rationale + citations (the GL
  rows, the rule, the legal ref) — the FR-04 advisor pattern, everywhere.
- **Reversible by default.** Reuse immutable audit + journal reversal; no
  autonomous action without an undo path.
- **Confidence over coverage.** Better to escalate than to auto-act unsurely; the
  learning loop earns coverage over time.
- **One inbox.** Never scatter approvals; the owner has a single surface.
- **Measured autonomy.** The Autonomy Report is the product's conscience — it must
  honestly show accuracy and let the owner dial back instantly.

---

## 5. Why this is the ceiling

At the limit, VousFin is a 24/7 finance team that never misses a deadline, keeps
the books continuously closed, manages cash and collections, stays compliant and
files taxes, decides and acts within policies the owner sets in plain language —
and **gets more capable every month while the owner does less**, with complete
transparency and the ability to reverse anything. It is more reliable than a human
team on the mechanical work and keeps the human exactly where they add value:
setting intent and handling true exceptions. Past this, added "intelligence"
(peer benchmarks, deeper ML) is incremental polish on a shape that is already
right. **This is as smart and autonomous as it should get — by design, no further.**
