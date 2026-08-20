# Analysis: how Instagram's SSL pinning actually works, and how we bypassed it

A record of the investigation behind this toolkit — the methodology, the dead ends,
and the result.

> ### ⚠️ Scope — this is a point-in-time snapshot, not universal truth
>
> Everything below was analyzed against **one specific build**:
>
> | | |
> |---|---|
> | App (bypass verified) | **v444.0.0.0.77** (native MNS/Fizz) and **v442.0.0.0.61** (Tigon config) |
> | App (decompiled for details) | a **v440.x** build (class names / smali below) |
> | ABI | **x86_64** |
> | OS / device | Android **12** (API 31), rooted emulator |
> | Date | 2026-08 |
>
> Instagram **v444** changed where pinning is enforced (native MNS/Fizz, see the update
> section below). The Tigon analysis further down still describes the pre-v444 mechanism.
>
> Instagram ships new builds constantly and re-obfuscates aggressively. So treat this as
> **version-specific**:
> - The **overall shape is stable** across recent versions — Meta uses the **Tigon/MNS**
>   stack, and the Java hook point is `TigonMNSServiceHolder.initHybrid`. `tigon_bypass.js`
>   detects the `initHybrid` overload at runtime, so it tolerates version drift.
> - The **details are not** — obfuscated class names (`X.0xxx`), method overloads, dex
>   layout, native offsets, and even which layers exist **change between versions and
>   between architectures (x86_64 vs arm64)**. Do not assume any exact name/offset here
>   holds for the version you are testing; re-verify against your own build.
> - Findings for **iOS** or **other Meta apps** may differ again.

---

## TL;DR of findings

- Instagram's real pinning is **not** OkHttp `CertificatePinner`, and there is **no**
  `libinstagram.so`. Those (widely reposted in AI-generated blogs) **do not exist** in the
  real app.
- **v444+ (current):** pinning moved into the **native MNS/Fizz TLS stack** (`libstartup.so`).
  It delegates the cert check to a **Java** verifier over JNI —
  `com.facebook.mobilenetwork.internal.certificateverifier.CertificateVerifier` — so the
  bypass is to **no-op its `verify()` / `verifyWithProofOfPossession()`**. Per-connection, so
  a late attach works. → `instagram_v444_bypass.js`.
- **pre-v444:** the network stack is **Tigon / MNS**; cert verification is turned on inside a
  **Java config** passed to `TigonMNSServiceHolder.initHybrid(...)`, hooked at startup. →
  `tigon_bypass.js`.
- Static approaches (network-security-config, Frida-gadget injection) **fail** on Instagram
  because of SoLoader/Superpack packaging + the native TLS layer.

---

## Methodology / tools

| Step | Tool |
|---|---|
| Decompile APK to smali + resources | [APKEditor](https://github.com/REAndroid/APKEditor) (`d`), grep |
| Inspect native libs / ELF | Python `zipfile`, LIEF |
| Runtime introspection & hooking | Frida (`frida-server` + `frida-tools`) |
| Observe behavior / crashes | `adb logcat`, tombstones, `/proc/<pid>/maps`, screenshots |
| Confirm traffic path | `ss -tnp`, Wi-Fi proxy = Burp |

Everything was verified against the **real decompiled APK** — not assumed from blogs.

---

## v444: pinning moved to the native MNS/Fizz stack

On **v444.0.0.0.77** the pre-v444 Tigon-config bypass stopped working — the app opened but
every request failed and it got stuck on a *"문제가 발생했습니다 / Something went wrong"*
config-load screen. `adb logcat` showed the real reason:

```
PLog: Fetch failed: ... network error: TransientError
      domain: MNSSecureTCP code: 4
      detail: fizzy_client_connect(): Pin verification failed (-0x0001)
```

So on v444 the cert check happens in the **native MNS/Fizz TLS stack** (`libstartup.so`,
namespace `crossapp::tigonhttp3::mns` / `facebook::distribgw::client`), not in the Java
Tigon config. That explains why the old hook no longer helped: its target
`TigonMNSServiceHolder.initHybrid` **is never even called** on v444, and the native config
(`MNSDGWNetworkStackConfig`, with `trustSandboxCertificates:false`) is a native struct.

### What was ruled out (before finding the real hook)

Each of these was hooked and confirmed **not** to intercept the failing MNS connection:

| Hook attempted | Result |
|---|---|
| Java `TigonMNSServiceHolder.initHybrid` config setters | never called on v444 |
| Java `TigonMNSConfig` setters / getters (even at VM-init via wait-for-debugger) | class never constructed for this path |
| Native `proxygen::SSLVerification::verifyWithMetrics` (the old `liger` hook, now in `libstartup.so`) | never called |
| Native `RetinaCertificateVerifier::verify` (via the relative-vtable) | never called |
| Native `fizz::client::ClientStateMachine::processConnect` — verifier arg nulled | pin still enforced |
| Native `X509_verify_cert` forced to succeed | never called (MNS pin isn't OpenSSL) |

The pin check is Meta's own logic in native MNS code, independent of fizz's verifier,
OpenSSL, and all Java config.

### The actual hook point

The native MNS code doesn't verify the certificate itself — it **calls back into Java over
JNI, once per connection**, using:

```
com.facebook.mobilenetwork.internal.certificateverifier.CertificateVerifier
    void verify(byte[][] chain, String host)
    void verify(byte[][] chain, String host, boolean)
    void verifyWithProofOfPossession(byte[][] chain, String host, boolean, int, byte[], byte[])
```

These return `void` and **throw on a pin mismatch**, so making them no-ops turns pinning
off. Because they run per connection (not once at startup), the hook works even when
attached slightly late — no spawn/gadget timing needed.

```mermaid
flowchart TD
    A["MNS/Fizz TLS handshake<br/>(native libstartup.so)"] --> B["JNI upcall:<br/>CertificateVerifier.verify(chain, host)"]
    B --> C{pin match?}
    C -- "no (normal)" --> D["throw → fizzy_client_connect():<br/>Pin verification failed (-0x0001)"]
    C -- "yes" --> E[handshake continues]
    B -. "Frida: verify() → no-op (never throws)" .-> E
    classDef ok fill:#1f6f43,stroke:#0d3,color:#fff;
    class E ok
```

**Result:** with `verify*` neutralized, no more `Pin verification failed`, dozens of TCP
connections established to the proxy, and Instagram loads its account/feed data normally —
traffic decrypted in Burp. This is what `instagram_v444_bypass.js` does (it also keeps the
pre-v444 Tigon and Conscrypt hooks below, so it stays a superset).

---

## Where the pinning actually lives (pre-v444 Tigon)

```mermaid
flowchart TD
    App["Instagram app code<br/>(obfuscated: X.0xxx)"]
    App -->|main API traffic| Tigon["Tigon / MNS<br/>(cronet-based stack)"]
    App -. rare / auxiliary .-> Conscrypt["Conscrypt / system TLS"]

    Tigon --> Cfg["TigonMNSConfig<br/>cert verification = ON"]
    Cfg --> BSSL["statically-linked BoringSSL<br/>(symbols stripped)"]
    Conscrypt --> Libssl["system libssl.so"]

    NSC["network-security-config"] -. controls .-> Conscrypt
    NSC -. does NOT control .-> Tigon

    classDef win fill:#1f6f43,stroke:#0d3,color:#fff;
    classDef bad fill:#7a1f1f,stroke:#d33,color:#fff;
    class Cfg win
    class NSC bad
```

Key point: the **NSC** (which `--patch-nsc` edits) and the **system BoringSSL** (which
native hooks reach) do **not** govern Tigon's traffic. Only the **`TigonMNSConfig`** does —
and it's reachable from Java at `initHybrid`.

---

## What we tried, and what happened

```mermaid
flowchart TD
    S([Goal: decrypt Instagram HTTPS]) --> A1[NSC patch: trust user CAs]
    A1 --> R1{App routes to proxy<br/>but Tigon still pins}
    R1 -->|fail| A2[Frida gadget via DT_NEEDED<br/>on libc++_shared.so]
    A2 --> R2{Gadget never loads<br/>SoLoader/Superpack + app hangs}
    R2 -->|fail| A3[Native BoringSSL hooks<br/>SSL_CTX_set_custom_verify]
    A3 --> R3{Only hooks Conscrypt/libssl<br/>not Tigon}
    R3 -->|fail| A4[Static gadget via smali loadLibrary<br/>+ Tigon script]
    A4 --> R4{Gadget loads, but script's<br/>Java.perform deferred ~5s<br/>-> misses initHybrid}
    R4 -->|fail| A5[Frida-server SPAWN<br/>+ tigon_bypass.js]
    A5 --> R5([SUCCESS: hook before initHybrid<br/>login reaches server])

    classDef ok fill:#1f6f43,stroke:#0d3,color:#fff;
    class R5 ok
```

| Attempt | Result | Why |
|---|---|---|
| `--patch-nsc` (trust user CAs) | ❌ | App reaches proxy, but Tigon pins in its own layer |
| Gadget via `DT_NEEDED` (LIEF) | ❌ | SoLoader loads libs from Superpack `libs.spo`, not `lib/<abi>/`; modifying libs → app hangs |
| Native BoringSSL hook | ❌ | Reaches only Conscrypt / system `libssl.so`, not Tigon's stripped BoringSSL |
| Static gadget + smali `loadLibrary` | ⚠️ | Gadget **loads** (proven), but the gadget script's `Java.perform` is deferred ~5 s → hook lands after `initHybrid` fired |
| **frida-server spawn + `tigon_bypass.js`** | ✅ | Script runs at first instruction → hooks `initHybrid` before it runs |

Two "walls" that turned out to be **false alarms**:

- *"`frida -f` times out → Instagram anti-frida"* — **No.** Spawn works; the timeout was
  transient (app already running / slow first-launch Superpack extraction). Retry succeeds.
- *"App crashes on inject → anti-frida detection"* — **No.** It was **our script** hooking
  `initHybrid` ~30× (async `Java.perform` defeated the guard) → stack overflow inside
  `frida-agent`. Fixed by hooking exactly once.

---

## The working bypass

```mermaid
sequenceDiagram
    participant F as frida (-f spawn)
    participant IG as Instagram process
    participant T as TigonMNSServiceHolder

    F->>IG: spawn (paused at first instruction)
    F->>IG: load tigon_bypass.js, install hook
    F->>IG: resume main thread
    IG->>T: initHybrid(config, ...)  [once, at startup]
    Note over T: our hook runs first
    T->>T: config.setEnableCertificateVerificationWithProofOfPossession(false)
    T->>T: config.setTrustSandboxCertificates(true)
    T->>T: config.setForceHttp2(true)
    Note over IG: pinning OFF, HTTP/2 forced → proxy decrypts traffic
```

**Proof it worked:** entering a wrong password produced the server's *"Incorrect password"*
response (the request reached Instagram's servers), and the requests appeared decrypted in
Burp. See [GUIDE-frida.md](GUIDE-frida.md) for the exact commands.

---

## Lessons

1. **Verify against the real binary.** Most online "Instagram SSL bypass" write-ups
   (libinstagram.so, `SecurityUtil.verifyCertificate`, fixed RVAs, OkHttp CertificatePinner)
   are AI-generated fiction — grepping the decompiled v440.x build returns **0** matches.
2. **Meta apps = Tigon.** The bypass surface is the Java config at `initHybrid`.
3. **Timing is everything.** The hook must precede `initHybrid`; only spawn guarantees it.
4. **Blame your own script first.** The "anti-frida crash" was a re-hook bug, not the app.
