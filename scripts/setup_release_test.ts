import { parseIdentities } from "./setup_release.ts";
import { assertEquals } from "../src/test_helpers.ts";

// Captured from a real `security find-identity -p codesigning <keychain>` run
// against a freshly imported .p12. The trailing trust status and the repeated
// "Valid identities only" section are the two things that broke the first
// version of the parser, so both are pinned here verbatim.
Deno.test("an untrusted identity is still found, and named without its status", () => {
  const output = `
Policy: Code Signing
  Matching identities
  1) 25E7D0D26F5067861FB3CFC7E4E01074B247CCBE "Developer ID Application: Test Person (A1B2C3D4E5)" (CSSMERR_TP_NOT_TRUSTED)
     1 identities found

  Valid identities only
     0 valid identities found
`;
  assertEquals(
    parseIdentities(output),
    ["Developer ID Application: Test Person (A1B2C3D4E5)"],
    "the trust status must not leak into the identity name",
  );
});

Deno.test("an identity listed in both sections is offered once", () => {
  const output = `
Policy: Code Signing
  Matching identities
  1) AAAA "Developer ID Application: Test Person (A1B2C3D4E5)"
     1 identities found

  Valid identities only
  1) AAAA "Developer ID Application: Test Person (A1B2C3D4E5)"
     1 valid identities found
`;
  assertEquals(
    parseIdentities(output),
    ["Developer ID Application: Test Person (A1B2C3D4E5)"],
    "a trusted identity appears in both sections and must be deduped",
  );
});

Deno.test("multiple distinct identities keep their listed order", () => {
  const output = `
  1) AAAA "Developer ID Application: One (AAAAAAAAAA)"
  2) BBBB "Developer ID Application: Two (BBBBBBBBBB)"
     2 identities found
`;
  assertEquals(
    parseIdentities(output),
    [
      "Developer ID Application: One (AAAAAAAAAA)",
      "Developer ID Application: Two (BBBBBBBBBB)",
    ],
    "order drives the numbered menu, so it has to be stable",
  );
});

Deno.test("a .p12 with no codesigning identity yields nothing", () => {
  const output = `
Policy: Code Signing
  Matching identities
     0 identities found

  Valid identities only
     0 valid identities found
`;
  assertEquals(parseIdentities(output), [], "no identities means no matches");
});

// A name can contain parentheses (every Developer ID does) and in principle a
// quote; the non-greedy match must stop at the closing quote, not the last one
// on the line.
Deno.test("the status suffix never becomes part of the name", () => {
  const output =
    `  1) AAAA "Developer ID Application: A (B) (CCCCCCCCCC)" (CSSMERR_TP_CERT_EXPIRED)`;
  assertEquals(
    parseIdentities(output),
    ["Developer ID Application: A (B) (CCCCCCCCCC)"],
    "parens inside the name are fine; the suffix outside the quotes is not",
  );
});
