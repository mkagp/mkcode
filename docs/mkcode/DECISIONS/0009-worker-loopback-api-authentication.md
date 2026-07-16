# ADR 0009: Worker loopback API and authentication

- **Status:** Accepted

## Context

The browser server must proxy workflow commands and queries without receiving
factory database ownership. The first deployment is one trusted operator and
one host, but local processes and accidental network exposure are still relevant
threats. Browser session credentials have a different audience and lifecycle
from service-to-service authentication.

## Decision

The factory worker exposes a versioned HTTP API bound to loopback by default.
Every endpoint uses a dedicated `MKCODE_FACTORY_TOKEN`, compared in constant
time. Unsafe binding is rejected unless explicitly enabled. The server keeps the
credential private, never returns it to the browser, and validates typed worker
responses. Durable cursor polling is authoritative; future live streams layer
over it.

## Consequences

- Server and worker can evolve and restart independently behind a typed
  compatibility boundary.
- Operators must provision and rotate a separate local credential.
- Loopback reduces exposure but is not mutual TLS or a multi-tenant boundary.
- A later systemd deployment should load the credential from a restricted
  environment/credential file rather than shell history.

## Alternatives considered

- **Browser connects directly to worker:** rejected because it exposes service
  credentials and bypasses server authorization.
- **Reuse browser pairing/session credentials:** rejected because the audience,
  scope, and rotation lifecycle differ.
- **Unix socket only:** viable later, but HTTP loopback is easier to test,
  supervise, and proxy in version one.
