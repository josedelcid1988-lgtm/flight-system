# NetSuite MCP: preparation for Flight System

Status: preparation only. No NetSuite credentials, no writes. Researched 2 Oct 2026.

## What already exists in Flight System

The app has a NetSuite seam and three bridge routes (HANDOVER.md section 7). With
`SK_INTEGRATIONS.mode = 'local'` (today) stock comes from the embedded snapshot and postings are exported
as CSV and marked posted by hand.

| Route the app calls | What it carries | NetSuite record |
| --- | --- | --- |
| `POST /netsuite/item-availability` | `partNumbers[]` | Item on hand by location (read) |
| `POST /netsuite/purchase-requisition` | vendor, process, need-by date for an external operation | Purchase Requisition (write) |
| `POST /netsuite/assembly-build` | `orderId`, `MES.netsuiteCsv` rows (item, revision, location, bin, quantity, lot, serial, work order, master WI, date) | Assembly Build with inventory detail (write) |

Every call already carries `actor` and `build`, so the bridge can log who asked and from which build.

## Recommendation

1. **Use Oracle's own NetSuite AI Connector Service with the free MCP Standard Tools SuiteApp**, connected
   to Claude as a custom connector. It is supported by Oracle, uses OAuth 2.0 with PKCE (no client secret
   on disk), refuses the Administrator role and full-permission roles, and keeps an execution log.
   Tools: record get, create, update and metadata, saved searches, reports, and read-only SuiteQL.
2. **Do not build on the community open-source servers.** None has more than about 25 GitHub stars and
   the useful ones have not been committed to in 10 to 16 months. The only one worth forking is
   glints-dev/mcp-netsuite (MIT, Go, read-only SuiteQL, OAuth 2.0 machine-to-machine), and only if a
   strictly read-only server under our own control becomes a requirement.

### What the MCP is for, and what it is not for

- **For:** Claude reading NetSuite during preparation and support: finding item internal IDs, locations,
  bins, lot and serial settings, the Assembly Build and Purchase Requisition field lists, and checking
  what the bridge posted.
- **Not for:** the bridge itself. The three routes above are deterministic and must post the same way
  every time, so the bridge calls NetSuite's REST and SuiteQL APIs directly with an integration role.
  An AI agent in the posting path would make the ERP record depend on a model's choices, which an
  AS9100 auditor will not accept.

## Security setup (AS9100)

- A dedicated custom role "Flight System MCP Read" with view-only permissions on items, locations, bins,
  inventory detail, assembly builds, purchase requisitions and vendors, plus "MCP Server Connection" and
  "Log in using OAuth 2.0 Access Tokens". No HR, payroll or bank records. No create or edit permissions,
  which blocks the write tools at the role.
- Sandbox account first. The sandbox holds copied production data, so treat it as controlled.
- The NetSuite execution log keeps 21 days in production (7 in sandbox). Export it monthly to the QMS
  record store. NetSuite does not log the prompt, so prompts stay in the Claude project history.
- Check whether export-controlled (ITAR or EAR) technical data sits in NetSuite item records before the
  connector is opened to production.

## Next steps

| Action | Owner | Due |
| --- | --- | --- |
| Ask the NetSuite administrator for a sandbox account and the read-only role above | Jose Del Cid | 9 Oct 2026 |
| Turn on OAuth 2.0, REST Web Services and Server SuiteScript in the sandbox; install MCP Standard Tools | IT (NetSuite administrator) | 14 Oct 2026 |
| Confirm no ITAR or EAR data is in the item records the role can read | Jose Del Cid with Trade Compliance | 14 Oct 2026 |
| Add the sandbox connector in Claude (Settings, Connectors, custom connector, the MCP Standard Tools URL) | Jose Del Cid | 16 Oct 2026 |
| Map the three bridge routes to real NetSuite fields and internal IDs from the sandbox, read-only | Claude, in the Flight System project | 21 Oct 2026 |
| Build the bridge (item availability first, writes after QA review) | IT, per HANDOVER.md open items | 14 Oct 2026 start |

## Sources

- Oracle, NetSuite AI Connector Service and MCP Standard Tools:
  https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/article_143403258.html,
  https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/article_0902023508.html,
  https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_0714082142.html
- Oracle product page: https://www.netsuite.com/portal/products/artificial-intelligence-ai/mcp-server.shtml
- Setup walkthrough and cost (no extra cost, per a third party; Oracle's pages do not state pricing):
  https://blog.prolecto.com/2025/12/06/how-to-connect-netsuite-to-chatgpt-and-claude-using-the-new-ai-connector/
- Governance notes: https://netwrix.com/en/resources/blog/netsuite-ai-connector-security-governance/
- Community servers checked on GitHub: dsvantien/netsuite-mcp-server, ChatFin-Labs/netsuite-mcp,
  glints-dev/mcp-netsuite, CDataSoftware/netsuite-mcp-server-by-cdata.
