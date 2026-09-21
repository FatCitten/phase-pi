# Security

Phase's only responsibility is to decide *how* work should be allocated and
coordinated. Keep the trust boundary narrow and explicit.

## Principles

- **Project facts stay in the project.** The model sees allocation state
  (features, budget ceiling, allowed tools) and nothing else. Project source,
  secrets, and credentials are never sent to the model endpoint.
- **Bounded output.** Every allocation decision from the model is clamped to the
  caller's declared ceiling. A compromised or confused model cannot grant tools
  or budgets outside what the caller allowed; it can only choose within bounds.
- **Heuristic fallback.** If the model endpoint is unreachable, Phase degrades
  to a deterministic heuristic. It never blocks on the network.
- **Bundled Pi extension runs with your full permissions** (like any Pi
  extension). It shells out to the phase CLIs only. Never point `PHASE_ROOT` or
  the model base URL at untrusted content.

## Model endpoint

The chat-completions endpoint is configured via `PHASE_SLM_BASE_URL`
(`PHASE_LLM_BASE_URL` for the chat/orchestration brain). Use a local, trusted
endpoint (for example Ollama on `http://localhost:11434/v1`).

## Reporting

Please report security issues privately to the repository maintainers rather
than in a public issue. Do not share exploit details publicly before a fix is
available.
