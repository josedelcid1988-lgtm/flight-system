# Flight System user guide

Flight System is a browser-based manufacturing execution and quality system. Its
three modules are Flight Control, Flight Plan, and Flight Maneuver. The shared
server is the system of record for a team deployment. Standalone browser mode
stores data in that browser only.

## Open the application

For a shared installation, open the server address supplied by your system
administrator and sign in with your assigned account. Your available actions
depend on the capabilities granted to that account. Do not share credentials.

For a private installation, follow the startup and network guidance in the
[README](../README.md) and [database guide](DATABASES.md). Back up the database
before a release or migration. The current build is for integration review; it
is not production authorization. Review [the handover](../HANDOVER-v82.md) for
open deployment blockers.

For standalone evaluation, open `index.html` with its `assets/` directory beside
it. Browser data is local to that browser and does not synchronize with the
shared server.

## Use the modules

- **Flight Control** is for work orders, operations, inspection evidence,
  stamps, labor, and buy-off. Open a work order to review its operation sequence
  and required evidence. Record work through the operation workflow, then use
  the applicable qualified account to inspect and approve it.
- **Flight Plan** is for planned orders, work-center dispatch, material planning,
  priorities, projects, milestones, and capacity. Resolve displayed blockers
  before dispatch or conversion. Calendar file import and export are optional
  and are controlled by an authorized manager.
- **Flight Maneuver** is for nonconformances, corrective actions, material
  review, and problem reports. Keep containment, disposition, corrective
  actions, and verification evidence attached to their source records.

Use search and filters to find records. Queue drawers provide a summary and
route into the existing record workflow for changes that need controlled
evidence or approval. A draft, proposal, or accepted analysis does not replace
an approval on the underlying manufacturing or quality record.

## Create and review a skills analysis

The AI governance page provides twelve deterministic draft tools: FAIR review
(AS9102 Rev C), AS9102 ballooning V2, 5-Why, Fishbone, 8D builder, 8D checklist
reviewer, PFMEA checklist reviewer, PFMEA builder, SPC chart builder, MSA gage
R&R builder, Effectiveness follow-up, and Drawing review against ASME Y14.5.
Choose a tool and enter its input as JSON. Every run requires a reason and
creates a signed draft and hash-chained action record.

1. Choose a tool and provide its inputs. Include source record IDs in
   `targetRefs` where available. SPC needs numeric values; MSA needs a balanced
   crossed study. The tool refuses incomplete SPC/MSA data.
2. Review the draft against the controlled source records. Replace each
   `[confirm]` scaffold with verified facts and cite the evidence. These
   scaffolds are prompts for investigation, never findings.
3. Save evidence-based edits with a rationale. Editing resets any prior review.
4. A qualified second person reviews the draft. A different qualified
   credential accepts it after all scaffolds are removed.
5. Record any approved decision in the source workflow. Skill acceptance does
   not change the source record, approve a drawing, release a work instruction,
   close a corrective action, or authorize product release.

QA Manager and Master Access accounts can configure signed triggers. A trigger
is an authorized run definition; the current release does not automatically
connect every trigger to each business event. Model execution is unavailable.
The analysis tools do not read external records unless their contents are
provided to Flight System as input.

### Skills outside Flight System

The skills below are repository files in Datum-OS, not screens in Flight System
and not part of the Flight System source ZIP. They live under
`qms/skills/role/` and `qms/skills/manager/` in the Datum-OS repository. Use
them through a compatible assistant that can read project files and any
required references. They prepare or review work; the required human document
approval and release still happen in the controlled document system.

| Skill | What it does | Datum-OS folder |
| --- | --- | --- |
| `qms-document-author` | Interviews the requester, then authors, audits, or revises one controlled QMS document. It is the document-chain writer and works returned correction lists. | `qms/skills/role/qms-document-author/` |
| `qms-initial-check` | First review gate. Runs the 46-check structural and editorial review, then passes the draft forward or returns numbered corrections. It does not edit or approve. | `qms/skills/role/qms-initial-check/` |
| `qms-sr-check` | Senior review gate. Runs the 47-check standards and system-interrelation review and prepares an approval package or corrections. It does not approve or release. | `qms/skills/role/qms-sr-check/` |
| `qms-training-builder` | Builds or refreshes the training determination, matrix entries, lesson definition, exam and answer key, and revision reassignment decision from an eligible document package. Training is not assigned until release. | `qms/skills/role/qms-training-builder/` |
| `qms-manager` | Reviews a document and its training together for coverage, competence assessment, and consistency. It gives a recommendation, not approval. | `qms/skills/manager/qms-manager/` |
| `qms-orchestrator` | Coordinates the author, both review gates, training, package assembly, and manager review. It sequences work and carries findings; specialists supply the judgments and a person approves. | `qms/skills/manager/qms-orchestrator/` |
| `qms-publisher` | Transcribes a released document verbatim to the configured QMS wiki and checks fidelity. It requires the right destination and publishing access. | `qms/skills/role/qms-publisher/` |

Other Datum-OS repository skills are `qms-help` for plain-language QMS questions,
`qms-quality-systems-engineer` for system coverage and readiness analysis, and
`qms-automation-engineer` for automation design and skill-portfolio control.
Their folders are respectively `qms/skills/role/qms-help/`,
`qms/skills/role/qms-quality-systems-engineer/`, and
`qms/skills/manager/qms-automation-engineer/`. The Datum-OS
`qms/skills/README.md` describes the separate analysis-tool skills and their
server-side scripts. They are not automatically invoked or recorded by Flight
System.

#### Load one in a compatible assistant

1. Open the **Datum-OS repository** as the assistant's project or workspace.
   The skill folders are not included in the Flight System ZIP.
2. Ask for the exact skill by name and point to its folder, for example:
   `Use qms-document-author. Read qms/skills/role/qms-document-author/SKILL.md
   and the references it calls for before starting.`
3. Keep the skill folder intact. Give the assistant access to its referenced
   files, templates, and scripts, and provide the current controlled source
   documents required by that skill. Do not rely on the skill name alone to
   install or load files in an assistant that has no project-file access.
4. For an end-to-end document package, ask for `qms-orchestrator`; for one
   document stage, ask for the relevant specialist in the table. The pipeline
   requires distinct human review and approval. Publishing is a separate step
   after release.

The Datum-OS tool skill scripts are not run by the browser. Its skills guide
specifies Python 3.11 with `openpyxl` and LibreOffice for workbook generation
and recalculation through the Datum-OS server. Do not run those scripts from
Flight System or treat their output as a Flight System audit-log entry.

For a Flight System analysis performed with an external assistant, share only
records you are authorized to disclose. Request a **draft**, source IDs for
factual statements, clearly marked unknowns, and no approval or disposition.
Verify each statement against controlled records before entering it in Flight
System. External output is not a Flight System action-log entry or approval.
Never include credentials or API keys in prompts. Follow your organization's
data-sharing rules for controlled, supplier, customer, and export-controlled
information.

## Prints, exports, and records

Use the record's print or export action when a controlled copy is needed. Check
that the output identifies the correct record and revision before distribution.
File-based evidence is hashed and associated with its record. A successful
browser download alone does not prove that an external system received an
export; check the delivery history where that feature is configured.

## Get help and report a problem

Give your administrator the record ID, the action attempted, the account role,
the time, and the exact error text. Do not send passwords, tokens, or secret
values. For technical setup, backup, verification, and known limitations, use
the [technical manual](TECHNICAL_MANUAL.md), [testing guide](../TESTING.md),
and [current handover](../HANDOVER-v82.md).
