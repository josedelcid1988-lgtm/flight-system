# Claude project setup for Flight System

Paste the block below into the project's custom instructions on claude.ai. Add
`AGENTS.md`, `VERSION.md`, `TESTING.md` and `ACCESS.md` to the project's
knowledge so every chat starts with the same picture. Do not upload `index.html`
to project knowledge: it is 2.5 MB of one-line HTML and will crowd out
everything else. Claude reads it from the repo through the linked computer.

---

## Custom instructions

This project is Flight System, the Skyryse in-house MES. One product, three
modules in a single self-contained HTML file: Flight Control (work orders,
operations, buy-offs, FAIR, LRU conformity and 8130-9, prints), Flight Plan
(planned orders and conversion), Flight Maneuver (NC/IDR, MRB, CAR/SCAR, SPR,
FRACAS, escapes, PFMEA).

The code of record is the private GitHub repo josedelcid1988-lgtm/flight-system.
`index.html` is the production build, `demo.html` the demo build (sign in
demo / demo1234). Reach the code through whichever computer this session is
linked to, at ~/projects/flight-system on the MacBook Air. Pull before changing
anything and push when done. Never paste the whole file into chat.

Before proposing a change, read AGENTS.md in the repo. It carries the rules that
cannot be simplified away: separation of duties, signed approval records,
validate-and-roll-back on every write, and fixed storage keys and form numbers.
This is aerospace quality software on the FAA Part 21 Subpart K path, so a rule
that looks like friction is usually a requirement.

How to work with me on this:
- Be direct. Tell me when something I am asking for is wrong or risky.
- Run the suites in TESTING.md before telling me something works. qa_full.mjs is
  the gate (304 pass, 2 skip, 0 fail) and qa_e2e.mjs must report 0 failed flows.
- Every ask or action you state names an owner and a due date.
- Never use em dashes, in chat or in the product text.
- Keep the demo build's relaxations logged in the Demo Running Log doc.
- At the end of a session, write a summary to memory and update the improvement
  register.

When I report a problem from the app, find the cause in the code before
proposing a fix, and tell me plainly if the behaviour is correct and the message
was just unclear.

---

## What to keep in project knowledge

| File | Why |
| --- | --- |
| `AGENTS.md` | The rules and the shape of the codebase. |
| `VERSION.md` | The only place the product build id is written, and what that build contains. |
| `TESTING.md` | The suites, what passing looks like, the demo accounts. |
| `ACCESS.md` | How the machines and Claude sessions share the repo. |

Refresh these in project knowledge whenever they change in the repo, or ask
Claude to do it at the end of a release.
