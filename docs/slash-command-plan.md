# Slash Command Surface Plan

Status: implemented.

## Goal

Keep Yet's slash-command surface small and intentional. A slash command should change harness state, perform a structured local operation, or enforce execution semantics that a normal prompt cannot guarantee. Prompt macros and duplicate entry points should not become permanent product surface.

The immediate target is ten visible commands:

```text
/status
/model
/effort
/permissions
/plan
/compact
/copy
/resume
/rename
/exit
```

Because Yet is greenfield, renamed commands do not need compatibility aliases.

## Current command decisions

| Current command | Decision | Target behavior |
| --- | --- | --- |
| `/about` | Replace | `/status` shows runtime and session state without automatically copying it. |
| `/ask` | Remove | `/plan` is the single read-only mode and one-shot planning entry point. |
| `/btw` | Remove for now | Reintroduce only after `/fork` exists, implemented as a side-chat fork rather than a hidden standalone request. |
| `/commit` | Remove | Users can request a commit in normal language; the current command is only a prompt macro. |
| `/compact` | Keep | Manual escape hatch when automatic compaction is not sufficient. |
| `/copy-conversation-id` | Remove | The conversation ID remains visible through `/status`. |
| `/copy-request-id` | Remove | The latest request ID remains visible through `/status`. |
| `/copy` | Keep | Copy the final message from the agent's latest completed response to the system clipboard. |
| `/img` | Remove | Image paste will use native clipboard interaction with Ctrl+V. |
| `/model` | Keep | Select one of Yet's supported models. |
| `/plan` | Keep | Toggle read-only planning mode or run one read-only planning turn. |
| `/permissions` | Keep | Select Ask for approval, Approve for me, or Full Access. |
| `/reasoning` | Rename | `/effort` selects the model's reasoning effort and matches `--effort`. |
| `/rename` | Keep | Rename the current saved session. |
| `/review` | Remove | A normal review request under `/plan` covers this workflow without another prompt command. |
| `/shell` | Remove | `!command` is the one direct-shell entry point. |
| `/show-thinking` | Remove for now | Move reasoning visibility into the future `/config` UI. |
| `/simplify` | Remove | This is a review prompt preset, not a distinct harness operation. |
| `/switch` | Rename | `/resume` selects another saved session and matches the CLI terminology. |
| `/toggle-auto-compact` | Remove for now | Move automatic compaction into the future `/config` UI. |
| `/tools` | Remove | Yet has two fixed tools; `/status` can report them for diagnostics. |
| `/quit` | Rename | `/exit` is the single in-session exit command. |

## Target command behavior

### `/status`

Consolidate the useful parts of `/about`, `/tools`, and the two copy-ID commands. Show:

- Yet, Ant, and host runtime versions
- current working directory
- current model and effort
- active permission mode and planning-mode status
- automatic-compaction and thinking-visibility settings
- active tools
- session title and conversation ID
- latest request ID, when available

The command must only render information. It must not copy to the clipboard as a side effect.

### `/effort`

Preserve the existing reasoning-effort picker and model-specific validation. Rename the source and user-facing terminology from `reasoning` to `effort`. Do not retain `/reasoning` or `/thinking` aliases in the greenfield command registry.

### `/plan`

`/plan` enables read-only shell access and removes `apply_patch` from the model's available tools. Users can request reviews normally while planning mode is enabled.

Remove `/ask`; it currently controls the same planning-mode state and creates two names for one capability.

### `/resume`, `/rename`, and `/exit`

Rename `/switch` to `/resume` so the CLI and in-session terminology agree. Keep `/rename` for durable session titles. Make `/exit` the primary command and remove the `/quit` alias.

## Immediate cleanup scope

1. Replace the built-in command registry with the exact ten-command target list.
2. Add `/status` and remove `/about`, `/tools`, and both copy-ID commands.
3. Rename `/reasoning` to `/effort`, `/switch` to `/resume`, and `/quit` to `/exit`.
4. Remove `/ask`, `/commit`, `/review`, `/simplify`, and `/shell`.
5. Remove `/img` and its slash-command-only clipboard plumbing. Preserve the provider-neutral image message and general attachment pipeline for the future Ctrl+V implementation.
6. Remove `/btw` and the current `runSidePrompt` plumbing so Yet does not retain a second, hidden agent path.
7. Remove `/show-thinking` and `/toggle-auto-compact` from the registry while retaining their state and persisted preferences for the future configuration UI.
8. Add `/copy` as the only clipboard command. It copies the final assistant message rather than accumulated progress text, and rejects use before a response exists.
9. Delete slash-command context methods, application adapters, imports, files, and tests that become unreachable after the removal.
10. Update CLI help, README documentation, autocomplete tests, and any visible hints to use only the final names.

## Future `/config` UI

Do not add `/config` as a placeholder. Add it when the interactive configuration picker is implemented.

Its first settings should be:

- Show thinking: on or off
- Automatic compaction: on or off

The picker should display current values, persist changes through Yet's existing preferences file, and be designed to accept future settings without adding another slash command for each toggle.

## Future clipboard image paste

Do not keep `/img` as an interim path. Proper clipboard support should:

- attach an image when Ctrl+V is received and the clipboard contains image data
- preserve normal Ctrl+V text paste behavior
- reuse the existing provider-neutral image attachment representation
- show an inline attachment token and a clear failure message
- feature-detect terminal and platform support instead of silently dropping input
- avoid requiring users to install or remember a slash command

Terminal key and bracketed-paste behavior must be tested before choosing the final cross-platform clipboard implementation.

## Future `/fork` and `/btw`

Do not restore `/btw` until Yet has a real conversation-fork primitive.

The future session model must record a parent session ID and fork point. `/fork` should create a durable child conversation from the selected point. `/btw <question>` should use that same primitive to spawn a side chat, run the question there, and preserve the parent conversation's model context. It must not use a separate ad hoc provider call that bypasses normal session storage, permissions, tools, usage accounting, or cancellation.

The parent can display a compact link or summary of the side chat, but the side chat's messages must remain isolated from the parent's prompt history unless the user explicitly brings them back.

## Validation

- Assert the exact ten-command registry and ordering in the Ant test bundle.
- Assert that removed names and aliases parse as unknown commands.
- Assert that `/effort`, `/resume`, and `/exit` retain the behavior of the commands they replace.
- Assert that `/status` reports the expected state and has no clipboard side effect.
- Verify `/plan` still enforces read-only tools.
- Verify `/copy` copies only the latest assistant response.
- Confirm no dead slash-command context methods or command files remain.
- Run `npm run typecheck`, `npm test`, and `npm run build`.
- Run the built CLI under Ant and inspect `--help` for stale command names.
- Search the active tree for every removed command and document any intentional future-plan references.

## Completion criteria

The cleanup is complete when Yet exposes only the ten target commands, removed commands have no active implementation or hidden aliases, the future configuration, clipboard-image, and conversation-fork directions exist only in this document, and all TypeScript, Ant, package, and hygiene checks pass.
