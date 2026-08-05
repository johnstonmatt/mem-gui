#!/usr/bin/env -S deno run --allow-run=gh,security,xcrun --allow-read --allow-write --allow-env=HOME
//
// Interactive, one-time setup for the six Apple credentials the release
// workflow needs. Run it with `deno task setup:release`, or directly as
// ./scripts/setup_release.ts — the shebang above carries the same grants the
// task does, and without it a shell runs this file as sh and evaluates the
// backticks in these comments as commands.
//
// The point of this being a script rather than a README checklist: every one of
// these credentials fails *silently* if it's subtly wrong. A .p12 exported
// without its private key, an Individual API key instead of a Team one, a
// "Mac Development" cert instead of "Developer ID Application" — each one sails
// through `gh secret set` and then blows up ten minutes into a release build,
// at which point you're debugging CI logs instead of a local prompt. So this
// verifies every value against the same tools CI uses before storing anything,
// and derives whatever it can rather than asking you to retype it.
//
// Nothing is written to GitHub until you confirm the summary at the end.

import { expandHome } from "../src/paths.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// ---------------------------------------------------------------- terminal io

function out(text: string): void {
  Deno.stdout.writeSync(encoder.encode(text));
}

function heading(text: string): void {
  out(`\n\x1b[1m${text}\x1b[0m\n`);
}

function note(text: string): void {
  out(`\x1b[2m${text}\x1b[0m\n`);
}

function good(text: string): void {
  out(`\x1b[32m✓\x1b[0m ${text}\n`);
}

function bad(text: string): void {
  out(`\x1b[31m✗\x1b[0m ${text}\n`);
}

function fail(text: string): never {
  bad(text);
  Deno.exit(1);
}

/** Ctrl-C during a raw-mode read would otherwise leave the terminal unusable. */
function abort(): never {
  try {
    Deno.stdin.setRaw(false);
  } catch {
    // Already cooked; nothing to restore.
  }
  out("\nCancelled — nothing was changed.\n");
  Deno.exit(130);
}

function ask(question: string, fallback?: string): string {
  const suffix = fallback === undefined ? "" : ` \x1b[2m[${fallback}]\x1b[0m`;
  const answer = prompt(`${question}${suffix}`);
  if (answer === null) abort();
  const trimmed = answer.trim();
  return trimmed === "" && fallback !== undefined ? fallback : trimmed;
}

function askYesNo(question: string, fallback: boolean): boolean {
  // The hint goes in the question rather than through ask()'s fallback, which
  // would hand back the literal "Y/n" as the answer on an empty line.
  const hint = fallback ? "Y/n" : "y/N";
  while (true) {
    const answer = ask(`${question} \x1b[2m[${hint}]\x1b[0m`).toLowerCase();
    if (answer === "") return fallback;
    if (answer === "y" || answer === "yes") return true;
    if (answer === "n" || answer === "no") return false;
    note('Answer "y" or "n".');
  }
}

/**
 * Reads a line without echoing it. Export passwords end up in shell history and
 * scrollback otherwise, and scrollback is the one place a password outlives the
 * process that needed it.
 */
function askSecret(question: string): string {
  if (!Deno.stdin.isTerminal()) {
    fail(
      "Needs an interactive terminal — run `deno task setup:release` directly.",
    );
  }
  out(`${question} `);
  const bytes: number[] = [];
  const buffer = new Uint8Array(1);
  Deno.stdin.setRaw(true);
  try {
    while (true) {
      if (Deno.stdin.readSync(buffer) === null) break;
      const byte = buffer[0];
      if (byte === 0x0d || byte === 0x0a) break;
      if (byte === 0x03) abort();
      if (byte === 0x7f || byte === 0x08) {
        if (bytes.length > 0) {
          bytes.pop();
          out("\b \b");
        }
        continue;
      }
      bytes.push(byte);
      out("•");
    }
  } finally {
    Deno.stdin.setRaw(false);
  }
  out("\n");
  return decoder.decode(new Uint8Array(bytes));
}

function choose(question: string, options: string[]): number {
  if (options.length === 1) return 0;
  out(`\n${question}\n`);
  options.forEach((option, index) => out(`  ${index + 1}) ${option}\n`));
  while (true) {
    const picked = Number(ask("Pick a number"));
    if (Number.isInteger(picked) && picked >= 1 && picked <= options.length) {
      return picked - 1;
    }
    note(`Enter 1–${options.length}.`);
  }
}

// ------------------------------------------------------------------- plumbing

interface Ran {
  code: number;
  stdout: string;
  stderr: string;
}

async function run(
  command: string,
  args: string[],
  stdin?: string,
): Promise<Ran> {
  const child = new Deno.Command(command, {
    args,
    stdin: stdin === undefined ? "null" : "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();

  if (stdin !== undefined) {
    const writer = child.stdin.getWriter();
    await writer.write(encoder.encode(stdin));
    await writer.close();
  }

  const { code, stdout, stderr } = await child.output();
  return {
    code,
    stdout: decoder.decode(stdout).trim(),
    stderr: decoder.decode(stderr).trim(),
  };
}

/**
 * Dragging a file into Terminal pastes it shell-escaped, and wrapping a pasted
 * path in quotes is a reflex — undo both so either habit just works.
 */
function cleanPath(input: string): string {
  let path = input.trim();
  const quoted = (path.startsWith("'") && path.endsWith("'")) ||
    (path.startsWith('"') && path.endsWith('"'));
  if (quoted && path.length >= 2) path = path.slice(1, -1);
  return expandHome(path.replace(/\\(.)/g, "$1"));
}

async function askFile(question: string, extension: string): Promise<string> {
  while (true) {
    const path = cleanPath(ask(question));
    if (path === "") continue;
    if (!path.endsWith(extension)) {
      bad(`That isn't a ${extension} file.`);
      continue;
    }
    try {
      if ((await Deno.stat(path)).isFile) return path;
      bad(`Not a file: ${path}`);
    } catch {
      bad(`No such file: ${path}`);
    }
  }
}

function base64(bytes: Uint8Array): string {
  // btoa wants a string, and spreading a whole file into String.fromCharCode
  // blows the argument limit, so feed it through in chunks.
  let binary = "";
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
}

async function base64File(path: string): Promise<string> {
  return base64(await Deno.readFile(path));
}

// ------------------------------------------------------------------ preflight

async function preflight(): Promise<string> {
  heading("Checking prerequisites");

  if (Deno.build.os !== "darwin") {
    fail("macOS only — this drives `security` and `xcrun`.");
  }

  if ((await run("gh", ["--version"])).code !== 0) {
    fail("The GitHub CLI isn't installed. `brew install gh`, then re-run.");
  }
  if ((await run("gh", ["auth", "status"])).code !== 0) {
    fail("Not logged in to GitHub. Run `gh auth login`, then re-run.");
  }

  const repo = await run("gh", [
    "repo",
    "view",
    "--json",
    "nameWithOwner",
    "-q",
    ".nameWithOwner",
  ]);
  if (repo.code !== 0) {
    fail(`Couldn't identify the GitHub repo: ${repo.stderr}`);
  }

  good(`GitHub CLI authenticated, targeting ${repo.stdout}`);
  return repo.stdout;
}

async function existingSecrets(): Promise<Set<string>> {
  const listed = await run("gh", [
    "secret",
    "list",
    "--json",
    "name",
    "-q",
    ".[].name",
  ]);
  if (listed.code !== 0) return new Set();
  return new Set(listed.stdout.split("\n").filter((name) => name !== ""));
}

// --------------------------------------------------------------- certificates

/**
 * `security find-identity` prints one `  1) HASH "Name"` line per identity, and
 * appends a trust status to that line when the cert doesn't chain to a trusted
 * root — hence the non-greedy name and no end anchor. Without -v it prints two
 * sections ("Matching identities" then "Valid identities only"), so a trusted
 * identity is listed twice; dedupe rather than offering it twice in a menu.
 *
 * Exported for the test — the shape of this output is the one thing here that's
 * pure guesswork about another tool, so it's pinned against real captures.
 */
export function parseIdentities(output: string): string[] {
  const names = output
    .split("\n")
    .map((line) => line.match(/^\s*\d+\)\s+\S+\s+"(.+?)"/)?.[1])
    .filter((name): name is string => name !== undefined);
  return [...new Set(names)];
}

/**
 * Imports the .p12 into a throwaway keychain — byte for byte the same
 * `security import` the release workflow runs. That checks the export password
 * and the presence of the private key in one shot, and hands back the identity
 * names baked into the certificate, so MACOS_SIGN_IDENTITY is read off the cert
 * instead of retyped from a screenshot.
 */
interface Inspected {
  /** Every codesigning identity the .p12 contains. */
  identities: string[];
  /** The subset that currently chains to a trusted root on this machine. */
  valid: string[];
}

async function identitiesInCertificate(
  p12: string,
  password: string,
): Promise<Inspected | string> {
  const directory = await Deno.makeTempDir({ prefix: "mem-gui-setup-" });
  const keychain = `${directory}/verify.keychain-db`;
  const keychainPassword = crypto.randomUUID();
  try {
    const created = await run("security", [
      "create-keychain",
      "-p",
      keychainPassword,
      keychain,
    ]);
    if (created.code !== 0) {
      return created.stderr || "Couldn't create a scratch keychain.";
    }
    await run("security", [
      "unlock-keychain",
      "-p",
      keychainPassword,
      keychain,
    ]);

    const imported = await run("security", [
      "import",
      p12,
      "-k",
      keychain,
      "-P",
      password,
      "-T",
      "/usr/bin/codesign",
    ]);
    if (imported.code !== 0) {
      return imported.stderr.includes("MAC verification failed") ||
          imported.stderr.includes("Invalid password")
        ? "Wrong export password for that .p12."
        : imported.stderr || "Couldn't import that .p12.";
    }

    // Two passes, because -v filters to identities that currently chain to a
    // trusted root. A cert whose Apple intermediate isn't installed locally is
    // still the right cert and will sign fine on the runner, so listing without
    // -v decides *what's in the file* and -v only decides whether to warn.
    const all = await run("security", [
      "find-identity",
      "-p",
      "codesigning",
      keychain,
    ]);
    const valid = await run("security", [
      "find-identity",
      "-v",
      "-p",
      "codesigning",
      keychain,
    ]);
    return {
      identities: parseIdentities(all.stdout),
      valid: parseIdentities(valid.stdout),
    };
  } finally {
    await run("security", ["delete-keychain", keychain]);
    await Deno.remove(directory, { recursive: true });
  }
}

interface Certificate {
  base64: string;
  password: string;
  identity: string;
  path: string;
}

async function collectCertificate(): Promise<Certificate> {
  heading("1/2 — Developer ID Application certificate");
  note("In Keychain Access: login → My Certificates → the");
  note('"Developer ID Application: …" row → right-click → Export as .p12.');
  note("It must have a disclosure triangle with a key inside, or the private");
  note("key isn't included and it can't sign anything.");
  out("\n");

  while (true) {
    const path = await askFile("Path to the .p12 (drag it in)", ".p12");
    const password = askSecret("Export password for the .p12:");

    out("Verifying against `security import`… ");
    const result = await identitiesInCertificate(path, password);
    if (typeof result === "string") {
      out("\n");
      bad(result);
      continue;
    }

    const usable = result.identities.filter((name) =>
      name.startsWith("Developer ID Application:")
    );
    if (usable.length === 0) {
      out("\n");
      if (result.identities.length === 0) {
        bad(
          "No signing identity in that .p12 — it was exported without its private key.",
        );
      } else {
        bad(`Wrong certificate type. Found: ${result.identities.join(", ")}`);
        note(
          "Distribution outside the App Store needs a Developer ID Application cert.",
        );
      }
      continue;
    }

    out("\n");
    const identity =
      usable[choose("Which identity should releases be signed with?", usable)];
    good(`Verified — signing as ${identity}`);
    if (!result.valid.includes(identity)) {
      note("Note: that cert doesn't chain to a trusted root on this machine —");
      note(
        "usually a missing Apple intermediate locally, harmless for CI, but",
      );
      note(
        "if it's actually expired the release build is where you'll find out.",
      );
    }
    return { base64: await base64File(path), password, identity, path };
  }
}

// -------------------------------------------------------------- notary tokens

interface NotaryKey {
  base64: string;
  keyId: string;
  issuer: string;
  path: string;
}

async function collectNotaryKey(): Promise<NotaryKey> {
  heading("2/2 — App Store Connect API key (for notarization)");
  note(
    "App Store Connect → Users and Access → Integrations → App Store Connect API.",
  );
  note('Generate it under the "Team Keys" tab with the "Developer" role —');
  note("Individual keys are rejected by notarytool outright.");
  out("\n");

  const canVerify = (await run("xcrun", ["--find", "notarytool"])).code === 0;
  if (!canVerify) {
    note(
      "notarytool not found (install Xcode Command Line Tools) — skipping live",
    );
    note("verification of these three. They'll be stored as given.");
  }

  while (true) {
    const path = await askFile("Path to the AuthKey_*.p8", ".p8");

    // The 10-character key ID is in Apple's own filename, so offer it as the
    // default rather than making you read it off the web page.
    const fromName = path.match(/AuthKey_([A-Z0-9]{10})\.p8$/)?.[1];
    const keyId = ask("Key ID", fromName).toUpperCase();
    if (!/^[A-Z0-9]{10}$/.test(keyId)) {
      bad("A Key ID is 10 alphanumeric characters.");
      continue;
    }

    const issuer = ask("Issuer ID (the UUID at the top of that page)")
      .toLowerCase();
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
        issuer,
      )
    ) {
      bad(
        "The Issuer ID is a UUID, e.g. c055ca8c-e5a8-4836-b61d-aa5794eeb3f4.",
      );
      continue;
    }

    if (canVerify) {
      out("Asking Apple whether these credentials work… ");
      const history = await run("xcrun", [
        "notarytool",
        "history",
        "--key",
        path,
        "--key-id",
        keyId,
        "--issuer",
        issuer,
      ]);
      out("\n");
      if (history.code !== 0) {
        bad(
          history.stderr || history.stdout ||
            "Apple rejected those credentials.",
        );
        note("An Individual (rather than Team) key fails here every time.");
        continue;
      }
      good("Apple accepted the key.");
    }

    return { base64: await base64File(path), keyId, issuer, path };
  }
}

// ----------------------------------------------------------------------- main

// Guarded rather than run at the top level: the test imports parseIdentities
// from this module, and a bare top-level flow would kick off the whole
// interactive setup — and then Deno.exit() out of the test run — on import.
async function main(): Promise<void> {
  heading("Release credential setup for Mem GUI");
  note("Sets up the Apple secrets used by .github/workflows/release.yml.");
  note("Ctrl-C at any point leaves everything untouched.");

  const repo = await preflight();
  const already = await existingSecrets();

  const names = [
    "MACOS_CERTIFICATE",
    "MACOS_CERTIFICATE_PASSWORD",
    "MACOS_SIGN_IDENTITY",
    "APPLE_API_KEY",
    "APPLE_API_KEY_ID",
    "APPLE_API_ISSUER",
  ];
  const configured = names.filter((name) => already.has(name));
  if (configured.length > 0) {
    out("\n");
    note(`Already set on ${repo}: ${configured.join(", ")}`);
    if (!askYesNo("Overwrite them?", false)) {
      out("Nothing to do.\n");
      Deno.exit(0);
    }
  }

  const certificate = await collectCertificate();
  const notary = await collectNotaryKey();

  const secrets = new Map<string, string>([
    ["MACOS_CERTIFICATE", certificate.base64],
    ["MACOS_CERTIFICATE_PASSWORD", certificate.password],
    ["MACOS_SIGN_IDENTITY", certificate.identity],
    ["APPLE_API_KEY", notary.base64],
    ["APPLE_API_KEY_ID", notary.keyId],
    ["APPLE_API_ISSUER", notary.issuer],
  ]);

  heading("Ready to write");
  out(`Repository: ${repo}\n\n`);
  for (const name of secrets.keys()) {
    // Values are deliberately not echoed — half of them are secret and the other
    // half were confirmed above.
    out(`  ${name}${already.has(name) ? "  (overwrite)" : ""}\n`);
  }
  out("\n");
  if (!askYesNo(`Write these ${secrets.size} secrets to ${repo}?`, true)) {
    out("Nothing was written.\n");
    Deno.exit(0);
  }

  out("\n");
  for (const [name, value] of secrets) {
    // Piped, never `--body`: an argv secret is visible to every `ps` on the box.
    const written = await run("gh", ["secret", "set", name], value);
    if (written.code !== 0) {
      fail(`Failed to set ${name}: ${written.stderr}`);
    }
    good(name);
  }

  heading("Done");
  note("Optional, and not something this script can do for you:");
  note(
    "  • RELEASE_PLEASE_TOKEN — a PAT with repo scope, so CI runs on release PRs.",
  );
  out("\n");

  // The exported copies are now redundant, and a .p12 sitting in ~/Downloads is a
  // signing key sitting in ~/Downloads. Offer, don't assume — they may be filed
  // somewhere deliberately.
  if (
    askYesNo(`Delete the local ${certificate.path} and ${notary.path}?`, false)
  ) {
    for (const path of [certificate.path, notary.path]) {
      try {
        await Deno.remove(path);
        good(`Deleted ${path}`);
      } catch (error) {
        bad(
          `Couldn't delete ${path}: ${
            error instanceof Error ? error.message : error
          }`,
        );
      }
    }
  } else {
    note(
      "Left in place — remember the .p8 can never be re-downloaded from Apple.",
    );
  }

  note(
    "\nNext release PR that merges will build, sign, notarize and attach the .app.",
  );
}

if (import.meta.main) {
  await main();
}
