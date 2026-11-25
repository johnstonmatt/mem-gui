import {
  assetName,
  checkForUpdates,
  compareVersions,
  macArch,
  parseRelease,
  type Release,
} from "./update.ts";
import { assertEquals, assertIncludes } from "./test_helpers.ts";

Deno.test("versions compare numerically, not as strings", () => {
  assertEquals(compareVersions("0.10.0", "0.9.1"), 1);
  assertEquals(compareVersions("0.1.4", "0.2.0"), -1);
  assertEquals(compareVersions("1.0", "1.0.0"), 0);
  assertEquals(compareVersions("1.2.3", "1.2.3"), 0);
});

Deno.test("asset names use uname -m's architecture", () => {
  assertEquals(macArch("aarch64"), "arm64");
  assertEquals(macArch("x86_64"), "x86_64");
  assertEquals(
    assetName("v0.2.0", "arm64"),
    "MemGui-v0.2.0-macos-arm64.zip",
  );
});

const RELEASE_JSON = {
  tag_name: "v0.2.0",
  assets: [
    {
      name: "MemGui-v0.2.0-macos-x86_64.zip",
      browser_download_url: "https://example.com/x86_64.zip",
    },
    {
      name: "MemGui-v0.2.0-macos-arm64.zip",
      browser_download_url: "https://example.com/arm64.zip",
    },
  ],
};

Deno.test("parseRelease picks this architecture's asset", () => {
  assertEquals(parseRelease(RELEASE_JSON, "arm64"), {
    tag: "v0.2.0",
    version: "0.2.0",
    assetUrl: "https://example.com/arm64.zip",
  });
  assertEquals(parseRelease(RELEASE_JSON, "riscv64").assetUrl, undefined);
});

Deno.test("parseRelease rejects a tag that isn't a version", () => {
  for (const tag_name of [undefined, "nightly", "v1.2-beta"]) {
    let message = "";
    try {
      parseRelease({ tag_name, assets: [] }, "arm64");
    } catch (err) {
      message = (err as Error).message;
    }
    assertIncludes(message, "GitHub returned");
  }
});

const latest = (version: string) => (): Promise<Release> =>
  Promise.resolve({ tag: `v${version}`, version });

Deno.test("checkForUpdates offers only a newer release", async () => {
  const newer = await checkForUpdates("0.1.4", latest("0.2.0"));
  assertEquals(newer.availableVersion, "0.2.0");
  assertIncludes(newer.message, "Mem GUI 0.2.0 is available");

  const same = await checkForUpdates("0.2.0", latest("0.2.0"));
  assertEquals(same.availableVersion, null);
  assertIncludes(same.message, "up to date");

  const older = await checkForUpdates("0.3.0", latest("0.2.0"));
  assertEquals(older.availableVersion, null);
});

Deno.test("checkForUpdates explains a dev build and a failed check", async () => {
  const dev = await checkForUpdates(null, latest("0.2.0"));
  assertEquals(dev.availableVersion, null);
  assertIncludes(dev.message, "development build");

  const failed = await checkForUpdates(
    "0.1.4",
    () => Promise.reject(new Error("offline")),
  );
  assertEquals(failed.availableVersion, null);
  assertIncludes(failed.message, "Couldn't check for updates: offline");
});
