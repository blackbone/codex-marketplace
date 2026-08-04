# Security policy

## Reporting

Please report vulnerabilities through the repository's private Git hosting
security-advisory channel. Do not open a public issue containing credentials,
private task data, command output with secrets, or a working exploit.

Include the affected plugin and version, impact, reproduction steps, and any
suggested mitigation. Maintainers will confirm the report and coordinate a fix
and disclosure timeline.

## Scope

Plugins can execute local commands, read repository context, and call configured
services with the current user's permissions. Review a plugin's manifest, MCP
configuration, hooks, and scripts before installing it. Installation does not
create a security boundary or elevate privileges.

The ToDo plugin writes repository-local `.todo/` runtime state and starts local
worker/dashboard processes only after repository activation or an explicit
runner action. Its dashboard is intended for local use and may expose prompts,
logs, errors, and task context.
