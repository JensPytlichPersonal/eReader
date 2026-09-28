# eReader

A self-hosted web e-reader for a household: a Node/Express server that converts EPUB, MOBI, PDF, Markdown and text into one reading format, and a plain static front end with an e-ink look and a Soft look. The README describes what it does in detail; treat it as the specification and change it with the code.

## Developing with agents

- The main session plans, designs and reviews, whatever model it runs on (Fable 5.1 by default). Code is written by the `implementer` agent (`.claude/agents/implementer.md`, `model: opus`, effort `xhigh`), started with the Agent tool and a self-contained brief: the agreed plan, the files involved, the rules of this file that bear on it, and what done means. The agent does not see the conversation.
- Exceptions the main session does itself: trivial edits (a few lines, a config or data tweak, a doc fix), and reading, planning and review of any size. A main session that itself runs Opus may write the code directly, since the code is Opus's either way.
- The main session reviews the agent's change before anything is reported done, stages by explicit path and commits it; the agent never commits, stages, pushes or deploys.
