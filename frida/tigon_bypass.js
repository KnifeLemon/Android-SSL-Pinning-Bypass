'use strict';
// Instagram / Meta (Tigon-MNS) SSL-pinning bypass for pre-444 builds.
// Run at startup (frida spawn, a startup-loaded gadget, or attach via run.py).
//
// NOTE: Instagram v444+ moved the real pinning into the native MNS/Fizz stack,
// which this script does NOT cover. For modern Instagram use
// ../frida/instagram_v444_bypass.js (a superset of this file).
// Technique credit: takaotr (frida codeshare).

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

// Retry until the Tigon class is loaded (it loads after our startup hook point).
var timer = setInterval(function () {
    if (tryHookTigon()) { clearInterval(timer); console.log("[*] Tigon hook complete"); }
}, 50);
tryHookTigon();

// Conscrypt + generic SSLContext trust-all (installed once).
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
