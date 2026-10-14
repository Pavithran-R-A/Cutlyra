# Agents.md

## Architecture

An ongoing migration is moving all business logic into `rust/`. Each app under `apps/` is a UI shell — it owns rendering, interaction, and platform-specific concerns, but never owns logic. The UI framework for any given app is a replaceable detail.

### `rust/`

The single source of truth for all non-UI code. Everything platform-agnostic belongs here: no components, no hooks, no framework imports.

### `apps/`

Each app is a frontend that calls into Rust. Logic is never duplicated between apps — only UI is, because each platform may use an entirely different framework and language to build it.

- `web/` — Next.js
- `desktop/` — GPUI

## Web

### React

- Read components before using them. They may already apply classes, which affects what you need to pass and how to override them.

## Commit and release attribution

This is an owner-maintained project. Do not append automated agent or AI
co-authorship trailers, assistant signatures, or "Generated with ..." lines
to Git commit messages, pull request descriptions, release notes, or handoff
reports. In particular, do not add Codebuff, Claude, Copilot, or other AI
systems as co-authors. Keep the actual Git author identity accurately
configured to the account owner before making owner-authorized commits.

Do not rewrite existing Git history, force-push, alter commit authors, or
remove third-party copyright/license/notice statements automatically.
Keep required upstream MIT and other license attributions intact. If a real
external person contributes original work, accurately represent their
contribution rather than claiming it is the owner's own work.
