#!/usr/bin/env -S deno run --allow-read=deno.jsonc --allow-write=deno.jsonc
//
// Rewrites `desktop.macos.codesignIdentity` in deno.jsonc, in place.
//
// `deno desktop` reads the signing identity from the config file and nowhere
// else — there is no CLI flag for it — but the identity is per-developer, so
// the repo commits the ad-hoc "-" and the release workflow swaps in the real
// Developer ID here. deno.jsonc is JSONC, so this rewrites the one line rather
// than doing a parse/serialize round-trip, which would eat every comment in
// the file.
//
//   deno run --allow-read=deno.jsonc --allow-write=deno.jsonc \
//     scripts/set_codesign_identity.ts "Developer ID Application: … (TEAMID)"

const CONFIG = new URL("../deno.jsonc", import.meta.url);
const LINE = /^(\s*"codesignIdentity":\s*)"[^"]*"/m;

const identity = Deno.args[0];
if (!identity) {
  console.error("usage: set_codesign_identity.ts <signing-identity>");
  Deno.exit(1);
}

const source = await Deno.readTextFile(CONFIG);
if (!LINE.test(source)) {
  // Fail loudly: a silent no-op here produces an ad-hoc signed .app that gets
  // notarized-and-rejected several minutes later, or worse, shipped.
  console.error('deno.jsonc has no "codesignIdentity" line to rewrite.');
  Deno.exit(1);
}

// JSON.stringify to escape the identity rather than interpolating it raw —
// Developer ID names contain commas and parens, and could contain a quote.
await Deno.writeTextFile(
  CONFIG,
  source.replace(LINE, `$1${JSON.stringify(identity)}`),
);
console.log(`codesignIdentity set to ${identity}`);
