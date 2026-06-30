# Skill Evolution Proposals

Multica skills should evolve through proposals before they are activated on
agents. A proposal is a workspace-scoped draft that can be produced by a human
or an automation, validated, then published into the workspace skill library.

## Flow

```text
task experience
  -> skill proposal
  -> lint / secret scan / eval metadata
  -> publish
  -> optional agent binding
```

Publishing a proposal creates or updates a workspace skill. It does not bind the
skill to any agent. Agent activation remains a separate explicit step through
the existing agent-skill APIs.

## API

Create a proposal:

```http
POST /api/skills/proposals
```

Required fields:

- `name`

Optional fields:

- `target_skill_id`: existing skill to update when published. Omit to create a
  new skill.
- `description`
- `content`: proposed `SKILL.md` body.
- `config`: skill config JSON.
- `files`: supporting files as `[{ "path": "...", "content": "..." }]`.
- `source`: provenance metadata, such as originating task IDs.
- `validation`: validation metadata, such as lint/eval/secret-scan results.
- `status`: `draft`, `validated`, or `rejected`. Defaults to `draft`.

List proposals:

```http
GET /api/skills/proposals?status=draft
```

Publish a proposal:

```http
POST /api/skills/proposals/{proposalId}/publish
```

Rejected and already-published proposals cannot be published.

## CLI

Create a draft proposal:

```bash
multica skill proposals create \
  --name "release-checklist" \
  --description "Use when preparing a release checklist" \
  --content-file ./SKILL.md \
  --source '{"kind":"autopilot","task_ids":["..."]}' \
  --validation '{"lint":"ok","secret_scan":"ok"}' \
  --status validated
```

Publish it into the workspace skill library:

```bash
multica skill proposals publish <proposal-id>
```

Bind the published skill to an agent only after review/canary:

```bash
multica agent skills add <agent-id> --skill-ids <skill-id>
```

## Automation Guardrails

- Automation may create proposals freely.
- Automation may publish new low-risk skills after validation.
- Updates to existing skills should require stronger validation because they can
  affect already-bound agents.
- Publishing must never auto-bind a skill to an agent.
- Store task IDs, validation output, and reviewer context in `source` and
  `validation`; do not store secrets.
