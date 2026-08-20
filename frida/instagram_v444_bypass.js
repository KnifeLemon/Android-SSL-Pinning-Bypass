'use strict';
/*
 * Instagram / Meta SSL-pinning bypass — v444+ (native MNS/Fizz stack).
 *
 * From roughly v444 onward, Instagram's real certificate pinning no longer lives
 * in the Java Tigon config. It moved into the native MNS/Fizz TLS stack
 * (libstartup.so), which fails a handshake with:
 *
 *     MNSSecureTCP ... fizzy_client_connect(): Pin verification failed (-0x0001)
 *
 * That native code doesn't verify the certificate itself — it calls back into a
 * Java verifier over JNI, once per connection:
 *
 *     com.facebook.mobilenetwork.internal.certificateverifier.CertificateVerifier
 *
 * Its verify() / verifyWithProofOfPossession() return void and throw on a pin
 * mismatch, so making them no-ops turns pinning off. Because the verifier is
 * invoked per connection (not once at startup), this works even when the script
 * is attached slightly late — a fast attach-by-pid (see run.py) is enough; a
 * gadget or spawn is not required.
 *
 * This script also keeps the older Tigon-config and Conscrypt / SSLContext
 * trust-all hooks, so it stays effective on pre-444 builds and ordinary apps.
 * For pre-444 Instagram specifically, tigon_bypass.js is the minimal equivalent.
 *
 * Verified on Instagram for Android v444.0.0.0.77 (x86_64, Android 12).
 * Technique credit: takaotr (frida codeshare) for the Tigon config hook.
 */

// ---- 1) v444+ MNS/Fizz native pinning (the effective layer on modern Instagram) ----
Java.perform(function () {
    try {
        var CV = Java.use("com.facebook.mobilenetwork.internal.certificateverifier.CertificateVerifier");
        try { CV.setTrustUserCertificates(); } catch (e) {}        // trust user-installed (proxy) CAs
        CV.verify.overloads.forEach(function (ol) { ol.implementation = function () { return; }; });
        try {
            CV.verifyWithProofOfPossession.overloads.forEach(function (ol) { ol.implementation = function () { return; }; });
        } catch (e) {}
        console.log("[+] MNS CertificateVerifier.verify* neutralized (v444+ pinning off)");
    } catch (e) {
        // class absent on older builds -> the Tigon / Conscrypt hooks below cover those
    }
});

// ---- 2) Legacy Tigon config (pre-444 Instagram / other Tigon-based Meta apps) ----
var hooked = false;   // guarded so initHybrid is hooked exactly once

function tryHookTigon() {
    if (hooked) return true;
    Java.perform(function () {
        var Holder;
        try { Holder = Java.use("com.facebook.tigon.tigonmns.TigonMNSServiceHolder"); }
        catch (e) { return; }          // class not loaded yet -> retry later
        if (hooked) return;            // another queued attempt already did it
        hooked = true;                 // set BEFORE wrapping to prevent re-hook
        Holder.initHybrid.overloads.forEach(function (ol) {
            ol.implementation = function () {
                var cfg = arguments[0];
                try { if (cfg && cfg.setEnableCertificateVerificationWithProofOfPossession) cfg.setEnableCertificateVerificationWithProofOfPossession(false); } catch (e) {}
                try { if (cfg && cfg.setTrustSandboxCertificates) cfg.setTrustSandboxCertificates(true); } catch (e) {}
                try { if (cfg && cfg.setForceHttp2) cfg.setForceHttp2(true); } catch (e) {}
                return ol.apply(this, arguments);
            };
        });
        console.log("[+] Tigon initHybrid hooked (" + Holder.initHybrid.overloads.length + " overloads)");
    });
    return hooked;
}

var timer = setInterval(function () {
    if (tryHookTigon()) { clearInterval(timer); console.log("[*] Tigon hook complete"); }
}, 50);
tryHookTigon();

// ---- 3) Conscrypt + generic SSLContext trust-all (ordinary Android TLS apps) ----
Java.perform(function () {
    try {
        var AL = Java.use("java.util.ArrayList");
        var TMI = Java.use("com.android.org.conscrypt.TrustManagerImpl");
        if (TMI.checkTrustedRecursive) {
            TMI.checkTrustedRecursive.implementation = function () { return AL.$new(); };
            console.log("[+] Conscrypt checkTrustedRecursive bypassed");
        }
    } catch (e) {}
    try {
        var X = Java.use("javax.net.ssl.X509TrustManager");
        var C = Java.use("javax.net.ssl.SSLContext");
        var TM = Java.registerClass({
            implements: [X],
            methods: {
                checkClientTrusted: function () {},
                checkServerTrusted: function () {},
                getAcceptedIssuers: function () { return []; }
            },
            name: "com.patch.TrustAll"
        });
        var init = C.init.overload("[Ljavax.net.ssl.KeyManager;", "[Ljavax.net.ssl.TrustManager;", "java.security.SecureRandom");
        init.implementation = function (km, tm, sr) { init.call(this, km, [TM.$new()], sr); };
        console.log("[+] SSLContext.init -> trust-all");
    } catch (e) {}
});
