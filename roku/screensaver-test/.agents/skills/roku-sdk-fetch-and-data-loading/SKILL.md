---
name: roku-sdk-fetch-and-data-loading
description: "Use when an RSG SDK TypeScript app has to load data over the network — calling fetch with the single argument this runtime accepts rather than the two-argument form the web uses and which still compiles here, checking ok because a 4xx or 5xx resolves instead of rejecting, reading a typed body out of json, building a Request when a method or headers are needed, pointing HttpsAgent at a custom certificate file, and asking isFeatureSupported before relying on an optional capability. Not when the rows of a FlexGrid fill in, which that grid owns; and not scaffolding or which packages an app declares, which is project-setup."
# @roku-sdk/ai managed v=1 hash=27980a05eca3e4b679ab75b457b8c741beb99c550ba65625a68d9e5a7d1118cc skills=1 do-not-edit
---

# Loading data over the network

## Overview

Requests in an RSG app go through a `fetch` the firmware provides. It looks like the web's and
differs in three ways that all fail quietly: it takes **one argument**, an error status
**resolves** rather than rejecting, and the types your editor shows you are the browser's
rather than this platform's.

That last one is the root of the other two showing up late. `fetch` is declared in no ambient
file the compiler reads, so TypeScript falls through to its default DOM library — which means
the unsupported two-argument call **compiles cleanly and fails at runtime**.

**Reaching a host behind your own certificate authority is in
`references/https-and-certificates.md`.** Read it when a request works against production and
fails against staging. The tables below name the option; that file has where the bundle lives,
how to make it the default for every request, and why a trust failure surfaces in a different
place from an HTTP error.

## When to Use

| If the request is | Then |
|---|---|
| Calling an HTTP API from an RSG app | Here |
| A POST or PUT with headers and a body | Here — and not the way the web writes it |
| An error status that never reached your error handling | Here — `fetch` resolved |
| Which type describes a response, when the editor says `Response` | Here |
| A host whose certificate this box does not trust | `references/https-and-certificates.md` |
| Whether aborting or streaming is available on this firmware | Here — ask at runtime |

### When not to use

| Situation | Use instead | Because |
|---|---|---|
| Filling a virtualized shelf's rows as the viewer approaches them | The `flex-grid` skill | That grid owns *when* a row is fetched. This skill owns the call it makes |
| Feeding a SceneGraph-native list its items, or telling which components take data that way | The `sdk-components` skill | Recognising a `content`-fed node is a component question, not a transport one |
| Which packages the app must declare, or where a file has to live to be imported | The `project-setup` skill | The scaffold already covers what this skill needs |
| Reading what Roku itself holds about the viewer, or selling something in-channel | The `user-accounts-and-purchases` skill | That goes through a component and a command, not through HTTP |
| Getting logs or a crash off a device | The `cli-dev-loop` or `mcp-ai-dev-loop` skill | Those are about observing the app, not about what it requests |

## Quick Reference

| Want | Do |
|---|---|
| A GET | `fetch(url)` — one argument |
| Anything with a method, headers or a body | Build a `Request` and pass that: `fetch(new Request(url, init))` |
| The parsed body | `await response.json()`, then assert your own shape |
| Raw text | `await response.text()` |
| To know an error status happened | Check `response.ok`. **The promise already resolved** |
| A custom CA | `certificatesFile` on an `HttpsAgent` — see the reference |
| To know if abort or streaming works here | `fetch.isFeatureSupported(...)` with a `FetchFeature` member |

Where things come from:

| | |
|---|---|
| `fetch` | A firmware global. Imported from nothing, declared in no ambient file — which is why the editor shows the DOM's |
| `Request`, `Headers`, `HttpsAgent` | Globals too, but **installed by `@roku-sdk/native`**, which the scaffold already depends on |
| `ResponseInstance`, `RequestInit`, `HttpsAgentOptions`, `FetchFeature` | Types, from `@roku-sdk/interfaces` |

## Instructions

1. **Pass one argument.** `fetch(url)` or `fetch(request)`. The two-argument form is the web's,
   it typechecks here because the compiler is reading the DOM library, and the second argument
   is ignored at runtime — so a POST silently becomes a GET.

2. **Put method, headers and body on a `Request`.** That is where `RequestInit` belongs, and
   `body` is typed **`string` only** — no form data, no object, no stream. Serialize first.

3. **Check `ok` before reading the body.** A 4xx or 5xx is a *resolved* response, so error
   handling written as a `catch` never sees it. Only a transport failure rejects.

4. **Do not expect the response type your editor shows.** What a call really resolves to is
   `ResponseInstance` from `@roku-sdk/interfaces`. Against the DOM types the compiler applies,
   `await response.json()` comes back loose, so assert your own interface on it rather than
   reaching for a generic that will not compile.

5. **Ask before relying on an optional capability.** `fetch.isFeatureSupported(...)` answers for
   `FetchFeature.STREAMING`, `ABORT_CONTROLLER` and `REQUEST_INIT`. A `false` is a branch to
   write, not a failure to report.

6. **Load from `onMount`, and let a signal carry the state.** Nothing about the request is
   reactive on its own, so the pattern is: fire it on mount, write the result into a signal, and
   render off that signal's three states — not yet, failed, arrived.

7. **Do not switch a base URL on a build variable.** Those are compiled away, and a request to
   the wrong environment is the one bug that looks like a server problem. Read the environment
   from configuration the app can actually see at runtime.

## Example

A GET whose result drives the view, a POST built the way this runtime wants, and the `ok` check
in the place it belongs.

```tsx rsg-skill=complete
import { Component, createSignal, onMount } from "@roku-sdk/solid";

interface Title {
    id: string;
    name: string;
}

export const Shelf: Component<{ endpoint: string }> = props => {
    const [titles, setTitles] = createSignal<Title[] | undefined>(undefined);
    const [failed, setFailed] = createSignal(false);

    const load = async () => {
        try {
            // One argument. A second one would compile and be ignored.
            const response = await fetch(`${props.endpoint}/titles`);

            // Already resolved, even on 404 — so this check is the error handling.
            if (!response.ok) {
                setFailed(true);
                return;
            }

            // The compiler is using the DOM's Response here, so assert the shape.
            const body = (await response.json()) as { titles: Title[] };
            setTitles(body.titles);
        } catch {
            // Only a transport or trust failure lands here.
            setFailed(true);
        }
    };

    onMount(() => void load());

    return (
        <group>
            <label text={failed() ? "could not load" : titles() === undefined ? "loading" : ""} />
            <label text={(titles() ?? []).map(t => t.name).join(", ")} translation={[0, 48]} />
        </group>
    );
};
```

A POST carries its method, headers and body on a `Request`, and the body is a string:

```tsx
const request = new Request(`${endpoint}/progress`, {
    method: "POST",
    headers: new Headers({ "Content-Type": "application/json" }),
    body: JSON.stringify({ titleId, seconds })
});

const response = await fetch(request);
```

## Common Mistakes

| Symptom | Cause | Fix |
|---|---|---|
| A POST arrives at the server as a GET with no body | The web's two-argument `fetch` — it compiled, and the second argument was ignored | Build a `Request` and pass that as the single argument |
| A 404 or 500 never reaches the error path | The promise resolved; only a transport failure rejects | Check `response.ok` before reading the body |
| A generic on the body parse will not compile | That generic is on this platform's response type, and the compiler is applying the DOM's | `await response.json()` and assert your own interface |
| Sending an object or form data as `body` fails | `body` is typed `string` | Serialize it yourself |
| `Request` resolves in the editor with no import, and it feels like a mistake | It is a global that `@roku-sdk/native` installs | Nothing to import for the value; take the *types* from `@roku-sdk/interfaces` |
| Aborting silently does nothing on an older box | Abort support is optional on this platform | Gate it on `fetch.isFeatureSupported(FetchFeature.ABORT_CONTROLLER)` |
| Requests work in production and fail against staging | The staging certificate is not in the platform trust store | `references/https-and-certificates.md` |
| The app talks to the wrong environment in a release build | The base URL was chosen from a build variable, which the build removed | Read it from runtime configuration |

Request and response types are documented with TSDoc in `@roku-sdk/interfaces`. Read a field's
exact shape there rather than assuming the browser's.
