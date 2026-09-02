---
name: klura
description: 'Use maintained local web-data tools first. Map a site into a reusable tool only when explicitly asked.'
emoji: 🌱
---

# Klura

Klura runs maintained web-data tools locally. Start with a managed package; its signed contract, local package, browser work, and scrape output stay on the user's machine.

## Default: use a managed package

1. Call `search_packages` for the site or capability.
2. Call `show_package` to inspect the selected package or capability.
3. Call `install_package` before use. `list_installed_packages` shows active immutable artifacts.
4. Use `call_package_capability` for one verified read, or `start_scrape_run` for a durable bounded collection. For a declared local browser realm, use `open_package_login`, wait for the user, then `complete_package_login` before selecting its session on a call or run; `clear_package_session` removes only that local session. A run pins that session generation until terminal state. Use `wait_scrape_run`, `get_scrape_run`, `list_scrape_runs`, and `list_scrape_run_items` to follow it; `resume_scrape_run`, `cancel_scrape_run`, and `discard_scrape_run` are explicit lifecycle operations. `run_consumer_doctor` shows current structural scheduler contention. `remove_package` changes only the active local pointer.

Consumer results are typed data. Read `kind`, operation, code, and declared outcome fields; never infer success, absence, retryability, or a next action from response wording, a status alone, or a text-matching rule. A consumer failure does not automatically start discovery. Explain the result or ask the user whether they want an explicit authoring attempt. See `klura://reference#consumer-tools`.

## Explicit authoring only

Use discovery tools only when the user asks to map, build, or maintain a tool, or explicitly chooses authoring after no managed package covers the job. The compact path is `start_session` → observed browser work → `end_drive`; follow the phase, checkpoint, audit, and schema feedback returned by tools. A successful session must save a complete reusable strategy, or be honestly closed with `abort_session` when the user stopped or the site cannot be completed. See `klura://reference#reverse-engineer-playbook` and `klura://reference#triage`.

For an explicit authoring task, preserve user literals exactly, use only observed traffic and structural verification, and keep incomplete progress in the discovery artifact rather than inventing runtime heuristics. `save_strategy` and `end_drive` return the next required action when an audit or checkpoint applies.

## Boundaries

- Managed public packages are read-only. Their sole source-bearing profile is an exact signed, maintainer-reviewed browser page program; do not ask klura to execute unreviewed package code, choose arbitrary egress, or bypass browser/security controls.
- Use the host's normal confirmation policy for installation, removal, and target-site reads. A scrape file path belongs to the user; MCP paths must already be absolute.
- Do not imply that a package is hosted by klura or that a scrape is cloud-run. The V1 registry is signed static metadata; execution is local.
