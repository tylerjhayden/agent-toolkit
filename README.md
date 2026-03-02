# Agent Toolkit

Curated Claude Code skills and CLI tools — ready to drop into any project.

## What's Here

| Directory | Contents |
|-----------|----------|
| `skills/` | Prompt-template skills with `SKILL.md`. Copy to `.claude/skills/`. Claude-aware — invoked by name in Claude Code sessions. |
| `tools/`  | Standalone CLI tools. No `SKILL.md`. Copy to `.claude/tools/` or add to PATH. Pure shell execution. |

## Skills

| Skill | Description | Platform | Version |
|-------|-------------|----------|---------|
| [bear](skills/bear/) | Bear.app CLI bridge — two-way sync between filesystem markdown and Bear notes. | macOS | 1.0.0 |
| [mde](skills/mde/) | MacDown 3000 CLI with smart recent-file discovery. | macOS | 1.0.1 |
| [publish-to-toolkit](skills/publish-to-toolkit/) | Sanitize and publish your skills and tools to the public agent-toolkit GitHub repo. | any | 1.0.2 |

## Tools

| Tool | Description | Platform | Version |
|------|-------------|----------|---------|
| [claude-usage](tools/claude-usage/) | Fetches real-time claude.ai session and weekly usage limits using headless Playwright to bypass Cloudflare TLS fingerprinting, then displays progress bars per model tier. Includes a background poller that keeps a cache file fresh for the statusline. | macOS | 1.1.0 |

## Installation

### Skills

1. Pick a skill from the catalog above
2. Copy its directory into your project or user skills:

```bash
# Project-level (recommended)
cp -r skills/bear .claude/skills/bear

# Or user-level (available across all projects)
cp -r skills/bear ~/.claude/skills/bear
```

3. The skill is now available in Claude Code sessions

### Tools

1. Pick a tool from the catalog above
2. Copy its directory and add it to PATH:

```bash
cp -r tools/claude-usage .claude/tools/claude-usage

# Add to PATH (e.g. in ~/.zshrc)
alias claude-usage="/path/to/.claude/tools/claude-usage/claude-usage.ts"
```

3. See the tool's README for full setup instructions

## Skill Format

Every skill follows the [Agent Skills Specification](https://agentskills.io/specification):

```
skills/<name>/
  SKILL.md          # Skill definition (YAML frontmatter + markdown)
  README.md         # User-facing documentation
  tools/            # Optional CLI tools (bash, python, etc.)
```

## Tool Format

Tools are standalone CLI executables — no SKILL.md required:

```
tools/<name>/
  README.md         # User-facing documentation (install, PATH setup, usage)
  <executable>      # Executable(s) (bash, python, TypeScript, etc.)
```

## Development Setup

If you're contributing, enable the pre-commit security hooks:

```bash
git config core.hooksPath .githooks
```

This runs automatic checks for secrets, hardcoded paths, and internal references before every commit.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the skill/tool format and PR checklist.

Maintaining a private project with skills or tools to share? [publish-skill](skills/publish-skill/) automates stripping internal references, security scanning, and publishing — the same tool used to maintain this repo.

## License

MIT — see [LICENSE](LICENSE).

---
