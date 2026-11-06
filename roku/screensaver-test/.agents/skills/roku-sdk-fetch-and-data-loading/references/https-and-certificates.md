<!-- @roku-sdk/ai managed v=1 hash=ff8b31d178cf027cf3688f6d6452475fd0af18c8718d409426aa08b78b2d3ffb skills=1 do-not-edit -->

# Reaching a host behind your own certificate authority

The body says *which* option points a request at a CA bundle. This file is the shape of it:
where the bundle has to live, how to make it the default for every request instead of one, and
what the failure looks like when it is missing.

## The two scopes

`HttpsAgent` is a constructor, and the agent it produces can be attached in two ways.

**Per request.** Build the agent, put it on the request's `agent` field, and only that request
uses it. Right for a single staging host while everything else keeps the platform trust store.

**For the whole app.** `HttpsAgent.setGlobalAgent(agent)` installs it as the default, so every
later call uses it without naming it. Right when every host the app talks to sits behind the
same internal authority — which is the case that otherwise ends up copy-pasting an `agent`
onto two dozen call sites and missing one.

`setGlobalAgent` is a static on the constructor, not a method on an instance, and it takes the
instance you built:

```tsx
const agent = new HttpsAgent({ certificatesFile: "pkg:/certs/internal-ca.crt" });
HttpsAgent.setGlobalAgent(agent);
```

Install it once, before anything fetches — `main()` or the app's bootstrap, not inside a
component that may mount twice.

## Where the bundle lives

`certificatesFile` is a URI the firmware reads, not a path the bundler resolves, so it is a
`pkg:/` location and the file has to be inside the package. That makes it one of the few places
in an RSG app where a hardcoded `pkg:/` URI is correct: the image-import rule exists because
the build pipeline rewrites image paths, and it does not process a certificate bundle.

Keep it under the app's `pkg/` directory so it ships, and remember that anything there is
readable by anyone who unpacks the app — a CA bundle is public by nature, but a client
certificate with a private key is not, and does not belong in a package.

## Which type describes the options

`HttpsAgentOptions` is `{ certificatesFile?: string }` and is exported from
`@roku-sdk/interfaces`. Note that it is the *only* field: there is no verification-disabling
switch here, and no per-host override. If a host fails to verify, the answer is the right
bundle, not a way around the check.

## What the failure looks like

A missing or wrong bundle does not produce a distinct error class. The call rejects the way a
transport failure rejects, because from the runtime's point of view the connection never
completed — so it reaches a `catch`, not the `ok` check the body describes for HTTP statuses.

That distinction is worth holding onto, because the two failures need opposite fixes:

| What happened | Where it surfaces | Fix |
|---|---|---|
| The certificate could not be verified | The promise rejects, so a `catch` | Attach the CA bundle |
| The server answered with 4xx or 5xx | The promise **resolves**; only `ok` is false | Read the status and handle it |

So a request that works against production and rejects against staging is usually a trust
problem rather than a server problem, and a request that "fails" with a body you can read is
the opposite.

## Checking the capability first

Aborting a request mid-flight is optional on this platform. Ask before relying on it rather
than discovering it on an older box:

```tsx
import { FetchFeature } from "@roku-sdk/interfaces";

if (fetch.isFeatureSupported(FetchFeature.ABORT_CONTROLLER)) {
    // safe to wire an AbortController to this request
}
```

The same question answers for `FetchFeature.STREAMING` and `FetchFeature.REQUEST_INIT`. A
`false` here is not an error to report — it is a branch to write.
