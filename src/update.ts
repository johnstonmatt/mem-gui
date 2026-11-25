// Checks GitHub for a newer release and installs it.
//
// Installing downloads the release zip, refuses anything that isn't the
// expected version or doesn't pass codesign and Gatekeeper, then hands off to
// the install.zsh that ships inside the *downloaded* app, so each release
// carries its own install steps. The installer outlives this process: it waits
// for the app to exit, swaps the bundle in /Applications, and relaunches it.

export const REPOSITORY = "johnstonmatt/mem-gui";
export const INSTALLED_APP = "/Applications/MemGui.app";
const APP_NAME = "MemGui.app";
const INSTALLER = "Contents/Resources/install.zsh";

/** Dotted versions compared number by number: 0.10.0 is newer than 0.9.1. */
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const x = a.split(".").map((part) => Number(part) || 0);
  const y = b.split(".").map((part) => Number(part) || 0);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const left = x[i] ?? 0;
    const right = y[i] ?? 0;
    if (left !== right) return left < right ? -1 : 1;
  }
  return 0;
}

/** Release assets are named by uname -m, which says arm64 where Deno says aarch64. */
export function macArch(arch: string = Deno.build.arch): string {
  return arch === "aarch64" ? "arm64" : arch;
}

export function assetName(tag: string, arch: string): string {
  return `MemGui-${tag}-macos-${arch}.zip`;
}

export interface Release {
  tag: string;
  version: string;
  /** Undefined when the release has no build for this architecture. */
  assetUrl?: string;
}

/** Reads the fields we need out of GitHub's `releases/latest` response. */
export function parseRelease(json: unknown, arch: string): Release {
  const release = json as {
    tag_name?: unknown;
    assets?: { name?: unknown; browser_download_url?: unknown }[];
  };
  const tag = release?.tag_name;
  if (typeof tag !== "string") {
    throw new Error("GitHub returned a release without a tag.");
  }
  const version = tag.startsWith("v") ? tag.slice(1) : tag;
  if (!/^\d+(\.\d+)*$/.test(version)) {
    throw new Error("GitHub returned an invalid release version.");
  }
  const wanted = assetName(tag, arch);
  const asset = (release.assets ?? []).find((a) => a.name === wanted);
  const url = asset?.browser_download_url;
  return {
    tag,
    version,
    assetUrl: typeof url === "string" ? url : undefined,
  };
}

export async function fetchLatestRelease(
  fetchFn: typeof fetch = fetch,
): Promise<Release> {
  const response = await fetchFn(
    `https://api.github.com/repos/${REPOSITORY}/releases/latest`,
    {
      headers: {
        accept: "application/vnd.github+json",
        "user-agent": "mem-gui",
      },
      cache: "no-store",
      signal: AbortSignal.timeout(30_000),
    },
  );
  if (!response.ok) {
    throw new Error(
      "GitHub couldn't return the latest release. Please try again later.",
    );
  }
  return parseRelease(await response.json(), macArch());
}

export interface UpdateStatus {
  currentVersion: string | null;
  /** Set only when a newer release exists. */
  availableVersion: string | null;
  message: string;
}

export async function checkForUpdates(
  currentVersion: string | null = Deno.desktopVersion,
  latest: () => Promise<Release> = fetchLatestRelease,
): Promise<UpdateStatus> {
  if (!currentVersion) {
    return {
      currentVersion,
      availableVersion: null,
      message:
        "This development build has no release version. Install a packaged release to check for updates.",
    };
  }
  let release: Release;
  try {
    release = await latest();
  } catch (err) {
    return {
      currentVersion,
      availableVersion: null,
      message: `Couldn't check for updates: ${(err as Error).message}`,
    };
  }
  if (compareVersions(currentVersion, release.version) < 0) {
    return {
      currentVersion,
      availableVersion: release.version,
      message:
        `Mem GUI ${release.version} is available. You're running ${currentVersion}.`,
    };
  }
  return {
    currentVersion,
    availableVersion: null,
    message: `You're up to date. Mem GUI ${currentVersion} is installed.`,
  };
}

/** Runs a system tool, failing with its stderr. */
async function tool(path: string, args: string[]): Promise<string> {
  const { code, stdout, stderr } = await new Deno.Command(path, {
    args,
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).output();
  const decoder = new TextDecoder();
  if (code !== 0) {
    const name = path.slice(path.lastIndexOf("/") + 1);
    throw new Error(`${name} failed: ${decoder.decode(stderr).trim()}`);
  }
  return decoder.decode(stdout).trim();
}

export function bundleVersion(app: string): Promise<string> {
  return tool("/usr/bin/plutil", [
    "-extract",
    "CFBundleShortVersionString",
    "raw",
    "-o",
    "-",
    `${app}/Contents/Info.plist`,
  ]);
}

/**
 * Downloads the release into `work` and checks it's the expected version,
 * Developer ID signed and notarized, and carries an installer. Returns the
 * path of the verified app.
 */
async function downloadVerified(
  release: Release & { assetUrl: string },
  work: string,
): Promise<string> {
  const zip = `${work}/${assetName(release.tag, macArch())}`;
  const response = await fetch(release.assetUrl, {
    headers: { "user-agent": "mem-gui" },
  });
  if (!response.ok || !response.body) {
    throw new Error(`GitHub answered ${response.status} for the download.`);
  }
  await response.body.pipeTo((await Deno.create(zip)).writable);
  await tool("/usr/bin/ditto", ["-x", "-k", zip, work]);
  await Deno.remove(zip);

  const app = `${work}/${APP_NAME}`;
  if (await bundleVersion(app).catch(() => null) !== release.version) {
    throw new Error(
      `The ${release.tag} download doesn't contain Mem GUI ${release.version}.`,
    );
  }
  // Only a Developer ID signed, notarized build is installed, as Gatekeeper
  // would require of any download.
  try {
    await tool("/usr/bin/codesign", ["--verify", "--deep", "--strict", app]);
    await tool("/usr/sbin/spctl", ["--assess", "--type", "execute", app]);
  } catch {
    throw new Error(
      `The ${release.tag} download failed signature checks, so it wasn't installed.`,
    );
  }
  try {
    await Deno.stat(`${app}/${INSTALLER}`);
  } catch {
    throw new Error(
      `${release.tag} can't be installed from the app. Download it from https://github.com/${REPOSITORY}/releases.`,
    );
  }
  return app;
}

/**
 * Downloads and verifies the latest release, then starts its installer.
 * Resolves once the installer is running; the caller must then exit so the
 * installer can replace the app.
 */
export async function installLatest(
  latest: () => Promise<Release> = fetchLatestRelease,
): Promise<string> {
  const release = await latest();
  const { assetUrl } = release;
  if (!assetUrl) {
    throw new Error(
      `${release.tag} has no ${assetName(release.tag, macArch())} download.`,
    );
  }

  const work = await Deno.makeTempDir({ prefix: "mem-gui-update-" });
  let app: string;
  try {
    app = await downloadVerified({ ...release, assetUrl }, work);
  } catch (err) {
    await Deno.remove(work, { recursive: true }).catch(() => {});
    throw err;
  }

  // Detached and with no pipes, so the installer keeps running once this
  // process exits; it writes its own log to $TMPDIR.
  const child = new Deno.Command("/bin/zsh", {
    args: [`${app}/${INSTALLER}`, app, String(Deno.pid)],
    stdin: "null",
    stdout: "null",
    stderr: "null",
    detached: true,
  }).spawn();
  child.unref();
  return `Installing Mem GUI ${release.version}. Mem GUI will restart.`;
}
